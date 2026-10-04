import { randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { generateTestVideo } from '../test/media';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_STORAGE_KEYS, VideoStatus } from '../videos/videos.constants';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingWorkerModule } from './video-processing-worker.module';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function jobFor(videoId: string): Job<ProcessVideoJobData> {
  return {
    data: { videoId },
    attemptsMade: 1,
    opts: { attempts: 3 },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        // Isolated prefix: this module also starts a BullMQ worker.
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'streamtube-test',
        }),
        VideoProcessingWorkerModule,
      ],
    }).compile();
    await module.init();
    processor = module.get(VideoProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    sampleVideo = await generateTestVideo({ durationSeconds: 3 });
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'worker', nickname: 'worker', user_id: user.id });
    channelId = channel.id;
  });

  async function processingVideoWith(content: Buffer): Promise<Video> {
    const id = randomUUID();
    const storageKey = VIDEO_STORAGE_KEYS.original(id);
    await storage.putObject(storageKey, content, 'video/mp4');
    return videoRepository.save({
      id,
      channel_id: channelId,
      slug: randomBytes(8).toString('base64url'),
      title: 'clip',
      status: VideoStatus.PROCESSING,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: String(content.length),
      storage_key: storageKey,
    });
  }

  it('turns a processing video into ready with metadata and thumbnail', async () => {
    const video = await processingVideoWith(sampleVideo);

    await processor.process(jobFor(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeCloseTo(3, 0);
    expect(updated.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
    });
    expect(updated.thumbnail_key).toBe(VIDEO_STORAGE_KEYS.thumbnail(video.id));
    const thumbnail = await storage.headObject(updated.thumbnail_key!);
    expect(thumbnail.size).toBeGreaterThan(0);
    expect(thumbnail.contentType).toBe('image/jpeg');
  }, 60000);

  it('fails a non-video object without retries and records the reason', async () => {
    const video = await processingVideoWith(randomBytes(32 * 1024));
    const job = jobFor(video.id);

    const error = await processor.process(job).catch((e: Error) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    await processor.onFailed(job, error as Error);

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.processing_error).toEqual(expect.any(String));
    expect(updated.processing_error).not.toContain('X-Amz-Signature');
  }, 60000);

  it('leaves the database untouched for unknown or already ready videos', async () => {
    const ready = await processingVideoWith(sampleVideo);
    await videoRepository.update(ready.id, { status: VideoStatus.READY });

    await processor.process(jobFor(randomUUID()));
    await processor.process(jobFor(ready.id));

    const unchanged = await videoRepository.findOneByOrFail({ id: ready.id });
    expect(unchanged.status).toBe(VideoStatus.READY);
    expect(unchanged.thumbnail_key).toBeNull();
  });
});
