---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-24
scope_description: "Upload and processing pipeline for videos: object-storage access, background job queue, 10GB resumable upload without buffering through the API, a separate FFmpeg worker for metadata + thumbnail extraction, unique public video URLs, streaming playback, download, and the processing-status lifecycle with FE notification."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Owns the new `videos/` module (draft pre-registration, presigned-URL issuance, streaming/download endpoints, status endpoint), the `videos` table + migration (FK to `channels`), the storage-client provider, the job-queue producer, and a **new separate worker** Compose service (own Dockerfile with FFmpeg) that consumes jobs and updates the video row. Also owns the Compose additions (MinIO, worker, and — depending on TD-01 — a queue service).
- `next-frontend/` — **no UI screens decided in this document.** The upload screen, player, and channel dashboard are deferred to a later frontend slice (following the `phase-02-auth` → `phase-02-auth-frontend` precedent). This document does decide the **cross-layer contracts** the frontend must implement when that slice lands: the 10GB upload handshake (TD-03), the streaming/download URL model (TD-07, TD-08), and the processing-status polling contract (TD-09). Those TDs are marked `Scope: Cross-layer` and are decided once here.

> Inherited anchors (already decided — do NOT reopen):
> - **Object storage = S3/MinIO** by architecture (`docs/diagrams/software-arch.mermaid`, `docs/project-plan.md`). What is open is *how* to use it (client lib, bucket/key layout, presigned-URL strategy), not *whether*.
> - **PostgreSQL 17 + TypeORM 0.3.28** persistence, **Docker Compose** with service-name hosts (root `CLAUDE.md`), the domain **error envelope `{ statusCode, error, message }`** (`phase-02-auth/TD-07`), **JWT bearer auth + custom guards** for authenticated endpoints (`phase-02-auth/TD-02`), and the **strict-BFF** frontend model — the browser only talks to same-origin `/api/...`, only server code reads `API_URL` (`next-frontend-config-base/TD-03`). Cross-layer TDs below respect these.
> - **`channels` table exists** (`id` uuid PK, one-to-one with `users`); `videos` FKs to it via `channel_id`.

---

## TD-01: Message Queue for Background Video Processing

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `project-plan.md` marks the queue as **TBD** — this is the phase's one genuinely open stack decision. The API must publish a "process this video" job after upload completes; a separate worker container consumes it (heavy FFmpeg work that must never block the API). The choice sets what infra Compose gains and how durable/retryable jobs are.

**Options:**

### Option A: pg-boss (job queue on the existing PostgreSQL 17)
- Job queue built on Postgres `SKIP LOCKED`; creates its own `pgboss` schema inside the DB already in Compose. API calls `boss.send('video-processing', data)`; the worker calls `boss.work(...)`. No official Nest wrapper — a thin `PgBossService` provider wraps it.
- **Pros:** **Zero new infra service** (reuses `db`); durable by default via Postgres WAL/backups; **transactional enqueue** — the job can be inserted in the *same* transaction as the draft video row (no dual-write divergence); native retry/backoff, dead-letter queue, and `singletonKey` idempotency.
- **Cons:** No official NestJS package (write the provider glue) and **not a first-class context7 library** (docs come from the `timgit/pg-boss` GitHub/site, not context7 — flag for `plan-resolve`); throughput is Postgres-bound and polling adds some DB load; fewer turnkey dashboards than BullMQ.

### Option B: BullMQ + Redis (`@nestjs/bullmq` 11.x + `bullmq` 5.x)
- Redis-backed queue with first-class Nest integration (`@InjectQueue` producer, `@Processor`/`WorkerHost` consumer). Adds a `redis` service to Compose.
- **Pros:** Best-in-class job semantics for heavy async work (attempts/backoff, stalled-job recovery, progress, concurrency, repeatable jobs); version-matched `@nestjs/bullmq` 11.0.4; rich observability ecosystem (Bull Board).
- **Cons:** **Adds Redis** — extra container, volume, memory tuning, new failure domain (against the minimal-infra preference); durability is Redis-persistence-dependent and **not transactional** with Postgres writes; two datastores to operate/back up.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport + `amqplib`)
- Broker-based; worker bootstrapped as an RMQ microservice (`@EventPattern`), API produces via `ClientProxy.emit`. Uses the already-installed `@nestjs/microservices`; adds a `rabbitmq` service.
- **Pros:** Cleanest producer/consumer split by design; durable queues with manual ack/requeue; mature routing if the pipeline later fans out (multiple renditions/stages).
- **Cons:** **Heaviest new infra** (broker to tune + manage); **retry/backoff/DLQ are manual** (DLX + TTL wiring) — most work to reach the reliability the other two give declaratively; no transactional enqueue with Postgres.

**Recommendation:** **Option A (pg-boss)** — PostgreSQL 17 is already in Compose, the project has an explicit minimal-infra preference, and video jobs need durability more than raw throughput. pg-boss delivers durable, WAL-backed jobs with retry/backoff, a real DLQ, and `singletonKey` idempotency **without adding a container**, and uniquely lets the processing job be enqueued in the same transaction as the draft-video insert. Honest cost: a thin hand-written provider and non-context7 docs. **BullMQ + Redis is a strong runner-up** — pick it if job dashboards, progress reporting, or higher throughput later outweigh adding a second datastore.

**Decision:** A (pg-boss)

---

## TD-02: Object-Storage Client & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO (S3-compatible) is fixed by architecture; what is open is the client library and how objects are laid out. The client must presign upload URLs (TD-03) and download/streaming URLs (TD-07/08), so its presigning ergonomics constrain those TDs. A bucket/key scheme must separate untrusted uploads from servable output and never collide across videos.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- `S3Client` with `endpoint: 'http://minio:9000'`, `forcePathStyle: true`, static creds. Genuine S3v4 signer that MinIO accepts natively; presigns any command (`PutObject`, `UploadPart`, `GetObject`) via `getSignedUrl`. context7 `/aws/aws-sdk-js-v3` (pin a specific `3.10xx`).
- **Pros:** Dedicated, individually-presignable command classes for the **entire multipart flow** (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`Abort`) — exactly what TD-03 needs; identical code targets MinIO in dev and real S3 in prod by swapping `endpoint`; TypeScript-native, best-documented.
- **Cons:** Larger dependency surface (several `@aws-sdk/*` + smithy runtime); multipart presigning is manual choreography you write yourself; frequent version churn (pin the version).

### Option B: `minio` JS client (minio-js 8.x)
- MinIO-native client (`new Minio.Client({ endPoint: 'minio', ... })`) with clean `presignedPutObject`/`presignedGetObject` helpers. context7 `/minio/minio-js`.
- **Pros:** Single small dependency; ergonomic for the simple cases (single-PUT upload, presigned GET for streaming/download); slightly less MinIO config boilerplate.
- **Cons:** **Weak multipart-presigning story** — no high-level presigned-part helper; you drop to low-level `presignedUrl()` and hand-assemble `?uploads`/`?uploadId&partNumber` query strings, the exact bottleneck for the 10GB requirement; less prod-portable off MinIO.

**Recommendation:** **Option A (AWS SDK v3)**, pinned to a specific `3.10xx`. TD-03's viable path is presigned **S3 multipart**, and the AWS SDK is the only option with dedicated, individually-presignable command classes for every step; it signs correctly against MinIO with `forcePathStyle: true` and gives a zero-change path to real S3 in prod.

**Recommended bucket/key scheme (concrete):**
- **`streamtube-raw`** — original uploads, browser-writable via presigned URLs, **private**. Lifecycle rule to auto-abort incomplete multipart uploads (e.g. after 7 days).
- **`streamtube-processed`** — worker output (generated thumbnail; renditions if HLS is added later); the bucket streaming/download read from. Private.
- Keys by video UUID, never by user filename: raw `videos/{videoId}/source` · thumbnail `videos/{videoId}/thumbnails/auto.jpg` · (future) renditions `videos/{videoId}/renditions/{quality}.mp4` or `hls/...`.
- The public short URL (TD-06) is a **separate column**, resolved by the API to `{videoId}` — decoupling the human-facing URL from storage keys so keys never collide and the slug can change without moving objects.

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + presigner; raw/processed buckets, key by videoId)

---

## TD-03: Large-File (10GB) Upload Protocol

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The critical constraint of the phase: a 10GB file must reach MinIO **without buffering through the API**, and the transfer must **resume** after a connection drop (`project-plan.md` §4). The backend issues the handshake and pre-registers the draft video row when upload starts; the frontend implements the client. This one contract lives on both sides — hence Cross-layer, decided once. Shared limits (S3/MinIO): single presigned PUT is capped at **5GB**; multipart parts are 5MB–5GB, max 10,000 parts, object up to 5TB; presigned part URLs should be short-lived; initiated multipart uploads have no auto-expiry (need a lifecycle abort rule).

**Options:**

### Option A: Presigned single-PUT (browser → MinIO)
- API creates the draft row and returns one presigned PUT URL; browser does a single `PUT` straight to MinIO.
- **Pros:** Simplest handshake (one call, one PUT); no orchestration; honors no-API-buffering.
- **Cons:** **Disqualifying** — presigned PUT is hard-capped at **5GB** (10GB impossible) and has **no resumability** (any drop restarts the whole multi-GB transfer), violating the resume requirement.

### Option B: Presigned S3 multipart (API orchestrates initiate/part-presign/complete; browser → MinIO)
- `POST /videos/uploads` creates the **draft video row** + `CreateMultipartUpload`, returns `{videoId, uploadId, key}`. FE slices the file (~64–128MB parts), requests short-lived presigned `UploadPart` URLs, PUTs each part **directly to MinIO** collecting ETags, then `POST /videos/uploads/{id}/complete` finalizes and enqueues the job. Resume by re-presigning only missing parts (via `ListParts`). Backend AWS SDK v3; FE plain `fetch`+`File.slice` or Uppy `@uppy/aws-s3` multipart mode.
- **Pros:** **Only option that sends bytes browser → MinIO directly** (API just signs + records state); 10,000-part/5TB envelope handles 10GB easily; full resumability + parallel parts for throughput; the initiate endpoint is the natural draft-on-start point; identical on MinIO and prod S3.
- **Cons:** Most orchestration code you own (initiate/presign/complete/abort + part accounting); sensitive to **MinIO CORS** (must expose the `ETag` header or completes fail) and part-URL expiry on slow parts (mitigate: short-lived, re-fetchable per-part URLs + lifecycle abort rule).

### Option C: tus resumable protocol (`@tus/server` + `@tus/s3-store`; tus-js-client/Uppy on FE)
- FE uploads via the tus protocol to a tus endpoint **on the API**; `onUploadCreate` creates the draft row, `@tus/s3-store` maps the upload onto an S3 multipart in MinIO, `onUploadFinish` finalizes + enqueues.
- **Pros:** Turnkey, spec'd resumability with the least app-owned upload logic; clean create/finish hooks that fit draft-on-start; bytes still land in MinIO via multipart (storage layout matches TD-02).
- **Cons:** **Chunks flow browser → API → MinIO** — `@tus/s3-store` streams part-sized windows through the Node process, so it does **not** honor the "não passar pela API" constraint and loads the API container with sustained 10GB throughput; adds a stateful endpoint (sticky sessions / temp storage) to Compose.

**Recommendation:** **Option B (presigned S3 multipart)** with AWS SDK v3 on the backend and Uppy `@uppy/aws-s3` (multipart mode) or a thin `fetch`/`File.slice` client on the Next.js side. It is the only option that keeps the 10GB payload off the API (the decisive constraint), is physically capable of 10GB (Option A is not), and resumes by re-presigning missing parts. Bake in the gotchas: MinIO CORS exposing `ETag`, ~10-min re-fetchable per-part URLs, an abort endpoint + lifecycle rule, and part size ≥5MB except the last.

**Decision:** B (presigned S3 multipart — browser → MinIO, resumable)

**Revisions:**

- 2026-08-22 — Browser-facing half of the handshake revised by `phase-03-videos-frontend/TD-01` (presigned part URLs must be signed for a browser-reachable host, not the `minio:9000` Compose name) and `phase-03-videos-frontend/TD-04` (the missing per-part ETag contract, now exposed via an owner-scoped `GET /videos/:publicId/upload/parts`). The protocol choice itself — presigned S3 multipart, bytes never through Nest or Next — is unchanged. Rationale: browser-facing half of the contract revised by the frontend slice.

---

## TD-04: Video Worker Runtime & Deployment

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The API image (`node:25.6.0-slim`) has no FFmpeg; the established decision is that the worker is a **separate Compose service with its own Dockerfile** that installs FFmpeg, and the API only publishes a job. Open question: how the worker process is structured so it reuses the API's TypeORM entities/config (it updates the video row) without dragging in the HTTP layer.

**Options:**

### Option A: NestJS standalone application context (`NestFactory.createApplicationContext`)
- Boots the DI container **without** an HTTP server; resolves providers via `app.get(...)`; the queue-consume loop runs in a bootstrap fn or `OnApplicationBootstrap` provider. Own Dockerfile + FFmpeg.
- **Pros:** Best reuse-to-weight ratio — shares the API's TypeORM entities, `DataSource`, and `ConfigService` via full DI while dropping the HTTP layer; lean image; honors the separate-container constraint.
- **Cons:** You wire the queue-consumption loop yourself unless the queue lib ships Nest processor decorators; slightly less conventional than a full microservice app.

### Option B: Full NestJS application (queue-consumer microservice)
- A second complete Nest app (own `main.ts`/`AppModule`) booting as a microservice/queue consumer.
- **Pros:** Fully idiomatic if the queue has Nest integration (e.g. BullMQ `@Processor`); full DI, config, lifecycle, testing utilities.
- **Cons:** Heaviest footprint for a single-purpose worker; pulls the HTTP/microservice framework into a job processor that needs no controllers; larger image and boot.

### Option C: Plain Node/TS worker script
- Standalone TS entrypoint that creates its own `DataSource`, connects to the queue, processes jobs — no Nest.
- **Pros:** Smallest, fastest boot, fewest moving parts.
- **Cons:** Re-implements config + DataSource wiring; risks **entity/connection drift** with the API; loses DI + Nest test utilities.

**Recommendation:** **Option A (NestJS standalone application context)** in its own Compose service + Dockerfile with FFmpeg — it maximizes reuse of the API's entities/DataSource/config (needed since the worker updates the video row) while dropping the unnecessary HTTP server. If TD-01 lands on BullMQ (which ships first-class Nest processor decorators), escalating to Option B is reasonable for idiomatic consumer wiring; with pg-boss (recommended), Option A's manual `boss.work` loop is trivial.

**Decision:** A (NestJS standalone application context — separate Compose service + FFmpeg Dockerfile)

---

## TD-05: FFmpeg Invocation Tooling (Metadata + Thumbnail Extraction)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Inside the worker, how should Node invoke `ffprobe`/`ffmpeg` to extract duration/resolution/codec/bitrate and generate a thumbnail from a representative frame? The tool sits in the critical processing path, so its maintenance status matters.

**Options:**

### Option A: Direct binary spawning (`node:child_process.execFile`, optionally `execa`)
- Spawn `ffprobe -v quiet -print_format json -show_format -show_streams <input>` and `JSON.parse` stdout; generate the thumbnail with `ffmpeg -ss <seek> -i <input> -frames:v 1 -q:v 2 -vf scale=320:-1 thumb.jpg`. `execFile`/`spawn` with an args array (no shell) avoids injection. context7 `/sindresorhus/execa`.
- **Pros:** No unmaintained dependency in the critical path; exact control of flags, aligned with the FFmpeg version the container installs anyway; native async/await; `execFile` is zero-dependency.
- **Cons:** You write the ffprobe-JSON parsing + seek-time math (a few dozen lines); `execa` v9/v10 is **ESM-only** (use built-in `child_process` if the worker shares CommonJS code).

### Option B: fluent-ffmpeg (wrapper)
- `ffmpeg.ffprobe(path, cb)` returns pre-parsed metadata; `.screenshots({ timestamps:['25%'], size:'320x?' })` generates the thumbnail. context7 `/fluent-ffmpeg/node-fluent-ffmpeg`.
- **Pros:** Highest-level, ergonomic API; parses ffprobe JSON and computes screenshot seek math for you; abundant examples.
- **Cons:** **Officially archived read-only (May 2025) and unmaintained** — the maintainer's own view is it adds little over calling FFmpeg directly; callback-based (needs promisify); any future Node/FFmpeg incompatibility falls to community forks.

**Recommendation:** **Option A (direct `execFile` spawning; `execa` optional for DX).** Taking a hard dependency on an archived wrapper for a brand-new worker is unjustified risk when its only value is generating CLI args the worker can write directly, and the metadata + single-frame-thumbnail surface here is small and stable. **Technical notes for `implement`:** duration `format.duration`, resolution `streams[].width/height`, codec `codec_name`, bitrate `format.bit_rate`; use input-seeking (`-ss` before `-i`) for speed; ffprobe/ffmpeg can read a **short-lived presigned MinIO URL directly** (range-reads only the needed bytes), so 10GB inputs need not be downloaded whole — keep a temp-disk fallback for non-faststart MP4s. Base image: `node:<ver>-slim` + `apt-get install -y ffmpeg` (or multi-stage `COPY --from=mwader/static-ffmpeg` for a pinned build).

**Decision:** A (direct `execFile` spawning — ffprobe JSON + input-seek thumbnail; avoid archived fluent-ffmpeg)

---

## TD-06: Unique Public Video Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-guessable-sequential public URL token (YouTube-style `/watch/:publicId`), stored as a dedicated column separate from the internal PK, unique-indexed, and used in FE routes. `project-plan.md` §4 stresses the URL must be short and never conflict.

**Options:**

### Option A: nanoid (custom alphabet, length 12)
- Cryptographically-random URL-friendly string; `customAlphabet(alphabet, size)` fixes symbol set + length. context7 `/ai/nanoid` (v5, ESM-only).
- **Pros:** Tiny, crypto-secure, fully tunable, no timestamp leak, ~23M weekly downloads; maps directly to the short-slug need.
- **Cons:** ESM-only in v5 (watch CJS interop in the Nest build); not sortable.

### Option B: uuid v4 / v7
- v4 = 122 random bits; v7 = time-sortable (48-bit ms prefix). 36-char hyphenated hex. `uuid` ~11.x.
- **Pros:** Ubiquitous, standardized (v7 in RFC 9562); v7 is an excellent **internal PK** (index locality); negligible collision risk.
- **Cons:** 36 chars is long/ugly for a public `/watch/` URL; v7 **leaks creation time**; hex is less dense than nanoid.

### Option C: @paralleldrive/cuid2
- Hashes multiple entropy sources into a lowercase-alphanumeric id, tunable length. context7 `/paralleldrive/cuid2`.
- **Pros:** Strong collision resistance even short; no timestamp leak; designed for horizontal scale.
- **Cons:** Lowercase-only → longer than nanoid for equal entropy; slightly heavier. (hashids/sqids rejected: they *encode* the sequential PK reversibly — not a true unique-id generator and not a security boundary.)

**Recommendation:** **Option A (nanoid)** with a **62-char alphabet** (`0-9a-zA-Z`, dropping `_`/`-` for clean double-click copy) and **length 12**. 62¹² ≈ 3.2×10²¹ ids: even at 100M videos the collision probability is ~10⁻⁶, and a DB unique constraint + generate-retry loop makes an actual duplicate impossible, while `/watch/aB3xK9mZ0qWp` stays YouTube-short. Keep the internal PK as **UUID v7** (or bigint) for index locality — nanoid `public_id` is the only value ever exposed.

**Decision:** A (nanoid — 62-char alphabet, length 12; UUID v7 internal PK)

---

## TD-07: Video Streaming Playback Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must stream without full download. Anonymous users watch freely; `unlisted` videos are link-only. The decision determines who serves the bytes (API vs storage) and how access control is enforced — a contract the backend issues and the frontend `<video>` element consumes, hence Cross-layer. NestJS `StreamableFile` does **not** auto-negotiate `Range`/`206` — that must be done manually if the API proxies.

**Options:**

### Option A: API-proxied HTTP Range (`206 Partial Content` from MinIO)
- `<video>` sends `Range`; the Nest controller reads it, fetches the matching byte range from MinIO (`getPartialObject`/`Range`), sets `206` + `Content-Range` + `Accept-Ranges` manually via `@Res({ passthrough: true })`, returns a `StreamableFile`.
- **Pros:** Full per-request access control (public/unlisted/owner checked on every request); MinIO stays fully private; uniform API surface.
- **Cons:** **Every viewer's bytes flow through Node** — at 10GB and concurrent viewers this is heavy on API CPU/memory/network and needs careful backpressure; Node becomes the streaming bottleneck and scaling unit.

### Option B: Presigned MinIO GET URL to the `<video>` element
- API authorizes, then returns a short-lived presigned GET URL; `<video src>` points at MinIO, which serves native Range requests directly.
- **Pros:** **API out of the byte path** — minimal load, MinIO handles Range/seek efficiently at 10GB, scales with storage not Node; best default for large files.
- **Cons:** Coarser access control — a URL is valid until expiry for anyone holding it; mitigate with **short TTL (1–5 min)**, per-request issuance, and a private bucket. Access is still gated at *issuance* (the API decides who gets a URL), which satisfies anonymous-public and unlisted-link-only.

### Option C: HLS adaptive streaming (worker → segments → hls.js)
- Worker transcodes each upload into bitrate renditions + `.m3u8`; player (hls.js) fetches playlist then segments.
- **Pros:** Adaptive bitrate = best UX at scale, instant seek, small segment requests instead of 10GB monoliths; industry standard for a YouTube-like product.
- **Cons:** Requires a transcoding pipeline (FFmpeg profiles/packaging), extra storage, more moving parts; per-segment access control for unlisted is trickier; **over-scoped for this milestone**.

**Recommendation:** **Option B (presigned MinIO GET URL, short TTL)** as the primary playback path; **HLS (Option C) is the roadmap target** once the worker's transcoding matures. MinIO serves Range natively against presigned URLs, so seeking/partial playback works with zero API byte-proxying — decisive at 10GB where Option A makes Node the bottleneck. Access stays correct because the API authorizes each URL issuance (public → anyone; unlisted → only visitors holding the `/watch/:publicId` link), with short TTL and a private bucket. Keep the API-proxy pattern available only for cases needing hard per-byte gating.

**Decision:** B (presigned MinIO GET URL, short TTL — HLS as roadmap)

**Revisions:**

- 2026-08-22 — Browser-facing playback path revised by `phase-03-videos-frontend/TD-06`: the browser is handed a stable same-origin BFF URL that issues a fresh redirect per request, instead of a raw presigned URL. The short TTL and the "zero API byte-proxying" property are both preserved — Node still stays out of the byte path — and issuance-time-only authorization is upgraded to per-request authorization. `phase-03-videos-frontend/TD-01` additionally revises which host the redirect target names. Rationale: browser-facing half of the contract revised by the frontend slice.

---

## TD-08: Video Download Delivery

**Scope:** Cross-layer

**Capability:** Download do vídeo pelo usuário

**Context:** Users can download the video file. The axis is the same as TD-07 (storage-served vs API-proxied); the difference is the file is delivered as an attachment (full file, `Content-Disposition: attachment`) rather than ranged playback. Depends on / reuses TD-07's presigned mechanism.

**Options:**

### Option A: Presigned MinIO URL with `response-content-disposition=attachment`
- API issues a presigned GET whose signed query includes `response-content-disposition=attachment; filename="..."`; MinIO returns the object with that header so the browser saves it.
- **Pros:** **Zero API byte-proxying** — storage serves the full 10GB directly, scales cleanly; reuses TD-07's exact authorization + signing helper (one mechanism serves both play and download).
- **Cons:** Documented MinIO/S3 gotcha — the response-header override params **must be in the signature**, and non-ASCII filenames can trigger `SignatureDoesNotMatch`/RFC 5987 issues; sanitize/URL-encode the filename. URL valid until TTL.

### Option B: API-proxied stream with `Content-Disposition: attachment`
- Controller returns `StreamableFile` with `disposition: 'attachment; filename="..."'`, piping the object through Node.
- **Pros:** Hard per-request access control; clean filename handling in code.
- **Cons:** Proxies the entire 10GB through Node per download — worst-case load, exactly what TD-07 avoided.

**Recommendation:** **Option A (presigned URL with `response-content-disposition=attachment`)** — it reuses TD-07's presigned-URL mechanism (one authorization + signing helper serves both play and download; the only difference is the disposition param). The API authorizes the request (respecting a per-video "downloads allowed" flag if one is later added), then hands bytes to MinIO. Sanitize/URL-encode `filename` to avoid the `SignatureDoesNotMatch` issue.

**Decision:** A (presigned URL with `response-content-disposition=attachment`)

---

## TD-09: Processing Status Lifecycle & Frontend Notification

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video moves draft (pre-registered at upload start) → processing → ready/failed. This TD fixes (1) the status state machine + failure handling stored on `videos.status`, and (2) how the frontend learns processing finished — a contract the worker writes, the API exposes, and the FE consumes, hence Cross-layer.

**State machine (recommended, stored as a Postgres enum `videos.status`):** `draft → processing → ready | failed`. `draft` is written when `POST /videos/uploads` starts (TD-03); `processing` when the worker picks up the job; `ready` when metadata + thumbnail are persisted (only `ready` videos are eligible to be published/served in later phases); `failed` after retries are exhausted, with a persisted `failure_reason` and a `processing_attempts` counter. **Failure handling: bounded retry-then-fail** at the queue layer (e.g. ≤3 attempts with backoff for transient errors, per TD-01's retry primitives) — not an infinite loop; `ready`/`failed` are terminal, an explicit re-trigger starts a new job.

**Options (frontend notification axis):**

### Option A: Polling the status endpoint
- After upload, the FE polls `GET /videos/:id/status` every ~3–5s (with backoff) until `ready`/`failed`, via the existing openapi-fetch + iron-session path.
- **Pros:** Dead simple, stateless, works through all proxies/LBs, reuses existing auth/observability; trivial in a Next.js client component (React Query/SWR polling); no long-lived connections; ideal when uploads are **occasional** and second-level latency is fine.
- **Cons:** Up-to-one-interval latency and some redundant requests; needs a stop condition + sensible backoff.

### Option B: SSE (Server-Sent Events)
- NestJS 11 `@Sse()` returns an `Observable`; FE opens an `EventSource` to `/videos/:id/events`; the server pushes on status change.
- **Pros:** Near-instant, unidirectional push (perfect for status); native `EventSource`; simpler than WebSocket.
- **Cons:** Long-lived connection per waiting client + a **worker→API status-change fan-out** (pub/sub) to build; `EventSource` cookie/auth friction with iron-session; extra machinery for an occasional-upload workload.

### Option C: WebSocket _(evaluated, not recommended)_
- Bidirectional (`@nestjs/websockets` gateway + connection state). Overkill — status is one-way server→client; no two-way need.

**Recommendation:** **Option A (polling)** for the notification mechanism, with the `draft→processing→ready|failed` state machine and bounded retry-then-fail above. Uploads are occasional and "your video finished" tolerates seconds of latency — the regime where polling beats SSE — and it reuses the existing Next.js 16 + openapi-fetch + iron-session HTTP path with no long-lived connections or worker→API push to build. Keep SSE as a clean upgrade path (NestJS 11 `@Sse()` is ready) if live progress percentages or high upload volume arrive later.

**Decision:** A (polling — `draft→processing→ready|failed` state machine + bounded retry-then-fail)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Repo-wide | Message queue for background processing | pg-boss (on existing Postgres; BullMQ+Redis runner-up) | A |
| TD-02 | Backend | Object-storage client & bucket/key layout | AWS SDK v3 (`@aws-sdk/client-s3` + presigner); raw/processed buckets, key by videoId | A |
| TD-03 | Cross-layer | 10GB upload protocol | Presigned S3 multipart (browser → MinIO, resumable) | B |
| TD-04 | Repo-wide | Video worker runtime & deployment | NestJS standalone app context, separate Compose service + FFmpeg Dockerfile | A |
| TD-05 | Backend | FFmpeg invocation tooling | Direct `execFile` spawning (ffprobe JSON + input-seek thumbnail); avoid archived fluent-ffmpeg | A |
| TD-06 | Backend | Unique public video identifier | nanoid, 62-char alphabet, length 12; UUID v7 internal PK | A |
| TD-07 | Cross-layer | Streaming playback delivery | Presigned MinIO GET URL, short TTL (HLS as roadmap) | B |
| TD-08 | Cross-layer | Download delivery | Presigned URL with `response-content-disposition=attachment` | A |
| TD-09 | Cross-layer | Processing status lifecycle & FE notification | `draft→processing→ready\|failed` + bounded retry; FE polling | A |
