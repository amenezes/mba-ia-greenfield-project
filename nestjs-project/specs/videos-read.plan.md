---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-read.e2e-spec.ts
---

# GET /videos/{slug} and GET /videos/{slug}/thumbnail Test Plan

## Application Overview

Public read of a video by its unique URL identifier (slug): details with status, duration, metadata and stream/download/thumbnail links, plus the JPEG thumbnail produced by the worker. No authentication required.

## Test Scenarios

### 1. GET /videos/{slug}

**Setup:** `beforeEach` cleans tables; a user + channel exist; videos are seeded directly through the `Video` repository in the required status (`processing`, or `ready` with `duration_seconds`, `metadata`, `thumbnail_key` and a JPEG object put into MinIO at `videos/{id}/thumbnail.jpg`).

#### 1.1. returns-details-anonymously

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug} of a `ready` video without `Authorization`
    - expect: status 200 with `slug`, `title`, `status: "ready"`, `durationSeconds`, `metadata.width`, `streamUrl: "/videos/{slug}/stream"`, `downloadUrl: "/videos/{slug}/download"`, `thumbnailUrl: "/videos/{slug}/thumbnail"`
  2. GET /videos/{slug} of a `processing` video
    - expect: status 200 with `status: "processing"` and `thumbnailUrl: null`

#### 1.2. returns-404-for-unknown-slug

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/doesnotexis
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`

### 2. GET /videos/{slug}/thumbnail

**Setup:** same as group 1.

#### 2.1. serves-jpeg-thumbnail

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/thumbnail of a `ready` video without `Authorization`
    - expect: status 200, `Content-Type: image/jpeg`, body starts with bytes `FF D8`

#### 2.2. rejects-thumbnail-when-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/thumbnail of a `processing` video
    - expect: status 409 with `error: "VIDEO_NOT_READY"`
