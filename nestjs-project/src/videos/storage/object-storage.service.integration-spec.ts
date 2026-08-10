import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../../config/storage.config';
import { ObjectStorageService } from './object-storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

describe('ObjectStorageService (integration)', () => {
  let service: ObjectStorageService;
  let rawClient: S3Client;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [ObjectStorageService],
    }).compile();

    service = module.get(ObjectStorageService);

    const config = storageConfig();
    rawClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await rawClient
        .send(new DeleteObjectCommand({ Bucket: service.rawBucket, Key: key }))
        .catch(() => undefined);
    }
    rawClient.destroy();
  });

  function newKey(): string {
    const key = service.buildSourceKey(randomUUID());
    createdKeys.push(key);
    return key;
  }

  /** Uploads one part through its presigned URL and returns the ETag MinIO issued. */
  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const url = await service.presignUploadPart(key, uploadId, partNumber);
    const response = await fetch(url, {
      method: 'PUT',
      body: new Blob([body]),
    });

    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  }

  it('should build keys from the video id, never from a filename', () => {
    expect(service.buildSourceKey('abc')).toBe('videos/abc/source');
    expect(service.buildThumbnailKey('abc')).toBe(
      'videos/abc/thumbnails/auto.jpg',
    );
  });

  it('should return a non-empty UploadId when starting a multipart upload', async () => {
    const key = newKey();

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('should complete the full multipart cycle: create → presign part → PUT → complete', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(7);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag },
    ]);

    const url = await service.presignGetObject(service.rawBucket, key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(FIVE_MIB);
  }, 60000);

  it('should list the parts already uploaded so a resumed upload can skip them', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(1);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await uploadPart(key, uploadId, 1, payload);

    await expect(service.listUploadedParts(key, uploadId)).resolves.toEqual([
      1,
    ]);
    await service.abortMultipartUpload(key, uploadId);
  }, 60000);

  it('should presign a GET URL that MinIO serves with Range (partial read)', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(3);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag },
    ]);

    const url = await service.presignGetObject(service.rawBucket, key);
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-99/${FIVE_MIB}`,
    );
    expect(body).toHaveLength(100);
  }, 60000);

  it('should presign a download URL carrying Content-Disposition: attachment', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(9);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag },
    ]);

    const url = await service.presignGetObject(service.rawBucket, key, {
      downloadFilename: 'Vídeo de férias.mp4',
    });
    // The signature covers the HTTP method, so the URL must be used with GET.
    // A 1-byte Range keeps the assertion cheap while still returning the header.
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    await response.arrayBuffer();

    expect(response.status).toBe(206);
    const disposition = response.headers.get('content-disposition');
    expect(disposition).toContain('attachment');
    // Non-ASCII survives via the RFC 5987 form without breaking the signature.
    expect(disposition).toContain("filename*=UTF-8''");
  }, 60000);

  it('should invalidate the UploadId on abort, making a later complete fail', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(5);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.abortMultipartUpload(key, uploadId);

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { PartNumber: 1, ETag: etag },
      ]),
    ).rejects.toThrow();
  }, 60000);
});
