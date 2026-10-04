import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestVideo } from '../src/test/media';
import { putToPresignedUrl } from '../src/test/storage';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { WorkerModule } from '../src/worker/worker.module';
import {
  binaryParser,
  createVideosTestApp,
  registerAndLogin,
} from './helpers/videos-e2e';

const PROCESSING_TIMEOUT_MS = 60_000;

async function waitForStatus(
  dataSource: DataSource,
  id: string,
  statuses: VideoStatus[],
): Promise<Video> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const video = await dataSource.getRepository(Video).findOneByOrFail({ id });
    if (statuses.includes(video.status)) return video;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Video ${id} did not reach ${statuses.join('/')} in time`);
}

describe('videos-pipeline', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createVideosTestApp());
    // In-process video worker (same module the video-worker container runs).
    const workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = await workerModule.init();
    // Another suite may have paused the queue and been interrupted.
    await app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).resume();
  }, 60_000);

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  test(
    'upload-queue-worker-stream-download',
    async () => {
      const token = await registerAndLogin(app, 'creator@example.com');
      const file = await generateTestVideo({ durationSeconds: 3 });

      // 1. Pre-register the draft and get presigned part URLs.
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileName: 'aula-1.mp4',
          fileSize: file.length,
          contentType: 'video/mp4',
          title: 'Aula 1',
        })
        .expect(201);

      // 2. Upload straight to object storage — the API never sees the bytes.
      const created = draft.body as InitiateUploadResponseDto;
      const parts = await Promise.all(
        created.parts.map(async (part) => ({
          partNumber: part.partNumber,
          etag: await putToPresignedUrl(part.url, file),
        })),
      );

      // 3. Complete → processing + job enqueued.
      await request(app.getHttpServer())
        .post(`/videos/${created.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      // 4. The worker processes it automatically.
      const processed = await waitForStatus(dataSource, created.id, [
        VideoStatus.READY,
        VideoStatus.FAILED,
      ]);
      expect(processed.processing_error).toBeNull();
      expect(processed.status).toBe(VideoStatus.READY);

      const details = await request(app.getHttpServer())
        .get(`/videos/${created.slug}`)
        .expect(200);
      expect(details.body).toMatchObject({
        title: 'Aula 1',
        status: 'ready',
        thumbnailUrl: `/videos/${created.slug}/thumbnail`,
      });
      const video = details.body as VideoResponseDto;
      expect(video.durationSeconds).toBeCloseTo(3, 0);
      expect(video.metadata).toMatchObject({
        width: 320,
        height: 240,
        videoCodec: 'h264',
      });

      const thumbnail = await request(app.getHttpServer())
        .get(`/videos/${created.slug}/thumbnail`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect((thumbnail.body as Buffer).subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      );

      // 5. Streaming without downloading the whole file.
      const chunk = await request(app.getHttpServer())
        .get(`/videos/${created.slug}/stream`)
        .set('Range', 'bytes=0-1023')
        .buffer(true)
        .parse(binaryParser)
        .expect(206);
      expect(chunk.headers['content-range']).toBe(
        `bytes 0-1023/${file.length}`,
      );
      expect((chunk.body as Buffer).equals(file.subarray(0, 1024))).toBe(true);

      // 6. Download returns the exact file.
      const download = await request(app.getHttpServer())
        .get(`/videos/${created.slug}/download`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect(download.headers['content-disposition']).toContain('aula-1.mp4');
      expect((download.body as Buffer).equals(file)).toBe(true);
    },
    PROCESSING_TIMEOUT_MS + 30_000,
  );
});
