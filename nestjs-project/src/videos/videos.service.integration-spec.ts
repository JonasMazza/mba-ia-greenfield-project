import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
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
import { Video, VideoStatus } from './entities/video.entity';
import { QueueService } from './queue/queue.service';
import { ObjectStorageService } from './storage/object-storage.service';
import * as publicIdModule from './utils/public-id';
import { MAX_UPLOAD_SIZE_BYTES, VIDEO_QUEUES } from './videos.constants';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  UploadExpiredException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const FIVE_MIB = 5 * 1024 * 1024;

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let service: VideosService;
  let objectStorage: ObjectStorageService;
  let queueService: QueueService;
  let channelsService: ChannelsService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  const openedUploads: { key: string; uploadId: string }[] = [];

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
      providers: [VideosService, ObjectStorageService, QueueService],
    }).compile();

    service = module.get(VideosService);
    objectStorage = module.get(ObjectStorageService);
    queueService = module.get(QueueService);
    channelsService = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = module.get(getRepositoryToken(Video));

    // `compile()` does not run lifecycle hooks, so the boss is started by hand.
    await queueService.start();
    await queueService.ensureQueue(VIDEO_QUEUES.PROCESS, {
      policy: 'stately',
    });
  }, 60000);

  afterAll(async () => {
    for (const { key, uploadId } of openedUploads) {
      await objectStorage
        .abortMultipartUpload(key, uploadId)
        .catch(() => undefined);
    }
    await queueService.stop();
    await dataSource.destroy();
  }, 60000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await dataSource.query('DELETE FROM pgboss.job');
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const suffix = ++counter;
    const email = `svc_user_${suffix}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    const channel = await channelsService.createChannel(user.id, email);
    return { userId: user.id, channelId: channel.id };
  }

  const validDto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 50 * 1024 * 1024,
  };

  /** Declares exactly the single 5 MiB part `uploadOnePart` sends. */
  const onePartDto = { ...validDto, size_bytes: FIVE_MIB };

  /** Tracks the multipart upload the service opened so afterAll can release it. */
  async function trackUpload(publicId: string): Promise<void> {
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    if (video.storage_key && video.upload_id) {
      openedUploads.push({
        key: video.storage_key,
        uploadId: video.upload_id,
      });
    }
  }

  it('should persist a draft carrying public_id, upload_id and storage_key', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await service.initiateUpload(userId, validDto);
    await trackUpload(result.public_id);

    const video = await videoRepository.findOneByOrFail({
      public_id: result.public_id,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.channel_id).toBe(channelId);
    expect(video.upload_id).toBe(result.upload_id);
    expect(video.storage_key).toBe(objectStorage.buildSourceKey(video.id));
    expect(video.content_type).toBe('video/mp4');
    expect(video.size_bytes).toBe(validDto.size_bytes);
    expect(video.processing_attempts).toBe(0);
  }, 30000);

  it('should derive part_count from the requested part size', async () => {
    const { userId } = await createUserWithChannel();

    const result = await service.initiateUpload(userId, {
      ...validDto,
      part_size_bytes: 10 * 1024 * 1024,
    });
    await trackUpload(result.public_id);

    expect(result.part_size_bytes).toBe(10 * 1024 * 1024);
    expect(result.part_count).toBe(5);
  }, 30000);

  it('should retry with a fresh public_id when the first one collides', async () => {
    const { userId } = await createUserWithChannel();
    const taken = await service.initiateUpload(userId, validDto);
    await trackUpload(taken.public_id);

    // Force the next insert to reuse an id that already exists, then let the
    // retry path generate a real one.
    const spy = jest
      .spyOn(publicIdModule, 'generatePublicId')
      .mockReturnValueOnce(taken.public_id);

    const result = await service.initiateUpload(userId, validDto);
    await trackUpload(result.public_id);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.public_id).not.toBe(taken.public_id);
    await expect(videoRepository.count()).resolves.toBe(2);
  }, 30000);

  it('should reject a content type outside video/*', async () => {
    const { userId } = await createUserWithChannel();

    await expect(
      service.initiateUpload(userId, {
        ...validDto,
        content_type: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(videoRepository.count()).resolves.toBe(0);
  }, 30000);

  it('should reject a size above the 10 GiB ceiling and accept the ceiling itself', async () => {
    const { userId } = await createUserWithChannel();

    await expect(
      service.initiateUpload(userId, {
        ...validDto,
        size_bytes: MAX_UPLOAD_SIZE_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeException);
    await expect(videoRepository.count()).resolves.toBe(0);

    const result = await service.initiateUpload(userId, {
      ...validDto,
      size_bytes: MAX_UPLOAD_SIZE_BYTES,
    });
    await trackUpload(result.public_id);
    expect(result.public_id).toBeTruthy();
  }, 30000);

  // --- SI-03.5: presign de partes, complete e abort ---

  /** Runs the real upload dance so `complete` gets ETags the storage accepts. */
  async function uploadOnePart(
    userId: string,
    publicId: string,
  ): Promise<{ part_number: number; etag: string }> {
    const presigned = await service.presignParts(userId, publicId, {
      part_numbers: [1],
    });
    const response = await fetch(presigned.parts[0].url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(FIVE_MIB).fill(4)]),
    });
    expect(response.status).toBe(200);
    return { part_number: 1, etag: response.headers.get('etag') as string };
  }

  it('should presign the requested parts for a draft of the owner', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);

    const result = await service.presignParts(userId, initiated.public_id, {
      part_numbers: [1, 3],
    });

    expect(result.parts.map((part) => part.part_number)).toEqual([1, 3]);
    for (const part of result.parts) {
      expect(part.url).toMatch(/^https?:\/\//);
      expect(part.url).toContain(`partNumber=${part.part_number}`);
      expect(decodeURIComponent(part.url)).toContain(initiated.upload_id);
    }
    expect(result.expires_in).toBe(objectStorage.uploadUrlTtlSeconds);
  }, 30000);

  it('should hide a video owned by someone else behind VIDEO_NOT_FOUND', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const initiated = await service.initiateUpload(owner.userId, validDto);
    await trackUpload(initiated.public_id);

    await expect(
      service.presignParts(stranger.userId, initiated.public_id, {
        part_numbers: [1],
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  }, 30000);

  it('should list the parts the storage already holds, with their ETags, for the owner', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);

    await expect(
      service.listUploadedParts(userId, initiated.public_id),
    ).resolves.toEqual({ parts: [] });

    const part = await uploadOnePart(userId, initiated.public_id);

    await expect(
      service.listUploadedParts(userId, initiated.public_id),
    ).resolves.toEqual({
      parts: [{ part_number: 1, etag: part.etag, size: FIVE_MIB }],
    });
  }, 60000);

  it('should hide the uploaded parts of a video owned by someone else', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const initiated = await service.initiateUpload(owner.userId, validDto);
    await trackUpload(initiated.public_id);

    await expect(
      service.listUploadedParts(stranger.userId, initiated.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  }, 30000);

  it('should reject listing parts once the upload is no longer a draft', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    await expect(
      service.listUploadedParts(userId, initiated.public_id),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
  }, 60000);

  it('should move the draft to processing and enqueue the job atomically', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);

    const result = await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    expect(result).toEqual({
      public_id: initiated.public_id,
      status: VideoStatus.PROCESSING,
    });

    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    expect(video.storage_key).toBeTruthy();

    const jobs = await dataSource.query<{ data: { videoId: string } }[]>(
      `SELECT data FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: video.id });
  }, 60000);

  it('should refuse to complete when the stored parts exceed the declared size', async () => {
    const { userId } = await createUserWithChannel();
    // The ceiling is checked on the declared size, so an honest-looking
    // declaration must not let a bigger object through.
    const initiated = await service.initiateUpload(userId, {
      ...validDto,
      size_bytes: 1024 * 1024,
    });
    await trackUpload(initiated.public_id);
    const part = await uploadOnePart(userId, initiated.public_id);

    await expect(
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);

    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toBe(initiated.upload_id);
    const jobs = await dataSource.query<unknown[]>(
      `SELECT id FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(0);
  }, 60000);

  it('should refuse to complete when the stored parts fall short of the declared size', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);
    const part = await uploadOnePart(userId, initiated.public_id);

    await expect(
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);
  }, 60000);

  it('should leave no job behind when the status transition fails', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);

    jest
      .spyOn(queueService, 'enqueue')
      .mockRejectedValueOnce(new Error('queue exploded'));

    await expect(
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ).rejects.toThrow('queue exploded');

    // The transaction rolled back, so the video never left `draft`.
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    const jobs = await dataSource.query<unknown[]>(
      `SELECT id FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(0);
  }, 60000);

  // --- Storage and database out of step (NoSuchUpload) ---

  /** A `complete` whose storage step went through but whose transaction did not. */
  async function stitchWithoutCommitting(
    userId: string,
    publicId: string,
    part: { part_number: number; etag: string },
  ): Promise<void> {
    jest
      .spyOn(queueService, 'enqueue')
      .mockRejectedValueOnce(new Error('queue exploded'));
    await expect(
      service.completeUpload(userId, publicId, { parts: [part] }),
    ).rejects.toThrow('queue exploded');
  }

  it('should finish a complete whose transaction failed after the storage stitched the object', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    await stitchWithoutCommitting(userId, initiated.public_id, part);

    // The multipart upload no longer exists, but the object it produced does.
    const result = await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    const jobs = await dataSource.query<unknown[]>(
      `SELECT id FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(1);
  }, 60000);

  it('should answer the loser of two concurrent completes with INVALID_UPLOAD_STATE', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);

    const results = await Promise.allSettled([
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InvalidUploadStateException);
    const jobs = await dataSource.query<unknown[]>(
      `SELECT id FROM pgboss.job WHERE name = $1`,
      [VIDEO_QUEUES.PROCESS],
    );
    expect(jobs).toHaveLength(1);
  }, 60000);

  it('should report UPLOAD_EXPIRED when the storage dropped the upload and holds no object', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    // What the storage's own cleanup of stale multipart uploads does.
    await objectStorage.abortMultipartUpload(
      video.storage_key as string,
      initiated.upload_id,
    );

    await expect(
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ).rejects.toBeInstanceOf(UploadExpiredException);
    await expect(
      service.listUploadedParts(userId, initiated.public_id),
    ).rejects.toBeInstanceOf(UploadExpiredException);
    const draft = await videoRepository.findOneByOrFail({ id: video.id });
    expect(draft.status).toBe(VideoStatus.DRAFT);
  }, 60000);

  it('should discard a draft whose upload the storage already dropped', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    await objectStorage.abortMultipartUpload(
      video.storage_key as string,
      initiated.upload_id,
    );

    await service.abortUpload(userId, initiated.public_id);

    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
  }, 30000);

  it('should delete the stitched object when aborting a draft whose complete never committed', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    await stitchWithoutCommitting(userId, initiated.public_id, part);
    await expect(
      objectStorage.getObjectSize(
        objectStorage.rawBucket,
        video.storage_key as string,
      ),
    ).resolves.toBe(FIVE_MIB);

    await service.abortUpload(userId, initiated.public_id);

    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
    await expect(
      objectStorage.getObjectSize(
        objectStorage.rawBucket,
        video.storage_key as string,
      ),
    ).resolves.toBeNull();
  }, 60000);

  it('should reject a second complete on an upload already finalized', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    await expect(
      service.completeUpload(userId, initiated.public_id, { parts: [part] }),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
  }, 60000);

  it('should reject presigning parts once the upload is no longer a draft', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    await expect(
      service.presignParts(userId, initiated.public_id, { part_numbers: [1] }),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
  }, 60000);

  it('should discard the draft and invalidate the upload on abort', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });

    await service.abortUpload(userId, initiated.public_id);

    await expect(
      videoRepository.findOneBy({ public_id: initiated.public_id }),
    ).resolves.toBeNull();
    await expect(
      objectStorage.listUploadedParts(
        video.storage_key as string,
        initiated.upload_id,
      ),
    ).rejects.toThrow();
  }, 30000);

  it('should reject aborting a video that is no longer a draft', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, onePartDto);
    const part = await uploadOnePart(userId, initiated.public_id);
    await service.completeUpload(userId, initiated.public_id, {
      parts: [part],
    });

    await expect(
      service.abortUpload(userId, initiated.public_id),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
    await expect(
      videoRepository.countBy({ public_id: initiated.public_id }),
    ).resolves.toBe(1);
  }, 60000);

  // --- SI-03.7: projeção de status ---

  it('should report processing without leaking metadata fields', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);
    await videoRepository.update(
      { public_id: initiated.public_id },
      { status: VideoStatus.PROCESSING },
    );

    const status = await service.getStatus(userId, initiated.public_id);

    expect(status).toEqual({
      public_id: initiated.public_id,
      status: VideoStatus.PROCESSING,
    });
  }, 30000);

  it('should report ready with metadata and a presigned thumbnail url', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    await videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.READY,
        duration_seconds: 128,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate: 2500000,
        thumbnail_key: objectStorage.buildThumbnailKey(video.id),
      },
    );

    const status = await service.getStatus(userId, initiated.public_id);

    expect(status.status).toBe(VideoStatus.READY);
    expect(status.duration_seconds).toBe(128);
    expect(status.width).toBe(1920);
    expect(status.height).toBe(1080);
    expect(status.thumbnail_url).toContain('X-Amz-Signature=');
    expect(status.failure_reason).toBeUndefined();
    expect(status).not.toHaveProperty('thumbnail_key');
  }, 30000);

  it('should report failed with the persisted failure reason', async () => {
    const { userId } = await createUserWithChannel();
    const initiated = await service.initiateUpload(userId, validDto);
    await trackUpload(initiated.public_id);
    await videoRepository.update(
      { public_id: initiated.public_id },
      {
        status: VideoStatus.FAILED,
        failure_reason: 'ffprobe: invalid data found when processing input',
      },
    );

    const status = await service.getStatus(userId, initiated.public_id);

    expect(status.status).toBe(VideoStatus.FAILED);
    expect(status.failure_reason).toBe(
      'ffprobe: invalid data found when processing input',
    );
    expect(status.thumbnail_url).toBeUndefined();
  }, 30000);

  it('should hide the status of a video owned by someone else', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const initiated = await service.initiateUpload(owner.userId, validDto);
    await trackUpload(initiated.public_id);

    await expect(
      service.getStatus(stranger.userId, initiated.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  }, 30000);

  // --- SI-03.8: playback público ---

  /** A ready video whose source object really exists, so presigned URLs work. */
  async function seedReadyVideo(
    userId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const initiated = await service.initiateUpload(userId, validDto);
    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });
    await objectStorage.abortMultipartUpload(
      video.storage_key as string,
      initiated.upload_id,
    );
    await objectStorage.putObject(
      objectStorage.rawBucket,
      video.storage_key as string,
      new Uint8Array(1024).fill(2),
      'video/mp4',
    );
    await videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.READY,
        upload_id: null,
        duration_seconds: 128,
        width: 1920,
        height: 1080,
        ...overrides,
      },
    );
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  it('should expose public metadata for a ready video to anyone', async () => {
    const { userId } = await createUserWithChannel();
    const video = await seedReadyVideo(userId, { title: 'Meu clipe' });

    const anonymous = await service.getPublicVideo(video.public_id);

    expect(anonymous).toEqual({
      public_id: video.public_id,
      title: 'Meu clipe',
      status: VideoStatus.READY,
      duration_seconds: 128,
      width: 1920,
      height: 1080,
      thumbnail_url: null,
      created_at: video.created_at.toISOString(),
    });
    await expect(
      service.getPublicVideo(video.public_id, userId),
    ).resolves.toEqual(anonymous);
  }, 60000);

  it('should issue a Range-capable stream url served by the storage', async () => {
    const { userId } = await createUserWithChannel();
    const video = await seedReadyVideo(userId);

    const result = await service.getStreamUrl(video.public_id);
    const ranged = await fetch(result.url, {
      headers: { Range: 'bytes=0-99' },
    });
    const body = new Uint8Array(await ranged.arrayBuffer());

    expect(result.expires_in).toBe(objectStorage.playbackUrlTtlSeconds);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-99/1024');
    expect(body).toHaveLength(100);
  }, 60000);

  it('should issue a download url carrying an attachment disposition', async () => {
    const { userId } = await createUserWithChannel();
    const video = await seedReadyVideo(userId, {
      title: 'Minha "férias" 2026',
    });

    const result = await service.getDownloadUrl(video.public_id);
    const response = await fetch(result.url);
    await response.arrayBuffer();

    expect(result.url).toContain('response-content-disposition=');
    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(response.headers.get('content-type')).toBe('video/mp4');
  }, 60000);

  it('should hide a non-ready video from everyone but its owner', async () => {
    const owner = await createUserWithChannel();
    const stranger = await createUserWithChannel();
    const initiated = await service.initiateUpload(owner.userId, validDto);
    await trackUpload(initiated.public_id);
    await videoRepository.update(
      { public_id: initiated.public_id },
      { status: VideoStatus.PROCESSING },
    );

    await expect(
      service.getPublicVideo(initiated.public_id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    await expect(
      service.getPublicVideo(initiated.public_id, stranger.userId),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    await expect(
      service.getStreamUrl(initiated.public_id, stranger.userId),
    ).rejects.toBeInstanceOf(VideoNotFoundException);

    // The owner is the only one who learns it exists — and gets 409, not 404.
    await expect(
      service.getPublicVideo(initiated.public_id, owner.userId),
    ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    await expect(
      service.getStreamUrl(initiated.public_id, owner.userId),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
    await expect(
      service.getDownloadUrl(initiated.public_id, owner.userId),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
  }, 60000);

  it('should return not-found for an unknown public id on every playback route', async () => {
    await expect(service.getPublicVideo('aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    await expect(service.getStreamUrl('aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    await expect(service.getDownloadUrl('aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  }, 30000);

  it('should abort the multipart upload when persisting the draft fails', async () => {
    const { userId } = await createUserWithChannel();
    const abortSpy = jest.spyOn(objectStorage, 'abortMultipartUpload');
    jest
      .spyOn(videoRepository, 'save')
      .mockRejectedValue(new Error('insert exploded'));

    await expect(service.initiateUpload(userId, validDto)).rejects.toThrow(
      'insert exploded',
    );

    expect(abortSpy).toHaveBeenCalledTimes(1);
    await expect(videoRepository.count()).resolves.toBe(0);
  }, 30000);
});
