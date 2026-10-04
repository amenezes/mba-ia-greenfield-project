import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';
import { binaryParser, createVideosTestApp } from './helpers/videos-e2e';
import { createChannel, seedVideo } from './helpers/videos-fixtures';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

describe('videos-read', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
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
    ready = await seedVideo(dataSource, storage, channel.id, {
      status: VideoStatus.READY,
      thumbnail: JPEG,
    });
    processing = await seedVideo(dataSource, storage, channel.id, {
      status: VideoStatus.PROCESSING,
    });
  });

  // 1. GET /videos/{slug}

  test('returns-details-anonymously', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.slug}`)
      .expect(200);

    expect(res.body).toMatchObject({
      slug: ready.slug,
      title: 'Fixture video',
      status: 'ready',
      durationSeconds: 3,
      streamUrl: `/videos/${ready.slug}/stream`,
      downloadUrl: `/videos/${ready.slug}/download`,
      thumbnailUrl: `/videos/${ready.slug}/thumbnail`,
    });
    expect((res.body as VideoResponseDto).metadata?.width).toBe(320);

    const pending = await request(app.getHttpServer())
      .get(`/videos/${processing.slug}`)
      .expect(200);
    expect(pending.body).toMatchObject({
      status: 'processing',
      thumbnailUrl: null,
    });
  });

  test('returns-404-for-unknown-slug', async () => {
    const res = await request(app.getHttpServer()).get('/videos/doesnotexis');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });

  // 2. GET /videos/{slug}/thumbnail

  test('serves-jpeg-thumbnail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.slug}/thumbnail`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/jpeg');
    expect((res.body as Buffer).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
  });

  test('rejects-thumbnail-when-not-ready', async () => {
    const res = await request(app.getHttpServer()).get(
      `/videos/${processing.slug}/thumbnail`,
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
  });
});
