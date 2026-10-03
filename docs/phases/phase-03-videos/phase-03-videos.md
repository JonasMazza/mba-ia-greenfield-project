---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-24T20:07:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-24T14:25:37-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20T13:23:34-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de upload e processamento de vídeos: armazenamento em object storage, upload resumável de até 10GB sem trafegar bytes pela API (presigned S3 multipart), pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento assíncrono via fila com um worker FFmpeg separado (extração de duração/metadados + geração de thumbnail), URL pública única por vídeo, reprodução via streaming e download por URLs presigned, e o ciclo de status de processamento (`draft → processing → ready | failed`) com notificação ao frontend por polling.

---

## Step Implementations

### SI-03.1 — Criar módulo videos, entidade Video e migration

**Description:** Fundação do domínio de vídeos — módulo `videos/`, entidade `Video` e a migration que cria a tabela `videos` e o enum `video_status`.

**Technical actions:**

1. Criar `videos/videos.module.ts` — módulo do domínio de vídeos.
2. Criar `videos/entities/video.entity.ts` conforme `## Technical Specifications → Data Model` (colunas, tipos, defaults, `@ManyToOne` → `Channel` com `@JoinColumn({ name: 'channel_id' })`, índices; `public_id` único) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-09`).
3. Criar migration `CreateVideos` — cria o enum `video_status` (`draft|processing|ready|failed`) e a tabela `videos` com FK `channel_id` → `channels(id)` ON DELETE CASCADE, índices em `channel_id` e `status`, e `up()`/`down()` simétricos (o `down()` derruba a tabela **e** o enum).
4. Registrar `VideosModule` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints (unique `public_id`, FK `channel_id`), defaults (`status='draft'`, `processing_attempts=0`), nullability | `videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: `up()` cria tabela + enum; `down()` derruba ambos | `database/migrations.integration-spec.ts` (estender) |

O `beforeAll`/`beforeEach` do spec de migrations que derruba tabelas gerenciadas **deve derrubar também o enum `video_status`** (senão `type "video_status" already exists` ao re-rodar após o `down()` da migration).

**Dependencies:** none

**Acceptance criteria:**

- Inserir um `Video` sem `public_id` viola a constraint `NOT NULL`; inserir dois com o mesmo `public_id` viola a constraint `UNIQUE`.
- Um `Video` recém-criado sem `status` explícito persiste com `status = 'draft'` e `processing_attempts = 0`.
- Remover o `Channel` dono remove em cascata seus `Video` (ON DELETE CASCADE).
- A migration aplica (`up`) e reverte (`down`) sem erro, deixando o schema idêntico ao estado anterior (tabela e enum removidos no `down`).

---

### SI-03.2 — Provider de object storage (MinIO/S3) + infra

**Description:** Cliente de object storage sobre o AWS SDK v3, apontando para o MinIO em dev, que assina URLs e orquestra o multipart — a API nunca trafega bytes.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (pin `3.10xx`) (per `phase-03-videos/TD-02`).
2. Adicionar o serviço `minio` ao `docker-compose` (bucket privado de vídeos + bootstrap), com CORS expondo `ETag` para o browser completar o multipart (per `phase-03-videos/TD-03`).
3. Criar `src/config/storage.config.ts` com `registerAs` (endpoint = service name Docker, `forcePathStyle: true`, credenciais, bucket) — nunca `localhost`.
4. Criar `videos/storage/object-storage.service.ts` encapsulando `S3Client`: `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `presignGetObject` (com `response-content-disposition` opcional) via `getSignedUrl` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
5. Registrar `ObjectStorageService` como provider em `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ObjectStorageService` | Integration (MinIO real): ciclo multipart create→presign part→PUT→complete e `presignGetObject` retorna URL que serve Range | `videos/storage/object-storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (provider registrado no `VideosModule`)

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` não-vazio para uma key no bucket de vídeos.
- Uma URL presigned de `UploadPart` aceita um PUT de ≥5 MiB e devolve um `ETag`; `completeMultipartUpload` com esse `{ ETag, PartNumber }` materializa o objeto.
- `presignGetObject` produz uma URL que responde a requisições com header `Range` (leitura parcial), sem passar pela API.
- `abortMultipartUpload` invalida o `UploadId`, impedindo o complete posterior.

---

### SI-03.3 — Provider de fila em background (pg-boss)

**Description:** Fila durável sobre o PostgreSQL existente para os jobs de processamento de vídeo, com enqueue transacional e idempotência.

**Technical actions:**

1. Instalar `pg-boss` (per `phase-03-videos/TD-01`).
2. Criar `src/config/queue.config.ts` com `registerAs` (connection string derivada do `databaseConfig`, schema/opções do pg-boss).
3. Criar `videos/queue/queue.service.ts` — ciclo de vida (`onModuleInit` sobe o boss, `onModuleDestroy` encerra), `enqueue(name, payload, opts)` com suporte a `singletonKey` e enqueue dentro de transação, e `work(name, handler)` (per `phase-03-videos/TD-01`).
4. Registrar `QueueService` como provider em `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration (PG real): `enqueue` grava o job; `work` consome o payload; `singletonKey` deduplica enqueues concorrentes | `videos/queue/queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (provider registrado no `VideosModule`)

**Acceptance criteria:**

- Um job enfileirado com `enqueue('video.process', { videoId })` é entregue ao handler registrado por `work` com o mesmo payload.
- Dois `enqueue` com o mesmo `singletonKey` resultam em um único job processado (idempotência).
- Enfileirar dentro de uma transação que sofre rollback não deixa o job na fila.

---

### SI-03.4 — Endpoint de início de upload (POST /videos)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Description:** Pré-cadastra o vídeo como rascunho e abre o upload multipart, devolvendo `public_id` e o `upload_id` para o cliente enviar as partes direto ao MinIO.

**Technical actions:**

1. Instalar `nanoid` e criar `videos/utils/public-id.ts` — gerador com alfabeto 62-char `[0-9a-zA-Z]`, length 12 (per `phase-03-videos/TD-06`).
2. Criar `InitiateUploadDto` conforme `## Technical Specifications → API Contracts → POST /videos` e `→ Validation Rules — videos` (`content_type` `video/*`, `size_bytes` 1..10 GiB, `part_size_bytes` opcional ≥5 MiB).
3. Implementar `VideosService.initiateUpload()` — gerar `public_id` único (retry em colisão de constraint), criar a linha `draft` do vídeo vinculada ao `Channel` do usuário, chamar `objectStorage.createMultipartUpload()` e persistir `upload_id`/`storage_key`, calcular `part_count`/`part_size_bytes` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`).
4. Criar `VideosController` com `POST /videos` conforme API Contracts, protegido pelo guard de autenticação existente (per `## Technical Specifications → Authorization Matrix`).
5. Registrar `VideosController` em `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Integration: rascunho persistido com `public_id`/`upload_id`/`storage_key`; colisão de `public_id` faz retry | `videos/videos.service.integration-spec.ts` |
| `public-id` util | Unit: comprimento 12, alfabeto `[0-9a-zA-Z]` | `videos/utils/public-id.spec.ts` |

Cenários E2E (201, 413 `FILE_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`, 401, validação de DTO) são autorados por `/plan-test-specs`.

**Dependencies:** SI-03.1 (entidade), SI-03.2 (storage multipart)

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna `201` com `{ public_id, upload_id, part_size_bytes, part_count, expires_in }` e cria um `Video` em `status='draft'` no canal do usuário.
- `POST /videos` com `size_bytes` acima de 10 GiB retorna `413` com `errorCode: "FILE_TOO_LARGE"`.
- `POST /videos` com `content_type` fora de `video/*` retorna `415` com `errorCode: "UNSUPPORTED_MEDIA_TYPE"`.
- `POST /videos` sem autenticação retorna `401`.

---

### SI-03.5 — Ciclo de upload: presign de partes, complete e abort

**Route:** POST /videos/:publicId/upload/parts · POST /videos/:publicId/upload/complete · DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-cycle.plan.md`
**Description:** Completa o protocolo de upload resumável — re-presign de partes faltantes, finalização (com transição para `processing` e enqueue do job) e abort.

**Technical actions:**

1. Criar `PresignPartsDto` e `CompleteUploadDto` conforme API Contracts (`part_numbers[]`; `parts[] = { part_number, etag }`).
2. Implementar `VideosService.presignParts()` — reemite URLs presigned de `UploadPart` para os `part_numbers` pedidos (caminho de resume), validando estado `draft` e posse (per `phase-03-videos/TD-03`).
3. Implementar `VideosService.completeUpload()` — `completeMultipartUpload`, e **na mesma transação** transicionar `draft → processing` e `queue.enqueue('video.process', { videoId }, { singletonKey })` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-09`).
4. Implementar `VideosService.abortUpload()` — `abortMultipartUpload` e descartar o rascunho, validando estado abortável (per `phase-03-videos/TD-03`).
5. Adicionar ao `VideosController` as rotas de parts/complete/abort conforme API Contracts, restritas ao dono (per `## Technical Specifications → Authorization Matrix`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Integration: transição `draft→processing` e job `video.process` enfileirado atomicamente | `videos/videos.service.integration-spec.ts` (estender) |
| `VideosService.presignParts` / `abortUpload` | Integration: presign só em `draft` do dono; abort descarta rascunho e invalida o upload | `videos/videos.service.integration-spec.ts` (estender) |

Cenários E2E (posse, `409 INVALID_UPLOAD_STATE`, `404 VIDEO_NOT_FOUND`, `204` no abort) são autorados por `/plan-test-specs`.

**Dependencies:** SI-03.4 (serviço/controller de vídeos), SI-03.2 (storage), SI-03.3 (fila — enqueue no complete)

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` do dono com `parts` válidas retorna `200` com `status: "processing"`, e um job `video.process` fica enfileirado.
- `POST /videos/:publicId/upload/parts` para um vídeo sem upload ativo retorna `409` com `errorCode: "INVALID_UPLOAD_STATE"`.
- Operar o ciclo de upload de um vídeo de outro dono retorna `404` com `errorCode: "VIDEO_NOT_FOUND"` (não vaza existência).
- `DELETE /videos/:publicId/upload` de um rascunho do dono retorna `204` e o `public_id` deixa de ser resolvível.

---

### SI-03.6 — Worker FFmpeg de processamento de vídeo

**Description:** Serviço separado que consome `video.process`, extrai metadados e thumbnail via FFmpeg e atualiza o vídeo para `ready`/`failed`.

**Technical actions:**

1. Criar o app standalone do worker (`worker/main.ts` com `NestFactory.createApplicationContext`) reusando entidades, `DataSource` e config da API, sem servidor HTTP (per `phase-03-videos/TD-04`).
2. Criar `worker/Dockerfile` (`node:<ver>-slim` + `apt-get install -y ffmpeg`) e adicionar o serviço do worker ao `docker-compose` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`).
3. Criar `worker/ffmpeg.util.ts` — invocação via `execFile` de `ffprobe` (duração `format.duration`, `streams[].width/height`, `codec_name`, `format.bit_rate`) e `ffmpeg` para thumbnail de um frame com input-seeking (`-ss` antes de `-i`), lendo URL presigned via Range com fallback de disco temporário (per `phase-03-videos/TD-05`).
4. Criar `worker/video-processor.service.ts` — `queue.work('video.process')`: extrair metadados, gerar+subir thumbnail (`thumbnail_key`), persistir e marcar `ready`; em falha, incrementar `processing_attempts` e, esgotado o limite, marcar `failed` com `failure_reason` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-processor` | Integration (ffmpeg real sobre fixture curto): metadados extraídos, thumbnail gerada, linha atualizada para `ready` | `worker/video-processor.service.integration-spec.ts` |
| `video-processor` (falha) | Integration: input inválido esgota retries e marca `failed` com `failure_reason` | `worker/video-processor.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (entidade/DataSource), SI-03.2 (storage), SI-03.3 (fila — consumo)

**Acceptance criteria:**

- Ao consumir `video.process` de um vídeo em `processing`, o worker persiste `duration_seconds`, `width`, `height`, `codec`, `bitrate` e um `thumbnail_key`, e transiciona para `status='ready'`.
- Um input que o FFmpeg não consegue processar leva o vídeo a `status='failed'` com `failure_reason` preenchido após esgotar as tentativas.
- O reprocessamento do mesmo `videoId` (mesmo `singletonKey`) não duplica trabalho nem thumbnails.

---

### SI-03.7 — Endpoint de status de processamento (polling)

**Route:** GET /videos/:publicId/status
**Test Specs:** see `nestjs-project/specs/videos-status.plan.md`
**Description:** Endpoint de polling pelo qual o dono acompanha o ciclo `draft → processing → ready | failed`.

**Technical actions:**

1. Implementar `VideosService.getStatus()` — resolve o vídeo por `public_id` restrito ao dono e projeta o status; quando `ready`, inclui metadados + `thumbnail_url` presigned; quando `failed`, inclui `failure_reason` (per `phase-03-videos/TD-09`).
2. Adicionar `GET /videos/:publicId/status` ao `VideosController` conforme API Contracts, restrito ao dono (per `## Technical Specifications → Authorization Matrix`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStatus` | Integration: projeção por estado (`processing` sem metadados; `ready` com metadados+thumbnail; `failed` com `failure_reason`) | `videos/videos.service.integration-spec.ts` (estender) |

Cenários E2E (`200` por estado, `404`, restrição ao dono) são autorados por `/plan-test-specs`.

**Dependencies:** SI-03.4 (serviço/controller de vídeos)

**Acceptance criteria:**

- `GET /videos/:publicId/status` do dono de um vídeo `ready` retorna `200` com `status`, `duration_seconds`, `width`, `height` e `thumbnail_url`.
- Para um vídeo `failed`, o mesmo endpoint retorna `200` com `status: "failed"` e `failure_reason`.
- `GET /videos/:publicId/status` de um vídeo que não pertence ao requisitante retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.

---

### SI-03.8 — Playback público: metadata, streaming e download

**Route:** GET /videos/:publicId · GET /videos/:publicId/stream · GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Description:** Resolve o vídeo público pela URL única e emite URLs presigned de streaming (Range) e download (attachment) — bytes servidos direto pelo MinIO.

**Technical actions:**

1. Implementar `VideosService.getPublicVideo()` — resolve por `public_id`; libera para qualquer um quando `ready`, e retorna 404 para não-donos quando não-`ready` (sem vazar existência) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`).
2. Implementar `VideosService.getStreamUrl()` e `getDownloadUrl()` — autorizam e emitem `presignGetObject` com TTL curto; download acrescenta `response-content-disposition: attachment` com `filename` sanitizado/URL-encoded (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
3. Adicionar ao `VideosController` `GET /videos/:publicId`, `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` conforme API Contracts (per `## Technical Specifications → Authorization Matrix`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPublicVideo` / `getStreamUrl` / `getDownloadUrl` | Integration: gate por `ready`, 404 não-vaza para não-dono, presign com disposition correta | `videos/videos.service.integration-spec.ts` (estender) |

Cenários E2E (`200` com `{ url, expires_in }`, `404`, `409 VIDEO_NOT_READY`) são autorados por `/plan-test-specs`.

**Dependencies:** SI-03.4 (serviço/controller de vídeos), SI-03.2 (storage — presign GET)

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com metadados públicos (`title`, `duration_seconds`, `thumbnail_url`, ...).
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com `{ url, expires_in }`, e a `url` responde a requisições com header `Range`.
- `GET /videos/:publicId/download` de um vídeo `ready` retorna `200` com uma `url` cujo download chega como anexo (disposition `attachment`).
- `GET /videos/:publicId` de um `public_id` inexistente, ou de um vídeo não-`ready` por um não-dono, retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.

---

## Technical Specifications

### Data Model

#### Video

New entity `Video` (`videos` table) in the `videos/` module. Created by a TypeORM migration that also defines the `video_status` enum type.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')` — project convention). Internal identity, never exposed. |
| public_id | varchar(12) | unique, not null — nanoid, 62-char alphabet `[0-9a-zA-Z]`, length 12; the only id ever exposed *(TD-06)* |
| channel_id | uuid | not null, FK → `channels(id)` ON DELETE CASCADE — owning channel |
| title | varchar(255) | nullable — not captured at upload; set later by the edit/publish flow (Fase 04) |
| status | `video_status` enum | not null, default `'draft'` — `draft \| processing \| ready \| failed` *(TD-09)* |
| storage_key | varchar(512) | nullable — object key of the original file in the video bucket *(TD-02)* |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; retained during upload for part re-presign / complete / abort, cleared after complete *(TD-03)* |
| content_type | varchar(127) | nullable — declared MIME type of the upload |
| size_bytes | bigint | nullable — total object size in bytes (≤ 10 GB) |
| duration_seconds | integer | nullable — derived from ffprobe `format.duration` *(TD-05)* |
| width | integer | nullable — derived from ffprobe `streams[].width` *(TD-05)* |
| height | integer | nullable — derived from ffprobe `streams[].height` *(TD-05)* |
| codec | varchar(64) | nullable — derived from ffprobe `codec_name` *(TD-05)* |
| bitrate | integer | nullable — derived from ffprobe `format.bit_rate` *(TD-05)* |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail *(TD-05)* |
| processing_attempts | integer | not null, default 0 — bounded retry counter before transition to `failed` *(TD-09)* |
| failure_reason | varchar(512) | nullable — populated when `status = failed` *(TD-09)* |
| created_at | timestamptz | not null, `@CreateDateColumn` |
| updated_at | timestamptz | not null, `@UpdateDateColumn` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (`@ManyToOne`, `@JoinColumn({ name: 'channel_id' })`).

**Indexes:** unique on `public_id`; index on `channel_id` (list videos by channel); index on `status` (worker/queue reconciliation queries).

**Enum:** `video_status` = `draft | processing | ready | failed` (new Postgres enum type, created and dropped by the migration).

**Notes:**

- ffprobe output names (`format.duration`, `streams[].width/height`, `codec_name`, `format.bit_rate`) are the *source* fields the worker reads *(TD-05)*; the column names above are the persisted projection — the mapping lives in the worker.
- TD-06 recommends **UUID v7** for the internal PK (index locality). The established project convention is `@PrimaryGeneratedColumn('uuid')` (v4), and PostgreSQL 17 has no native `uuidv7()`. The plan keeps the v4 convention for consistency; adopting v7 would require an app-side default or extension and is an optional optimization, not a requirement.
- Storage key layout (original vs thumbnail) follows the bucket/key organization decided in *(TD-02)*; keys are opaque to the DB (plain `varchar`).

### API Contracts

Backend tier (Scope-driven). All endpoints address the video by its `public_id` — the internal `id` is never exposed *(TD-06)*. Playback/download stream bytes directly from MinIO via presigned URLs — the API only authorizes and issues URLs, never proxies bytes *(TD-07, TD-08)*.

#### POST /videos (SI-03.4)

Initiate an upload: pre-registers a draft video and opens an S3 multipart upload *(TD-03, TD-06)*.

**Request headers:**
- Content-Type: application/json
- (authenticated session — see Authorization Matrix)

**Request body:**
- filename: string, required — original file name (extension used to derive the storage key)
- content_type: string, required — MIME type; must be `video/*`
- size_bytes: integer, required — total size in bytes; 1 .. 10737418240 (10 GiB)
- part_size_bytes: integer, optional — desired part size; server clamps to ≥ 5 MiB (except the last part)

**Response 201:**
- public_id: string — the nanoid public identifier
- upload_id: string — S3 multipart `UploadId`
- part_size_bytes: integer — the part size the client must use
- part_count: integer — number of parts for the declared size
- expires_in: integer — TTL (seconds) applying to presigned part URLs requested next

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 413 FILE_TOO_LARGE: when `size_bytes` exceeds 10 GiB
- 415 UNSUPPORTED_MEDIA_TYPE: when `content_type` is not `video/*`

---

#### POST /videos/:publicId/upload/parts (SI-03.5)

(Re)issue presigned `UploadPart` URLs for a batch of part numbers — also the resume path (re-presign only the missing parts) *(TD-03)*.

**Request headers:**
- Content-Type: application/json
- (authenticated owner)

**Request body:**
- part_numbers: integer[], required — 1-based part numbers to presign (each 1 .. 10000)

**Response 200:**
- parts: array of `{ part_number: integer, url: string }` — presigned `UploadPart` URLs
- expires_in: integer — TTL (seconds) of the returned URLs (~600)

**Error responses:**
- 400 validation error: when `part_numbers` is missing/empty/out of range
- 404 VIDEO_NOT_FOUND: when no video with `publicId` exists for this owner
- 409 INVALID_UPLOAD_STATE: when the video has no active multipart upload (not in `draft`)

---

#### POST /videos/:publicId/upload/complete (SI-03.5)

Finalize the multipart upload, transition `draft → processing`, and enqueue the processing job atomically *(TD-01, TD-03, TD-09)*.

**Request headers:**
- Content-Type: application/json
- (authenticated owner)

**Request body:**
- parts: array of `{ part_number: integer, etag: string }`, required — the `ETag` MinIO returned for each uploaded part

**Response 200:**
- public_id: string
- status: string — `processing`

**Error responses:**
- 400 validation error: when `parts` is missing/malformed
- 404 VIDEO_NOT_FOUND: when no video with `publicId` exists for this owner
- 409 INVALID_UPLOAD_STATE: when the video is not in `draft` / has no active upload

---

#### DELETE /videos/:publicId/upload (SI-03.5)

Abort an in-progress upload: `AbortMultipartUpload` + discard the draft *(TD-03)*.

**Request headers:**
- (authenticated owner)

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `publicId` exists for this owner
- 409 INVALID_UPLOAD_STATE: when the video is not in an abortable (`draft`) state

---

#### GET /videos/:publicId/status (SI-03.7)

Owner polling for the processing lifecycle *(TD-09)*.

**Request headers:**
- (authenticated owner)

**Response 200:**
- public_id: string
- status: string — `draft | processing | ready | failed`
- duration_seconds: integer, present when `ready`
- width: integer, present when `ready`
- height: integer, present when `ready`
- thumbnail_url: string (presigned GET), present when `ready`
- failure_reason: string, present when `failed`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `publicId` exists for this owner

---

#### GET /videos/:publicId (SI-03.8)

Resolve public video metadata (the API behind the frontend `/watch/:publicId` page) *(TD-06, TD-07)*.

**Response 200:**
- public_id: string
- title: string | null
- status: string — `ready` (non-ready videos are not resolvable by non-owners)
- duration_seconds: integer
- width: integer
- height: integer
- thumbnail_url: string (presigned GET)
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the `publicId` does not exist, or the video is not `ready` and the requester is not the owner (existence is not leaked)

---

#### GET /videos/:publicId/stream (SI-03.8)

Authorize playback and issue a short-lived presigned MinIO GET URL that supports HTTP Range (seeking / partial playback) *(TD-07)*.

**Response 200:**
- url: string — presigned MinIO GET URL (Range-capable)
- expires_in: integer — TTL (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the `publicId` does not exist, or the video is not `ready` and the requester is not the owner
- 409 VIDEO_NOT_READY: when the owner requests a stream for a video still `draft`/`processing`/`failed`

---

#### GET /videos/:publicId/download (SI-03.8)

Reuse the presigned-URL mechanism with an attachment disposition to hand the original file to the user *(TD-08)*.

**Response 200:**
- url: string — presigned MinIO GET URL carrying `response-content-disposition: attachment; filename="..."` (filename sanitized/URL-encoded to avoid `SignatureDoesNotMatch`)
- expires_in: integer — TTL (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the `publicId` does not exist, or the video is not `ready` and the requester is not the owner
- 409 VIDEO_NOT_READY: when the owner requests a download for a non-`ready` video

---

#### Validation Rules — videos

- `content_type`: required, must match `video/*`.
- `size_bytes`: required, integer, 1 .. 10737418240 (10 GiB); over the ceiling → `413 FILE_TOO_LARGE`.
- `part_size_bytes`: optional; when provided, ≥ 5242880 (5 MiB) — the S3/MinIO minimum for every part except the last.
- `part_numbers[]`: each integer 1 .. 10000 (S3 multipart part-number ceiling); non-empty.
- `parts[].part_number`: integer 1 .. 10000; `parts[].etag`: non-empty string.
- Presigned URL TTL: short-lived (~600s); part URLs are re-fetchable via `POST /videos/:publicId/upload/parts` for resume *(TD-03)*.

**Note (playback response shape):** `stream`/`download` return the presigned URL as JSON `{ url, expires_in }`; a `302` redirect to the same URL is an acceptable equivalent left to implementation *(TD-07, TD-08)*.

### Authorization Matrix

"Authenticated" = a logged-in user who is **not** the video's owner. "Owner" = the owner of the video's channel.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:publicId/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /videos/:publicId/status | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ † | ✓ † | ✓ |
| GET /videos/:publicId/stream | ✓ † | ✓ † | ✓ |
| GET /videos/:publicId/download | ✓ † | ✓ † | ✓ |

† Only when the video is `ready`. For a non-`ready` video, a non-owner receives `404 VIDEO_NOT_FOUND` (existence is not leaked); the owner can access it in any state. Anonymous playback/download is free per the product model (only social features require auth).

**Note (visibility deferral):** TD-07 anticipates a `public` vs `unlisted` distinction where the API authorizes each URL issuance. The publish/visibility flow itself lands in **Fase 04** (rascunho e publicação). In this phase the URL-issuance gate is on **processing status (`ready`) + ownership**; a per-video visibility flag can layer on top of this same authorization seam without changing the contract.

### Error Catalog

Response envelope `{ statusCode, error, message }` with machine-readable domain codes is **inherited** from `phase-02-auth/TD-07` (custom domain exception filter) — not redefined here. Only the phase-specific codes are listed.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `public_id` inexistente, ou vídeo não-`ready` acessado por quem não é o dono |
| VIDEO_NOT_READY | 409 | Dono solicita stream/download de um vídeo ainda `draft`/`processing`/`failed` |
| INVALID_UPLOAD_STATE | 409 | presign de partes / complete / abort sem upload multipart ativo (vídeo não está em `draft`) |
| FILE_TOO_LARGE | 413 | `size_bytes` acima de 10 GiB |
| UNSUPPORTED_MEDIA_TYPE | 415 | `content_type` não é `video/*` |

### Events/Messages

The queue substrate is **pg-boss** on the existing PostgreSQL 17 *(TD-01, Repo-wide infra)*; the consumer runs in a **separate FFmpeg worker** Compose service *(TD-04, Repo-wide infra)*. Both are infrastructure that this event rides on — no HTTP surface.

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`) — the job is created **inside the same DB transaction** as the `draft → processing` status transition on upload complete, exploiting pg-boss's transactional enqueue *(TD-01)*.
**Consumer:** the **Video Worker** — a standalone NestJS worker with FFmpeg (per `phase-03-videos/TD-04`), consuming via pg-boss `boss.work('video.process', handler)`, reusing the API's entities + DataSource to read/update the `videos` row.
**Trigger:** fires on `POST /videos/:publicId/upload/complete`, once the multipart upload is finalized.
**Delivery semantics:** at-least-once — pg-boss is durable/WAL-backed with retry/backoff and a DLQ; `singletonKey = videoId` provides idempotency (per `phase-03-videos/TD-01`).

**Worker actions (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`):**

1. Read the `videos` row; open the original object via a short-lived presigned MinIO GET URL (ffprobe/ffmpeg read Range directly — 10 GB inputs are not downloaded whole; temp-disk fallback for non-faststart MP4s).
2. Extract metadata with `ffprobe` → `duration_seconds`, `width`, `height`, `codec`, `bitrate`.
3. Generate a thumbnail from a single frame with `ffmpeg` (input-seeking `-ss` before `-i`); upload it and persist `thumbnail_key`.
4. On success → `status = ready` (with metadata + thumbnail). On failure → increment `processing_attempts`; retry within the bounded limit, then `status = failed` with `failure_reason` *(TD-09)*.

The frontend learns of completion by polling `GET /videos/:publicId/status` — there is no worker→API push *(TD-09)*.

---

## Dependency Map

```
SI-03.1 (root) — módulo videos + entidade Video + migration
├── SI-03.2 — depends on SI-03.1 (provider de storage registrado no módulo)
│   └── SI-03.4 — depends on SI-03.1, SI-03.2 (rascunho + createMultipartUpload)
│       ├── SI-03.5 — depends on SI-03.4, SI-03.2, SI-03.3 (ciclo de upload + enqueue no complete)
│       ├── SI-03.7 — depends on SI-03.4 (endpoint de status no controller de vídeos)
│       └── SI-03.8 — depends on SI-03.4, SI-03.2 (playback presign)
├── SI-03.3 — depends on SI-03.1 (provider de fila registrado no módulo)
└── SI-03.6 — depends on SI-03.1, SI-03.2, SI-03.3 (worker: entidade + storage + consumo da fila)
```

Nós-raiz: **SI-03.1**. SI-03.5 e SI-03.6 são os pontos de convergência (dependem de storage + fila).

---

## Deliverables

- [ ] SI-03.1 — Criar módulo videos, entidade Video e migration
- [ ] SI-03.2 — Provider de object storage (MinIO/S3) + infra
- [ ] SI-03.3 — Provider de fila em background (pg-boss)
- [ ] SI-03.4 — Endpoint de início de upload (POST /videos)
- [ ] SI-03.5 — Ciclo de upload: presign de partes, complete e abort
- [ ] SI-03.6 — Worker FFmpeg de processamento de vídeo
- [ ] SI-03.7 — Endpoint de status de processamento (polling)
- [ ] SI-03.8 — Playback público: metadata, streaming e download

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
