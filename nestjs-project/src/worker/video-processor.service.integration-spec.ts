import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { QueueService } from '../videos/queue/queue.service';
import { ObjectStorageService } from '../videos/storage/object-storage.service';
import { generatePublicId } from '../videos/utils/public-id';
import { VideoProcessorService } from './video-processor.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

/** Synthesizes a tiny real MP4 so the suite carries no binary fixture. */
async function buildSampleVideo(path: string): Promise<Uint8Array> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    path,
  ]);
  return readFile(path);
}

describe('VideoProcessorService (integration)', () => {
  let processor: VideoProcessorService;
  let objectStorage: ObjectStorageService;
  let queueService: QueueService;
  let channelsService: ChannelsService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let sampleVideo: Uint8Array;
  let channelId: string;
  const uploadedKeys: { bucket: string; key: string }[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
          autoLoadEntities: true,
        }),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
      ],
      providers: [VideoProcessorService, ObjectStorageService, QueueService],
    }).compile();

    processor = module.get(VideoProcessorService);
    objectStorage = module.get(ObjectStorageService);
    queueService = module.get(QueueService);
    channelsService = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = module.get(getRepositoryToken(Video));

    const samplePath = join(tmpdir(), 'video-processor-sample.mp4');
    sampleVideo = await buildSampleVideo(samplePath);
    await rm(samplePath, { force: true });
  }, 120000);

  afterAll(async () => {
    await queueService.stop();
    await dataSource.destroy();
  }, 60000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const suffix = uploadedKeys.length + 1;
    const email = `worker_user_${suffix}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    channelId = (await channelsService.createChannel(user.id, email)).id;
  });

  /** Creates a `processing` video whose source object really exists in storage. */
  async function createProcessingVideo(
    body: Uint8Array = sampleVideo,
  ): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
        content_type: 'video/mp4',
        size_bytes: body.byteLength,
      }),
    );

    const key = objectStorage.buildSourceKey(video.id);
    await objectStorage.putObject(
      objectStorage.rawBucket,
      key,
      body,
      'video/mp4',
    );
    uploadedKeys.push({ bucket: objectStorage.rawBucket, key });

    await videoRepository.update({ id: video.id }, { storage_key: key });
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  it('should extract metadata, store a thumbnail and mark the video ready', async () => {
    const video = await createProcessingVideo();

    await processor.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBe(2);
    expect(processed.width).toBe(320);
    expect(processed.height).toBe(240);
    expect(processed.codec).toBe('h264');
    expect(processed.bitrate).toBeGreaterThan(0);
    expect(processed.thumbnail_key).toBe(
      objectStorage.buildThumbnailKey(video.id),
    );
    expect(processed.failure_reason).toBeNull();

    // The thumbnail is really in the processed bucket, not just referenced.
    const url = await objectStorage.presignGetObject(
      objectStorage.processedBucket,
      processed.thumbnail_key as string,
      { audience: 'server' },
    );
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
  }, 120000);

  it('should be a no-op when the same job is redelivered for a ready video', async () => {
    const video = await createProcessingVideo();
    await processor.process(video.id);
    const firstPass = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(video.id);

    const secondPass = await videoRepository.findOneByOrFail({ id: video.id });
    expect(secondPass.status).toBe(VideoStatus.READY);
    expect(secondPass.updated_at.getTime()).toBe(
      firstPass.updated_at.getTime(),
    );
    expect(secondPass.processing_attempts).toBe(0);
  }, 120000);

  it('should retry a broken input and mark it failed once the budget is spent', async () => {
    const notAVideo = new TextEncoder().encode(
      'this is definitely not a video',
    );
    const video = await createProcessingVideo(notAVideo);

    // Attempts below the limit rethrow so the queue retries with backoff.
    await expect(processor.process(video.id)).rejects.toThrow();
    let current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.status).toBe(VideoStatus.PROCESSING);
    expect(current.processing_attempts).toBe(1);

    await expect(processor.process(video.id)).rejects.toThrow();
    current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.processing_attempts).toBe(2);

    // The last attempt is terminal: it fails the video instead of rethrowing.
    await expect(processor.process(video.id)).resolves.toBeUndefined();

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_attempts).toBe(3);
    expect(failed.failure_reason).toBeTruthy();
    expect(failed.thumbnail_key).toBeNull();
  }, 120000);

  it('should fail a video that has no source object key', async () => {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
      }),
    );

    await processor.process(video.id);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.failure_reason).toContain('storage key');
  }, 60000);

  it('should drop a job whose video no longer exists', async () => {
    await expect(
      processor.process('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  }, 30000);
});
