import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';
import { binaryParser, createVideosTestApp } from './helpers/videos-e2e';
import { createChannel, seedVideo } from './helpers/videos-fixtures';

describe('videos-stream', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let content: Buffer;
  let ready: Video;
  let processing: Video;

  beforeAll(async () => {
    ({ app, dataSource } = await createVideosTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const storage = app.get(StorageService);
    const channel = await createChannel(dataSource);
    content = randomBytes(64 * 1024);
    ready = await seedVideo(dataSource, storage, channel.id, {
      status: VideoStatus.READY,
      content,
      originalFileName: 'minha aula.mp4',
    });
    processing = await seedVideo(dataSource, storage, channel.id, {
      status: VideoStatus.PROCESSING,
    });
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse(binaryParser);
  }

  // 1. GET /videos/{slug}/stream

  test('returns-partial-content-for-range', async () => {
    const res = await get(`/videos/${ready.slug}/stream`)
      .set('Range', 'bytes=0-1023')
      .expect(206);

    expect(res.headers['content-range']).toBe(`bytes 0-1023/${content.length}`);
    expect(res.headers['content-length']).toBe('1024');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect((res.body as Buffer).equals(content.subarray(0, 1024))).toBe(true);

    const suffix = await get(`/videos/${ready.slug}/stream`)
      .set('Range', 'bytes=-100')
      .expect(206);
    expect(
      (suffix.body as Buffer).equals(content.subarray(content.length - 100)),
    ).toBe(true);
  });

  test('returns-full-content-without-range', async () => {
    const res = await get(`/videos/${ready.slug}/stream`).expect(200);

    expect(res.headers['content-length']).toBe(String(content.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect((res.body as Buffer).equals(content)).toBe(true);
  });

  test('rejects-unsatisfiable-range', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.slug}/stream`)
      .set('Range', `bytes=${content.length}-`);

    expect(res.status).toBe(416);
    expect(res.body).toMatchObject({ error: 'RANGE_NOT_SATISFIABLE' });
    expect(res.headers['content-range']).toBe(`bytes */${content.length}`);
  });

  // 2. GET /videos/{slug}/download

  test('downloads-as-attachment', async () => {
    const res = await get(`/videos/${ready.slug}/download`).expect(200);

    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''minha%20aula.mp4",
    );
    expect((res.body as Buffer).equals(content)).toBe(true);
  });

  test('rejects-not-ready-and-unknown', async () => {
    for (const path of ['stream', 'download']) {
      const res = await request(app.getHttpServer()).get(
        `/videos/${processing.slug}/${path}`,
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
    }

    const unknown = await request(app.getHttpServer()).get(
      '/videos/zzzzzzzzzzz/stream',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });
});
