---
libs:
  "pg-boss":
    version: "11.1.2"
    context7_id: "/websites/deepwiki_timgit_pg-boss"
    fetched_at: "2026-10-03T13:55:29-03:00"
  "@aws-sdk/client-s3":
    version: "3.1106.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T13:55:29-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1106.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T13:55:29-03:00"
  "nanoid":
    version: "3.3.18"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-10-03T13:55:29-03:00"
  "ffmpeg":
    version: "5.1.9 (Debian 12 package installed by nestjs-project/Dockerfile.worker; not pinned)"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-10-03T13:55:29-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-02T23:06:37-03:00"
---

# Library References — phase-03-videos

Cache for the libraries behind the decided TDs of `phase-03-videos`: TD-01 (queue → `pg-boss`), TD-02 (object-storage client → `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), TD-03 (presigned S3 multipart), TD-05 (direct `execFile` of `ffprobe`/`ffmpeg`), TD-06 (`nanoid` public id) and TD-07/TD-08 (presigned GET for playback and download).

**How this file came to be.** It was generated when the phase was closed, not during planning. `/plan-validate` came out `clean` on the first pass, so `/plan-resolve` — the stage that writes this cache — never ran; and the TDs name their libraries in the `**Decision:**` lines instead of a `**Libraries:**` line, so the library-cache carve-out did not fire either. The procedure followed is `/plan-resolve`'s library-cache-only mode, applied by hand. Because the code already exists, every section below is restricted to the API surface the code actually calls, with the file that calls it.

**Versions.** Exact versions pinned in `nestjs-project/package.json` (`node_modules` agrees). FFmpeg comes from the worker image (`apt install ffmpeg` on `node:25.6.0-slim`, Debian 12); `ffmpeg -version` in the running `video-worker` reports `5.1.9-0+deb12u1`.

**Discrepancies between Context7 and the installed versions** (flagged per `CLAUDE.md`; where they differ, the installed package's own type definitions were used):

- **pg-boss.** The only Context7 source is DeepWiki for the current repository, which documents a newer major than 11.1.2: it imports `{ PgBoss }` as a named export and lists policies (`key_strict_fifo`) and queue options (`notify`) that 11.1.2 does not have. In 11.1.2 `types.d.ts` ends in `export = PgBoss` (hence `import PgBoss from 'pg-boss'` in `queue.service.ts`), `QueuePolicy` is `'standard' | 'short' | 'singleton' | 'stately' | 'exclusive'`, and `Queue` is `{ name, policy?, partition?, deadLetter?, warningQueueSize? } & QueueOptions` — so `retryLimit`, `retryDelay` and `expireInSeconds` are queue options, which DeepWiki's `createQueue` parameter list omits.
- **AWS SDK v3.** Context7 serves the `main` branch of `aws-sdk-js-v3`, not 3.1106.0. The surfaces used here are stable across 3.x; the ListParts pagination fields were confirmed in the installed `client-s3/dist-types/models/models_0.d.ts`.
- **nanoid / FFmpeg.** No version mismatch for the APIs used. Context7 serves the nanoid `main` branch (5.x); the 3.x line is chosen precisely because of the CommonJS note quoted below.

## pg-boss

Used only inside `src/videos/queue/queue.service.ts` (`QueueService`), which the API and the worker share.

### Lifecycle

```ts
const boss = new PgBoss({ connectionString, schema });
boss.on('error', (error) => logger.error('pg-boss error', error)); // attach before start
await boss.start();   // creates the schema if needed
await boss.stop({ graceful: true, close: true });
```

`stop(options)` — `graceful` (default `true`) waits for pending cleanups, `timeout` defaults to 30 000 ms, `close` (default `true`) closes the database connection; remaining active jobs are failed by the manager. pg-boss is an `EventEmitter`: an unhandled `'error'` would crash the process, which is why the listener is attached in the constructor.

### createQueue / updateQueue

```ts
createQueue(name: string, options?: Omit<PgBoss.Queue, 'name'>): Promise<void>
updateQueue(name: string, options?: Omit<PgBoss.Queue, 'name', 'partition', 'policy'>): Promise<void>  // 11.1.2 types
```

- `createQueue` — "If the queue already exists, the operation has no effect." So a changed `QUEUE_*` env never reaches an existing queue through it; `QueueService.ensureQueue` follows it with `updateQueue(name, settings)` on every boot.
- `updateQueue` — "Only the options provided are updated; other options remain unchanged." In 11.1.2 its type excludes `policy` and `partition`: the policy is fixed at creation.
- `policy` — the code uses `'stately'` for `video.process` (one job per state per `singletonKey`) and `'standard'` (the default) elsewhere.
- `deadLetter` — "The dead letter queue must exist before being referenced" and "cannot be the same as the queue name". `ensureQueue` creates the dead-letter queue first (`video.process.dead-letter`).

### Dead-letter semantics

From the DeepWiki *Dead Letter Queues* page: dead-letter routing is configured per queue; jobs that permanently fail are **copied** (not moved) to the dead-letter queue with their original data and failure output, and the copy inherits the dead-letter queue's retry settings. Under `stately`, a job that would enter `retry` while another job of the same key already sits there can be forced straight to `failed` — and is still routed to the dead-letter queue. `VideoProcessorService` consumes `video.process.dead-letter` and fails the video still in `processing`.

### send — with a caller-owned transaction

```ts
await boss.send(name, data, { singletonKey, db: { executeSql(text, values) } });
// returns the job id, or null when a singleton/throttling constraint prevented creation
```

- `singletonKey` — uniqueness key; combined with the `stately` policy it is what makes `video.process` idempotent per video (TD-01).
- `db` — "Pass a custom database adapter in the options of send methods to integrate pg-boss operations into your own transactions. The adapter must provide an `executeSql` method." 11.1.2 types: `executeSql(text: string, values: any[]): Promise<{ rows: any[] }>`. `asPgBossDb(manager)` wraps a TypeORM `EntityManager`, so the job is inserted in the same transaction that moves the video to `processing` (no dual write).

### work / offWork

```ts
work<ReqData>(name: string, handler: PgBoss.WorkHandler<ReqData>): Promise<string>  // handler receives an ARRAY of jobs
offWork(name: string): Promise<void>
```

The handler receives an array of jobs (`id`, `name`, `data`); `QueueService.work` iterates it and hands only `job.data` to the caller. The worker registers its consumers in `src/worker/video-processor.service.ts`.

## @aws-sdk/client-s3

Used only inside `src/videos/storage/object-storage.service.ts` (`ObjectStorageService`); nothing else imports the SDK.

### Client configuration

```ts
new S3Client({
  endpoint,                 // custom endpoint: overrides rule-based endpoint resolution
  region,
  forcePathStyle,           // v2's s3ForcePathStyle, renamed in v3 — needed for MinIO
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

The checksum options appeared in 3.731.0 (CHANGELOG): since then the S3 client "always calculate[s] CRC32 checksum by default for operations that support it (such as PutObject or UploadPart)"; both options accept `WHEN_SUPPORTED` (default) or `WHEN_REQUIRED`. With the default, the checksum header becomes part of the presigned `UploadPart` signature and a browser `PUT` that does not send it fails with `SignatureDoesNotMatch` — hence `WHEN_REQUIRED`. Two clients are built: one for the Compose-internal endpoint (every real request) and one for the browser-facing endpoint, used only to sign (TD-01 of `phase-03-videos-frontend`).

### Multipart commands (TD-03)

| Command | Fields the code sets | Fields the code reads | Method |
|---|---|---|---|
| `CreateMultipartUploadCommand` | `Bucket`, `Key`, `ContentType` (`Bucket`/`Key` required) | `UploadId` | `createMultipartUpload` |
| `UploadPartCommand` (presigned only) | `Bucket`, `Key`, `UploadId`, `PartNumber` — `PartNumber` must be 1–10 000 | the browser reads `ETag` from the part `PUT` response | `presignUploadPart` |
| `ListPartsCommand` | `Bucket`, `Key`, `UploadId`, `MaxParts`, `PartNumberMarker` | `Parts[].PartNumber/ETag/Size`, `IsTruncated`, `NextPartNumberMarker` | `listUploadedParts` |
| `CompleteMultipartUploadCommand` | `Bucket`, `Key`, `UploadId`, `MultipartUpload: { Parts: [{ PartNumber, ETag }] }` | — | `completeMultipartUpload` |
| `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | — | `abortMultipartUpload` |

**ListParts pagination** (installed `models_0.d.ts`): `MaxParts` "sets the maximum number of parts to return"; `IsTruncated` is true when "the number of parts exceeds the limit returned in the MaxParts element"; `NextPartNumberMarker` is "the value to use for the `part-number-marker` request parameter in a subsequent request"; `PartNumberMarker` lists only "parts with higher part numbers". The code loops with `MaxParts: LIST_PARTS_PAGE_SIZE` (1000) until `IsTruncated` is false — a 10 GiB upload at the 5 MiB floor has 2048 parts.

**Errors.** A missing multipart upload surfaces as an error named `NoSuchUpload`; the service translates it into its own `MultipartUploadNotFoundError` so callers never depend on the SDK.

### Object commands

- `HeadObjectCommand({ Bucket, Key })` → `ContentLength` (`getObjectSize`). HEAD has no body, so a missing key surfaces as `NotFound` / HTTP 404 (`$metadata.httpStatusCode`), mapped to `null`.
- `DeleteObjectCommand({ Bucket, Key })` (`deleteObject`) — deleting a missing key succeeds.
- `PutObjectCommand({ Bucket, Key, Body, ContentType })` (`putObject`) — only for the worker's thumbnail; video bytes never pass through the app.
- `GetObjectCommand({ Bucket, Key, ResponseContentDisposition? })` — only presigned (below).

## @aws-sdk/s3-request-presigner

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const url = await getSignedUrl(client, command, { expiresIn });
```

`getSignedUrl(client, command, options?: RequestPresigningArguments)`; `expiresIn` defaults to 900 s when omitted. The signature is computed locally from the client's config (endpoint, region, credentials) — which is why the browser-audience URL must be signed by the client configured with the public endpoint: SigV4 signs the `host`, so a URL cannot be rewritten afterwards.

Used for:

- `UploadPartCommand` with `expiresIn: STORAGE_UPLOAD_URL_TTL_SECONDS` — one URL per part, on demand (`presignUploadPart`).
- `GetObjectCommand` with `expiresIn: STORAGE_PLAYBACK_URL_TTL_SECONDS` (or an explicit value) — playback, thumbnails and the worker's ffprobe input (TD-07); with `ResponseContentDisposition` (RFC 5987 `attachment; filename=…; filename*=UTF-8''…`) for download (TD-08). The override is part of the signature, so a non-ASCII filename must be encoded before signing.

## nanoid

`src/videos/utils/public-id.ts`:

```ts
import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH); // 62 chars, length 12
export function generatePublicId(): string { return nanoid(); }
```

`customAlphabet(alphabet, defaultSize?)` returns a generator function that builds ids from the given alphabet (the secure entry point, not `nanoid/non-secure`). Version line: the 4.0 changelog says "Removed CommonJS support. Nano ID 4 will work only with ESM applications. We will support 3.x branch with CommonJS" — the backend compiles to CommonJS, hence `nanoid@3`.

## ffmpeg / ffprobe

Invoked with `node:child_process.execFile` (promisified) from `src/worker/ffmpeg.util.ts` — no wrapper library (TD-05). The code raises `maxBuffer` to 16 MiB for ffprobe's JSON and passes a `signal` (`AbortSignal`) that bounds every run below the queue's job expiration.

### Metadata — `probeVideo`

```text
ffprobe -v quiet -print_format json -show_format -show_streams <input>
```

`-print_format json` emits JSON; `-show_format` gives the `format` section (`duration`, `bit_rate`); `-show_streams` gives `streams[]` (`codec_type`, `codec_name`, `width`, `height`). The input is a server-audience presigned URL: ffprobe range-reads over HTTP, so the source is never downloaded whole.

### Thumbnail — `extractThumbnail`

```text
ffmpeg -y -ss <seconds> -i <input> -frames:v 1 -q:v 2 -vf scale=320:-1 <output.jpg>
```

- `-ss` **before** `-i` — "When used as an input option (before `-i`), seeks in this input file to position… `ffmpeg` will seek to the closest seek point before position." As an output option it would instead decode and discard everything up to the position. The code seeks to 25% of the duration (`thumbnailSeekSeconds`).
- `-frames:v 1` — "Stop writing to the stream after framecount frames" (`-vframes` is the obsolete alias).
- `-vf scale=320:-1` — "If one and only one of the values is -n with n >= 1, the scale filter will use a value that maintains the aspect ratio of the input image": 320 px wide, height derived.
- `-q:v 2` — `-q`/`-qscale`: "Use fixed quality scale (VBR). The meaning of q/qscale is codec-dependent" (here the JPEG encoder).
- `-y` overwrites the temporary output path.
