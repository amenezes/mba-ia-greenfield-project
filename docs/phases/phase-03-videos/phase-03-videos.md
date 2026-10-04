---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-04T01:41:05-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-04T01:41:05-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-04T01:41:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-04T01:17:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver upload de vídeos de até 10GB sem travar o sistema (multipart direto ao object storage, com pré-cadastro automático do vídeo como rascunho), processamento automático em segundo plano por fila e worker (extração de duração e metadados + geração de thumbnail a partir de um frame), URL única por vídeo, reprodução via streaming sem download completo e download do vídeo pelo usuário — com object storage, fila e worker subindo no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços no Docker Compose

**Description:** Instala as libs decididas, cria os namespaces de configuração de storage e fila com validação Joi e sobe MinIO, Redis e o container `video-worker` (com FFmpeg) no Compose — base de infraestrutura de todas as SIs seguintes.

**Technical actions:**

1. Instalar `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` em `nestjs-project/package.json` (versões de `library-refs.md`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Criar `src/config/storage.config.ts` (`registerAs('storage', ...)`) e `src/config/queue.config.ts` (`registerAs('queue', ...)`) com as chaves de `### Data Model → Configuration keys`; adicionar `S3_*` e `REDIS_*` a `src/config/env.validation.ts` (`S3_ACCESS_KEY`/`S3_SECRET_KEY` required) e registrar ambos os configs no `ConfigModule.forRoot({ load })` do `AppModule` (per `phase-01-configuracao-base/TD-02`, `phase-01-configuracao-base/TD-03`)
3. Atualizar `nestjs-project/Dockerfile.dev` para instalar `ffmpeg` (apt) — imagem compartilhada por API e worker (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
4. Adicionar a `nestjs-project/compose.yaml` os serviços `minio` (`minio/minio`, portas 9000/9001, volume, healthcheck), `redis` (`redis:7-alpine`, `--maxmemory-policy noeviction`, healthcheck `redis-cli ping`) e `video-worker` (build `Dockerfile.dev`, volume do código, `depends_on` db/redis/minio healthy); `nestjs-api` passa a depender de `redis` e `minio` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
5. Atualizar `nestjs-project/.env.example` com `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PRESIGNED_URL_EXPIRATION_SECONDS`, `REDIS_HOST=redis`, `REDIS_PORT=6379` (nomes de serviço do Compose, nunca `localhost` para tráfego interno)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (novas chaves `S3_*`/`REDIS_*`) | Integration: schema rejeita ausência de `S3_ACCESS_KEY`/`S3_SECRET_KEY` e aplica defaults | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker`; `minio` e `redis` ficam `healthy`
- `docker compose exec redis redis-cli ping` retorna `PONG`; `curl http://localhost:9000/minio/health/live` retorna `200`
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com sucesso
- Iniciar a aplicação sem `S3_ACCESS_KEY` falha na validação de ambiente com erro citando a variável

---

### SI-03.2 — StorageModule: cliente S3 (MinIO), multipart, leitura por range e URLs pré-assinadas

**Description:** Encapsula todo acesso ao object storage num `StorageService` reutilizado por API e worker, com bucket provisionado no bootstrap e dois clientes S3 (interno e público para assinatura).

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.constants.ts` — provê dois `S3Client` (tokens `S3_INTERNAL_CLIENT` → `storage.endpoint`, `S3_PUBLIC_CLIENT` → `storage.publicEndpoint`), ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-06`; library-refs `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` — `ensureBucket()` (`HeadBucket`/`CreateBucket`, chamado em `onModuleInit`), `createMultipartUpload(key, contentType)`, `presignUploadParts(key, uploadId, partNumbers)` (cliente público, `expiresIn = storage.presignedUrlExpirationSeconds`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`)
3. Adicionar a `StorageService`: `headObject(key)` → `{ size, contentType }`, `getObjectStream(key, range?)` → `{ body: Readable, contentLength, contentRange?, contentType }`, `putObject(key, body, contentType)`, `deleteObject(key)`, `presignInternalGetUrl(key)` (cliente interno, usado pelo worker) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
4. Mapear erros do S3 em `completeMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) para `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, nova em `src/common/exceptions/domain.exception.ts`); demais erros propagam

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation (DI de `storage` config + clientes) | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: MinIO real — bucket bootstrap, multipart completo via `fetch` em URLs pré-assinadas, `headObject`, `getObjectStream` com range, `putObject`/`deleteObject`, mapeamento `INVALID_UPLOAD_PARTS` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — config `storage` e serviço `minio` no Compose

**Acceptance criteria:**

- Bootstrap do módulo com bucket inexistente cria o bucket `S3_BUCKET`; um segundo bootstrap não falha
- Upload de 2 partes via URLs pré-assinadas + `completeMultipartUpload` produz objeto com tamanho igual à soma das partes
- `getObjectStream(key, 'bytes=0-9')` retorna exatamente 10 bytes e `contentRange` `bytes 0-9/{size}`
- `completeMultipartUpload` com ETag inválido lança `INVALID_UPLOAD_PARTS`
- URLs entregues a clientes usam o host de `S3_PUBLIC_ENDPOINT`; a URL de leitura do worker usa o host de `S3_ENDPOINT`

---

### SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos

**Description:** Cria a tabela `videos` ligada ao canal com o ciclo de status, chaves de storage, metadados e slug único — persistência de toda a fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`) com as colunas de `### Data Model → Video`, enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`) em `src/videos/videos.constants.ts`, `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'channel_id' })` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts` (regra: ambos os lados da relação)
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` — tabela, enum `videos_status_enum`, unique `slug`, índice `channel_id`, FK com `ON DELETE CASCADE`
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule`; atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`) e o array de migrations de `src/database/migrations.integration-spec.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `slug`, default `status = draft`, cascade ao remover canal, `bigint` `size_bytes`, `jsonb` `metadata` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: run/revert da migration (restaura estado no `afterAll`) | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com FK `channel_id → channels.id`, unique em `slug` e enum `videos_status_enum`
- Inserir dois vídeos com o mesmo `slug` viola a constraint unique
- Vídeo inserido sem `status` persiste `draft`
- Remover o canal remove seus vídeos (cascade)
- `npm run migration:revert` remove a tabela e o enum sem erro

---

### SI-03.4 — Fila video-processing: conexão BullMQ e produtor de jobs

**Description:** Configura a conexão BullMQ com o Redis e o produtor do job `process-video` conforme o contrato de `### Events/Messages`, compartilhado por API (produtor) e worker (consumidor).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (c) => ({ connection: { host: c.host, port: c.port } }) })`; importado pelo `AppModule` (e pelo `WorkerModule` em SI-03.8) (per `phase-03-videos/TD-01`; library-refs `@nestjs/bullmq`)
2. Criar `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: true`) e o tipo `ProcessVideoJobData { videoId: string }` (per `phase-03-videos/TD-09`)
3. Criar `src/video-processing/video-processing-queue.service.ts` (`VideoProcessingQueue`) — `enqueue(videoId)` via `@InjectQueue(VIDEO_PROCESSING_QUEUE)` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })` (per `phase-03-videos/TD-01`; library-refs `bullmq`)
4. Criar `src/video-processing/video-processing-queue.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, provê e exporta `VideoProcessingQueue` e o `BullModule` da fila

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueueModule` | Unit: compilation com `QueueModule` + config `queue` | `src/video-processing/video-processing-queue.module.spec.ts` |
| `VideoProcessingQueue` | Integration: Redis real — job `process-video` enfileirado com `jobId = videoId`, payload `{ videoId }`, `attempts: 3`; enqueue duplicado não cria segundo job | `src/video-processing/video-processing-queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — config `queue`, lib `@nestjs/bullmq` e serviço `redis`

**Acceptance criteria:**

- `enqueue(videoId)` cria na fila `video-processing` um job `process-video` com id igual ao `videoId` e payload `{ "videoId": "<uuid>" }`
- O job criado tem `attempts = 3` e backoff exponencial de 5000 ms
- Chamar `enqueue` duas vezes com o mesmo `videoId` enquanto o job existe mantém um único job na fila
- A aplicação (`AppModule`) inicializa conectada ao Redis do Compose (`REDIS_HOST=redis`)

---

### SI-03.5 — Iniciar upload: pré-cadastro do rascunho e URLs pré-assinadas por parte

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`
**Authorization:** Authenticated (cria no canal do usuário); `POST /videos/{id}/upload/parts` — Owner

**Description:** Ao iniciar o upload, cria o vídeo como `draft` com slug único e inicia o multipart no storage, devolvendo as URLs pré-assinadas por parte — o arquivo de até 10GB nunca passa pela API.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` (`fileName`, `fileSize`, `contentType`, `title?`) e `src/videos/dto/upload-parts.dto.ts` (`partNumbers`) conforme `#### Validation Rules — videos`; DTOs de resposta (`InitiateUploadResponseDto`, `UploadPartsResponseDto`) com `@ApiProperty` (per `phase-02-auth/TD-06`)
2. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` (consulta do domínio de canais; `VideosModule` importa `ChannelsModule`)
3. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: resolve canal (`ChannelNotFoundException` / `CHANNEL_NOT_FOUND`), gera `slug` com `randomBytes(8).toString('base64url')` e retry em violação unique (máx. 5, SAVEPOINT por tentativa conforme `typeorm-queries.md`), título default = `fileName` sem extensão, `storage_key = videos/{id}/original`, `createMultipartUpload`, persiste `upload_id`, calcula `partCount = ceil(fileSize / UPLOAD_PART_SIZE_BYTES)` e assina todas as partes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
4. Adicionar `VideosService.presignParts(userId, videoId, partNumbers)` — ownership (`VideoNotFoundException` / `VIDEO_NOT_FOUND`), status `draft` (`InvalidVideoStatusException` / `INVALID_VIDEO_STATUS`), faixa `1..partCount` (`INVALID_UPLOAD_PARTS`); novas exceções em `src/common/exceptions/domain.exception.ts`
5. Criar `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()`) com `POST /videos` (201) e `POST /videos/:id/upload/parts` (200, `ParseUUIDPipe`), `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` por status com `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01`); registrar controller, `StorageModule`, `ChannelsModule` e `VideoProcessingQueueModule` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` / `presignParts` | Unit: título default, cálculo de `partCount`, canal ausente, status ≠ draft, part fora da faixa, retry de slug (repo/storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: Postgres + MinIO reais — rascunho persistido com `upload_id`, `storage_key`, slug de 11 chars; URLs assinadas aceitam `PUT` | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna canal do usuário / `null` | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — `VideoProcessingQueueModule` registrado no módulo

**Acceptance criteria:**

- `POST /videos` autenticado com `{ fileName: "aula.mp4", fileSize: 314572800, contentType: "video/mp4" }` retorna `201` com `status: "draft"`, `title: "aula"`, `slug` de 11 caracteres, `partSize: 104857600`, `partCount: 3` e 3 URLs
- O registro em `videos` é criado com `status = draft`, `upload_id` preenchido e `storage_key = videos/{id}/original`
- `POST /videos` com `fileSize: 10737418241` ou `contentType: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- `POST /videos/{id}/upload/parts` com `partNumbers: [4]` para vídeo de 3 partes retorna `400` `INVALID_UPLOAD_PARTS`
- `POST /videos/{id}/upload/parts` por usuário que não é dono retorna `404` `VIDEO_NOT_FOUND`
- Dois vídeos criados em sequência recebem slugs distintos

---

### SI-03.6 — Concluir e abortar upload: transição para processing e enfileiramento

**Route:** POST /videos/{id}/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (também `DELETE /videos/{id}/upload`)

**Description:** Fecha o multipart, valida o tamanho real do arquivo armazenado, move o vídeo para `processing` e publica o job — o processamento começa automaticamente após o upload; o abort descarta o rascunho.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts: { partNumber, etag }[]`, `@ValidateNested` + `@Type`) e `CompleteUploadResponseDto` (per `phase-02-auth/TD-06`)
2. Adicionar `VideosService.completeUpload(userId, videoId, dto)`: ownership + status `draft`; exigir partes exatamente `1..partCount` (`INVALID_UPLOAD_PARTS`); `completeMultipartUpload`; `headObject` — tamanho ≠ `size_bytes` ou > `MAX_VIDEO_SIZE_BYTES` → `deleteObject`, `status = failed`, `processing_error`, `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`); sucesso → `status = processing`, `upload_id = null`, persistir e só então `VideoProcessingQueue.enqueue(id)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`)
3. Adicionar `VideosService.abortUpload(userId, videoId)`: ownership + status `draft` → `abortMultipartUpload` → remover a linha do vídeo (per `phase-03-videos/TD-02`)
4. Adicionar ao `VideosController` `POST /videos/:id/upload/complete` (`@HttpCode(202)`) e `DELETE /videos/:id/upload` (`@HttpCode(204)`), com `ParseUUIDPipe`, `@ApiBearerAuth('access-token')` e `@ApiResponse` por status (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` / `abortUpload` | Unit: partes incompletas, size mismatch (delete + failed), ordem persistir→enqueue, status ≠ draft, ownership (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService` (complete/abort) | Integration: Postgres + MinIO + Redis reais — upload real de partes, `processing` persistido, job `process-video` na fila; abort remove linha e multipart | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — fluxo de iniciação, controller e DTOs base

**Acceptance criteria:**

- `POST /videos/{id}/upload/complete` com todas as partes e ETags válidos retorna `202` com `status: "processing"`
- Após o complete, `videos.status = processing`, `upload_id IS NULL` e existe job `process-video` com id igual ao `id` do vídeo na fila `video-processing`
- Complete com partes faltando retorna `400` `INVALID_UPLOAD_PARTS` e o vídeo permanece `draft`
- Complete cujo objeto armazenado difere de `fileSize` retorna `400` `UPLOAD_SIZE_MISMATCH`, remove o objeto e grava `status = failed`
- Complete em vídeo já `processing` retorna `409` `INVALID_VIDEO_STATUS`
- `DELETE /videos/{id}/upload` de rascunho retorna `204` e a linha deixa de existir; segunda chamada retorna `404` `VIDEO_NOT_FOUND`

---

### SI-03.7 — MediaProbeService: metadados via ffprobe e thumbnail via ffmpeg

**Description:** Isola a invocação dos binários FFmpeg num serviço testável que extrai duração/metadados e gera o JPEG da thumbnail a partir de uma URL, sem copiar o vídeo para disco.

**Technical actions:**

1. Criar `src/video-processing/media-probe.service.ts` — `probe(inputUrl)` executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.execFile` (sem shell, timeout, `maxBuffer`) e retorna `{ durationSeconds, metadata: { formatName, bitRate, width, height, videoCodec, audioCodec } }` (per `phase-03-videos/TD-05`; library-refs `ffmpeg`)
2. Adicionar `extractThumbnail(inputUrl, offsetSeconds)` — `ffmpeg -v error -ss <offset> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` → `Buffer` JPEG; e `thumbnailOffset(duration)` = `min(duration × 0.1, 5)` (0 quando < 1s) (per `phase-03-videos/TD-05`)
3. Criar `src/video-processing/media-probe.errors.ts` — `InvalidMediaError` lançado quando não há stream de vídeo ou a duração não é numérica (consumido pelo processor como erro irrecuperável)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService.thumbnailOffset` / parsing de saída | Unit: regra de offset e mapeamento do JSON do ffprobe (incl. sem stream de áudio, sem stream de vídeo → `InvalidMediaError`) | `src/video-processing/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration: binários reais sobre vídeo gerado por `ffmpeg -f lavfi testsrc` — duração ≈ esperada, dimensões, codec; JPEG válido (magic bytes `FF D8`); arquivo não-vídeo → `InvalidMediaError` | `src/video-processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg instalado na imagem

**Acceptance criteria:**

- `probe` de um vídeo de teste de 3s 320x240 H.264 retorna `durationSeconds ≈ 3`, `width = 320`, `height = 240`, `videoCodec = "h264"`
- `probe` de um arquivo sem stream de vídeo falha com `InvalidMediaError`
- `extractThumbnail` retorna bytes JPEG (início `FF D8`) com largura ≤ 1280
- `thumbnailOffset(120)` = 5, `thumbnailOffset(20)` = 2, `thumbnailOffset(0.5)` = 0

---

### SI-03.8 — Video Worker: processor da fila, entrypoint standalone e container

**Description:** Implementa o consumidor `process-video` que transforma `processing` em `ready` (metadados + thumbnail) ou `failed`, rodando num processo/container separado da API.

**Technical actions:**

1. Adicionar a `VideosService` as transições usadas pelo worker: `findForProcessing(videoId)`, `markReady(videoId, { durationSeconds, metadata, thumbnailKey })` e `markFailed(videoId, reason)` (domínio de vídeos continua dono do status) (per `phase-03-videos/TD-09`)
2. Criar `src/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`: algoritmo de `### Events/Messages → Consumer algorithm` (no-op se ausente/≠ processing; `presignInternalGetUrl`; `probe`; `extractThumbnail`; `putObject videos/{id}/thumbnail.jpg`; `markReady`); `InvalidMediaError` → `UnrecoverableError`; `@OnWorkerEvent('failed')` grava `markFailed` na última tentativa ou erro irrecuperável, com log (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-09`)
3. Extrair `src/database/database.module.ts` (`TypeOrmModule.forRootAsync` com `databaseConfig`, hoje inline no `AppModule`) para ser reutilizado por API e worker sem duplicar parâmetros (per `phase-01-configuracao-base/TD-04` + convenção herdada de fonte única de conexão)
4. Criar `src/video-processing/video-processing-worker.module.ts` (importa `VideosModule`, `StorageModule`; provê `VideoProcessor`, `MediaProbeService`), `src/worker/worker.module.ts` (`ConfigModule` global + `DatabaseModule` + `QueueModule` + módulo do worker) e `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks`) (per `phase-03-videos/TD-04`; library-refs `@nestjs/bullmq`)
5. Adicionar scripts `start:worker` / `start:worker:dev` (`nest start --entryFile worker [--watch]`) em `package.json` e usar `start:worker:dev` como `command` do serviço `video-worker` no `compose.yaml`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: no-op para vídeo ausente/≠ processing, `InvalidMediaError` → `UnrecoverableError`, `failed` só marca na última tentativa (mocks) | `src/video-processing/video.processor.spec.ts` |
| `VideoProcessor` | Integration: Postgres + MinIO + FFmpeg reais — vídeo `processing` com objeto real vira `ready` com `duration_seconds`, `metadata`, thumbnail no bucket; objeto não-vídeo vira `failed` com `processing_error` | `src/video-processing/video.processor.integration-spec.ts` |
| `VideoProcessingWorkerModule` / `WorkerModule` | Unit: compilation | `src/worker/worker.module.spec.ts` |
| `VideosService.markReady` / `markFailed` | Integration: colunas persistidas | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — fila e constantes; SI-03.6 — `VideosService` com transição para `processing`; SI-03.7 — `MediaProbeService`

**Acceptance criteria:**

- Job `process-video` para vídeo `processing` com MP4 válido no storage resulta em `status = ready`, `duration_seconds` preenchido, `metadata.width/height` preenchidos e objeto `videos/{id}/thumbnail.jpg` existente
- Job para vídeo cujo objeto não é vídeo resulta em `status = failed` com `processing_error` não vazio, sem novas tentativas
- Job para vídeo inexistente ou já `ready` termina sem alterar o banco
- `docker compose logs video-worker` mostra o worker iniciado e conectado à fila `video-processing`; o processo da API não registra consumidor da fila
- `AppModule` continua inicializando com a conexão de banco vinda do `DatabaseModule`

---

### SI-03.9 — Leitura pública: detalhes do vídeo e thumbnail pela URL única

**Route:** GET /videos/{slug}
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`
**Authorization:** Anonymous (`@Public()`), também `GET /videos/{slug}/thumbnail`

**Description:** Expõe o vídeo pela sua URL única (slug) com status, duração, metadados e links de stream/download/thumbnail, e serve a thumbnail gerada pelo worker.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` (`VideoResponseDto` com `@ApiProperty` — campos de `#### GET /videos/{slug}`) e mapeamento entidade → DTO no `VideosService` (`streamUrl`, `downloadUrl`, `thumbnailUrl` só quando `ready`)
2. Adicionar `VideosService.findBySlug(slug)` (`VIDEO_NOT_FOUND`) e `VideosService.getThumbnail(slug)` — exige `ready` (`VideoNotReadyException` / `VIDEO_NOT_READY`) e retorna stream de `thumbnail_key` via `StorageService.getObjectStream` (per `phase-03-videos/TD-08`)
3. Adicionar ao `VideosController` `GET /videos/:slug` e `GET /videos/:slug/thumbnail` com `@Public()`, sem `@ApiBearerAuth`; a thumbnail é enviada com `StreamableFile` (`Content-Type: image/jpeg`, `Cache-Control: public, max-age=3600`) (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findBySlug` / `getThumbnail` | Unit: not found, not ready, `thumbnailUrl` nulo fora de `ready` | `src/videos/videos.service.spec.ts` |
| `VideosService.getThumbnail` | Integration: MinIO real — bytes da thumbnail armazenada | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — controller e `VideosService`; SI-03.8 — thumbnail produzida pelo worker (`thumbnail_key`)

**Acceptance criteria:**

- `GET /videos/{slug}` sem token retorna `200` com `slug`, `title`, `status`, `streamUrl: "/videos/{slug}/stream"` e `downloadUrl`
- `GET /videos/{slug}` de vídeo `ready` inclui `durationSeconds`, `metadata` e `thumbnailUrl`; de vídeo `processing` traz `thumbnailUrl: null`
- `GET /videos/{slug}` inexistente retorna `404` `VIDEO_NOT_FOUND`
- `GET /videos/{slug}/thumbnail` de vídeo `ready` retorna `200` `image/jpeg` com bytes iniciando em `FF D8`
- `GET /videos/{slug}/thumbnail` de vídeo `processing` retorna `409` `VIDEO_NOT_READY`

---

### SI-03.10 — Streaming com HTTP Range (206) e download do vídeo

**Route:** GET /videos/{slug}/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous (`@Public()`), também `GET /videos/{slug}/download`

**Description:** Entrega o arquivo original sob demanda: streaming por faixas de bytes (o player não precisa baixar o arquivo inteiro) e download como anexo, ambos repassando o stream do storage sem bufferizar.

**Technical actions:**

1. Criar `src/videos/range.util.ts` — `parseRange(header, size)` para `bytes=a-b`, `bytes=a-`, `bytes=-n` (faixa única; clamp do fim em `size-1`; malformado, multi-range ou `start ≥ size` → `RangeNotSatisfiableException` / `RANGE_NOT_SATISFIABLE`, 416) (per `phase-03-videos/TD-08`)
2. Adicionar `VideosService.openStream(slug, rangeHeader?)` — exige `ready` (`VIDEO_NOT_READY`), resolve tamanho via `size_bytes`, chama `StorageService.getObjectStream(key, 'bytes=a-b')` e retorna `{ stream, status: 206|200, headers }`; e `openDownload(slug)` com `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` (per `phase-03-videos/TD-08`)
3. Adicionar ao `VideosController` `GET /videos/:slug/stream` e `GET /videos/:slug/download` com `@Public()`, `@Res({ passthrough: true })` para status/headers e `StreamableFile` para o corpo; `RangeNotSatisfiableException` também define `Content-Range: bytes */{size}` (via filtro de domínio/handler específico); `@ApiResponse` para 200/206/404/409/416 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseRange` | Unit: formas válidas, clamp, sufixo, malformado, multi-range, fora dos limites | `src/videos/range.util.spec.ts` |
| `VideosService.openStream` / `openDownload` | Unit: not ready, 206 vs 200, headers | `src/videos/videos.service.spec.ts` |
| `VideosService.openStream` | Integration: MinIO real — bytes da faixa iguais ao trecho do objeto | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — `findBySlug` e mapeamento de leitura pública

**Acceptance criteria:**

- `GET /videos/{slug}/stream` com `Range: bytes=0-1023` retorna `206`, `Content-Range: bytes 0-1023/{size}`, `Content-Length: 1024`, `Accept-Ranges: bytes` e exatamente esses bytes do arquivo
- `GET /videos/{slug}/stream` sem `Range` retorna `200` com `Content-Length` igual ao tamanho e `Accept-Ranges: bytes`
- `GET /videos/{slug}/stream` com `Range: bytes={size}-` retorna `416` `RANGE_NOT_SATISFIABLE` com `Content-Range: bytes */{size}`
- `GET /videos/{slug}/download` retorna `200` com `Content-Disposition: attachment` contendo o nome original e corpo idêntico ao arquivo enviado
- Stream/download de vídeo `processing` retornam `409` `VIDEO_NOT_READY`; slug inexistente retorna `404` `VIDEO_NOT_FOUND`

---

### SI-03.11 — Fluxo ponta a ponta, OpenAPI e documentação da fase

**Description:** Prova o pipeline completo upload → fila → worker → streaming contra a infra real do Compose, regenera o `openapi.json` e atualiza a documentação de IA (CLAUDE.md) com vídeos, fila, worker e storage.

**Technical actions:**

1. Criar `test/videos-pipeline.e2e-spec.ts` — fluxo real: registrar/confirmar/login, `POST /videos` (vídeo gerado com `ffmpeg -f lavfi`), `PUT` das partes nas URLs assinadas (no e2e `S3_PUBLIC_ENDPOINT` aponta para `http://minio:9000`, alcançável de dentro do container), `complete`, worker in-process (`VideoProcessingWorkerModule` em contexto de teste) até `ready`, então `GET /videos/{slug}`, thumbnail, stream (206) e download (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)
2. Regenerar `nestjs-project/openapi.json` via script de export existente com os novos endpoints `videos` (per `openapi-docs-nestjs/TD-02`)
3. Atualizar `nestjs-project/CLAUDE.md` (serviços `minio`/`redis`/`video-worker`, verificação de prontidão, comandos do worker, nota de testes com MinIO/Redis reais) e o `CLAUDE.md` da raiz (seção de vídeos: endpoints, fila `video-processing`, worker, storage) — apenas o que existe no código
4. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — estratégia de storage passa a ser MinIO real no Compose (resolução IC-1) e fila definida como BullMQ + Redis

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline upload → fila → worker → stream | E2E: fluxo completo contra Postgres, MinIO, Redis e FFmpeg reais | `test/videos-pipeline.e2e-spec.ts` |
| `openapi.json` export | Integration: spec exportada contém os paths `/videos*` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.8, SI-03.9, SI-03.10 — todas as rotas e o worker prontos

**Acceptance criteria:**

- Um vídeo enviado em partes via URLs pré-assinadas chega a `status = ready` automaticamente após o `complete`, sem intervenção manual
- Após o fluxo, `GET /videos/{slug}/stream` com Range retorna `206` e `GET /videos/{slug}/download` retorna o arquivo íntegro
- `openapi.json` lista `POST /videos`, `POST /videos/{id}/upload/parts`, `POST /videos/{id}/upload/complete`, `DELETE /videos/{id}/upload`, `GET /videos/{slug}`, `/thumbnail`, `/stream`, `/download`
- `CLAUDE.md` (raiz e `nestjs-project/`) descreve somente arquivos, serviços e comandos existentes no repositório
- Definition of Done: `npm test`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` passam no container

---

## Technical Specifications

### Data Model

#### Video (new — table `videos`)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Also the storage key prefix (per phase-03-videos/TD-06) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owner channel (one channel has many videos) |
| slug | varchar(11) | unique, not null | Public unique URL identifier: `crypto.randomBytes(8)` → base64url, 11 chars; regenerated on unique violation, max 5 attempts (per phase-03-videos/TD-07) |
| title | varchar(255) | not null | From request `title`, or the file name without extension when omitted (AMB-2 resolution) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` | Lifecycle per phase-03-videos/TD-09 |
| original_file_name | varchar(255) | not null | Client-declared file name |
| content_type | varchar(100) | not null | Client-declared MIME type, must match `video/*` |
| size_bytes | bigint | not null | Client-declared size (≤ 10 GiB = 10737418240); verified against the stored object at completion. TypeORM maps `bigint` to `string` — entity exposes it as `string` |
| storage_key | varchar(255) | not null | `videos/{id}/original` (per phase-03-videos/TD-06) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while `draft`; set to `null` after complete/abort |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, set by the worker when `ready` |
| duration_seconds | double precision | nullable | From `ffprobe` `format.duration`, set by the worker |
| metadata | jsonb | nullable | `{ formatName, bitRate, width, height, videoCodec, audioCodec }` from `ffprobe` (per phase-03-videos/TD-05) |
| processing_error | text | nullable | Last failure reason when `status = failed` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, inverse side `channel.videos`).
**Indexes:** `(slug)` — unique; `(channel_id)` — b-tree (FK lookups).

#### Status lifecycle (per phase-03-videos/TD-09)

| From | To | Actor | Trigger |
|------|----|-------|---------|
| — | `draft` | API (`VideosService`) | `POST /videos` — pre-registration + multipart initiation |
| `draft` | (row deleted) | API | `DELETE /videos/{id}/upload` — upload aborted by owner |
| `draft` | `processing` | API | `POST /videos/{id}/upload/complete` — multipart completed, size verified, job enqueued |
| `draft` | `failed` | API | `POST /videos/{id}/upload/complete` — stored object size ≠ declared size or > 10 GiB (object deleted) |
| `processing` | `ready` | Worker (`VideoProcessor`) | Metadata extracted + thumbnail stored |
| `processing` | `failed` | Worker | Final attempt failed (3 attempts) or unrecoverable media error (no video stream) |

#### Object storage layout (per phase-03-videos/TD-06)

| Key | Content | Writer |
|-----|---------|--------|
| `videos/{id}/original` | Uploaded video (multipart) | Client via presigned `UploadPart` URLs |
| `videos/{id}/thumbnail.jpg` | JPEG frame, max width 1280 | Worker (`PutObject`) |

Single private bucket `S3_BUCKET` (default `streamtube`), created on API/worker bootstrap when absent. Server-side clients use `S3_ENDPOINT` (`http://minio:9000`); URLs handed to clients are signed with `S3_PUBLIC_ENDPOINT`.

#### Configuration keys (new)

| Env var | Config namespace.key | Default | Used by |
|---------|----------------------|---------|---------|
| `S3_ENDPOINT` | `storage.endpoint` | `http://minio:9000` | API + worker (internal calls, worker presigned GET) |
| `S3_PUBLIC_ENDPOINT` | `storage.publicEndpoint` | `http://localhost:9000` | API (presigned part URLs for clients) |
| `S3_REGION` | `storage.region` | `us-east-1` | both |
| `S3_ACCESS_KEY` | `storage.accessKey` | required | both |
| `S3_SECRET_KEY` | `storage.secretKey` | required | both |
| `S3_BUCKET` | `storage.bucket` | `streamtube` | both |
| `S3_PRESIGNED_URL_EXPIRATION_SECONDS` | `storage.presignedUrlExpirationSeconds` | `3600` | both |
| `REDIS_HOST` | `queue.host` | `redis` | API (producer) + worker (consumer) |
| `REDIS_PORT` | `queue.port` | `6379` | both |

### API Contracts

All endpoints live in `VideosController` (`@Controller('videos')`, `@ApiTags('videos')`, `@SkipThrottle()` at class level — a player issues many Range requests; the global 10 req/min throttler from phase-02-auth/TD-08 is reserved for auth endpoints). Error bodies follow the inherited envelope `{ statusCode, error, message }` (phase-02-auth/TD-07). Upload sizes: `UPLOAD_PART_SIZE_BYTES = 104857600` (100 MiB), `MAX_VIDEO_SIZE_BYTES = 10737418240` (10 GiB) (per phase-03-videos/TD-02).

#### POST /videos (SI-03.5)

Pre-registers the video as `draft` and starts the S3 multipart upload (per phase-03-videos/TD-02, TD-09).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1..255 characters
- fileSize: integer, required — 1..10737418240 (bytes)
- contentType: string, required — must match `^video\/[\w.+-]+$`
- title: string, optional — 1..255 characters; defaults to `fileName` without its extension

**Response 201:**
- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft"`
- uploadId: string
- partSize: integer (bytes, 104857600)
- partCount: integer (`ceil(fileSize / partSize)`)
- parts: array of `{ partNumber: integer, url: string }` — presigned `UploadPart` URLs (signed with `S3_PUBLIC_ENDPOINT`), one per part
- expiresAt: string (ISO-8601) — URL expiry (`now + S3_PRESIGNED_URL_EXPIRATION_SECONDS`)

**Error responses:**
- 401 UNAUTHORIZED: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel
- 400 VALIDATION_ERROR: body fails validation (including `fileSize` > 10 GiB or non-`video/*` `contentType`)

**Client protocol (cross-layer, per phase-03-videos/TD-02):** for each part, `PUT {url}` with the byte range `[(partNumber-1)*partSize, min(partNumber*partSize, fileSize))` as body; read the `ETag` response header; then call `POST /videos/{id}/upload/complete`.

---

#### POST /videos/{id}/upload/parts (SI-03.5)

Re-signs part URLs (e.g., after expiry or to resume a failed part).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1..1000 items, each 1..`partCount`, unique

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }`
- expiresAt: string (ISO-8601)

**Error responses:**
- 401 UNAUTHORIZED
- 404 VIDEO_NOT_FOUND: id unknown or not owned by the caller's channel
- 409 INVALID_VIDEO_STATUS: video is not `draft`
- 400 INVALID_UPLOAD_PARTS: a part number is outside `1..partCount`
- 400 VALIDATION_ERROR: `id` not a UUID or body invalid

---

#### POST /videos/{id}/upload/complete (SI-03.6)

Completes the multipart upload, verifies the stored size, moves the video to `processing` and enqueues the processing job (per phase-03-videos/TD-03, TD-09).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — 1..10000 items of `{ partNumber: integer 1..10000, etag: string non-empty }`

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 401 UNAUTHORIZED
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATUS: video is not `draft`
- 400 INVALID_UPLOAD_PARTS: parts list incomplete (must cover `1..partCount` exactly) or storage rejected the part list/ETags
- 400 UPLOAD_SIZE_MISMATCH: stored object size differs from the declared `fileSize` or exceeds 10 GiB (object deleted; video → `failed`)
- 400 VALIDATION_ERROR

---

#### DELETE /videos/{id}/upload (SI-03.6)

Aborts an in-progress upload: aborts the multipart upload in storage and deletes the draft video.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 401 UNAUTHORIZED
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATUS: video is not `draft`
- 400 VALIDATION_ERROR: `id` not a UUID

---

#### GET /videos/{slug} (SI-03.9)

Public video details by unique URL identifier (any status — lets the uploader poll processing).

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- durationSeconds: number | null
- metadata: `{ formatName, bitRate, width, height, videoCodec, audioCodec }` | null
- sizeBytes: string (bigint as decimal string)
- contentType: string
- channelId: string (uuid)
- streamUrl: string — `/videos/{slug}/stream`
- downloadUrl: string — `/videos/{slug}/download`
- thumbnailUrl: string | null — `/videos/{slug}/thumbnail` when `ready`, else `null`
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/{slug}/thumbnail (SI-03.9)

**Response 200:** `image/jpeg` body (streamed from storage), `Cache-Control: public, max-age=3600`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status is not `ready`

---

#### GET /videos/{slug}/stream (SI-03.10)

Streams the original file honoring HTTP Range (per phase-03-videos/TD-08).

**Request headers:**
- Range: `bytes={start}-{end}` | `bytes={start}-` | `bytes=-{suffix}`, optional (single range only)

**Response 206 (Range present and satisfiable):**
- Headers: `Content-Type: {content_type}`, `Content-Range: bytes {start}-{end}/{size}`, `Content-Length: {end-start+1}`, `Accept-Ranges: bytes`
- Body: requested byte range

**Response 200 (no Range):**
- Headers: `Content-Type`, `Content-Length: {size}`, `Accept-Ranges: bytes`
- Body: full object

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY
- 416 RANGE_NOT_SATISFIABLE: malformed/multi-range header or start ≥ size (response also carries `Content-Range: bytes */{size}`)

---

#### GET /videos/{slug}/download (SI-03.10)

**Response 200:**
- Headers: `Content-Type: {content_type}`, `Content-Length: {size}`, `Content-Disposition: attachment; filename="{original_file_name}"` (RFC 6266 `filename*` UTF-8 variant included)
- Body: full object (streamed)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — videos

- `fileName`: required string, 1..255 chars
- `fileSize`: required integer, min 1, max 10737418240
- `contentType`: required string, regex `^video\/[\w.+-]+$`
- `title`: optional string, 1..255 chars
- `partNumbers`: required array, 1..1000 unique integers ≥ 1
- `parts`: required array, 1..10000 items; `partNumber` integer 1..10000; `etag` non-empty string
- `id` path param: UUID (`ParseUUIDPipe` → 400 VALIDATION_ERROR)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✓ | — | Video is created in the caller's channel |
| POST /videos/{id}/upload/parts | ✗ | ✗ | ✓ | Non-owner gets 404 VIDEO_NOT_FOUND (existence not revealed) |
| POST /videos/{id}/upload/complete | ✗ | ✗ | ✓ | Same |
| DELETE /videos/{id}/upload | ✗ | ✗ | ✓ | Same |
| GET /videos/{slug} | ✓ | ✓ | ✓ | `@Public()` (AMB-1 resolution: public read) |
| GET /videos/{slug}/thumbnail | ✓ | ✓ | ✓ | `@Public()`; only `ready` |
| GET /videos/{slug}/stream | ✓ | ✓ | ✓ | `@Public()`; only `ready` |
| GET /videos/{slug}/download | ✓ | ✓ | ✓ | `@Public()`; only `ready` |

Ownership = `video.channel_id` equals the id of the channel whose `user_id` is the JWT `sub`. Ownership is decided in `VideosService` (layer-separation rule), never in the controller.

### Error Catalog

Inherits the error response format `{ statusCode, error, message }` from phase-02-auth (Error Catalog). New domain exceptions in `src/common/exceptions/domain.exception.ts`:

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the current user | POST /videos when the JWT `sub` has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `id`/`slug`, or `id` not owned by the caller's channel |
| INVALID_VIDEO_STATUS | 409 | Video is not in a valid status for this operation | upload parts/complete/abort when status ≠ `draft` |
| INVALID_UPLOAD_PARTS | 400 | Upload parts are invalid | part numbers outside `1..partCount`; complete with incomplete part list; storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 400 | Uploaded file size does not match the declared size | stored object `ContentLength` ≠ `size_bytes` or > 10 GiB after completion |
| VIDEO_NOT_READY | 409 | Video is not ready | thumbnail/stream/download when status ≠ `ready` |
| RANGE_NOT_SATISFIABLE | 416 | Requested range not satisfiable | malformed, multi-range, or out-of-bounds `Range` header on stream |

Worker-side failures are not HTTP errors: they are recorded in `videos.processing_error` with `status = failed` (see Events/Messages).

### Events/Messages

#### video-processing / process-video (BullMQ job)

**Queue:** `video-processing` — **Job name:** `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (idempotent enqueue — a second enqueue while the job exists is ignored), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: true` (state of record lives in `videos`).

**Producer:** `VideoProcessingQueue.enqueue(videoId)` called by `VideosService.completeUpload` after the `draft → processing` transition is persisted (per phase-03-videos/TD-01, TD-03)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')`, `WorkerHost`) running only in the `video-worker` container via `src/worker.ts` (per phase-03-videos/TD-04)
**Trigger:** successful `POST /videos/{id}/upload/complete`
**Delivery semantics:** at-least-once (per phase-03-videos/TD-01). The consumer is idempotent: it skips jobs whose video no longer exists or is not `processing`; reprocessing overwrites the same thumbnail key and metadata columns.

**Consumer algorithm (per phase-03-videos/TD-05, TD-09):**
1. Load video; if absent or `status ≠ processing` → return (no-op).
2. Presign an internal `GET` URL for `storage_key` (signed with `S3_ENDPOINT`).
3. `ffprobe -v error -print_format json -show_format -show_streams <url>` → duration (`format.duration`), `formatName`, `bitRate`, first video stream (`width`, `height`, `codec_name`), first audio stream (`codec_name`). No video stream or unparsable duration → throw BullMQ `UnrecoverableError` (no retries).
4. Thumbnail offset = `min(duration × 0.1, 5)` seconds (`0` when duration < 1s); `ffmpeg -v error -ss <offset> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` → JPEG buffer → `PutObject videos/{id}/thumbnail.jpg` (`image/jpeg`).
5. Persist `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processing_error = null`.

**Failure handling:** `@OnWorkerEvent('failed')` — when `job.attemptsMade >= job.opts.attempts` or the error is `UnrecoverableError`, persist `status = failed` and `processing_error = error.message`. Errors are logged, never swallowed silently (background-task exception to the services error rule).

**Video Worker container:** `video-worker` Compose service, same image/codebase as the API (`Dockerfile.dev` with `ffmpeg` installed), command runs `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`), depends on `db`, `redis`, `minio` being healthy.

---

## Dependency Map

```
SI-03.1 (root — deps, config, Compose: minio, redis, video-worker, ffmpeg)
├── SI-03.2 — depends on SI-03.1 (config `storage` + serviço minio)
├── SI-03.4 — depends on SI-03.1 (config `queue` + serviço redis)
└── SI-03.7 — depends on SI-03.1 (ffmpeg na imagem)
SI-03.3 (root, independent — entidade Video + migration)

SI-03.5 — depends on SI-03.2 + SI-03.3 + SI-03.4 (storage, entidade, módulo da fila)
└── SI-03.6 — depends on SI-03.5 (complete/abort sobre o rascunho criado)
    └── SI-03.8 — depends on SI-03.4 + SI-03.6 + SI-03.7 (fila, transição processing, probe)
        └── SI-03.9 — depends on SI-03.5 + SI-03.8 (controller + thumbnail gerada)
            └── SI-03.10 — depends on SI-03.9 (leitura pública por slug)
                └── SI-03.11 — depends on SI-03.6 + SI-03.8 + SI-03.9 + SI-03.10 (fluxo completo)
```

---

## Deliverables

- [x] SI-03.1 — Infra: dependências, configuração e serviços no Docker Compose
- [x] SI-03.2 — StorageModule: cliente S3 (MinIO), multipart, leitura por range e URLs pré-assinadas
- [x] SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos
- [x] SI-03.4 — Fila video-processing: conexão BullMQ e produtor de jobs
- [x] SI-03.5 — Iniciar upload: pré-cadastro do rascunho e URLs pré-assinadas por parte
- [x] SI-03.6 — Concluir e abortar upload: transição para processing e enfileiramento
- [x] SI-03.7 — MediaProbeService: metadados via ffprobe e thumbnail via ffmpeg
- [x] SI-03.8 — Video Worker: processor da fila, entrypoint standalone e container
- [x] SI-03.9 — Leitura pública: detalhes do vídeo e thumbnail pela URL única
- [x] SI-03.10 — Streaming com HTTP Range (206) e download do vídeo
- [x] SI-03.11 — Fluxo ponta a ponta, OpenAPI e documentação da fase

**Full test suites:**

- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
