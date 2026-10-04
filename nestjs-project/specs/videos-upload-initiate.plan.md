---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload-initiate.e2e-spec.ts
---

# POST /videos and POST /videos/{id}/upload/parts Test Plan

## Application Overview

`POST /videos` pre-registers a video as `draft` in the caller's channel, generates its unique slug and starts an S3 multipart upload, returning presigned part URLs so the file (up to 10GB) goes straight to object storage. `POST /videos/{id}/upload/parts` re-signs part URLs for the owner of a draft.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeEach` cleans tables (`cleanAllTables`) and throttler storage; app bootstrapped from `AppModule` with global `ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`; user registered, confirmed and logged in to obtain `access_token`.

#### 1.1. creates-draft-with-presigned-part-urls

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos with `Authorization: Bearer <token>` and body `{ fileName: "aula.mp4", fileSize: 314572800, contentType: "video/mp4" }`
    - expect: status 201
    - expect: body `status` is `"draft"`, `title` is `"aula"`, `slug` has 11 characters, `partSize` is 104857600, `partCount` is 3, `parts` has 3 items with `partNumber` 1..3 and non-empty `url`, `uploadId` non-empty, `expiresAt` is an ISO date
  2. Query `videos` by returned `id`
    - expect: row with `status = draft`, non-null `upload_id`, `storage_key = videos/{id}/original`, `size_bytes = 314572800`, `channel_id` equal to the user's channel

#### 1.2. rejects-invalid-size-or-content-type

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos authenticated with `fileSize: 10737418241`
    - expect: status 400 with `error: "VALIDATION_ERROR"`
  2. POST /videos authenticated with `contentType: "image/png"`
    - expect: status 400 with `error: "VALIDATION_ERROR"`

#### 1.3. requires-authentication

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos without `Authorization` header and a valid body
    - expect: status 401

#### 1.4. generates-distinct-slugs

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos twice with valid bodies
    - expect: both 201 and the two `slug` values differ

### 2. POST /videos/{id}/upload/parts

**Setup:** same as group 1, plus a draft video created via POST /videos with 3 parts.

#### 2.1. rejects-part-number-out-of-range

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. POST /videos/{id}/upload/parts as owner with `{ partNumbers: [4] }`
    - expect: status 400 with `error: "INVALID_UPLOAD_PARTS"`
  2. POST /videos/{id}/upload/parts as owner with `{ partNumbers: [1, 2] }`
    - expect: status 200 with 2 `parts` and `expiresAt`

#### 2.2. hides-video-from-non-owner

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. Register/confirm/login a second user; POST /videos/{id}/upload/parts with their token and `{ partNumbers: [1] }`
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
