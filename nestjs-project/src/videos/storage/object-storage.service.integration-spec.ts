import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../../config/storage.config';
import {
  MultipartUploadNotFoundError,
  ObjectStorageService,
} from './object-storage.service';

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
    const url = await service.presignUploadPart(
      key,
      uploadId,
      partNumber,
      'server',
    );
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

    const url = await service.presignGetObject(service.rawBucket, key, {
      audience: 'server',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(FIVE_MIB);
  }, 60000);

  it('should list the parts already uploaded so a resumed upload can skip them', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(1);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await expect(service.listUploadedParts(key, uploadId)).resolves.toEqual([]);
    const etag = await uploadPart(key, uploadId, 1, payload);

    await expect(service.listUploadedParts(key, uploadId)).resolves.toEqual([
      { part_number: 1, etag, size: FIVE_MIB },
    ]);
    await service.abortMultipartUpload(key, uploadId);
  }, 60000);

  it('should list every uploaded part even past the 1000-part page of ListParts', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    // A 10 GiB upload at the 5 MiB floor has 2048 parts; ListParts pages at
    // 1000. Parts below 5 MiB are accepted until complete, so 1 byte is enough.
    const partCount = 1001;
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const batchSize = 50;
    for (let start = 0; start < partCount; start += batchSize) {
      await Promise.all(
        partNumbers
          .slice(start, start + batchSize)
          .map((partNumber) =>
            uploadPart(key, uploadId, partNumber, new Uint8Array(1).fill(1)),
          ),
      );
    }

    const parts = await service.listUploadedParts(key, uploadId);

    expect(parts).toHaveLength(partCount);
    expect(parts.map((part) => part.part_number)).toEqual(partNumbers);
    await service.abortMultipartUpload(key, uploadId);
  }, 120000);

  it('should presign a GET URL that MinIO serves with Range (partial read)', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(3);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag },
    ]);

    const url = await service.presignGetObject(service.rawBucket, key, {
      audience: 'server',
    });
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
      audience: 'server',
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

  describe('presign audiences', () => {
    const PUBLIC_ENDPOINT = 'http://public.storage.test:9000';

    /** Plain instantiation: the audience split is pure signing, no DI needed. */
    function serviceWithPublicEndpoint(): ObjectStorageService {
      return new ObjectStorageService({
        ...storageConfig(),
        publicEndpoint: PUBLIC_ENDPOINT,
      });
    }

    it('should sign browser-audience URLs for the public endpoint and server-audience URLs for the internal one', async () => {
      const split = serviceWithPublicEndpoint();
      const key = split.buildSourceKey(randomUUID());
      const internalHost = new URL(storageConfig().endpoint).host;

      const browserPart = await split.presignUploadPart(key, 'u', 1, 'browser');
      const serverPart = await split.presignUploadPart(key, 'u', 1, 'server');
      const browserGet = await split.presignGetObject(split.rawBucket, key, {
        audience: 'browser',
      });
      const serverGet = await split.presignGetObject(split.rawBucket, key, {
        audience: 'server',
      });

      expect(new URL(browserPart).host).toBe('public.storage.test:9000');
      expect(new URL(browserGet).host).toBe('public.storage.test:9000');
      expect(new URL(serverPart).host).toBe(internalHost);
      expect(new URL(serverGet).host).toBe(internalHost);
      for (const url of [browserPart, serverPart, browserGet, serverGet]) {
        expect(url).toContain('X-Amz-Signature=');
        expect(url).toContain('X-Amz-SignedHeaders=host');
      }
      // Same object, different signed host → different signature (SigV4 covers `host`).
      expect(new URL(browserGet).searchParams.get('X-Amz-Signature')).not.toBe(
        new URL(serverGet).searchParams.get('X-Amz-Signature'),
      );
      split.onModuleDestroy();
    });

    it('should keep the server-audience URL usable against the real storage while the browser one targets a host it never contacts', async () => {
      const split = serviceWithPublicEndpoint();
      const key = newKey();
      const payload = new Uint8Array(FIVE_MIB).fill(4);

      const uploadId = await split.createMultipartUpload(key, 'video/mp4');
      const serverUrl = await split.presignUploadPart(
        key,
        uploadId,
        1,
        'server',
      );
      const response = await fetch(serverUrl, {
        method: 'PUT',
        body: new Blob([payload]),
      });
      expect(response.status).toBe(200);

      const browserUrl = await split.presignUploadPart(
        key,
        uploadId,
        1,
        'browser',
      );
      expect(new URL(browserUrl).host).toBe('public.storage.test:9000');

      await split.abortMultipartUpload(key, uploadId);
      split.onModuleDestroy();
    }, 60000);
  });

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
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
    await expect(
      service.listUploadedParts(key, uploadId),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
  }, 60000);

  it('should report the size of a stored object, null once it is deleted', async () => {
    const key = newKey();
    const payload = new Uint8Array(FIVE_MIB).fill(6);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(key, uploadId, 1, payload);
    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag },
    ]);

    await expect(service.getObjectSize(service.rawBucket, key)).resolves.toBe(
      FIVE_MIB,
    );

    await service.deleteObject(service.rawBucket, key);

    await expect(
      service.getObjectSize(service.rawBucket, key),
    ).resolves.toBeNull();
    // Deleting a missing key is not an error.
    await expect(
      service.deleteObject(service.rawBucket, key),
    ).resolves.toBeUndefined();
  }, 60000);
});
