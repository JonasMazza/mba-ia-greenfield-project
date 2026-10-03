import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { LIST_PARTS_PAGE_SIZE } from '../videos.constants';

export interface CompletedPart {
  PartNumber: number;
  ETag: string;
}

/** A part the storage already holds — what a resumed upload needs to skip it and to complete later. */
export interface UploadedPart {
  part_number: number;
  etag: string;
  size: number;
}

/**
 * The storage no longer knows the multipart upload: it was completed, aborted,
 * or dropped by the storage's own cleanup of stale uploads. Raised in place of
 * the SDK's `NoSuchUpload` so callers never depend on the AWS SDK.
 */
export class MultipartUploadNotFoundError extends Error {
  constructor(uploadId: string) {
    super(`Multipart upload "${uploadId}" does not exist in the storage`);
    this.name = 'MultipartUploadNotFoundError';
  }
}

/** S3 and MinIO both answer with this code; only some operations model it as a class. */
function isNoSuchUpload(error: unknown): boolean {
  return error instanceof Error && error.name === 'NoSuchUpload';
}

/** HeadObject has no body, so a missing key surfaces as a bare 404. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'NotFound' ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404)
  );
}

/**
 * Who will open a presigned URL. The two audiences reach the storage through
 * different hosts, and SigV4 signs the host, so the audience must be chosen at
 * signing time — it is a required argument, never a default.
 *
 * - `browser`: the user's browser (upload parts, playback, download, thumbnails).
 * - `server`: a process inside the Compose network (the FFmpeg worker).
 */
export type PresignAudience = 'browser' | 'server';

export interface PresignGetOptions {
  audience: PresignAudience;
  expiresIn?: number;
  /** When set, MinIO returns `Content-Disposition: attachment` so the browser saves the file. */
  downloadFilename?: string;
}

/**
 * Wraps the S3 client so the rest of the app never touches the AWS SDK.
 * The API only ever *signs* URLs and orchestrates the multipart handshake —
 * video bytes always travel browser ⇄ MinIO directly.
 */
@Injectable()
export class ObjectStorageService implements OnModuleDestroy {
  /** Talks to the storage from inside the Compose network — every real request goes through it. */
  private readonly client: S3Client;
  /**
   * Never sends a request: it exists only so `getSignedUrl` (a local HMAC
   * computation) produces URLs whose signed `host` is the one the browser
   * will actually use.
   */
  private readonly publicSigningClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.createClient(config.endpoint);
    this.publicSigningClient = this.createClient(config.publicEndpoint);
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      // The SDK defaults to WHEN_SUPPORTED, which injects `x-amz-checksum-*`
      // into the signature. A browser PUT-ing a presigned part URL never sends
      // those headers, so the request fails with SignatureDoesNotMatch.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private signingClientFor(audience: PresignAudience): S3Client {
    return audience === 'browser' ? this.publicSigningClient : this.client;
  }

  onModuleDestroy(): void {
    this.client.destroy();
    this.publicSigningClient.destroy();
  }

  get rawBucket(): string {
    return this.config.rawBucket;
  }

  get processedBucket(): string {
    return this.config.processedBucket;
  }

  get uploadUrlTtlSeconds(): number {
    return this.config.uploadUrlTtlSeconds;
  }

  get playbackUrlTtlSeconds(): number {
    return this.config.playbackUrlTtlSeconds;
  }

  /** Keys are derived from the internal video UUID, never from the user's filename. */
  buildSourceKey(videoId: string): string {
    return `videos/${videoId}/source`;
  }

  buildThumbnailKey(videoId: string): string {
    return `videos/${videoId}/thumbnails/auto.jpg`;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.rawBucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`MinIO did not return an UploadId for key "${key}"`);
    }
    return response.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    audience: PresignAudience,
  ): Promise<string> {
    return getSignedUrl(
      this.signingClientFor(audience),
      new UploadPartCommand({
        Bucket: this.rawBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.uploadUrlTtlSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.forUpload(uploadId, () =>
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.rawBucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber),
          },
        }),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.forUpload(uploadId, () =>
      this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.rawBucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
  }

  /** Runs a request that targets an open multipart upload, translating `NoSuchUpload`. */
  private async forUpload<T>(
    uploadId: string,
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new MultipartUploadNotFoundError(uploadId);
      }
      throw error;
    }
  }

  /**
   * Parts already uploaded, with the ETags only the storage knows — lets a
   * resumed upload re-presign only what is missing and complete without the
   * browser ever having persisted anything.
   */
  async listUploadedParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;

    // A 10 GiB upload at the 5 MiB floor has 2048 parts — more than one page.
    do {
      const response = await this.forUpload(uploadId, () =>
        this.client.send(
          new ListPartsCommand({
            Bucket: this.rawBucket,
            Key: key,
            UploadId: uploadId,
            MaxParts: LIST_PARTS_PAGE_SIZE,
            PartNumberMarker: marker,
          }),
        ),
      );
      for (const part of response.Parts ?? []) {
        if (part.PartNumber !== undefined && part.ETag !== undefined) {
          parts.push({
            part_number: part.PartNumber,
            etag: part.ETag,
            size: part.Size ?? 0,
          });
        }
      }
      marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    } while (marker !== undefined);

    return parts.sort((a, b) => a.part_number - b.part_number);
  }

  /** Size of a stored object, or `null` when the key does not exist. */
  async getObjectSize(bucket: string, key: string): Promise<number | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return response.ContentLength ?? 0;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Idempotent: deleting a key that does not exist succeeds. */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  /** Small worker output (thumbnails) — video bytes never travel through the app. */
  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    bucket: string,
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    const { audience, expiresIn, downloadFilename } = options;

    return getSignedUrl(
      this.signingClientFor(audience),
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        // The override must be part of the signature; a non-ASCII filename that
        // is not encoded triggers SignatureDoesNotMatch on MinIO.
        ...(downloadFilename && {
          ResponseContentDisposition:
            buildAttachmentDisposition(downloadFilename),
        }),
      }),
      { expiresIn: expiresIn ?? this.config.playbackUrlTtlSeconds },
    );
  }
}

/**
 * RFC 5987: an ASCII-only fallback plus a percent-encoded UTF-8 variant, so
 * accented titles survive without breaking the signature.
 */
export function buildAttachmentDisposition(filename: string): string {
  const asciiFallback =
    filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'video';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
