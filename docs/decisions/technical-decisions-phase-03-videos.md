---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-04
scope_description: "Backend foundation for video upload and processing: queue technology, direct-to-storage upload of files up to 10GB, upload completion handshake, worker runtime, FFmpeg metadata/thumbnail extraction, object-storage layout, unique video URL, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the videos module (draft pre-registration, upload handshake, streaming/download endpoints), the storage integration (S3 API on MinIO), the queue producer, the video worker (FFmpeg) and the new Compose infrastructure (MinIO, queue broker, worker container).
- `next-frontend/` — Frontend deferred: the video UI is explicitly out of scope for this phase (backend-only challenge). The only client-facing contract (the upload handshake) is captured as a `Cross-layer` TD (TD-02) so the future UI inherits it; no frontend-only decision is open in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` leave the Message Queue as "TBD". The API must publish a processing job after each upload and a separate worker must consume it with retries. The choice adds (or not) a new infrastructure service to `compose.yaml` and defines the producer/consumer API used in both the API and the worker.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. NestJS documents it as the official queue technique (`BullModule.forRootAsync`, `registerQueue`, `@InjectQueue`, `@Processor` + `WorkerHost`).
- **Pros:** First-party NestJS integration with DI and lifecycle; built-in `attempts` + exponential `backoff`, job ids for idempotent enqueue, `failed` events, concurrency control; Redis is a single lightweight container.
- **Cons:** Adds Redis as a new stateful service; job delivery semantics are "at least once" (handler must be idempotent); no cross-language broker features.

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker. Producer publishes to an exchange/queue; worker consumes with manual ack; retries via dead-letter exchanges + TTL.
- **Pros:** Mature broker, protocol-level acks, language-agnostic, management UI.
- **Cons:** Retry/backoff must be hand-built with DLX/TTL queues; NestJS microservice transport is message-pattern oriented (no job state, no attempts counter); heavier container.

### Option C: pg-boss (PostgreSQL-backed queue)
- Queue tables inside the existing PostgreSQL; workers poll with `SKIP LOCKED`.
- **Pros:** No new infrastructure; transactional enqueue with domain writes.
- **Cons:** No new queue service in Compose (the phase explicitly expects a real queue service); polling load on the main DB; no first-party NestJS integration.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the queue technique officially specified by NestJS docs (`@nestjs/bullmq`), gives retries/backoff/idempotent job ids out of the box (needed by TD-09), and adds a single small Redis container. RabbitMQ would require hand-building retry/backoff; pg-boss does not deliver a dedicated queue service.

**Decision:** A (BullMQ + Redis via @nestjs/bullmq)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file cannot go through the API process without holding connections, memory/disk and event-loop time for minutes. The protocol is a contract between backend (handshake endpoints) and the future frontend (client chunking logic), so it is decided once here.

**Options:**

### Option A: Proxy multipart/form-data through the API
- Client sends the file to the API (`multer`/stream), API streams it to storage.
- **Pros:** Simplest client; API sees every byte (validation inline).
- **Cons:** The API carries the full 10GB per upload — exactly the "travar o sistema" anti-pattern; no resume; long-lived connections on the API.

### Option B: Single presigned PUT URL
- API returns one presigned `PutObject` URL; client uploads directly to storage.
- **Pros:** API never touches bytes; trivial client.
- **Cons:** S3 single PUT is capped at 5GB — cannot satisfy 10GB; no resume on failure.

### Option C: S3 multipart upload with presigned part URLs
- API starts a multipart upload (`CreateMultipartUpload`), returns presigned `UploadPart` URLs; client PUTs each part directly to storage and calls the API to complete (`CompleteMultipartUpload` with part ETags) or abort.
- **Pros:** API never touches bytes; supports up to 10,000 parts × 5GB; parts can be retried/resumed individually; native S3/MinIO API, no extra server.
- **Cons:** Multi-step handshake (initiate → part URLs → complete/abort); orphan multipart uploads need abort; storage must be reachable by the client via a public endpoint.

### Option D: tus resumable protocol (tus server)
- A tus server (e.g. tusd) receives chunks and writes to S3.
- **Pros:** Standard resumable protocol with client libs.
- **Cons:** Extra server to run and secure; bytes still flow through an intermediary service; duplicates what S3 multipart already provides.

**Recommendation:** **Option C (S3 multipart with presigned part URLs)** — the only option that meets 10GB while keeping bytes entirely off the API, using the storage the project already targets (S3/MinIO). Fixed part size of 100 MiB (10GB → ~103 parts, well under the 10,000-part limit and above the 5 MiB minimum); declared size validated against the 10GB cap at initiation.

**Decision:** C (S3 multipart upload with presigned part URLs)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Completion Trigger (when processing starts)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload finishes. Something has to (1) finalize the multipart upload and (2) enqueue the processing job. This depends on TD-01 and TD-02.

**Options:**

### Option A: Client calls a "complete" endpoint on the API
- Client sends part ETags to the API; the API runs `CompleteMultipartUpload`, moves the video to `processing` and enqueues the job in the same request flow.
- **Pros:** Single authoritative transition point; ownership checked by the API; synchronous error to the client if completion fails; trivially testable via e2e.
- **Cons:** If the client never calls complete, the upload stays in draft (mitigated by abort endpoint).

### Option B: Storage bucket notification (MinIO/S3 event → queue)
- MinIO publishes `s3:ObjectCreated:CompleteMultipartUpload` events to a target (Redis/AMQP/webhook); the worker reacts.
- **Pros:** No completion endpoint needed for the trigger.
- **Cons:** The client still must call `CompleteMultipartUpload` (needs the API to sign it); MinIO notification config is vendor-specific and differs from AWS S3 (SQS/SNS/EventBridge); harder to test; status transition happens outside the API.

**Recommendation:** **Option A (API complete endpoint)** — keeps status transitions and enqueueing inside the API (one owner, one transaction boundary) and is portable between MinIO and AWS S3.

**Decision:** A (Client calls a "complete" endpoint on the API)

---

## TD-04: Video Worker Runtime

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram defines a separate "Video Worker (FFmpeg)" container. The decision is how its code is packaged relative to the API.

**Options:**

### Option A: Same codebase, separate entrypoint and container
- `nestjs-project` gets a second bootstrap (`NestFactory.createApplicationContext`) that loads only the worker module; Compose runs it as a `video-worker` service from an image that includes FFmpeg.
- **Pros:** Reuses entities, config namespaces, TypeORM data source and storage service; single lint/tsc/test pipeline; independent scaling/crash isolation from the API.
- **Cons:** API image and worker image share dependencies (FFmpeg only needed by the worker image).

### Option B: Separate project (new subproject)
- A standalone Node/TS project with its own package.json.
- **Pros:** Full isolation.
- **Cons:** Duplicates entities/config/storage code or requires a shared package (new monorepo tooling); second test/lint pipeline.

### Option C: In-process consumer inside the API
- The API process registers the `@Processor` itself.
- **Pros:** No extra container.
- **Cons:** CPU-heavy FFmpeg work competes with HTTP handling; contradicts the architecture diagram (separate worker container).

**Recommendation:** **Option A** — honors the C4 diagram (separate container) while reusing the existing NestJS module/config/entity patterns without new monorepo tooling.

**Decision:** A (Same codebase, separate entrypoint and container)

---

## TD-05: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration/metadata and produce a thumbnail. FFmpeg/ffprobe are the de-facto tools; the decision is how Node invokes them and what input they read.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` binaries directly (`child_process.execFile`) reading a presigned GET URL
- `ffprobe -print_format json -show_format -show_streams <url>` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1` for a JPEG thumbnail. FFmpeg reads the object over HTTP (range requests), so the worker does not download 10GB to disk.
- **Pros:** No wrapper dependency; JSON output parsed into typed metadata; no full local copy of the file.
- **Cons:** Must handle process errors/timeouts manually.

### Option B: `fluent-ffmpeg` wrapper
- Fluent builder API on top of the binaries.
- **Pros:** Convenience API (`ffprobe()`, `screenshots()`).
- **Cons:** Repository archived/deprecated upstream; adds a dependency for two simple commands.

### Option C: Download object to local temp file, then run FFmpeg
- **Pros:** Simple local paths.
- **Cons:** Requires up to 10GB scratch disk per job and a full transfer before any processing.

**Recommendation:** **Option A** — two well-defined commands do not justify a deprecated wrapper, and reading via presigned URL avoids 10GB temp copies. Thumbnail frame at 10% of duration (capped at 5s; 0s for very short videos), JPEG, max width 1280.

**Decision:** A (Spawn ffprobe/ffmpeg via child_process.execFile over a presigned GET URL)
**Libraries:** ffmpeg (Debian package — ffprobe/ffmpeg binaries)

---

## TD-06: Object Storage Layout and Endpoints

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is S3-compatible (MinIO locally, S3 in production) — not an open choice. Open: how buckets/keys are organized, and how presigned URLs work given the Docker networking rule (the API reaches MinIO at `minio:9000`, but a client outside Compose cannot resolve `minio`). Cross-component: env schema + compose + storage service + worker.

**Options:**

### Option A: Single private bucket, per-video key prefixes, separate public endpoint for presigning
- Bucket `streamtube` (private); keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Two S3 clients: internal (`S3_ENDPOINT=http://minio:9000`) for server-side calls, public (`S3_PUBLIC_ENDPOINT`) only to sign URLs handed to clients.
- **Pros:** One bucket to provision; all artifacts of a video co-located (simple cleanup); respects the Compose service-name rule internally while giving clients a reachable URL.
- **Cons:** Two client instances to configure.

### Option B: Two buckets (`videos`, `thumbnails`), single endpoint
- **Pros:** Separate policies per bucket (e.g. public-read thumbnails).
- **Cons:** Presigned URLs signed for `minio:9000` are unusable outside Docker; two buckets to provision for no requirement in this phase.

**Recommendation:** **Option A** — minimal provisioning, consistent key scheme keyed by the video id, and correct presigned URLs both inside and outside Compose.

**Decision:** A (Single private bucket, per-video key prefixes, separate public endpoint for presigning)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, URL-safe public identifier that does not collide with others.

**Options:**

### Option A: Expose the UUID primary key
- **Pros:** Zero extra column; uniqueness guaranteed.
- **Cons:** Long, unfriendly URLs (36 chars); couples public URLs to the PK.

### Option B: Random short slug (11-char base64url) with UNIQUE constraint
- `crypto.randomBytes(8)` → base64url (11 chars, 64 bits of entropy), stored in a `slug` column with a unique index; regenerate on unique-violation (bounded retries).
- **Pros:** YouTube-like short URL; non-enumerable; DB-enforced uniqueness; decoupled from PK.
- **Cons:** Extra column + retry path.

### Option C: Hashids/Sqids over a sequential id
- **Pros:** Short, deterministic.
- **Cons:** Requires a sequence/serial column and a lib; reversible encoding leaks creation order/volume.

**Recommendation:** **Option B** — short, non-enumerable and DB-guaranteed unique without new dependencies (`node:crypto`).

**Decision:** B (Random 11-char base64url slug with UNIQUE constraint)

---

## TD-08: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must not require the full download; users must also download the file. The decision is whether bytes are served by the API (streamed from storage) or by storage directly.

**Options:**

### Option A: API streams from storage honoring HTTP Range (206 Partial Content)
- `GET /videos/:slug/stream` forwards the `Range` header to `GetObject` and pipes the body with `206`, `Content-Range`, `Accept-Ranges: bytes`; `GET /videos/:slug/download` pipes the whole object with `Content-Disposition: attachment`.
- **Pros:** Stable URLs on the API domain; access rules enforced per request; testable end-to-end with supertest; Node streams with backpressure (no buffering).
- **Cons:** Playback bandwidth passes through the API process (acceptable for this phase; CDN later).

### Option B: Redirect (302) to presigned GET URLs
- API checks access and redirects to a short-lived presigned URL; storage handles Range natively.
- **Pros:** Zero bandwidth on the API.
- **Cons:** Depends on `S3_PUBLIC_ENDPOINT` reachability from the client; expiring URLs in the player; harder to exercise in e2e inside Compose (public host not resolvable from the container).

### Option C: HLS/DASH transcoding
- **Pros:** Adaptive bitrate.
- **Cons:** Transcoding is not a phase capability; large worker/CPU/storage cost.

**Recommendation:** **Option A** — satisfies "streaming sem download completo" via standard Range/206 with verifiable behavior, and keeps one delivery path (API) for stream, download and thumbnail. Option B remains a later optimization.

**Decision:** A (API streams from storage honoring HTTP Range — 206 Partial Content)
**Libraries:** @aws-sdk/client-s3

---

## TD-09: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video is pre-registered as a draft when the upload starts, then processed asynchronously. The status set and failure policy are shared by API, worker and DB enum.

**Options:**

### Option A: `draft → processing → ready | failed`, queue retries then terminal `failed`
- `draft` on initiate; `processing` on complete (job enqueued with `jobId = videoId`, `attempts: 3`, exponential backoff); worker sets `ready` with metadata/thumbnail; after the last failed attempt the worker sets `failed` and stores `processing_error`. Processing is idempotent (re-running overwrites the same keys).
- **Pros:** Minimal states that map 1:1 to capabilities; transient failures retried automatically; terminal error is visible in DB.
- **Cons:** No intermediate "uploaded" state.

### Option B: Finer-grained states (`uploading`, `uploaded`, `processing`, `ready`, `failed`)
- **Pros:** More observability.
- **Cons:** `uploaded` exists only between two synchronous steps of the same request — adds states with no consumer; diverges from the "rascunho → processando → pronto/erro" vocabulary.

**Recommendation:** **Option A** — matches the challenge vocabulary and uses BullMQ retry semantics (TD-01) with a terminal, queryable `failed` state.

**Decision:** A (draft → processing → ready | failed with queue retries)
**Libraries:** bullmq

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | S3 multipart with presigned part URLs | C (S3 multipart with presigned part URLs) |
| TD-03 | Backend | Upload Completion Trigger | API complete endpoint | A (API complete endpoint) |
| TD-04 | Backend | Video Worker Runtime | Same codebase, separate entrypoint/container | A (Same codebase, separate entrypoint/container) |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | Spawn ffprobe/ffmpeg over presigned URL | A (Spawn ffprobe/ffmpeg over presigned URL) |
| TD-06 | Backend | Object Storage Layout and Endpoints | Single bucket, per-video prefixes, public signing endpoint | A (Single bucket, per-video prefixes, public signing endpoint) |
| TD-07 | Backend | Unique Video URL Identifier | 11-char base64url slug + UNIQUE | B (11-char base64url slug + UNIQUE) |
| TD-08 | Backend | Streaming and Download Delivery | API Range/206 streaming | A (API Range/206 streaming) |
| TD-09 | Backend | Video Status Lifecycle and Failure Handling | draft→processing→ready/failed + retries | A (draft→processing→ready/failed + retries) |
