---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-04T01:17:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T01:41:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-04T01:17:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-04T01:17:47-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-04T01:17:47-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-04T01:17:47-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-04T01:17:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ (Neighbor Phase 04 owns video editing, categories, visibility and draft → publish flow.)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly in this phase's section of project-plan.md._

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — depende de Fase 01.
- **Phase 04:** Gerenciamento de Vídeos e Canal — depende de Fase 02, Fase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis via @nestjs/bullmq) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Protocol for Files up to 10GB | decided | C (S3 multipart upload with presigned part URLs) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Upload Completion Trigger (when processing starts) | decided | A (Client calls a "complete" endpoint on the API) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime | decided | A (Same codebase, separate entrypoint and container) | — |
| phase-03-videos/TD-05 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (Spawn ffprobe/ffmpeg via child_process.execFile over a presigned GET URL) | ffmpeg (Debian package — ffprobe/ffmpeg binaries) |
| phase-03-videos/TD-06 | phase | Backend | Object Storage Layout and Endpoints | decided | A (Single private bucket, per-video key prefixes, separate public endpoint for presigning) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | phase | Backend | Unique Video URL Identifier | decided | B (Random 11-char base64url slug with UNIQUE constraint) | — |
| phase-03-videos/TD-08 | phase | Backend | Streaming and Download Delivery | decided | A (API streams from storage honoring HTTP Range — 206 Partial Content) | @aws-sdk/client-s3 |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (draft → processing → ready \| failed with queue retries) | bullmq |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the queue technique officially specified by NestJS docs (`@nestjs/bullmq`), gives retries/backoff/idempotent job ids out of the box (needed by TD-09), and adds a single small Redis container. RabbitMQ would require hand-building retry/backoff; pg-boss does not deliver a dedicated queue service.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-02

**Recommendation:** the only option that meets 10GB while keeping bytes entirely off the API, using the storage the project already targets (S3/MinIO). Fixed part size of 100 MiB (10GB → ~103 parts, well under the 10,000-part limit and above the 5 MiB minimum); declared size validated against the 10GB cap at initiation.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** keeps status transitions and enqueueing inside the API (one owner, one transaction boundary) and is portable between MinIO and AWS S3.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** honors the C4 diagram (separate container) while reusing the existing NestJS module/config/entity patterns without new monorepo tooling.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** two well-defined commands do not justify a deprecated wrapper, and reading via presigned URL avoids 10GB temp copies. Thumbnail frame at 10% of duration (capped at 5s; 0s for very short videos), JPEG, max width 1280.
**Libraries:** ffmpeg (Debian package — ffprobe/ffmpeg binaries)

### phase-03-videos/TD-06

**Recommendation:** minimal provisioning, consistent key scheme keyed by the video id, and correct presigned URLs both inside and outside Compose.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-07

**Recommendation:** short, non-enumerable and DB-guaranteed unique without new dependencies (`node:crypto`).
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** satisfies "streaming sem download completo" via standard Range/206 with verifiable behavior, and keeps one delivery path (API) for stream, download and thumbnail. Option B remains a later optimization.
**Libraries:** @aws-sdk/client-s3

### phase-03-videos/TD-09

**Recommendation:** matches the challenge vocabulary and uses BullMQ retry semantics (TD-01) with a terminal, queryable `failed` state.
**Libraries:** bullmq

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. PostgreSQL is already in the stack, so no new infrastructure needed.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important; keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP, works with Mailpit for local development.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on; a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration; scoping rate limiting via guards with `@SkipThrottle()` for exemptions. Single-instance, in-memory storage is sufficient.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value.
**Note:** Decision deliberately diverged — JWT was kept to reuse the access-token signing/verification infrastructure.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — strict `[a-z0-9_]` allowlist for channel handles with `user_<random>` fallback.
**Libraries:** —

### phase-02-auth-frontend/TD-01 … TD-07

**Recommendation:** Frontend-only (Next.js BFF with cookie session via `iron-session`, server-side refresh single-flight, react-hook-form + Zod forms, Route Handlers as the single mutation surface, RSC-delivered session, RSC-first token pages). No backend constraint for Phase 03 beyond the strict-BFF model (frontend calls NestJS only through Route Handlers).
**Libraries:** iron-session, react-hook-form, @hookform/resolvers

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (Runtime UI + `openapi.json` exportado) — o custo marginal é apenas um npm script e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI apenas em dev/staging (via env flag) — alinha com a postura defensiva já estabelecida em phase 02; o `openapi.json` commitado cumpre o papel de spec consultável fora da UI.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped; BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password destination screen absent from Figma. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Exception Filter | Unit + E2E |
| Queue consumer / processor (future-types) | Processor with business logic: Unit (mock deps) + Integration (real DB/storage); external calls only: Integration |

External-system strategies declared by the testing guide (`references/external-systems.md`): PostgreSQL — real (Docker `db`); **Object Storage — local filesystem adapter in dev and tests, S3 in production**; Message Queue — real broker in Docker (technology TBD; BullMQ example with `REDIS_HOST`/`REDIS_PORT`); Email — Mailpit.
