import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { QueueService } from '../videos/queue/queue.service';
import { ObjectStorageService } from '../videos/storage/object-storage.service';
import { probeVideo } from './ffmpeg.util';
import { VideoProcessorService } from './video-processor.service';

jest.mock('./ffmpeg.util', () => ({
  ...jest.requireActual<typeof import('./ffmpeg.util')>('./ffmpeg.util'),
  probeVideo: jest.fn(),
}));

const RETRY_LIMIT = 3;

function makeVideo(processingAttempts: number): Video {
  const video = new Video();
  video.id = 'video-id';
  video.status = VideoStatus.PROCESSING;
  video.storage_key = 'videos/video-id/source';
  video.processing_attempts = processingAttempts;
  return video;
}

describe('VideoProcessorService', () => {
  let processor: VideoProcessorService;
  const videoRepository = {
    findOneBy: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessorService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: ObjectStorageService,
          useValue: {
            rawBucket: 'streamtube-raw',
            presignGetObject: jest
              .fn()
              .mockResolvedValue('http://minio:9000/streamtube-raw/signed'),
          },
        },
        { provide: QueueService, useValue: {} },
        {
          provide: queueConfig.KEY,
          useValue: { retryLimit: RETRY_LIMIT, expireInSeconds: 3600 },
        },
      ],
    }).compile();

    processor = module.get(VideoProcessorService);
  });

  describe('failure_reason on the terminal attempt', () => {
    it('should store a generic reason when the error message was not written for the owner', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo(RETRY_LIMIT - 1));
      jest
        .mocked(probeVideo)
        .mockRejectedValue(
          new Error(
            'connect ECONNREFUSED http://minio:9000/raw?X-Amz-Signature=abc',
          ),
        );

      await processor.process('video-id');

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-id' },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_reason: 'Unexpected error while processing the video',
        }),
      );
    });
  });

  describe('processing deadline', () => {
    it('should bound the media tools by a signal that fires before the job expires', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo(0));
      jest.mocked(probeVideo).mockRejectedValue(new Error('stop here'));

      await expect(processor.process('video-id')).rejects.toThrow('stop here');

      expect(probeVideo).toHaveBeenCalledWith(
        'http://minio:9000/streamtube-raw/signed',
        expect.any(AbortSignal),
      );
    });
  });
});
