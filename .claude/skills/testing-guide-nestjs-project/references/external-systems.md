> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage via the Docker `minio` service (Compose). Decided in phase-03-videos (validation IC-1): presigned multipart uploads cannot be exercised against a local-filesystem adapter, so storage is **never** mocked in integration/e2e tests. Production uses S3 with the same API.

**How tests reach it:**
- `StorageModule` + `ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] })`; `module.init()` bootstraps the bucket.
- Presigned URLs are signed for `S3_PUBLIC_ENDPOINT` (host address, unreachable from inside the container). Call `useInternalEndpointForPresignedUrls()` from `src/test/storage.ts` **before** the config loads.
- Upload a part to a presigned URL with `putToPresignedUrl(url, buffer)` (returns the ETag).
- For bucket-level tests, use a throwaway bucket (`process.env.S3_BUCKET = 'streamtube-test-<random>'`) and remove it with `emptyAndDeleteBucket()`.
- Seed objects with `StorageService.putObject`; verify with `headObject` / `getObjectStream`.

---

## Message Queue — Real BullMQ on Redis (Docker)

**Strategy:** Real Redis via the Docker `redis` service; the queue technology is BullMQ (`@nestjs/bullmq`), decided in phase-03-videos/TD-01.

**Isolation from the running `video-worker` container** (it consumes the default prefix):
- Integration tests register their own root connection with a dedicated prefix and clean it per test:

```typescript
BullModule.forRoot({
  connection: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  prefix: 'streamtube-test',
}),
// ...
const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
beforeEach(() => queue.obliterate({ force: true }));
```

- E2E suites (which boot `AppModule` with the default prefix) that assert enqueued jobs call `queue.pause()` in `beforeAll` and `queue.resume()` in `afterAll`.
- Publisher tests assert the job by id (`queue.getJob(videoId)`): name, data and options (`attempts`, `backoff`).
- Consumer tests call `VideoProcessor.process(job)` / `onFailed(job, error)` directly with a job-shaped object, against real DB, MinIO and FFmpeg.
- The full pipeline e2e boots `WorkerModule` in-process and polls the DB until the video leaves `processing`.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
