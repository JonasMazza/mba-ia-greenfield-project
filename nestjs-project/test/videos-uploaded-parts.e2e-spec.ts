import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

interface UploadedPartsBody {
  parts: { part_number: number; etag: string; size: number }[];
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface OpenApiDocument {
  paths: Record<
    string,
    Record<
      string,
      {
        security?: Record<string, unknown>[];
        responses: Record<
          string,
          {
            content?: Record<
              string,
              {
                schema?: {
                  properties?: Record<
                    string,
                    { items?: { properties?: Record<string, unknown> } }
                  >;
                };
              }
            >;
          }
        >;
      }
    >
  >;
}

const FIVE_MIB = 5 * 1024 * 1024;

const VALID_BODY = {
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: FIVE_MIB,
};

describe('videos-uploaded-parts', () => {
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
    ownerToken = await registerConfirmAndLogin('parts-owner-a@example.com');
    strangerToken = await registerConfirmAndLogin('parts-owner-b@example.com');
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

  /** Signs one part, PUTs 5 MiB straight to the storage and returns its ETag. */
  async function uploadPart(
    publicId: string,
    partNumber: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [partNumber] });
    expect(res.status).toBe(200);
    const { parts } = res.body as PresignPartsBody;

    const uploaded = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(FIVE_MIB).fill(partNumber)]),
    });
    expect(uploaded.status).toBe(200);
    return uploaded.headers.get('etag') as string;
  }

  function listParts(publicId: string, token?: string) {
    const req = request(app.getHttpServer()).get(
      `/videos/${publicId}/upload/parts`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function completeUpload(
    publicId: string,
    parts: { part_number: number; etag: string }[],
  ) {
    return request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts });
  }

  async function findVideo(publicId: string): Promise<Video | null> {
    return dataSource.getRepository(Video).findOneBy({ public_id: publicId });
  }

  // 1. Listagem das partes recebidas

  it('lists-uploaded-parts-with-storage-etags', async () => {
    const initiated = await initiateUpload();
    const etag = await uploadPart(initiated.public_id, 1);

    const res = await listParts(initiated.public_id, ownerToken);
    const body = res.body as UploadedPartsBody;

    expect(res.status).toBe(200);
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].part_number).toBe(1);
    expect(body.parts[0].etag).toBe(etag);
    expect(body.parts[0].size).toBe(FIVE_MIB);

    const again = await listParts(initiated.public_id, ownerToken);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(body);

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
    expect(video?.upload_id).toBe(initiated.upload_id);
  }, 60000);

  it('returns-empty-list-before-any-part', async () => {
    const initiated = await initiateUpload();

    const res = await listParts(initiated.public_id, ownerToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parts: [] });
  }, 60000);

  // 2. Estado do upload

  it('rejects-listing-after-complete', async () => {
    const initiated = await initiateUpload();
    const etag = await uploadPart(initiated.public_id, 1);
    const completed = await completeUpload(initiated.public_id, [
      { part_number: 1, etag },
    ]);
    expect(completed.status).toBe(200);

    const res = await listParts(initiated.public_id, ownerToken);

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.PROCESSING);
  }, 60000);

  // 3. Posse e autenticação

  it('hides-other-owners-upload', async () => {
    const initiated = await initiateUpload();
    await uploadPart(initiated.public_id, 1);

    const res = await listParts(initiated.public_id, strangerToken);
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await listParts('zzzzzzzzzzzz', strangerToken);
    expect(unknown.status).toBe(404);
    expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    expect(unknown.body).toEqual(res.body);
  }, 60000);

  it('rejects-anonymous-listing', async () => {
    const initiated = await initiateUpload();

    const res = await listParts(initiated.public_id);

    expect(res.status).toBe(401);

    const video = await findVideo(initiated.public_id);
    expect(video?.status).toBe(VideoStatus.DRAFT);
  }, 60000);

  // 4. Contrato publicado

  it('openapi-contract-exposes-the-route', () => {
    const document = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
    ) as OpenApiDocument;
    const path = document.paths['/videos/{publicId}/upload/parts'];

    expect(path).toBeDefined();
    expect(path.post).toBeDefined();
    expect(path.get).toBeDefined();
    expect(path.get.security).toEqual(
      expect.arrayContaining([expect.objectContaining({ 'access-token': [] })]),
    );
    expect(Object.keys(path.get.responses)).toEqual(
      expect.arrayContaining(['200', '401', '404', '409']),
    );

    const schema =
      path.get.responses['200'].content?.['application/json'].schema;
    const itemProperties = schema?.properties?.parts.items?.properties ?? {};
    expect(Object.keys(itemProperties)).toEqual(
      expect.arrayContaining(['part_number', 'etag', 'size']),
    );
  });
});
