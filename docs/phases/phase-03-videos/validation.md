---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-04T01:41:05-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T01:41:05-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage in tests; TD-02/TD-06 need S3 API"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download/see thumbnail of a video in Phase 03 is undefined"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Upload initiation payload undefined (title source, accepted video types)"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "Browser-direct storage/stream URLs vs inherited strict-BFF frontend model"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Upload Protocol for Files up to 10GB"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Upload Completion Trigger"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Metadata Extraction and Thumbnail Generation"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Object Storage Layout and Endpoints"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-09
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (no UI scope in this phase)

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — Testing guide prescribes local-FS storage in tests; TD-02/TD-06 need S3 API. User decision (2026-10-04): integration and e2e tests run against the **real MinIO service in Compose** (S3 API end-to-end); the testing guide's "local filesystem" storage strategy is superseded for this project.
- **AMB-1** _(resolved_by clarification)_ — Access policy for stream/download/thumbnail. User decision: **public read** — any requester (anonymous included) can stream, download and fetch the thumbnail of a `ready` video by its slug (`@Public()`); a video that is not `ready` is rejected (not playable).
- **AMB-2** _(resolved_by clarification)_ — Upload initiation payload. User decision: client sends `fileName`, `fileSize` (≤ 10GB), `contentType` (must be `video/*`) and an **optional** `title`; when absent, the title defaults to the file name without extension.
- **ICC-1** _(resolved_by clarification)_ — Browser-direct storage/stream URLs vs strict-BFF. User decision: presigned storage URLs are not NestJS calls (allowed by the BFF model); stream/download endpoints will be proxied by a frontend Route Handler in a future UI phase. No backend change in Phase 03.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: A (BullMQ + Redis via @nestjs/bullmq).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: C (S3 multipart upload with presigned part URLs).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: A (Client calls a "complete" endpoint on the API).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: A (Same codebase, separate entrypoint and container).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: A (Spawn ffprobe/ffmpeg via execFile over a presigned GET URL).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: A (Single private bucket, per-video key prefixes, separate public endpoint for presigning).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: B (Random 11-char base64url slug with UNIQUE constraint).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: A (API streams from storage honoring HTTP Range — 206 Partial Content).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: A (draft → processing → ready | failed with queue retries).
