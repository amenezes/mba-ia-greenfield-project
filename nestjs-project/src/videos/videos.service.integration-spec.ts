import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import {
  createTestS3Client,
  putToPresignedUrl,
  useInternalEndpointForPresignedUrls,
} from '../test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userId: string;
  let queue: Queue;
  let s3: S3Client;

  beforeAll(async () => {
    useInternalEndpointForPresignedUrls();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        // Isolated prefix so the Compose video-worker never consumes test jobs.
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'streamtube-test',
        }),
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    s3 = createTestS3Client();
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    s3.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    userId = user.id;
    await queue.obliterate({ force: true });
  });

  async function uploadedDraft(content: Buffer) {
    const draft = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      fileSize: content.length,
      contentType: 'video/mp4',
    });
    const etag = await putToPresignedUrl(draft.parts[0].url, content);
    return { draft, parts: [{ partNumber: 1, etag }] };
  }

  describe('initiateUpload', () => {
    it('persists the draft and returns part URLs that accept PUT', async () => {
      const result = await service.initiateUpload(userId, {
        fileName: 'clip.mp4',
        fileSize: 1024,
        contentType: 'video/mp4',
      });

      const video = await videoRepository.findOneByOrFail({ id: result.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.upload_id).toBe(result.uploadId);
      expect(video.storage_key).toBe(`videos/${video.id}/original`);
      expect(video.slug).toHaveLength(11);
      expect(video.title).toBe('clip');
      expect(result.parts).toHaveLength(1);

      const etag = await putToPresignedUrl(
        result.parts[0].url,
        Buffer.alloc(1024, 1),
      );
      expect(etag).toMatch(/^".+"$/);
    });
  });

  describe('presignParts', () => {
    it('re-signs parts of the owned draft', async () => {
      const draft = await service.initiateUpload(userId, {
        fileName: 'big.mp4',
        fileSize: 300 * 1024 * 1024,
        contentType: 'video/mp4',
      });

      const result = await service.presignParts(userId, draft.id, [3]);

      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].url).toContain('partNumber=3');
    });
  });

  describe('completeUpload', () => {
    it('moves the video to processing and enqueues its job', async () => {
      const { draft, parts } = await uploadedDraft(Buffer.alloc(2048, 7));

      const result = await service.completeUpload(userId, draft.id, parts);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const video = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      const job = await queue.getJob(draft.id);
      expect(job?.data).toEqual({ videoId: draft.id });
    });

    it('marks the video failed and deletes the object on size mismatch', async () => {
      const draft = await service.initiateUpload(userId, {
        fileName: 'liar.mp4',
        fileSize: 4096,
        contentType: 'video/mp4',
      });
      const etag = await putToPresignedUrl(
        draft.parts[0].url,
        Buffer.alloc(1024, 1),
      );

      await expect(
        service.completeUpload(userId, draft.id, [{ partNumber: 1, etag }]),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_SIZE_MISMATCH' });

      const video = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.processing_error).toContain('does not match');
      await expect(
        module.get(StorageService).headObject(video.storage_key),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      expect(await queue.getJob(draft.id)).toBeUndefined();
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and deletes the draft row', async () => {
      const { draft } = await uploadedDraft(Buffer.alloc(512, 3));

      await service.abortUpload(userId, draft.id);

      expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
      await expect(
        s3.send(
          new ListPartsCommand({
            Bucket: process.env.S3_BUCKET ?? 'streamtube',
            Key: `videos/${draft.id}/original`,
            UploadId: draft.uploadId,
          }),
        ),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });
  });

  describe('worker transitions', () => {
    async function processingVideo(): Promise<string> {
      const { draft, parts } = await uploadedDraft(Buffer.alloc(256, 5));
      await service.completeUpload(userId, draft.id, parts);
      return draft.id;
    }

    it('markReady persists duration, metadata and thumbnail key', async () => {
      const id = await processingVideo();
      const metadata = {
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitRate: 1000,
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: null,
      };

      await service.markReady(id, {
        durationSeconds: 3.04,
        metadata,
        thumbnailKey: `videos/${id}/thumbnail.jpg`,
      });

      const video = await videoRepository.findOneByOrFail({ id });
      expect(video.status).toBe(VideoStatus.READY);
      expect(video.duration_seconds).toBeCloseTo(3.04);
      expect(video.metadata).toEqual(metadata);
      expect(video.thumbnail_key).toBe(`videos/${id}/thumbnail.jpg`);
      expect(await service.findForProcessing(id)).toBeNull();
    });

    it('markFailed records the reason', async () => {
      const id = await processingVideo();

      await service.markFailed(id, 'No video stream found');

      const video = await videoRepository.findOneByOrFail({ id });
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.processing_error).toBe('No video stream found');
    });
  });

  describe('getThumbnail', () => {
    it('streams the thumbnail bytes stored for a ready video', async () => {
      const { draft, parts } = await uploadedDraft(Buffer.alloc(256, 4));
      await service.completeUpload(userId, draft.id, parts);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      const thumbnailKey = `videos/${draft.id}/thumbnail.jpg`;
      await module
        .get(StorageService)
        .putObject(thumbnailKey, jpeg, 'image/jpeg');
      await service.markReady(draft.id, {
        durationSeconds: 1,
        metadata: {
          formatName: null,
          bitRate: null,
          width: 1,
          height: 1,
          videoCodec: 'h264',
          audioCodec: null,
        },
        thumbnailKey,
      });

      const result = await service.getThumbnail(draft.slug);
      const chunks: Buffer[] = [];
      for await (const chunk of result.body)
        chunks.push(Buffer.from(chunk as Uint8Array));

      expect(Buffer.concat(chunks).equals(jpeg)).toBe(true);
      expect(result.contentType).toBe('image/jpeg');
    });
  });

  describe('openStream', () => {
    it('returns exactly the requested bytes of the stored file', async () => {
      const content = Buffer.from(
        Array.from({ length: 4096 }, (_, i) => i % 251),
      );
      const { draft, parts } = await uploadedDraft(content);
      await service.completeUpload(userId, draft.id, parts);
      await videoRepository.update(draft.id, { status: VideoStatus.READY });

      const result = await service.openStream(draft.slug, 'bytes=1000-1999');
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream)
        chunks.push(Buffer.from(chunk as Uint8Array));

      expect(result.status).toBe(206);
      expect(result.contentRange).toBe('bytes 1000-1999/4096');
      expect(Buffer.concat(chunks).equals(content.subarray(1000, 2000))).toBe(
        true,
      );
    });
  });
});
