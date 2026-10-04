---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{id}/upload/complete and DELETE /videos/{id}/upload Test Plan

## Application Overview

`POST /videos/{id}/upload/complete` finalizes the S3 multipart upload, verifies the stored object size against the declared size, moves the video to `processing` and enqueues the `process-video` job. `DELETE /videos/{id}/upload` aborts the multipart upload and removes the draft.

## Test Scenarios

### 1. POST /videos/{id}/upload/complete

**Setup:** `beforeEach` cleans tables, throttler storage and the `video-processing` queue (`obliterate({ force: true })`); test process sets `S3_PUBLIC_ENDPOINT=http://minio:9000` so presigned URLs are reachable from inside the container; user logged in; small test files (< 100 MiB part size) produce single-part uploads PUT to the presigned URL; multi-part drafts are declared with `fileSize` > 100 MiB without uploading every part.

#### 1.1. completes-and-enqueues-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos with the file's real `fileSize`; PUT each part body to its URL and collect the `ETag` headers
    - expect: every PUT returns 200 with an `ETag`
  2. POST /videos/{id}/upload/complete with `{ parts: [{ partNumber, etag }...] }`
    - expect: status 202 with `{ id, slug, status: "processing" }`
  3. Query `videos` and the `video-processing` queue
    - expect: `status = processing`, `upload_id IS NULL`; job with id equal to the video id, name `process-video`, data `{ videoId }`

#### 1.2. rejects-incomplete-part-list

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. Create a draft whose `partCount` is 2 and POST complete with only part 1
    - expect: status 400 with `error: "INVALID_UPLOAD_PARTS"`
    - expect: video remains `draft`

#### 1.3. rejects-size-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos declaring `fileSize` larger than the bytes actually uploaded (still 1 part); PUT the smaller body; POST complete with its ETag
    - expect: status 400 with `error: "UPLOAD_SIZE_MISMATCH"`
    - expect: `videos.status = failed` with non-empty `processing_error`; object `videos/{id}/original` no longer exists in storage

#### 1.4. rejects-complete-when-not-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. Complete a valid upload, then POST complete again with the same parts
    - expect: status 409 with `error: "INVALID_VIDEO_STATUS"`

### 2. DELETE /videos/{id}/upload

**Setup:** same as group 1 with a fresh draft.

#### 2.1. aborts-draft-upload

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. DELETE /videos/{id}/upload as owner
    - expect: status 204 and no row for `id` in `videos`
  2. DELETE /videos/{id}/upload again
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
