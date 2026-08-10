import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { ObjectStorageService } from '../src/videos/storage/object-storage.service';
import { VIDEO_QUEUES } from '../src/videos/videos.constants';

interface InitiateUploadBody {
  public_id: string;
  upload_id: string;
  part_size_bytes: number;
  part_count: number;
  expires_in: number;
}

interface PresignPartsBody {
  parts: { part_number: number; url: string }[];
  expires_in: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const FIVE_MIB = 5 * 1024 * 1024;

const VALID_BODY = {
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: FIVE_MIB,
};

describe('videos-upload-cycle', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let objectStorage: ObjectStorageService;
  let ownerToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    objectStorage = moduleFixture.get(ObjectStorageService);

    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin('owner-a@example.com');
    strangerToken = await registerConfirmAndLogin('owner-b@example.com');
  }, 90000);

  afterAll(async () => {
    await releaseOpenUploads();
    await app.close();
  }, 60000);

  beforeEach(async () => {
    await releaseOpenUploads();
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM pgboss.job');
    throttlerStorage.storage.clear();
  });

  async function releaseOpenUploads(): Promise<void> {
    const videos = await dataSource.getRepository(Video).find();
    for (const video of videos) {
      if (video.storage_key && video.upload_id) {
        await objectStorage
          .abortMultipartUpload(video.storage_key, video.upload_id)
          .catch(() => undefined);
      }
    }
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token) => {
        confirmationToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return (login.body as { access_token: string }).access_token;
  }

  async function initiateUpload(): Promise<InitiateUploadBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    return res.body as InitiateUploadBody;
  }

  function presignParts(publicId: string, body: object, token = ownerToken) {
    return request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function completeUpload(publicId: string, body: object, token = ownerToken) {
    return request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function abortUpload(publicId: string, token = ownerToken) {
    return request(app.getHttpServer())
      .delete(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** PUTs the single part straight to the storage and returns its ETag. */
  async function uploadParts(
    publicId: string,
  ): Promise<{ part_number: number; etag: string }[]> {
    const res = await presignParts(publicId, { part_numbers: [1] });
    const { parts } = res.body as PresignPartsBody;

    const uploaded = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(FIVE_MIB).fill(8)]),
    });
    expect(uploaded.status).toBe(200);

    return [{ part_number: 1, etag: uploaded.headers.get('etag') as string }];
  }

  async function findVideo(publicId: string): Promise<Video | null> {
    return dataSource.getRepository(Video).findOneBy({ public_id: publicId });
  }

  async function countProcessJobs(): Promise<number> {
    const rows = await dataSource.query<unknown[]>(
      `SELECT id FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    return rows.length;
  }

  // 1. Presign de partes

  it('presigns-requested-parts-for-owner-draft', async () => {
    const initiated = await initiateUpload();

    const res = await presignParts(initiated.public_id, {
      part_numbers: [1, 2],
    });
    const body = res.body as PresignPartsBody;

    expect(res.status).toBe(200);
    expect(body.parts).toHaveLength(2);
    expect(body.parts.map((part) => part.part_number)).toEqual([1, 2]);
    for (const part of body.parts) {
      expect(part.url).toMatch(/^https?:\/\//);
      expect(part.url).toContain('X-Amz-Signature=');
      expect(part.url).toContain(`partNumber=${part.part_number}`);
      expect(decodeURIComponent(part.url)).toContain(initiated.upload_id);
    }
    expect(Number.isInteger(body.expires_in)).toBe(true);
    expect(body.expires_in).toBeGreaterThan(0);

    const resume = await presignParts(initiated.public_id, {
      part_numbers: [2],
    });
    const resumeBody = resume.body as PresignPartsBody;
    expect(resume.status).toBe(200);
    expect(resumeBody.parts).toHaveLength(1);
    expect(resumeBody.parts[0].part_number).toBe(2);

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
  }, 60000);

  it('rejects-presign-without-active-upload', async () => {
    const initiated = await initiateUpload();
    const parts = await uploadParts(initiated.public_id);
    await completeUpload(initiated.public_id, { parts });

    const res = await presignParts(initiated.public_id, { part_numbers: [1] });

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
  }, 60000);

  it('rejects-invalid-part-numbers', async () => {
    const initiated = await initiateUpload();

    await expect(
      presignParts(initiated.public_id, { part_numbers: [] }).then(
        (res) => res.status,
      ),
    ).resolves.toBe(400);
    await expect(
      presignParts(initiated.public_id, { part_numbers: [0] }).then(
        (res) => res.status,
      ),
    ).resolves.toBe(400);
    await expect(
      presignParts(initiated.public_id, { part_numbers: [10001] }).then(
        (res) => res.status,
      ),
    ).resolves.toBe(400);
    await expect(
      presignParts(initiated.public_id, {}).then((res) => res.status),
    ).resolves.toBe(400);
  }, 60000);

  // 2. Finalização do upload

  it('completes-upload-and-enqueues-processing', async () => {
    const initiated = await initiateUpload();
    const parts = await uploadParts(initiated.public_id);

    const res = await completeUpload(initiated.public_id, { parts });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      public_id: initiated.public_id,
      status: 'processing',
    });

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.PROCESSING);
    expect(video?.upload_id).toBeNull();
    expect(video?.storage_key).toBeTruthy();

    const jobs = await dataSource.query<{ data: { videoId: string } }[]>(
      `SELECT data FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: video?.id });
  }, 60000);

  it('rejects-complete-of-already-completed-upload', async () => {
    const initiated = await initiateUpload();
    const parts = await uploadParts(initiated.public_id);
    await completeUpload(initiated.public_id, { parts });

    const res = await completeUpload(initiated.public_id, { parts });

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.PROCESSING);
    await expect(countProcessJobs()).resolves.toBe(1);
  }, 60000);

  it('rejects-malformed-parts-payload', async () => {
    const initiated = await initiateUpload();

    await expect(
      completeUpload(initiated.public_id, {}).then((res) => res.status),
    ).resolves.toBe(400);
    await expect(
      completeUpload(initiated.public_id, {
        parts: [{ part_number: 1 }],
      }).then((res) => res.status),
    ).resolves.toBe(400);
    await expect(
      completeUpload(initiated.public_id, {
        parts: [{ part_number: 1, etag: '' }],
      }).then((res) => res.status),
    ).resolves.toBe(400);

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
  }, 60000);

  // 3. Abort do upload

  it('aborts-draft-upload-and-discards-video', async () => {
    const initiated = await initiateUpload();

    const res = await abortUpload(initiated.public_id);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const status = await request(app.getHttpServer())
      .get(`/videos/${initiated.public_id}/status`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(status.status).toBe(404);
    expect((status.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const publicView = await request(app.getHttpServer()).get(
      `/videos/${initiated.public_id}`,
    );
    expect(publicView.status).toBe(404);
    expect((publicView.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await expect(findVideo(initiated.public_id)).resolves.toBeNull();
  }, 60000);

  it('rejects-abort-of-non-draft-video', async () => {
    const initiated = await initiateUpload();
    const parts = await uploadParts(initiated.public_id);
    await completeUpload(initiated.public_id, { parts });

    const res = await abortUpload(initiated.public_id);

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.PROCESSING);
  }, 60000);

  // 4. Posse e autenticação

  it('hides-other-owners-video-across-upload-cycle', async () => {
    const initiated = await initiateUpload();

    const parts = await presignParts(
      initiated.public_id,
      { part_numbers: [1] },
      strangerToken,
    );
    expect(parts.status).toBe(404);
    expect((parts.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const complete = await completeUpload(
      initiated.public_id,
      { parts: [{ part_number: 1, etag: '"abc"' }] },
      strangerToken,
    );
    expect(complete.status).toBe(404);
    expect((complete.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const abort = await abortUpload(initiated.public_id, strangerToken);
    expect(abort.status).toBe(404);
    expect((abort.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
    expect(video?.upload_id).toBe(initiated.upload_id);
  }, 60000);

  it('rejects-anonymous-upload-cycle-requests', async () => {
    const initiated = await initiateUpload();
    const server = app.getHttpServer();

    const parts = await request(server)
      .post(`/videos/${initiated.public_id}/upload/parts`)
      .send({ part_numbers: [1] });
    expect(parts.status).toBe(401);

    const complete = await request(server)
      .post(`/videos/${initiated.public_id}/upload/complete`)
      .send({ parts: [{ part_number: 1, etag: '"abc"' }] });
    expect(complete.status).toBe(401);

    const abort = await request(server).delete(
      `/videos/${initiated.public_id}/upload`,
    );
    expect(abort.status).toBe(401);

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
  }, 60000);
});
