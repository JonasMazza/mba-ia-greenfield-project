import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { ObjectStorageService } from '../src/videos/storage/object-storage.service';
import { generatePublicId } from '../src/videos/utils/public-id';

interface StatusBody {
  public_id: string;
  status: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  thumbnail_url?: string;
  failure_reason?: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const VALID_BODY = {
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: 52428800,
};

describe('videos-status', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let objectStorage: ObjectStorageService;
  let ownerToken: string;
  let strangerToken: string;
  let ownerChannelId: string;

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
    ownerToken = await registerConfirmAndLogin('status-owner@example.com');
    strangerToken = await registerConfirmAndLogin('status-other@example.com');
    ownerChannelId = await findChannelIdByEmail('status-owner@example.com');
  }, 90000);

  afterAll(async () => {
    await releaseOpenUploads();
    await app.close();
  }, 60000);

  beforeEach(async () => {
    await releaseOpenUploads();
    await dataSource.query('DELETE FROM "videos"');
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

  /** Resolves through the user, since the channel nickname is derived/sanitized. */
  async function findChannelIdByEmail(email: string): Promise<string> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    return channel.id;
  }

  /** Seeds a row directly so the E2E does not have to wait on the real worker. */
  async function seedVideo(
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const repository = dataSource.getRepository(Video);
    return repository.save(
      repository.create({
        public_id: generatePublicId(),
        channel_id: ownerChannelId,
        status,
        ...overrides,
      }),
    );
  }

  function getStatus(publicId: string, token?: string) {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}/status`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  // 1. Projeção por estado do ciclo

  it('reports-processing-without-metadata', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING);

    const res = await getStatus(video.public_id, ownerToken);
    const body = res.body as StatusBody;

    expect(res.status).toBe(200);
    expect(body.public_id).toBe(video.public_id);
    expect(body.status).toBe('processing');
    expect(body).not.toHaveProperty('duration_seconds');
    expect(body).not.toHaveProperty('width');
    expect(body).not.toHaveProperty('height');
    expect(body).not.toHaveProperty('thumbnail_url');
    expect(body).not.toHaveProperty('failure_reason');
  }, 30000);

  it('reports-ready-with-metadata-and-thumbnail', async () => {
    const video = await seedVideo(VideoStatus.READY, {
      duration_seconds: 128,
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 2500000,
    });
    // The thumbnail must really exist for the presigned URL to be fetchable.
    const thumbnailKey = objectStorage.buildThumbnailKey(video.id);
    await objectStorage.putObject(
      objectStorage.processedBucket,
      thumbnailKey,
      new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]),
      'image/jpeg',
    );
    await dataSource
      .getRepository(Video)
      .update({ id: video.id }, { thumbnail_key: thumbnailKey });

    const res = await getStatus(video.public_id, ownerToken);
    const body = res.body as StatusBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.duration_seconds).toBe(128);
    expect(body.width).toBe(1920);
    expect(body.height).toBe(1080);
    expect(body.thumbnail_url).toMatch(/^https?:\/\//);
    expect(body.thumbnail_url).toContain('X-Amz-Signature=');
    expect(body).not.toHaveProperty('thumbnail_key');
    expect(body).not.toHaveProperty('storage_key');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('failure_reason');

    const thumbnail = await fetch(body.thumbnail_url as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  }, 60000);

  it('reports-failed-with-reason', async () => {
    const video = await seedVideo(VideoStatus.FAILED, {
      failure_reason: 'ffprobe: invalid data found when processing input',
    });

    const res = await getStatus(video.public_id, ownerToken);
    const body = res.body as StatusBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.failure_reason).toBe(
      'ffprobe: invalid data found when processing input',
    );
    expect(body).not.toHaveProperty('thumbnail_url');
  }, 30000);

  it('reports-draft-before-upload-completes', async () => {
    const initiated = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(VALID_BODY);
    const publicId = (initiated.body as { public_id: string }).public_id;

    const res = await getStatus(publicId, ownerToken);
    const body = res.body as StatusBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('draft');
    expect(body).not.toHaveProperty('duration_seconds');
    expect(body).not.toHaveProperty('width');
    expect(body).not.toHaveProperty('height');
    expect(body).not.toHaveProperty('thumbnail_url');
    expect(body).not.toHaveProperty('failure_reason');
  }, 30000);

  // 2. Posse e autenticação

  it('hides-video-from-authenticated-non-owner', async () => {
    const ready = await seedVideo(VideoStatus.READY);

    const readyRes = await getStatus(ready.public_id, strangerToken);
    expect(readyRes.status).toBe(404);
    expect((readyRes.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const processing = await seedVideo(VideoStatus.PROCESSING);
    const processingRes = await getStatus(processing.public_id, strangerToken);
    expect(processingRes.status).toBe(404);
    expect((processingRes.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  }, 30000);

  it('returns-404-for-unknown-public-id', async () => {
    const known = await seedVideo(VideoStatus.READY);

    const unknownRes = await getStatus('aaaaaaaaaaaa', ownerToken);
    expect(unknownRes.status).toBe(404);
    expect((unknownRes.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    // Indistinguishable from "exists but is not yours".
    const foreignRes = await getStatus(known.public_id, strangerToken);
    expect(unknownRes.status).toBe(foreignRes.status);
    expect(unknownRes.body).toEqual(foreignRes.body);
  }, 30000);

  it('rejects-anonymous-status-request', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const res = await getStatus(video.public_id);

    expect(res.status).toBe(401);
  }, 30000);
});
