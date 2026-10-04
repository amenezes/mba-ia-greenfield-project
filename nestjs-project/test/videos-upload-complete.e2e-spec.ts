import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putToPresignedUrl } from '../src/test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { Video } from '../src/videos/entities/video.entity';
import { createVideosTestApp, registerAndLogin } from './helpers/videos-e2e';

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let token: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createVideosTestApp());
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Keep the Compose video-worker from consuming the jobs asserted here.
    await queue.pause();
  });

  afterAll(async () => {
    await queue.resume();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    token = await registerAndLogin(app, 'owner@example.com');
  });

  async function draftFor(fileSize: number) {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'clip.mp4', fileSize, contentType: 'video/mp4' })
      .expect(201);
    return res.body as {
      id: string;
      slug: string;
      parts: { partNumber: number; url: string }[];
    };
  }

  async function uploadedDraft(content: Buffer) {
    const draft = await draftFor(content.length);
    const etag = await putToPresignedUrl(draft.parts[0].url, content);
    return { draft, parts: [{ partNumber: 1, etag }] };
  }

  function complete(id: string, parts: object[]) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });
  }

  // 1. POST /videos/{id}/upload/complete

  test('completes-and-enqueues-processing', async () => {
    const { draft, parts } = await uploadedDraft(Buffer.alloc(4096, 9));

    const res = await complete(draft.id, parts).expect(202);

    expect(res.body).toEqual({
      id: draft.id,
      slug: draft.slug,
      status: 'processing',
    });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(video.status).toBe('processing');
    expect(video.upload_id).toBeNull();
    const job = await queue.getJob(draft.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: draft.id });
  });

  test('rejects-incomplete-part-list', async () => {
    const draft = await draftFor(150 * 1024 * 1024);

    const res = await complete(draft.id, [{ partNumber: 1, etag: '"x"' }]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_UPLOAD_PARTS' });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(video.status).toBe('draft');
  });

  test('rejects-size-mismatch', async () => {
    const draft = await draftFor(8192);
    const etag = await putToPresignedUrl(draft.parts[0].url, Buffer.alloc(100));

    const res = await complete(draft.id, [{ partNumber: 1, etag }]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'UPLOAD_SIZE_MISMATCH' });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draft.id });
    expect(video.status).toBe('failed');
    expect(video.processing_error).toEqual(expect.any(String));
    await expect(
      app.get(StorageService).headObject(video.storage_key),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });

  test('rejects-complete-when-not-draft', async () => {
    const { draft, parts } = await uploadedDraft(Buffer.alloc(1024, 2));
    await complete(draft.id, parts).expect(202);

    const res = await complete(draft.id, parts);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'INVALID_VIDEO_STATUS' });
  });

  // 2. DELETE /videos/{id}/upload

  test('aborts-draft-upload', async () => {
    const draft = await draftFor(2048);

    await request(app.getHttpServer())
      .delete(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(
      await dataSource.getRepository(Video).findOneBy({ id: draft.id }),
    ).toBeNull();

    const again = await request(app.getHttpServer())
      .delete(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });
});
