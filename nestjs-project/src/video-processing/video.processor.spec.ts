import { Job, UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { InvalidMediaError } from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessor } from './video.processor';

function job(attemptsMade = 1, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videos: Record<
    'findForProcessing' | 'markReady' | 'markFailed',
    jest.Mock
  >;
  let storage: Record<'presignInternalGetUrl' | 'putObject', jest.Mock>;
  let probe: Record<
    'probe' | 'extractThumbnail' | 'thumbnailOffset',
    jest.Mock
  >;

  beforeEach(() => {
    videos = {
      findForProcessing: jest.fn().mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/original',
      } as Video),
      markReady: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      presignInternalGetUrl: jest.fn().mockResolvedValue('http://minio/x'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    probe = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 20,
        metadata: { width: 320, height: 240 },
      }),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
      thumbnailOffset: jest.fn().mockReturnValue(2),
    };
    processor = new VideoProcessor(
      videos as unknown as VideosService,
      storage as unknown as StorageService,
      probe as unknown as MediaProbeService,
    );
  });

  it('stores the thumbnail and marks the video ready', async () => {
    await processor.process(job());

    expect(probe.extractThumbnail).toHaveBeenCalledWith('http://minio/x', 2);
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      Buffer.from([0xff, 0xd8]),
      'image/jpeg',
    );
    expect(videos.markReady).toHaveBeenCalledWith('video-1', {
      durationSeconds: 20,
      metadata: { width: 320, height: 240 },
      thumbnailKey: 'videos/video-1/thumbnail.jpg',
    });
  });

  it('is a no-op when the video is gone or no longer processing', async () => {
    videos.findForProcessing.mockResolvedValue(null);

    await processor.process(job());

    expect(probe.probe).not.toHaveBeenCalled();
    expect(videos.markReady).not.toHaveBeenCalled();
  });

  it('turns invalid media into an unrecoverable error', async () => {
    probe.probe.mockRejectedValue(new InvalidMediaError('No video stream'));

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('lets transient errors propagate for retry', async () => {
    const transient = new Error('connection reset');
    probe.probe.mockRejectedValue(transient);

    await expect(processor.process(job())).rejects.toBe(transient);
  });

  it('marks the video failed only on the final attempt', async () => {
    await processor.onFailed(job(1, 3), new Error('boom'));
    expect(videos.markFailed).not.toHaveBeenCalled();

    await processor.onFailed(job(3, 3), new Error('boom'));
    expect(videos.markFailed).toHaveBeenCalledWith('video-1', 'boom');
  });

  it('marks the video failed immediately on an unrecoverable error', async () => {
    await processor.onFailed(job(1, 3), new UnrecoverableError('not a video'));

    expect(videos.markFailed).toHaveBeenCalledWith('video-1', 'not a video');
  });
});
