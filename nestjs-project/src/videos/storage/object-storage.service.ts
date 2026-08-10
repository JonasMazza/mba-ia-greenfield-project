import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';

export interface CompletedPart {
  PartNumber: number;
  ETag: string;
}

export interface PresignGetOptions {
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
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // The SDK defaults to WHEN_SUPPORTED, which injects `x-amz-checksum-*`
      // into the signature. A browser PUT-ing a presigned part URL never sends
      // those headers, so the request fails with SignatureDoesNotMatch.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
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
  ): Promise<string> {
    return getSignedUrl(
      this.client,
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
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.rawBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.rawBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Part numbers already uploaded — lets a resumed upload re-presign only what is missing. */
  async listUploadedParts(key: string, uploadId: string): Promise<number[]> {
    const response = await this.client.send(
      new ListPartsCommand({
        Bucket: this.rawBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    return (response.Parts ?? [])
      .map((part) => part.PartNumber)
      .filter((partNumber): partNumber is number => partNumber !== undefined);
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
    options: PresignGetOptions = {},
  ): Promise<string> {
    const { expiresIn, downloadFilename } = options;

    return getSignedUrl(
      this.client,
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
