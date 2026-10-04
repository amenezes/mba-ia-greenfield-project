---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# GET /videos/{slug}/stream and GET /videos/{slug}/download Test Plan

## Application Overview

Delivers the original video file from object storage without buffering: `/stream` honors HTTP Range requests (206 Partial Content) so playback does not require the full download; `/download` returns the whole file as an attachment with the original file name. Both are public and only for `ready` videos.

## Test Scenarios

### 1. GET /videos/{slug}/stream

**Setup:** `beforeEach` cleans tables; a user + channel exist; a `ready` video is seeded through the repository and a known random byte buffer (e.g., 64 KiB) is put into MinIO at its `storage_key`, with `size_bytes` equal to the buffer length; a second video is seeded as `processing`.

#### 1.1. returns-partial-content-for-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/stream with `Range: bytes=0-1023`, no `Authorization`
    - expect: status 206, `Content-Range: bytes 0-1023/{size}`, `Content-Length: 1024`, `Accept-Ranges: bytes`
    - expect: body equals bytes 0..1023 of the stored buffer
  2. GET /videos/{slug}/stream with `Range: bytes=-100`
    - expect: status 206 with the last 100 bytes of the buffer

#### 1.2. returns-full-content-without-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/stream without `Range`
    - expect: status 200, `Content-Length` equal to `{size}`, `Accept-Ranges: bytes`, body equal to the full buffer

#### 1.3. rejects-unsatisfiable-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/stream with `Range: bytes={size}-`
    - expect: status 416 with `error: "RANGE_NOT_SATISFIABLE"` and header `Content-Range: bytes */{size}`

### 2. GET /videos/{slug}/download

**Setup:** same as group 1.

#### 2.1. downloads-as-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/download without `Authorization`
    - expect: status 200, `Content-Disposition` contains `attachment` and the original file name, body equal to the full buffer

#### 2.2. rejects-not-ready-and-unknown

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T04:48:46Z

**Steps:**
  1. GET /videos/{slug}/stream and /download of the `processing` video
    - expect: status 409 with `error: "VIDEO_NOT_READY"`
  2. GET /videos/zzzzzzzzzzz/stream
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
