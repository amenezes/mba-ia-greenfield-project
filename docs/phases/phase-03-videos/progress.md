# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

### SI-03.1 — Infra: dependências, configuração e serviços no Docker Compose
- **Status:** completed
- **Tests:** 8 passing (env.validation.integration-spec.ts)
- **Observations:**
  - Imagem oficial `minio/minio` não está mais disponível no Docker Hub (pull access denied) — usado `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (fork comunitário com mesma CLI/API S3), tag fixada.
  - Redis sem porta publicada no host (consumido apenas pela rede do Compose).
  - Fora de escopo: `.env.example` traz `MAIL_FROM` sem aspas, o que quebra o parser de `.env` do Docker Compose (`unexpected character "<"`) — corrigido apenas no `.env` local.
  - Ambiente local: `compose.override.yaml` não versionado remapeia db→15432 e minio→19000 por conflito de portas no host desta máquina.

### SI-03.2 — StorageModule: cliente S3 (MinIO), multipart, leitura por range e URLs pré-assinadas
- **Status:** completed
- **Tests:** 9 passing (storage.module.spec, storage.service.spec, storage.service.integration-spec)
- **Observations:**
  - Adicionado `src/storage/storage.service.spec.ts` (unit com S3Client real, sem rede) para provar que URLs entregues a clientes usam o host de `S3_PUBLIC_ENDPOINT` e a URL do worker o host interno — de dentro do container os dois endpoints precisam ser o mesmo para o PUT real funcionar.
  - Helper de teste `src/test/storage.ts` (`useInternalEndpointForPresignedUrls`, `putToPresignedUrl`, bucket descartável) reutilizável pelas SIs seguintes.

### SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos
- **Status:** completed
- **Tests:** 71 passing (video.entity + migrations + 10 regression suites)
- **Observations:**
  - Migration gerada via CLI: `src/database/migrations/1791089882275-CreateVideos.ts`.
  - A relação `Channel.videos` exige `Video` em todo DataSource de teste que lista `Channel`: 10 arrays `ALL_ENTITIES` de testes existentes receberam `Video` (sem outra mudança de comportamento).
  - `migrations.integration-spec.ts`: o `beforeAll` passou a derrubar também a tabela `videos` e os enums gerenciados (DROP TYPE) em sequência — sem isso o re-run falharia com tipo já existente; o teste de revert agora cobre `CreateVideos` (última migration).

### SI-03.4 — Fila video-processing: conexão BullMQ e produtor de jobs
- **Status:** completed
- **Tests:** 4 passing (queue module spec, producer integration, app.e2e regression)
- **Observations:**
  - Fix 1: `@nestjs/bullmq@12` é ESM-only (`"type": "module"`, alvo NestJS 12) e quebra o build CommonJS/ts-jest (`Unexpected token 'export'`) apesar do peer aceitar NestJS 11 — trocado para `@nestjs/bullmq@^11.0.5`; `library-refs.md` corrigido.
  - Fix 2: `bullmq@6` torna `ioredis` peer opcional — instalado `ioredis@^5.11.1` (registrado em `library-refs.md`).
  - Teste de integração do produtor usa `prefix: 'streamtube-test'` no BullMQ para não competir com o consumidor do container `video-worker`.

### SI-03.5 — Iniciar upload: pré-cadastro do rascunho e URLs pré-assinadas por parte
- **Status:** completed
- **Tests:** 23 passing (17 unit/integration + 6 e2e em test/videos-upload-initiate.e2e-spec.ts)
- **Observations:**
  - Inserção do rascunho com retry de slug fora de transação (um INSERT autocommit por tentativa), então SAVEPOINT não foi necessário; compensação aborta o multipart se o INSERT falhar.
  - Helper e2e compartilhado `test/helpers/videos-e2e.ts` (bootstrap espelhando `main.ts`, cadastro+confirmação+login com limpeza do throttler).
  - Fora de escopo: warning recorrente do driver `pg` (`client.query() when the client is already executing a query is deprecated`) — preexistente, vem do TypeORM.

### SI-03.6 — Concluir e abortar upload: transição para processing e enfileiramento
- **Status:** completed
- **Tests:** 26 passing (21 unit/integration + 5 e2e em test/videos-upload-complete.e2e-spec.ts)
- **Observations:**
  - Transição `draft → processing` é um UPDATE condicional (`WHERE status = 'draft'`); `affected = 0` (complete concorrente) responde `INVALID_VIDEO_STATUS` sem reenfileirar.
  - E2E pausa a fila `video-processing` durante a suíte (`queue.pause()`/`resume()`) para o consumidor do container não remover os jobs que o teste verifica.
  - Risco conhecido: se o `enqueue` falhar depois do UPDATE, o vídeo fica em `processing` sem job — não há reconciliação nesta fase (candidato a tarefa futura).

### SI-03.7 — MediaProbeService: metadados via ffprobe e thumbnail via ffmpeg
- **Status:** completed
- **Tests:** 11 passing (media-probe unit + integration com ffmpeg real)
- **Observations:**
  - Saída de erro do ffprobe/ffmpeg com 'Invalid data found when processing input' ou 'moov atom not found' vira `InvalidMediaError` (irrecuperável); demais falhas (rede, timeout) seguem como erro comum para permitir retry.
  - Helper `src/test/media.ts` gera MP4 H.264/AAC via `ffmpeg -f lavfi` (reutilizado no worker e no e2e).

### SI-03.8 — Video Worker: processor da fila, entrypoint standalone e container
- **Status:** completed
- **Tests:** 18 passing (processor unit/integration, worker module, videos.service integration, app.e2e) + 20 no re-run após a correção de redação
- **Observations:**
  - `WorkerModule` importa `UsersModule`: `autoLoadEntities` só conhece entidades de `forFeature`, e a relação `Channel.user` exige `User` no grafo (sem isso o worker falhava com 'Entity metadata for Channel#user was not found').
  - Worker em dev roda via `node --watch -r ts-node/register` (`start:worker:dev`) para não disputar o `dist/` com o `nest start --watch` da API no mesmo volume; `start:worker` (prod) usa `dist/worker.js`.
  - Correção de segurança em código do SI-03.7 detectada aqui: a mensagem de erro do ffprobe incluía a URL pré-assinada (com `X-Amz-Signature`) e ia para logs e `videos.processing_error` — agora a entrada é substituída por `<input>`; testes de MediaProbe/Processor cobrem a redação.
  - `DatabaseModule` extraído do `AppModule` (mesma configuração) para a API e o worker compartilharem a conexão sem duplicação.

### SI-03.9 — Leitura pública: detalhes do vídeo e thumbnail pela URL única
- **Status:** completed
- **Tests:** 33 passing (29 unit/integration + 4 e2e em test/videos-read.e2e-spec.ts)
- **Observations:**
  - Fixtures e2e compartilhadas em `test/helpers/videos-fixtures.ts` (canal + vídeo semeado com objetos reais no MinIO) e parser binário do supertest em `test/helpers/videos-e2e.ts`.

### SI-03.10 — Streaming com HTTP Range (206) e download do vídeo
- **Status:** completed
- **Tests:** 61 passing (56 unit/integration + 5 e2e em test/videos-stream.e2e-spec.ts)
- **Observations:**
  - `DomainException` ganhou o campo opcional `headers` e o `DomainExceptionFilter` passou a enviá-los — necessário para o 416 carregar `Content-Range: bytes */{size}`; mudança retrocompatível, coberta por novo caso em `domain-exception.filter.spec.ts`.
  - Status 206 aplicado via `@Res({ passthrough: true })`: o Nest define o status padrão antes do handler e não o sobrescreve no `reply`, então o corpo segue como `StreamableFile` (pipe sem buffer).

### SI-03.11 — Fluxo ponta a ponta, OpenAPI e documentação da fase
- **Status:** completed
- **Tests:** 11 passing (openapi-export integration 10 + videos-pipeline e2e 1)
- **Observations:**
  - Fix 1: o e2e do pipeline pedia `bytes=0-65535`, mas o MP4 gerado tem ~45 KB — o servidor ajustou corretamente o fim para o último byte; teste passou a pedir `bytes=0-1023`.
  - `openapi.json` regenerado via `npm run openapi:export`: 8 paths `/videos*` e 8 schemas novos, sem remover nada existente.
  - Fora de escopo (preexistente): o export via ts-node não aplica o plugin do `@nestjs/swagger`, então request DTOs saem com `properties: {}` (já acontecia com `RegisterDto`); `scripts/sync-openapi.sh` (cópia para `next-frontend/`) não foi executado — frontend fora do escopo da fase.
  - Fora de escopo: `docs/diagrams/software-arch.mermaid` ainda mostra a fila como "TBD" e `Frontend → Object Storage: Streams` (nesta fase o streaming passa pela API, TD-08); o CLAUDE.md da raiz já reflete BullMQ/Redis.
  - Guia de testes (`references/external-systems.md`, `SKILL.md`, `artifacts/services.md`) atualizado: storage = MinIO real, fila = BullMQ/Redis real (resolução IC-1).

## Final verification

- **Unit + integration:** `docker compose exec nestjs-api npm test -- --runInBand` — 38 suites, 243 tests passing (re-run after the follow-up fixes below).
- **E2E:** `docker compose exec nestjs-api npm run test:e2e` — 8 suites, 73 tests passing.
- **Type-check:** `npx tsc --noEmit` — exit 0.
- **Lint:** `npm run lint` — 0 errors (1 pre-existing `no-unsafe-argument` warning, configured as `warn`).
- **Build:** `npm run build` — emits `dist/main.js` and `dist/worker.js`.
- **Observations:**
  - `npm run lint` already failed before this phase (150 errors / 40 warnings in Phase 01/02 code at HEAD). With the user's approval it was fixed in this phase by typing only (no rule relaxed): typed mocks in `auth.service.spec.ts` / `channels.service.spec.ts`, typed response bodies in `test/auth.e2e-spec.ts`, typed Mailpit helper (`src/test/mailpit.ts`), typed unique-violation check in `channels.service.ts`, `DataSourceOptions['entities']` in `create-test-data-source.ts`, unused imports/vars removed.
  - `test/jest-e2e.json` got `"maxWorkers": 1`: `nestjs-project/CLAUDE.md` already stated e2e runs in band, but the config did not enforce it; with 8 e2e files sharing one database, parallel workers caused FK/unique violations.
  - Post-verification consistency fixes: `.env.example` `MAIL_FROM` is now single-quoted (unquoted `<…>` made `docker compose` fail to read a `.env` copied from the example; parsed value unchanged); root `CLAUDE.md` container list and `docs/diagrams/software-arch.mermaid` now match the implementation (queue = BullMQ on Redis; frontend uploads parts to storage via presigned URLs; streaming/download go through the API).
  - Follow-up fix — OpenAPI export: `openapi:export` now runs `nest build && node dist/openapi-export` (was ts-node, which skips the `@nestjs/swagger` CLI plugin and left every request DTO schema empty since the task that introduced it). Regenerated `openapi.json` has 17 schemas, none empty; `openapi-export.integration-spec.ts` asserts the committed artifact keeps request DTO fields. Decision `openapi-docs-nestjs/TD-02` (runtime UI + exported spec) is unchanged — only the script mechanism.
  - Follow-up fix — enqueue failure: if publishing the `process-video` job fails after the `draft → processing` transition, `VideosService.completeUpload` now marks the video `failed` (`processing_error: 'Processing could not be scheduled'`) and rethrows, so no video stays in `processing` without a job (terminal state per TD-09). Covered by a new unit case.
  - Not done (out of the phase scope): `scripts/sync-openapi.sh` + `openapi:types` in `next-frontend/` — regenerating the versioned `next-frontend/lib/api/types.gen.ts` changes the frontend subproject (not set up locally, no `node_modules`), which the challenge excludes from Phase 03. The backend `openapi.json` is ready for that step.
