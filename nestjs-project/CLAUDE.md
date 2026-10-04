# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (object storage):** `docker compose ps minio` — expect `(healthy)` (the healthcheck probes `/minio/health/live`)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started — consuming queue "video-processing"`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing worker (same image/codebase as the API, FFmpeg installed); runs `npm run start:worker:dev` and consumes the `video-processing` queue. It starts with the stack (`restart: unless-stopped`) — this is infrastructure, not the API dev server
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7 for BullMQ (`--maxmemory-policy noeviction`), reachable only inside the Compose network (`REDIS_HOST=redis`)
- `minio` — S3-compatible object storage (`pgsty/minio`), API port `9000`, console port `9001`, credentials `streamtube` / `streamtube123`; bucket `streamtube` is created by the API/worker on bootstrap
- `mailpit` — SMTP capture, ports `1025` (SMTP) and `8025` (UI/API)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/worker.js)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

The `video-worker` container runs `npm run start:worker:dev` itself (`node --watch` + `ts-node` on `src/worker.ts`, so it never shares `dist/` with the API's `nest start --watch`). Do not start a second worker inside `nestjs-api`.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Integration and e2e tests use the **real** Compose infrastructure — PostgreSQL, MinIO (S3 API), Redis (BullMQ) and the FFmpeg binaries in the image; storage and queue are never mocked in those layers. Conventions specific to the video stack:

- Presigned URLs are signed for `S3_PUBLIC_ENDPOINT` (a host address), which does not resolve inside the container. Tests call `useInternalEndpointForPresignedUrls()` (`src/test/storage.ts`) before the config loads, so URLs point to `http://minio:9000`.
- Integration tests that touch BullMQ register `BullModule.forRoot({ ..., prefix: 'streamtube-test' })` so the running `video-worker` never consumes their jobs. E2E suites that assert enqueued jobs pause the `video-processing` queue for their duration (`queue.pause()` / `queue.resume()`).
- Test videos are generated on the fly with `generateTestVideo()` (`src/test/media.ts`, ffmpeg `lavfi`); e2e helpers live in `test/helpers/`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the codebase: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (standalone video worker, `WorkerModule` via `NestFactory.createApplicationContext`). Both use `DatabaseModule` (TypeORM connection) and `QueueModule` (BullMQ connection to Redis).

### Video modules (Phase 03)

| Module | Path | Responsibility |
|--------|------|----------------|
| `VideosModule` | `src/videos/` | `Video` entity, `VideosService` (draft pre-registration, unique slug, upload complete/abort, status transitions, public read, Range streaming) and `VideosController` (`/videos` endpoints) |
| `StorageModule` | `src/storage/` | `StorageService` over the S3 API (MinIO): bucket bootstrap, multipart upload + presigned part URLs, ranged reads, put/delete; two `S3Client`s (internal `S3_ENDPOINT`, public `S3_PUBLIC_ENDPOINT` for signing) |
| `QueueModule` | `src/queue/` | BullMQ root connection (`queue` config → Redis) |
| `VideoProcessingQueueModule` | `src/video-processing/` | Registers queue `video-processing` and the `VideoProcessingQueue` producer (`process-video` job, `jobId = videoId`, 3 attempts, exponential backoff) |
| `VideoProcessingWorkerModule` | `src/video-processing/` | `VideoProcessor` (consumer) + `MediaProbeService` (`ffprobe` metadata, `ffmpeg` thumbnail); loaded **only** by `WorkerModule` (`src/worker/`) |

Endpoints (`/videos`, all with `@SkipThrottle()`): `POST /videos`, `POST /videos/:id/upload/parts`, `POST /videos/:id/upload/complete` (202), `DELETE /videos/:id/upload` (204) — authenticated, owner-only; `GET /videos/:slug`, `GET /videos/:slug/thumbnail`, `GET /videos/:slug/stream` (Range → 206), `GET /videos/:slug/download` — `@Public()`. Contracts, error codes and the job payload are specified in `docs/phases/phase-03-videos/phase-03-videos.md`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
