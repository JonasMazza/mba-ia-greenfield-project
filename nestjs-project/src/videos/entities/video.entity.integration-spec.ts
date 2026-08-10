import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${suffix}`,
        nickname: `vidchan${suffix}`,
        user_id: user.id,
      }),
    );
  }

  it('should reject a video without public_id (NOT NULL)', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce the unique constraint on public_id', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        public_id: 'dup123456789',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'dup123456789',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel_id does not exist (FK)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'orphan00001',
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft and processing_attempts to 0', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'defaults0001',
        channel_id: channel.id,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.processing_attempts).toBe(0);
  });

  it('should leave every metadata column null until the worker fills them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'nullable0001',
        channel_id: channel.id,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.title).toBeNull();
    expect(found.storage_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.content_type).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.codec).toBeNull();
    expect(found.bitrate).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.failure_reason).toBeNull();
  });

  it('should persist size_bytes as a number beyond the 32-bit range', async () => {
    const channel = await createChannel();
    const tenGiB = 10 * 1024 * 1024 * 1024;

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'bigint000001',
        channel_id: channel.id,
        size_bytes: tenGiB,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(tenGiB);
  });

  it('should accept every value of the video_status enum', async () => {
    const channel = await createChannel();
    const statuses = [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ];

    for (const [index, status] of statuses.entries()) {
      const saved = await videoRepository.save(
        videoRepository.create({
          public_id: `status00000${index}`,
          channel_id: channel.id,
          status,
        }),
      );
      expect(saved.status).toBe(status);
    }
  });

  it('should cascade-delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'cascade00001',
        channel_id: channel.id,
      }),
    );

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'relation0001',
        channel_id: channel.id,
      }),
    );

    const found = await videoRepository.findOne({
      where: { public_id: 'relation0001' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
