import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { UploadPartsResponseDto } from '../src/videos/dto/upload-parts-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { createVideosTestApp, registerAndLogin } from './helpers/videos-e2e';

const VALID_BODY = {
  fileName: 'aula.mp4',
  fileSize: 314572800,
  contentType: 'video/mp4',
};

describe('videos-upload-initiate', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let token: string;

  beforeAll(async () => {
    ({ app, dataSource } = await createVideosTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    token = await registerAndLogin(app, 'owner@example.com');
  });

  const draftOf = (res: { body: unknown }) =>
    res.body as InitiateUploadResponseDto;

  function createDraft(body: object = VALID_BODY) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  // 1. POST /videos

  test('creates-draft-with-presigned-part-urls', async () => {
    const res = await createDraft().expect(201);

    expect(res.body).toMatchObject({
      status: 'draft',
      title: 'aula',
      partSize: 104857600,
      partCount: 3,
    });
    expect(draftOf(res).slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(draftOf(res).uploadId).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(draftOf(res).expiresAt))).toBe(false);
    expect(draftOf(res).parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    for (const part of draftOf(res).parts) {
      expect(part.url).toContain(`partNumber=${part.partNumber}`);
    }

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: draftOf(res).id });
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: 'owner@example.com' });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    expect(video.status).toBe('draft');
    expect(video.upload_id).toBe(draftOf(res).uploadId);
    expect(video.storage_key).toBe(`videos/${video.id}/original`);
    expect(video.size_bytes).toBe('314572800');
    expect(video.channel_id).toBe(channel.id);
  });

  test('rejects-invalid-size-or-content-type', async () => {
    const tooBig = await createDraft({ ...VALID_BODY, fileSize: 10737418241 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    const notVideo = await createDraft({
      ...VALID_BODY,
      contentType: 'image/png',
    });
    expect(notVideo.status).toBe(400);
    expect(notVideo.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  test('requires-authentication', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(VALID_BODY)
      .expect(401);
  });

  test('generates-distinct-slugs', async () => {
    const first = await createDraft().expect(201);
    const second = await createDraft().expect(201);

    expect(draftOf(first).slug).not.toBe(draftOf(second).slug);
  });

  // 2. POST /videos/{id}/upload/parts

  test('rejects-part-number-out-of-range', async () => {
    const draft = await createDraft().expect(201);

    const outOfRange = await request(app.getHttpServer())
      .post(`/videos/${draftOf(draft).id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [4] });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body).toMatchObject({ error: 'INVALID_UPLOAD_PARTS' });

    const resigned = await request(app.getHttpServer())
      .post(`/videos/${draftOf(draft).id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);
    expect((resigned.body as UploadPartsResponseDto).parts).toHaveLength(2);
    expect((resigned.body as UploadPartsResponseDto).expiresAt).toEqual(
      expect.any(String),
    );
  });

  test('hides-video-from-non-owner', async () => {
    const draft = await createDraft().expect(201);
    const otherToken = await registerAndLogin(app, 'intruder@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/${draftOf(draft).id}/upload/parts`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ partNumbers: [1] });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });
});
