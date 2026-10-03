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

interface PublicVideoBody {
  public_id: string;
  title: string | null;
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  thumbnail_url: string | null;
  created_at: string;
}

interface PresignedUrlBody {
  url: string;
  expires_in: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const SOURCE_BYTES = 1024;

describe('videos-playback', () => {
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
    ownerToken = await registerConfirmAndLogin('play-owner@example.com');
    strangerToken = await registerConfirmAndLogin('play-other@example.com');
    ownerChannelId = await findChannelIdByEmail('play-owner@example.com');
  }, 90000);

  afterAll(async () => {
    await app.close();
  }, 60000);

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    throttlerStorage.storage.clear();
  });

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

  async function findChannelIdByEmail(email: string): Promise<string> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    return channel.id;
  }

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
        content_type: 'video/mp4',
        ...overrides,
      }),
    );
  }

  /** Seeds a ready video whose source and thumbnail really exist in the buckets. */
  async function seedReadyVideo(
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const video = await seedVideo(VideoStatus.READY, {
      duration_seconds: 128,
      width: 1920,
      height: 1080,
      ...overrides,
    });

    const storageKey = objectStorage.buildSourceKey(video.id);
    const thumbnailKey = objectStorage.buildThumbnailKey(video.id);
    await objectStorage.putObject(
      objectStorage.rawBucket,
      storageKey,
      new Uint8Array(SOURCE_BYTES).fill(6),
      'video/mp4',
    );
    await objectStorage.putObject(
      objectStorage.processedBucket,
      thumbnailKey,
      new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]),
      'image/jpeg',
    );
    await dataSource
      .getRepository(Video)
      .update(
        { id: video.id },
        { storage_key: storageKey, thumbnail_key: thumbnailKey },
      );

    return dataSource.getRepository(Video).findOneByOrFail({ id: video.id });
  }

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  // 1. Metadata pública

  it('returns-public-metadata-for-ready-video', async () => {
    const video = await seedReadyVideo({ title: 'Meu clipe' });

    const res = await get(`/videos/${video.public_id}`);
    const body = res.body as PublicVideoBody;

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'created_at',
      'duration_seconds',
      'height',
      'public_id',
      'status',
      'thumbnail_url',
      'title',
      'width',
    ]);
    expect(body.public_id).toBe(video.public_id);
    expect(body.title).toBe('Meu clipe');
    expect(body.status).toBe('ready');
    expect(body.duration_seconds).toBe(128);
    expect(body.width).toBe(1920);
    expect(body.height).toBe(1080);
    expect(Number.isNaN(Date.parse(body.created_at))).toBe(false);
    expect(body.thumbnail_url).toMatch(/^https?:\/\//);
    expect(body.thumbnail_url).toContain('X-Amz-Signature=');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('storage_key');
    expect(body).not.toHaveProperty('thumbnail_key');
    expect(body).not.toHaveProperty('upload_id');

    for (const token of [strangerToken, ownerToken]) {
      const authed = await get(`/videos/${video.public_id}`, token);
      const authedBody = authed.body as PublicVideoBody;
      expect(authed.status).toBe(200);
      // The presigned thumbnail URL is signed per request, so compare the rest.
      expect({ ...authedBody, thumbnail_url: null }).toEqual({
        ...body,
        thumbnail_url: null,
      });
    }
  }, 60000);

  // 2. Streaming

  it('issues-range-capable-stream-url', async () => {
    const video = await seedReadyVideo();

    const res = await get(`/videos/${video.public_id}/stream`);
    const body = res.body as PresignedUrlBody;

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'url']);
    expect(body.url).toMatch(/^https?:\/\//);
    expect(body.url).toContain('X-Amz-Signature=');
    expect(Number.isInteger(body.expires_in)).toBe(true);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.expires_in).toBeLessThanOrEqual(900);

    const ranged = await fetch(body.url, {
      headers: { Range: 'bytes=0-99' },
    });
    const rangedBody = new Uint8Array(await ranged.arrayBuffer());
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-99/${SOURCE_BYTES}`,
    );
    expect(rangedBody.byteLength).toBeLessThanOrEqual(100);

    const whole = await fetch(body.url);
    await whole.arrayBuffer();
    expect(whole.status).toBe(200);
  }, 60000);

  it('rejects-stream-of-non-ready-video-for-owner', async () => {
    const processing = await seedVideo(VideoStatus.PROCESSING);
    const processingRes = await get(
      `/videos/${processing.public_id}/stream`,
      ownerToken,
    );
    expect(processingRes.status).toBe(409);
    expect((processingRes.body as ErrorBody).error).toBe('VIDEO_NOT_READY');

    const failed = await seedVideo(VideoStatus.FAILED, {
      failure_reason: 'boom',
    });
    const failedRes = await get(
      `/videos/${failed.public_id}/stream`,
      ownerToken,
    );
    expect(failedRes.status).toBe(409);
    expect((failedRes.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
  }, 60000);

  // 3. Download

  it('issues-attachment-download-url', async () => {
    const video = await seedReadyVideo({ title: 'Meu clipe' });

    const res = await get(`/videos/${video.public_id}/download`);
    const body = res.body as PresignedUrlBody;

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'url']);
    const disposition = new URL(body.url).searchParams.get(
      'response-content-disposition',
    );
    expect(disposition?.startsWith('attachment')).toBe(true);

    const download = await fetch(body.url);
    await download.arrayBuffer();
    expect(download.status).toBe(200);
    const header = download.headers.get('content-disposition');
    expect(header?.startsWith('attachment')).toBe(true);
    expect(header).toContain('filename');
    expect(download.headers.get('content-type')).toBe('video/mp4');
  }, 60000);

  it('rejects-download-of-non-ready-video-for-owner', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING);

    const res = await get(`/videos/${video.public_id}/download`, ownerToken);

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
  }, 60000);

  it('signs-download-url-with-special-character-filename', async () => {
    const video = await seedReadyVideo({ title: 'Minha "férias" 2026.mp4' });

    const res = await get(`/videos/${video.public_id}/download`);
    const body = res.body as PresignedUrlBody;

    expect(res.status).toBe(200);
    const disposition = new URL(body.url).searchParams.get(
      'response-content-disposition',
    );
    expect(disposition).toContain('attachment');
    expect(disposition).toContain("filename*=UTF-8''");
    // The quotes and the accent must not survive raw in the ASCII fallback.
    expect(disposition).not.toContain('"férias"');

    const download = await fetch(body.url);
    await download.arrayBuffer();
    expect(download.status).toBe(200);
    const header = download.headers.get('content-disposition');
    expect(header).toContain('attachment');
    expect(header).toContain("filename*=UTF-8''");
  }, 60000);

  // 4. Não-vazamento de existência

  it('returns-404-for-unknown-public-id', async () => {
    for (const path of [
      '/videos/aaaaaaaaaaaa',
      '/videos/aaaaaaaaaaaa/stream',
      '/videos/aaaaaaaaaaaa/download',
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    }
  }, 60000);

  it('hides-non-ready-video-from-non-owner', async () => {
    const unknownBodies: ErrorBody[] = [];
    for (const path of [
      '/videos/aaaaaaaaaaaa',
      '/videos/aaaaaaaaaaaa/stream',
      '/videos/aaaaaaaaaaaa/download',
    ]) {
      unknownBodies.push((await get(path)).body as ErrorBody);
    }

    for (const status of [
      VideoStatus.PROCESSING,
      VideoStatus.DRAFT,
      VideoStatus.FAILED,
    ]) {
      const video = await seedVideo(status);
      const paths = [
        `/videos/${video.public_id}`,
        `/videos/${video.public_id}/stream`,
        `/videos/${video.public_id}/download`,
      ];

      for (const [index, path] of paths.entries()) {
        for (const token of [undefined, strangerToken]) {
          const res = await get(path, token);
          expect(res.status).toBe(404);
          expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
          // Indistinguishable from a public id that never existed.
          expect(res.body).toEqual(unknownBodies[index]);
        }
      }
    }
  }, 120000);
});
