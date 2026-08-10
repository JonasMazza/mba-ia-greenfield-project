import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { QueueService } from '../videos/queue/queue.service';
import { ObjectStorageService } from '../videos/storage/object-storage.service';
import { VIDEO_QUEUES } from '../videos/videos.constants';
import type { VideoProcessPayload } from '../videos/videos.service';
import {
  extractThumbnail,
  probeVideo,
  thumbnailSeekSeconds,
} from './ffmpeg.util';

/** Long enough for ffmpeg to finish reading a large source through one URL. */
const SOURCE_URL_TTL_SECONDS = 3600;
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoProcessorService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly objectStorage: ObjectStorageService,
    private readonly queueService: QueueService,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queueService.work<VideoProcessPayload>(
      VIDEO_QUEUES.PROCESS,
      (payload) => this.process(payload.videoId),
    );
    this.logger.log(`Consuming "${VIDEO_QUEUES.PROCESS}"`);
  }

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video) {
      this.logger.warn(`Job for unknown video ${videoId} — dropping`);
      return;
    }
    // At-least-once delivery: a redelivered job for a finished video is a no-op
    // rather than a second thumbnail.
    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} is already ready — skipping`);
      return;
    }
    if (!video.storage_key) {
      await this.markFailed(video, 'Video has no storage key');
      return;
    }

    try {
      await this.extractAndPersist(video, video.storage_key);
    } catch (error) {
      await this.handleFailure(video, error);
    }
  }

  private async extractAndPersist(
    video: Video,
    storageKey: string,
  ): Promise<void> {
    const sourceUrl = await this.objectStorage.presignGetObject(
      this.objectStorage.rawBucket,
      storageKey,
      { expiresIn: SOURCE_URL_TTL_SECONDS },
    );

    const metadata = await probeVideo(sourceUrl);
    const thumbnailPath = join(tmpdir(), `thumb-${video.id}.jpg`);

    try {
      await extractThumbnail(
        sourceUrl,
        thumbnailPath,
        thumbnailSeekSeconds(metadata.duration_seconds),
      );
      const thumbnailKey = this.objectStorage.buildThumbnailKey(video.id);
      await this.objectStorage.putObject(
        this.objectStorage.processedBucket,
        thumbnailKey,
        await readFile(thumbnailPath),
        THUMBNAIL_CONTENT_TYPE,
      );

      await this.videoRepository.update(
        { id: video.id },
        {
          ...metadata,
          thumbnail_key: thumbnailKey,
          status: VideoStatus.READY,
          failure_reason: null,
        },
      );
      this.logger.log(`Video ${video.id} is ready`);
    } finally {
      await rm(thumbnailPath, { force: true });
    }
  }

  /**
   * Bounded retry-then-fail (TD-09): transient errors are rethrown so the queue
   * retries with backoff; once the budget is spent the video terminally fails
   * and the error is swallowed so the job is not retried forever.
   */
  private async handleFailure(video: Video, error: unknown): Promise<void> {
    const attempts = video.processing_attempts + 1;
    const reason = error instanceof Error ? error.message : String(error);

    if (attempts >= this.config.retryLimit) {
      await this.markFailed(video, reason, attempts);
      this.logger.error(
        `Video ${video.id} failed after ${attempts} attempts: ${reason}`,
      );
      return;
    }

    await this.videoRepository.update(
      { id: video.id },
      { processing_attempts: attempts },
    );
    this.logger.warn(
      `Video ${video.id} attempt ${attempts} failed: ${reason} — will retry`,
    );
    throw error;
  }

  private async markFailed(
    video: Video,
    reason: string,
    attempts = video.processing_attempts + 1,
  ): Promise<void> {
    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.FAILED,
        failure_reason: reason.slice(0, 512),
        processing_attempts: attempts,
      },
    );
  }
}
