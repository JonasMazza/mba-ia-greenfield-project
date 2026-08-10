import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { QueueService } from './queue/queue.service';
import { ObjectStorageService } from './storage/object-storage.service';
import { generatePublicId } from './utils/public-id';
import {
  DEFAULT_PART_SIZE_BYTES,
  MAX_UPLOAD_SIZE_BYTES,
  VIDEO_QUEUES,
} from './videos.constants';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_RETRIES = 5;

export interface InitiateUploadResult {
  public_id: string;
  upload_id: string;
  part_size_bytes: number;
  part_count: number;
  expires_in: number;
}

export interface PresignedPart {
  part_number: number;
  url: string;
}

export interface PresignPartsResult {
  parts: PresignedPart[];
  expires_in: number;
}

export interface CompleteUploadResult {
  public_id: string;
  status: VideoStatus;
}

export interface VideoProcessPayload {
  videoId: string;
}

export interface PublicVideoResult {
  public_id: string;
  title: string | null;
  status: VideoStatus;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  thumbnail_url: string | null;
  created_at: string;
}

export interface PresignedUrlResult {
  url: string;
  expires_in: number;
}

/** Projection of the processing lifecycle: fields appear only when meaningful. */
export interface VideoStatusResult {
  public_id: string;
  status: VideoStatus;
  duration_seconds?: number;
  width?: number;
  height?: number;
  thumbnail_url?: string;
  failure_reason?: string;
}

/** The pg driver hangs `code`/`detail` off the error; TypeORM copies them onto QueryFailedError. */
interface PostgresError {
  code?: string;
  detail?: string;
}

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const pgError = error as unknown as PostgresError;
  return (
    pgError.code === PG_UNIQUE_VIOLATION &&
    (pgError.detail?.includes('public_id') ?? false)
  );
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
};

/**
 * The original file name is not persisted (the Data Model has no such column),
 * so the download name is the title when the owner has set one, falling back to
 * the public id. The extension comes from the declared content type.
 */
function buildDownloadFilename(video: Video): string {
  const base = video.title?.trim() || video.public_id;
  if (/\.[a-z0-9]{2,4}$/i.test(base)) {
    return base;
  }
  const extension = video.content_type
    ? (CONTENT_TYPE_EXTENSIONS[video.content_type] ?? '')
    : '';
  return `${base}${extension}`;
}

/** The multipart handshake only exists while the video is a draft. */
function requireActiveUpload(video: Video): {
  storageKey: string;
  uploadId: string;
} {
  if (
    video.status !== VideoStatus.DRAFT ||
    !video.upload_id ||
    !video.storage_key
  ) {
    throw new InvalidUploadStateException();
  }
  return { storageKey: video.storage_key, uploadId: video.upload_id };
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly objectStorage: ObjectStorageService,
    private readonly queueService: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (!dto.content_type.startsWith('video/')) {
      throw new UnsupportedMediaTypeException(dto.content_type);
    }
    if (dto.size_bytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new FileTooLargeException(MAX_UPLOAD_SIZE_BYTES);
    }

    const channel = await this.channelsService.getByUserId(userId);

    // The id is minted here so the storage key is known before the row exists;
    // that keeps the insert to a single write and leaves no half-built draft.
    const videoId = randomUUID();
    const storageKey = this.objectStorage.buildSourceKey(videoId);
    const partSizeBytes = dto.part_size_bytes ?? DEFAULT_PART_SIZE_BYTES;
    const partCount = Math.ceil(dto.size_bytes / partSizeBytes);

    const uploadId = await this.objectStorage.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertDraft({
        id: videoId,
        channel_id: channel.id,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (error) {
      // Nothing references the multipart upload now — release it rather than
      // leaving an invisible, billable upload behind.
      await this.objectStorage
        .abortMultipartUpload(storageKey, uploadId)
        .catch((abortError: unknown) => {
          this.logger.error(
            `Failed to abort orphaned multipart upload for key ${storageKey}`,
            abortError,
          );
        });
      throw error;
    }

    return {
      public_id: video.public_id,
      upload_id: uploadId,
      part_size_bytes: partSizeBytes,
      part_count: partCount,
      expires_in: this.objectStorage.uploadUrlTtlSeconds,
    };
  }

  /** (Re)issues presigned part URLs — the resume path asks only for what is missing. */
  async presignParts(
    userId: string,
    publicId: string,
    dto: PresignPartsDto,
  ): Promise<PresignPartsResult> {
    const video = await this.getOwnedVideo(userId, publicId);
    const { storageKey, uploadId } = requireActiveUpload(video);

    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.objectStorage.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
        ),
      })),
    );

    return { parts, expires_in: this.objectStorage.uploadUrlTtlSeconds };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.getOwnedVideo(userId, publicId);
    const { storageKey, uploadId } = requireActiveUpload(video);

    await this.objectStorage.completeMultipartUpload(
      storageKey,
      uploadId,
      dto.parts.map((part) => ({
        PartNumber: part.part_number,
        ETag: part.etag,
      })),
    );

    // Status transition and job creation share a transaction: either the video
    // is processing and the job exists, or neither happened.
    await this.dataSource.transaction(async (manager) => {
      const update = await manager.update(
        Video,
        { id: video.id, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );

      // A concurrent complete won the race — this one has nothing left to do.
      if (update.affected === 0) {
        throw new InvalidUploadStateException();
      }

      await this.queueService.enqueue<VideoProcessPayload>(
        VIDEO_QUEUES.PROCESS,
        { videoId: video.id },
        { singletonKey: video.id, manager },
      );
    });

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.getOwnedVideo(userId, publicId);
    const { storageKey, uploadId } = requireActiveUpload(video);

    await this.objectStorage.abortMultipartUpload(storageKey, uploadId);
    await this.videoRepository.delete({ id: video.id });
  }

  /** Owner-only polling of the `draft → processing → ready | failed` lifecycle. */
  async getStatus(
    userId: string,
    publicId: string,
  ): Promise<VideoStatusResult> {
    const video = await this.getOwnedVideo(userId, publicId);
    const result: VideoStatusResult = {
      public_id: video.public_id,
      status: video.status,
    };

    if (video.status === VideoStatus.READY) {
      if (video.duration_seconds !== null) {
        result.duration_seconds = video.duration_seconds;
      }
      if (video.width !== null) {
        result.width = video.width;
      }
      if (video.height !== null) {
        result.height = video.height;
      }
      if (video.thumbnail_key) {
        result.thumbnail_url = await this.objectStorage.presignGetObject(
          this.objectStorage.processedBucket,
          video.thumbnail_key,
        );
      }
    }

    if (video.status === VideoStatus.FAILED && video.failure_reason) {
      result.failure_reason = video.failure_reason;
    }

    return result;
  }

  /** Public metadata behind the `/watch/:publicId` page. */
  async getPublicVideo(
    publicId: string,
    userId?: string,
  ): Promise<PublicVideoResult> {
    const video = await this.resolveVisibleVideo(publicId, userId);

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnail_url: video.thumbnail_key
        ? await this.objectStorage.presignGetObject(
            this.objectStorage.processedBucket,
            video.thumbnail_key,
          )
        : null,
      created_at: video.created_at.toISOString(),
    };
  }

  /** Range-capable URL: MinIO serves the bytes, the API never proxies them. */
  async getStreamUrl(
    publicId: string,
    userId?: string,
  ): Promise<PresignedUrlResult> {
    const video = await this.requirePlayableVideo(publicId, userId);

    return {
      url: await this.objectStorage.presignGetObject(
        this.objectStorage.rawBucket,
        video.storage_key as string,
      ),
      expires_in: this.objectStorage.playbackUrlTtlSeconds,
    };
  }

  /** Same mechanism as streaming, plus the attachment disposition (TD-08). */
  async getDownloadUrl(
    publicId: string,
    userId?: string,
  ): Promise<PresignedUrlResult> {
    const video = await this.requirePlayableVideo(publicId, userId);

    return {
      url: await this.objectStorage.presignGetObject(
        this.objectStorage.rawBucket,
        video.storage_key as string,
        { downloadFilename: buildDownloadFilename(video) },
      ),
      expires_in: this.objectStorage.playbackUrlTtlSeconds,
    };
  }

  /**
   * A non-`ready` video exists only for its owner. Everyone else gets a plain
   * 404 so the response cannot be used to probe whether a `public_id` is taken.
   */
  private async resolveVisibleVideo(
    publicId: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status === VideoStatus.READY) {
      return video;
    }
    if (!(await this.isOwner(video, userId))) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Adds the playback gate on top of visibility: the owner gets a 409, not a 404. */
  private async requirePlayableVideo(
    publicId: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.resolveVisibleVideo(publicId, userId);

    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async isOwner(video: Video, userId?: string): Promise<boolean> {
    if (!userId) return false;
    const channel = await this.channelsService.findByUserId(userId);
    return channel?.id === video.channel_id;
  }

  /**
   * Ownership is part of the lookup, so a video owned by someone else is
   * indistinguishable from one that does not exist.
   */
  private async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.getByUserId(userId);
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Retries only on a `public_id` collision — any other failure propagates. */
  private async insertDraft(
    data: Omit<Partial<Video>, 'public_id' | 'status'>,
  ): Promise<Video> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        if (!isPublicIdCollision(error)) {
          throw error;
        }
        this.logger.warn('public_id collision — retrying with a new id');
      }
    }

    throw new Error(
      `Could not generate a unique public_id after ${PUBLIC_ID_MAX_RETRIES} attempts`,
    );
  }
}
