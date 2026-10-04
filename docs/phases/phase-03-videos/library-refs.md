---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-04T01:40:21-03:00"
  "bullmq":
    version: "^6.3.11"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-04T01:40:21-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "n/a (transitive requirement of bullmq@6 — see note below)"
    fetched_at: "2026-10-04T01:40:21-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-04T01:40:21-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-04T01:40:21-03:00"
  "ffmpeg (Debian package — ffprobe/ffmpeg binaries)":
    version: "Debian bookworm/trixie package installed in the worker image"
    context7_id: "n/a (system binary — CLI flags documented below)"
    fetched_at: "2026-10-04T01:40:21-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T01:41:05-03:00"
---

# Library References — phase-03-videos

Version compatibility check: `@nestjs/bullmq@11.0.5` declares peers `@nestjs/common|core ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6` — compatible with the installed NestJS `^11.0.1`. **Do not use `@nestjs/bullmq@12.x`**: it (and `@nestjs/bull-shared@12`) ships ESM-only (`"type": "module"`) for NestJS 12, which the CommonJS build and ts-jest setup of this project cannot load (`SyntaxError: Unexpected token 'export'`) even though its peer range still lists NestJS 11. `bullmq@6` ships CommonJS (`dist/cjs`) but declares `ioredis` (`>=5.0.0`) as an **optional peer dependency** — it must be installed explicitly (`ioredis@^5.11.1`), otherwise every `Queue`/`Worker` fails with "BullMQ could not load the optional 'ioredis' package". `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are released in lockstep (same version).

### @nestjs/bullmq

Used by: phase-03-videos/TD-01, TD-04, TD-09.

- Root connection, async with config injection (project convention: `ConfigType` + `KEY`):
  ```ts
  BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (config: ConfigType<typeof queueConfig>) => ({
      connection: { host: config.host, port: config.port },
    }),
  });
  BullModule.registerQueue({ name: 'video-processing' });
  ```
- Producer: `constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}` (`Queue` from `bullmq`).
- Consumer: class decorated with `@Processor('video-processing')` extending `WorkerHost`, implementing `async process(job: Job): Promise<...>`; must be registered as a provider. Worker events via `@OnWorkerEvent('failed')` inside the processor class.
- Standalone worker bootstrap: `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener (`docs.nestjs.com/application-context`).
- Test helper: `getQueueToken('video-processing')` resolves the injected `Queue` from a testing module.

### bullmq

Used by: phase-03-videos/TD-01, TD-09.

- `queue.add(name, data, { jobId, attempts, backoff: { type: 'exponential', delay }, removeOnComplete, removeOnFail })`.
- **Job ids:** a job id already present in the queue is not re-added (idempotent enqueue). Jobs removed by `removeOnComplete`/`removeOnFail` are **not** considered duplicates — the same id can be added again after removal.
- Worker `failed` event receives `(job, error)`; `job.attemptsMade` vs `job.opts.attempts` tells whether the failure is final.
- Tests: `queue.getJobs(['waiting'])`, `queue.obliterate({ force: true })` / `queue.drain()` to isolate state between tests; always `await queue.close()` in `afterAll`.

### @aws-sdk/client-s3

Used by: phase-03-videos/TD-02, TD-06, TD-08.

- Reuse one `S3Client` per endpoint/credentials (EFFECTIVE_PRACTICES). Config used here: `{ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }` (path-style required by MinIO).
- **Checksum defaults (v3.729+):** the SDK computes CRC32 checksums by default on `PutObject`/`UploadPart`. For S3-compatible third-party storage and for presigned part URLs used by plain HTTP clients, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on the client (aws-sdk-js-v3 issue #6810).
- Multipart: `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (PartNumber 1–10000, part ≥ 5 MiB except last, ≤ 5 GiB) → `ETag`; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- Ranged reads: `GetObjectCommand({ Bucket, Key, Range: 'bytes=0-9' })` → `ContentLength` (range size), `ContentRange: 'bytes 0-9/43'`, `AcceptRanges: 'bytes'`, `Body` is a Node `Readable` (consume or destroy to free the socket).
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType`.
- `PutObjectCommand` for the thumbnail upload; `HeadBucketCommand`/`CreateBucketCommand` for bucket bootstrap.

### @aws-sdk/s3-request-presigner

Used by: phase-03-videos/TD-02, TD-05, TD-06.

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` in seconds (default 900). Works with any command, e.g. `new UploadPartCommand({...})` for part URLs and `new GetObjectCommand({...})` for the worker's ffprobe/ffmpeg input URL.
- The signature binds the host: URLs handed to clients must be signed with a client whose `endpoint` is the public endpoint (`S3_PUBLIC_ENDPOINT`); URLs used inside Compose (worker → MinIO) are signed with the internal endpoint (`http://minio:9000`).

### ffmpeg (ffprobe / ffmpeg binaries)

Used by: phase-03-videos/TD-05.

- Metadata: `ffprobe -v error -print_format json -show_format -show_streams <input>` → JSON `{ format: { duration, size, format_name, bit_rate }, streams: [{ codec_type, codec_name, width, height, ... }] }`.
- Thumbnail: `ffmpeg -v error -ss <seconds> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` (or an output file path). `-ss` before `-i` performs fast input seeking (HTTP range requests when input is a URL).
- Both accept an `http(s)://` presigned URL as `<input>`; invoke via `child_process.execFile` (no shell) with a timeout and `maxBuffer` sized for the output.
