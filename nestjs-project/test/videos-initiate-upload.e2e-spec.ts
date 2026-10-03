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
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { ObjectStorageService } from '../src/videos/storage/object-storage.service';

interface InitiateUploadBody {
  public_id: string;
  upload_id: string;
  part_size_bytes: number;
  part_count: number;
  expires_in: number;
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

const TEN_GIB = 10737418240;

describe('videos-initiate-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let objectStorage: ObjectStorageService;
  let accessToken: string;
  let channelId: string;

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
    accessToken = await registerConfirmAndLogin('uploader@example.com');
    channelId = (
      await dataSource.getRepository(Channel).findOneByOrFail({
        nickname: 'uploader',
      })
    ).id;
  }, 60000);

  afterAll(async () => {
    await releaseOpenUploads();
    await app.close();
  }, 60000);

  beforeEach(async () => {
    await releaseOpenUploads();
    await dataSource.query('DELETE FROM "videos"');
    throttlerStorage.storage.clear();
  });

  /** Leaves no dangling multipart upload behind in MinIO between tests. */
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

  /** Intercepts the confirmation mail to read the token instead of parsing an inbox. */
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

  function post(body: object) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function countVideos(): Promise<number> {
    return dataSource.getRepository(Video).count();
  }

  // 1. Abertura do upload multipart

  it('initiates-multipart-upload-and-creates-draft', async () => {
    const res = await post(VALID_BODY);
    const body = res.body as InitiateUploadBody;

    expect(res.status).toBe(201);
    expect(Object.keys(body).sort()).toEqual([
      'expires_in',
      'part_count',
      'part_size_bytes',
      'public_id',
      'upload_id',
    ]);
    expect(body.public_id).toHaveLength(12);
    expect(body.public_id).toMatch(/^[0-9a-zA-Z]{12}$/);
    expect(body.upload_id.length).toBeGreaterThan(0);
    expect(body.part_size_bytes).toBeGreaterThanOrEqual(5242880);
    expect(body.part_count).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(body.expires_in)).toBe(true);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('storage_key');
    expect(body).not.toHaveProperty('channel_id');

    const rows = await dataSource
      .getRepository(Video)
      .findBy({ public_id: body.public_id });
    expect(rows).toHaveLength(1);
    const video = rows[0];
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.processing_attempts).toBe(0);
    expect(video.channel_id).toBe(channelId);
    expect(video.upload_id).toBeTruthy();
    expect(video.storage_key).toBeTruthy();
    expect(video.content_type).toBe('video/mp4');
    expect(video.size_bytes).toBe(52428800);
  }, 30000);

  it('honors-requested-part-size', async () => {
    const res = await post({ ...VALID_BODY, part_size_bytes: 10485760 });
    const body = res.body as InitiateUploadBody;

    expect(res.status).toBe(201);
    expect(body.part_size_bytes).toBe(10485760);
    expect(body.part_count).toBe(5);
  }, 30000);

  it('issues-distinct-public-ids-across-uploads', async () => {
    const first = await post(VALID_BODY);
    const second = await post(VALID_BODY);
    const firstBody = first.body as InitiateUploadBody;
    const secondBody = second.body as InitiateUploadBody;

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(firstBody.public_id).not.toBe(secondBody.public_id);
    expect(firstBody.upload_id).not.toBe(secondBody.upload_id);

    const drafts = await dataSource
      .getRepository(Video)
      .findBy({ channel_id: channelId });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((video) => video.status === VideoStatus.DRAFT)).toBe(
      true,
    );
  }, 30000);

  // 2. Validação da requisição

  it('rejects-file-above-size-ceiling', async () => {
    const tooLarge = await post({ ...VALID_BODY, size_bytes: TEN_GIB + 1 });

    expect(tooLarge.status).toBe(413);
    expect((tooLarge.body as ErrorBody).error).toBe('FILE_TOO_LARGE');
    await expect(countVideos()).resolves.toBe(0);

    const atCeiling = await post({ ...VALID_BODY, size_bytes: TEN_GIB });
    expect(atCeiling.status).toBe(201);
  }, 30000);

  it('rejects-non-video-content-type', async () => {
    const res = await post({ ...VALID_BODY, content_type: 'application/pdf' });

    expect(res.status).toBe(415);
    expect((res.body as ErrorBody).error).toBe('UNSUPPORTED_MEDIA_TYPE');
    await expect(countVideos()).resolves.toBe(0);
  }, 30000);

  it('rejects-malformed-body', async () => {
    const empty = await post({});
    expect(empty.status).toBe(400);
    const message = JSON.stringify(empty.body);
    expect(message).toContain('filename');
    expect(message).toContain('content_type');
    expect(message).toContain('size_bytes');

    const zeroSize = await post({ ...VALID_BODY, size_bytes: 0 });
    expect(zeroSize.status).toBe(400);

    const tinyPart = await post({ ...VALID_BODY, part_size_bytes: 1048576 });
    expect(tinyPart.status).toBe(400);

    await expect(countVideos()).resolves.toBe(0);
  }, 30000);

  // 3. Autenticação

  it('rejects-anonymous-request', async () => {
    const anonymous = await request(app.getHttpServer())
      .post('/videos')
      .send(VALID_BODY);

    expect(anonymous.status).toBe(401);
    await expect(countVideos()).resolves.toBe(0);

    const badToken = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', 'Bearer not-a-real-token')
      .send(VALID_BODY);

    expect(badToken.status).toBe(401);
    await expect(countVideos()).resolves.toBe(0);
  }, 30000);
});
