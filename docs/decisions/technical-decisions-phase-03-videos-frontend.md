---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-15
scope_description: "Frontend slice of Phase 03 — the upload interface for files up to 10GB (resumable, browser → object storage direct), the processing-status tracking surface, and a minimal playback/download surface proving the streaming contract. Backend is settled in `phase-03-videos/TD-01..TD-09` and is not reopened, except where the browser-facing URL contract is provably broken (TD-01) or missing (TD-04)."
covers_capabilities:
  - "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"
  - "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"
  - "Processamento automático do vídeo após upload (extração de duração e metadados)"
  - "Reprodução via streaming (sem necessidade de download completo)"
  - "Download do vídeo pelo usuário"
depends_on_slices:
  - phase-03-videos
---

# Technical Decisions — Phase 03 Frontend (Upload, Processing Status & Playback Surface)

_Subprojects in scope:_

- `next-frontend/` — primary subproject. Owns the upload screen and its multipart client, the BFF Route Handlers under `app/api/videos/**`, the processing-status tracking surface, the minimal playback/download surface, the `mocks/handlers/videos.ts` MSW domain file (per `next-frontend-msw-foundation/TD-01`), and the video contract aliases in `lib/api/contracts.ts` (per `next-frontend-openapi-typing/TD-04`).
- `nestjs-project/` — **two open decisions only, both forced by defects in the browser-facing contract, not by new backend features.** TD-01 (presigned URLs carry a host the browser cannot resolve — measured, see below) and TD-04 (the upload cannot be resumed after a page reload because part ETags are never exposed). Everything else in `phase-03-videos/TD-01..TD-09` is consumed unchanged.

> **Scope boundary with Fase 05.** Fase 05 owns the watch page — `Player de vídeo com controles: play/pause, volume e barra de progresso`, layout, description, suggestions, and `Botão de download do vídeo`. This slice does **not** build that page. It builds the minimal surface needed to prove Fase 03's own bullets (`Reprodução via streaming`, `Download do vídeo pelo usuário`) end-to-end and to settle the cross-layer URL contracts (TD-01, TD-06) that Fase 05 would otherwise inherit broken. TD-07 is deliberately scoped so it does not pre-commit Fase 05's player.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Presigned S3 multipart, browser → MinIO direct** (`phase-03-videos/TD-03`). The bytes never pass through Nest or Next. What is open here is the *client* implementation, not the protocol.
> - **Presigned GET for playback and download** (`phase-03-videos/TD-07`, `TD-08`), short TTL, API out of the byte path. HLS is roadmap, not this slice.
> - **Polling** as the processing-notification mechanism (`phase-03-videos/TD-09`); `draft → processing → ready | failed`. The mechanism is settled; *what does the polling on the FE* is open.
> - **Strict BFF — single server-only `API_URL`** (`next-frontend-config-base/TD-03`). The browser only talks to same-origin `/api/...`; only server code reads `env.API_URL`.
> - **OpenAPI contract chain** (`next-frontend-openapi-typing/TD-01..TD-05`): `openapi.json` → `lib/api/types.gen.ts` → aliases in `lib/api/contracts.ts`. Feature code never imports `paths` directly.
> - **MSW per-domain handlers + `onUnhandledRequest: "error"`** (`next-frontend-msw-foundation/TD-01..TD-04`); E2E fakes only the upstream NestJS, server-side.
> - **Public identifier is `public_id`** (nanoid, 12 chars) — the internal `id` is never exposed (`phase-03-videos/TD-06`).
> - **A video owned by someone else is indistinguishable from a nonexistent one** — 404, never 403. Only the owner gets 409 on a not-ready video. The UI must not leak the difference.

> **Strict BFF is not violated by this slice — it is partitioned.** The *control plane* (create draft, request signed URLs, complete, abort, status, playback-URL issuance) goes through `app/api/videos/**` exclusively; the browser never learns `API_URL`. The *byte path* (part `PUT`s, media `GET`s) goes browser ⇄ object storage directly, which is the entire point of `phase-03-videos/TD-03` and `TD-07`. This is a partition of responsibilities, not an exception to the BFF — recorded here so it is explicit rather than implicit.

> **Mechanical prerequisite (not a decision).** `next-frontend/lib/api/types.gen.ts` currently contains **zero** `/videos` paths. Before any SI of this slice, run `bash scripts/sync-openapi.sh` (host) then `npm run openapi:types` (container), per `.claude/rules/next-frontend-bff-api.md`. Two known drifts, both pre-existing debt outside this slice: `next-frontend/openapi.json` is gitignored although `openapi-typing/TD-02` calls it "committed", and `.github/workflows/openapi-freshness.yml` (the CI guard cited by `openapi-typing/TD-03`) does not exist.

> **Routes owned by this slice** (resolved 2026-08-22, `AMB-1`). This slice ships exactly two screens, at routes chosen deliberately so they cannot collide with Fase 05's `/watch/:publicId`:
> - `/videos/upload` — the upload screen (TD-02, TD-03, TD-04) and the processing-status surface (TD-05).
> - `/videos/:publicId/preview` — the minimal playback/download surface that proves the streaming and download contracts (TD-06, TD-07). Fase 05 replaces it with the real watch page; nothing else may link to it as a permanent destination.
>
> No screen inventory is authored for this slice: both screens are throwaway verification surfaces, and every TD here is a runtime or contract decision rather than a screen decision.

---

## TD-01: Browser-Reachable Host for Presigned Storage URLs

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Every presigned URL the API issues — upload parts, stream, download, thumbnail — carries the host from `STORAGE_ENDPOINT`, which is `http://minio:9000`, a Compose service name. The whole backend suite passes because it runs inside Docker. The browser runs on the developer's machine and cannot resolve `minio`. Measured on 2026-08-15 against the running stack:

| Probe | Result |
|---|---|
| `minio:9000` resolves from the host | ❌ DNS failure |
| `localhost:9000` responds | ✅ HTTP 200 |
| URL signed for `minio:9000`, host rewritten to `localhost` | ❌ `SignatureDoesNotMatch` |
| URL signed **directly** for `localhost:9000` | ✅ `NoSuchKey` (signature accepted) |

The last two rows are the decisive pair: SigV4 signs the `host` header (`X-Amz-SignedHeaders=host`), so string-rewriting the host is impossible — but signing *for* a host the signer itself cannot reach works fine, because `getSignedUrl` is a local HMAC computation that opens no connection. **There are three audiences, not two:** `src/worker/video-processor.service.ts:79` presigns a GET so ffmpeg can pull the source **from inside the container** — a global endpoint swap would silently break the worker. Browser-facing call sites are `videos.service.ts:219` (parts) and `:301,330,347,363` (thumbnail, stream, download).

**Options:**

### Option A: Dual endpoint — separate internal and public signing clients
- Add `STORAGE_PUBLIC_ENDPOINT`; construct a second `S3Client` used **only** to sign browser-facing URLs (it never sends a request). Each presign call site declares its audience; the worker and all server-to-server commands keep the internal client.
- **Pros:** Mirrors how this deploys for real (internal/VPC endpoint vs. public or CDN edge); no external DNS dependency, so offline and CI-sandboxed runs work; the worker stays correct **by construction** rather than by remembering; makes the audience distinction explicit — precisely the thing whose implicitness let this bug through the whole suite.
- **Cons:** Touches `storage.config.ts`, `object-storage.service.ts`, the five browser-facing call sites, `.env`/`.env.example`; introduces a new way to be wrong (signing with the wrong client) — mitigate by making audience a **required** parameter rather than a default.

### Option B: A single hostname that resolves on both sides
- Set `STORAGE_ENDPOINT=http://minio.localtest.me:9000` and give the `minio` service a Compose network alias `minio.localtest.me`. **Both halves verified:** `localtest.me` is public wildcard DNS resolving to `127.0.0.1` (so the host reaches the published port), and a dotted network alias resolves inside the Compose network (probe container with `--network-alias probe.localtest.me` resolved from `nestjs-api` to its container IP). Same port both sides, so the signed `host` header is byte-identical.
- **Pros:** Zero code change, zero test change, one env var; the signature question disappears entirely rather than being managed.
- **Cons:** Depends on public DNS — breaks offline and in air-gapped CI; erases the internal/public distinction that production reimposes anyway, so the work returns later; the `/etc/hosts` + `extra_hosts` variant avoids the DNS dependency but requires `sudo` on every developer machine.

### Option C: Proxy the bytes through the API or the BFF
- Nest (or a Next Route Handler) reads from MinIO and streams to the browser, so no presigned URL ever leaves the server.
- **Pros:** No host problem at all; hard per-request access control.
- **Cons:** **Disqualifying** — directly contradicts `phase-03-videos/TD-07` and `TD-03`, which removed Node from the byte path specifically because of the 10GB constraint. Re-adopting it here would undo the phase's central architectural choice for a local-DNS convenience.

**Recommendation:** **Option A.** It is the only option that survives contact with production, where the internal and public endpoints genuinely differ and Option B's single-hostname trick has no analogue. It also fixes the worker by construction: the bug that hid from 282 passing tests did so precisely because "which host should this URL carry?" was never an explicit question, and Option A makes it one at every call site. Option B is a legitimate lower-cost choice if the priority is zero backend churn during a frontend slice — the trade is a deferred migration plus an offline-DNS dependency, and it is defensible if accepted knowingly. Option C is out.

**Decision:** A — dual endpoint: separate internal and public signing clients.

---

## TD-02: Multipart Upload Client Implementation

**Scope:** Frontend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** `phase-03-videos/TD-03` fixed the protocol and explicitly left the client open ("Uppy `@uppy/aws-s3` (multipart mode) or a thin `fetch`/`File.slice` client"). The client must: slice the file at `part_size_bytes` (default 64 MiB → ~160 parts at the 10 GiB cap), `PUT` each part directly to storage, read each response's `ETag`, cap concurrency, retry individual parts, report progress, and support cancel/abort. The draft row is created by the same call that opens the multipart (`POST /videos`), so "pre-register as draft" is this client's first step, not a separate flow. The frontend currently has **no** upload dependency of any kind.

**Options:**

### Option A: `@uppy/aws-s3` in multipart mode
- Uppy's S3 plugin exposes exactly the four hooks this backend needs — `createMultipartUpload`, `signPart`, `completeMultipartUpload`, `abortMultipartUpload` — each overridable to call our BFF routes instead of Uppy's Companion server. `shouldUseMultipart`, concurrency (`limit`) and `retryDelays` are configuration.
- **Pros:** The hook surface is a near-exact match for the four endpoints already built, including per-part signing (which is what makes TD-03's expiry problem tractable); part accounting, ETag collection, per-part retry, progress events and cancellation are all solved and battle-tested — the highest-risk logic in this slice is the part you do not write; optional companion plugins for resume (see TD-04).
- **Cons:** Adds a dependency family (`@uppy/core` + `@uppy/aws-s3`, plus UI packages if its components are used) to a project that has deliberately stayed lean; its React UI components will not match this project's shadcn/Tailwind design system, so realistically it is used headlessly, paying for the core without the UI; another moving part to keep current.

### Option B: Hand-rolled client over `fetch` + `File.slice`
- A `lib/videos/uploader.ts` module owning the state machine: slice, request URLs, `PUT` with a concurrency pool, collect ETags, complete, abort.
- **Pros:** Zero dependencies; every behaviour is explicit and directly testable with `msw/node`; the UI is native to the design system; no impedance mismatch between a general-purpose uploader's assumptions and this specific four-endpoint contract.
- **Cons:** The genuinely hard parts are hand-written — concurrency pool, per-part retry with backoff, aborting in-flight `PUT`s, accurate aggregate progress, and correct behaviour when a part expires mid-flight; these are exactly the bugs that surface only at 10 GiB over a flaky link, which is the hardest condition to test; realistically 250–400 lines carrying real risk.

### Option C: `tus-js-client`
- The resumable protocol Uppy also speaks natively.
- **Pros:** Best-in-class resumability semantics.
- **Cons:** **Disqualifying** — tus requires a tus server; `phase-03-videos/TD-03` evaluated and rejected it (Option C there) because `@tus/s3-store` streams chunks through the Node process, violating the no-API-buffering constraint. The backend built is S3-multipart, not tus. Listed only to record that it was reconsidered and remains rejected.

**Recommendation:** **Option A, used headlessly** (Uppy core + `@uppy/aws-s3`, this project's own React UI on top). The four override hooks map one-to-one onto the four endpoints already shipped, so the integration is configuration rather than translation, and the risky mechanics — retry, concurrency, ETag accounting, cancellation — arrive tested. Option B is defensible if dependency minimalism outweighs that, but it should be chosen with eyes open: the code it replaces is small in volume and large in failure modes, and the failure modes appear only under conditions this project cannot easily reproduce. Note the choice is not fully independent of TD-04 — Option A brings a resume story with it.

**Decision:** A — `@uppy/aws-s3` in multipart mode, used headlessly (Uppy core + the plugin, with this project's own React UI on top).
**Renders in:** frontend-runtime
**Libraries:** @uppy/core, @uppy/aws-s3

---

## TD-03: Part-URL Signing Cadence — the Upload Control-Plane Contract

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Presigned part URLs expire at `STORAGE_UPLOAD_URL_TTL_SECONDS = 600` (10 minutes). A 10 GiB upload at 10 MB/s takes ~17 minutes; at 2 MB/s, ~85 minutes. **Signing all ~160 parts up front is therefore not merely wasteful, it is incorrect** — most URLs expire before their turn. `POST /videos/:publicId/upload/parts` accepts an arbitrary `part_numbers: number[]` (validated 1..10000), so every cadence below is already supported by the shipped contract with no backend change; what is open is which one the client uses and how it reacts to expiry. This also determines BFF request volume and how the resume path (same endpoint) is driven.

**Options:**

### Option A: Sign one part at a time, on demand
- The client requests a URL immediately before uploading each part (Uppy's `signPart` shape).
- **Pros:** A URL is never idle, so expiry is structurally impossible under normal operation regardless of link speed or file size; the resume path is the same code path with no special case; trivially correct.
- **Cons:** ~160 extra BFF round trips per 10 GiB upload — negligible against 160 × 64 MiB of payload, but it does mean the control plane must stay responsive for the whole upload; a BFF or session hiccup stalls the upload even when storage is healthy.

### Option B: Sign in sliding windows of N parts
- Request URLs in batches (e.g. 10 at a time), refilling as parts complete.
- **Pros:** Amortizes round trips while keeping each URL's idle time bounded; a natural fit for a fixed-size concurrency pool.
- **Cons:** Introduces a tunable (window size) that must be reasoned about against TTL and the *slowest* plausible link — get it wrong and expiry returns under exactly the conditions hardest to test; needs explicit re-signing on a 403, so the expiry handling that Option A eliminates must be written anyway.

### Option C: Sign all parts up front
- One call at upload start returns all `part_count` URLs.
- **Pros:** Single round trip; simplest client.
- **Cons:** **Disqualifying at the target size** — with a 600 s TTL and multi-hour uploads, the majority of URLs are dead on arrival. Viable only if the TTL were raised to cover the worst-case upload duration, which would mean hours-long valid write URLs for a whole object — a materially worse security posture than the short-TTL model the phase chose.

**Recommendation:** **Option A.** It removes an entire failure class rather than tuning it: no window size to calibrate against unknown link speeds, no 403-and-retry path to write and test, and the resume flow reduces to "ask for the parts still missing" with no branch. The cost is ~160 lightweight control-plane calls against a payload three orders of magnitude larger. It is also what Option A of TD-02 does natively, so if Uppy is chosen this cadence is the default rather than a customization. Option B is a reasonable optimization **later**, if control-plane chattiness ever measures as a real problem; adopting it up front buys latency that does not matter and pays with a tunable that does.

**Decision:** A — sign one part at a time, on demand.

---

## TD-04: Upload Resume Across Page Reload — the Missing ETag Contract

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** `docs/project-plan.md` §4 requires the upload to "permitir retomar em caso de falha de conexão". Two distinct scenarios hide behind that phrase, and the current API surface supports only one:

- **Transient drop, page still open** — the client holds part state in memory; per-part retry covers it. Already solvable.
- **Page reload / browser restart** — **not currently achievable.** `POST /videos/:publicId/upload/complete` requires `{part_number, etag}` pairs, and an ETag is only ever seen by the browser that `PUT` the part. `ObjectStorageService.listUploadedParts()` exists and S3 `ListParts` does return ETags, but **no endpoint exposes them** (the method is referenced only by an integration spec). After a reload the client knows neither which parts landed nor their ETags, so it cannot complete the upload — it can only start over.

This is a genuine gap in the shipped contract, not a frontend styling question, so the fix is either FE-side persistence or a small backend addition. Note that in every option the browser cannot re-open the file handle after a reload — the File System Access API is not available across all target browsers — so the user re-selects the file in all cases; identity is checked by `name` + `size` + `lastModified`.

**Options:**

### Option A: Frontend persists progress, including ETags
- Store `{public_id, upload_id, file identity, [{part_number, etag}]}` in IndexedDB (or `localStorage`) as parts complete. On return, offer "resume", have the user re-select the file, verify identity, request URLs for the missing parts, complete with the merged ETag list.
- **Pros:** No backend change, so the slice stays frontend-only; the data is tiny (~160 short strings); works immediately.
- **Cons:** Makes the browser the sole custodian of state required to finish a server-side operation — clearing site data, switching browsers, or switching devices loses a multi-hour upload irrecoverably; storage authoritatively knows all of this, so the FE copy is a cache of a truth it cannot re-derive.

### Option B: Backend exposes the uploaded parts (`GET /videos/:publicId/upload/parts`)
- A new owner-only endpoint returning `ListParts` output — `[{part_number, etag, size}]`. The client asks storage (via the API) what already landed, signs only the gaps, and completes with server-sourced ETags.
- **Pros:** Resume becomes stateless on the client — nothing to persist, nothing to lose, works from a different browser or device; the source of truth is storage, which is where it actually lives; `listUploadedParts()` is already written and tested, so the backend cost is a thin controller + service passthrough; also enables a "resume your unfinished upload" affordance driven purely by server state.
- **Cons:** Reopens the backend during a frontend slice (one endpoint, one E2E spec, an `openapi.json` regeneration); marginally widens the authenticated surface.

### Option C: Accept session-scoped resume only
- Retry within the page session; a reload restarts the upload. Document the limit.
- **Pros:** Zero cost.
- **Cons:** Fails the §4 requirement in the scenario that actually motivates it — a 10 GiB upload is precisely the case where a reload during a multi-hour transfer is likely and restarting is most punishing.

**Recommendation:** **Option B.** The information needed to resume already exists in MinIO and is already retrievable by code that is already written and tested; Option A's alternative is to have the browser keep a private, losable copy of it. For a capability whose entire purpose is surviving failure, storing the recovery key only in the client is the wrong custodian — Option A survives a reload but not a cleared cache, a different browser, or a different machine, and those are ordinary events across a multi-hour upload. The backend cost is genuinely small: `listUploadedParts()` is done, and the addition is one owner-scoped read endpoint with the same 404-not-403 ownership semantics as its siblings. This is the second and last backend change this slice proposes, and like TD-01 it exists to repair a browser-facing contract, not to add a feature. Option C should be chosen only if the §4 requirement is explicitly relaxed.

**Decision:** B — the backend exposes the uploaded parts via an owner-scoped `GET /videos/:publicId/upload/parts`.

---

## TD-05: Processing-Status Tracking on the Client

**Scope:** Frontend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** `phase-03-videos/TD-09` settled polling as the mechanism; what is open is what performs it. After `complete`, the client polls `GET /videos/:publicId/status` (via the BFF) until `ready` or `failed`, then renders metadata + thumbnail, or the `failure_reason`. It needs an interval with a stop condition, backoff, cleanup on unmount, and pause when the tab is hidden. The frontend today has **no** data-fetching library — Phase 02 used Route Handlers plus a small `use-session` hook. This choice therefore sets the default for Phases 04–07, which will have substantially more client-side server-state.

**Options:**

### Option A: Hand-rolled `useVideoStatus` hook
- `useEffect` + `setTimeout` recursion, `AbortController` on unmount, explicit backoff and terminal-state stop.
- **Pros:** No dependency; ~40 lines; matches the existing `hooks/use-session.ts` idiom exactly, so the codebase stays uniform; fully testable with fake timers and MSW.
- **Cons:** Cache, deduplication, retry, and focus/visibility handling are hand-written or absent; each later phase needing similar behaviour either duplicates it or grows this into an ad-hoc library — the classic path to a homegrown data layer nobody chose deliberately.

### Option B: TanStack Query v5
- `useQuery` with `refetchInterval` as a function returning `false` on a terminal state — the documented polling idiom, verified against current v5 docs.
- **Pros:** The polling-with-stop-condition case is a first-class documented feature rather than a construction; brings caching, dedup, retry/backoff, and focus/visibility handling that Phases 04–07 will otherwise reimplement; `refetchIntervalInBackground` defaults to off, so hidden tabs pause for free.
- **Cons:** A significant dependency and a `QueryClientProvider` in the tree, adopted on the evidence of a single polling loop; RSC/hydration boundaries need deliberate placement to avoid quietly turning server components into client ones; a real architectural commitment made at the point of least information about the phases that would justify it.

### Option C: Server Component + `router.refresh()`
- Status rendered server-side; a small client component calls `router.refresh()` on an interval.
- **Pros:** Almost no client JavaScript; status stays in RSC where the rest of the page's data already lives.
- **Cons:** Each refresh re-renders and re-fetches the whole route segment to observe one enum field — heavy and imprecise; interleaves badly with the client-side upload state that must survive the refresh; no clean stop/backoff primitive.

**Recommendation:** **Option A for this slice.** Adopting a data layer for the whole application on the strength of one polling loop is a large decision resting on a small case, and Option B's benefits — cache, dedup, invalidation — are mostly about *lists and mutations*, which is Fase 04's dashboard, not this slice. The hook is small, mirrors `use-session.ts`, and is straightforwardly replaced. The honest caveat: if Option B is going to be adopted, adopting it at Fase 04 with the dashboard's real requirements in hand is better-informed than adopting it here — but arriving at Fase 04 having written two bespoke fetching hooks is the failure mode to watch for. **Flag for Fase 04's research: revisit as a deliberate agenda item, not by default.** Option C is not competitive for a single polled field.

**Decision:** A — hand-rolled `useVideoStatus` hook for this slice, mirroring `use-session.ts`. Flagged for Fase 04 research: revisit TanStack Query v5 as a deliberate agenda item with the dashboard's real requirements in hand, not by default.
**Renders in:** frontend-runtime

---

## TD-06: Playback URL Lifetime vs. Session Length

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `phase-03-videos/TD-07` deliberately chose a short TTL (`STORAGE_PLAYBACK_URL_TTL_SECONDS = 300`, 5 minutes) because a presigned URL is valid to anyone holding it until it expires. But a `<video>` element issues a **new** HTTP request for every seek and every subsequent byte range, and each is validated against the same signed expiry. A viewer watching past minute 5 — or seeking after a pause — gets a 403 from storage on a URL that worked at minute 1. The same applies to a large download that takes longer than the TTL to transfer. The tension is inherent to the decided model, not a defect in it, and something must reconcile the 5-minute credential with an arbitrarily long viewing session. Fase 05 builds the real watch page on top of whatever is decided here.

**Options:**

### Option A: Raise the playback TTL
- Set the TTL to cover the longest plausible session (e.g. 6 hours).
- **Pros:** One-line change; the `<video>` element holds a single URL and never notices.
- **Cons:** Directly regresses the posture `TD-07` reasoned about — a leaked URL grants a 6-hour window on the raw object to anyone; the value is a guess about the longest session and is wrong for the tail; scales badly toward the unlisted-video semantics Fase 04 introduces.

### Option B: Client-side re-issue on expiry
- The player listens for `error`/stalled, fetches a fresh URL from the BFF, reassigns `src`, restores `currentTime`.
- **Pros:** Preserves the short TTL; no new backend surface.
- **Cons:** Every viewer sees a re-buffer at the seam; media error codes and recovery behaviour differ across browsers, so this is fiddly and hard to test; a mid-seek expiry is a particularly awkward case; pushes permanent complexity into Fase 05's player for a problem that is not really the player's.

### Option C: Stable same-origin BFF URL that redirects per request
- `<video src="/api/videos/{publicId}/stream">`. The Route Handler authorizes, presigns, and answers **307** with `Location` pointing at storage. The browser follows it — preserving `Range` — and reads bytes directly from storage. Every subsequent range request repeats the handshake with a freshly signed URL.
- **Pros:** Expiry becomes unobservable: each request gets a URL seconds old, so no player-side recovery logic exists to write, in this slice or in Fase 05; the short TTL is preserved and access is re-authorized on **every** request rather than once at issuance — strictly stronger than what `TD-07` settled for; **bytes still never traverse Node** (a redirect is not a proxy), so `TD-07`'s decisive constraint holds; the `<video>` element gets a stable, shareable, same-origin URL, which is also exactly what Fase 05's page and the download button want; keeps the control plane inside the BFF, consistent with the partition stated at the top of this document.
- **Cons:** One extra same-origin round trip per range-request burst (signing is local HMAC, so the cost is latency, not compute); the handler must be `no-store` so the redirect is never cached past its TTL; a browser or player that mishandles redirects on media would need Option B as fallback — none of the current targets do.

**Recommendation:** **Option C.** It is the only option that resolves the tension instead of trading one side away: Option A buys simplicity with a weaker credential, Option B keeps the credential and pays with permanent player-side complexity that Fase 05 would inherit, and Option C keeps the short TTL *and* leaves the player trivial, because the expiry problem stops existing rather than being handled. It also improves on the access control `TD-07` explicitly listed as its own weakness — issuance-time-only authorization becomes per-request authorization — while keeping Node out of the byte path, which was `TD-07`'s reason for existing. The download button is the same mechanism with `downloadFilename` set. Note this does **not** remove the need for TD-01: the `Location` header still names a host the browser must resolve.

**Decision:** C — a stable same-origin BFF URL that issues a fresh redirect per request. Download is the same mechanism with `downloadFilename` set.

**Revision (2026-10-03) — C stays, B added as the Chrome recovery.** The manual smoke (`phase-03-videos-frontend/progress.md`, SI-03.17) refuted the premise that "every subsequent range request repeats the handshake": Chrome follows the 307 once and reuses the *redirected* storage URL for every later `Range` request of the same `<video>`. Once the playback TTL passes, a seek outside the buffer retries the expired URL for about 30 s and then fails with `MEDIA_ERR_NETWORK`; nothing goes back to `/api/videos/{publicId}/stream`. The Cons of C anticipated exactly this ("a browser … that mishandles redirects on media would need Option B as fallback"), and Chrome is that browser.

- **Kept:** Option C as the contract — stable same-origin URL, per-request authorization, short TTL, bytes never through Node. It still gives every *load* a URL signed seconds ago, which is what makes B cheap.
- **Added:** Option B, reduced to the case C cannot cover. `components/videos/stream-player.tsx` wraps the native `<video>` (TD-07 is unchanged): on `MEDIA_ERR_NETWORK` it calls `load()` on the same same-origin `src` — which goes through the BFF and gets a fresh redirect — and restores `currentTime` and the playing state on `loadedmetadata`. The playing state is tracked from `play`/`pause` events, because Chrome sets `paused` before firing `error` without a `pause` event. A second failure within 10 s is left to the native error (video gone or access lost), so recovery cannot loop.
- **Rejected again:** Option A. The URL is reusable by anyone holding it, and no TTL is long enough for a paused tab.
- **Verified** in real Chrome against the real stack with `STORAGE_PLAYBACK_URL_TTL_SECONDS=20`: play, pause past the TTL, seek to 85 %. A plain `<video>` fails with `MEDIA_ERR_NETWORK` and never calls the BFF again; `StreamPlayer` makes one new BFF request after the error and is playing again at the seek target 5 s later.
- **Known cost:** the viewer waits through Chrome's ~30 s of retries before the error that triggers recovery. Fase 05 inherits `StreamPlayer` and may shorten that (for example, reloading proactively when playback resumes after a pause longer than the TTL); the recovery stays as the safety net either way.

---

## TD-07: Playback & Download Contract for This Slice

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Fase 03 must demonstrate that streaming works — playback starts without downloading the whole file, and seeking issues `Range` requests. Fase 05 owns the actual watch page and its controls. The risk is choosing a player library here, on the strength of a verification surface, and thereby deciding Fase 05's player before its design exists.

**Options:**

### Option A: Native `<video controls>`
- The browser's built-in player, `src` per TD-06; download as an `<a>` to the download route.
- **Pros:** Zero dependencies and zero commitment — Fase 05 chooses its player with the design in hand; native `Range`/seek handling is exactly what needs proving, with nothing in between to confound the test; smallest possible surface for what is a verification affordance.
- **Cons:** Unstyled and inconsistent across browsers; will be replaced in Fase 05, so some of the work is transitional.

### Option B: Vidstack (`@vidstack/react`)
- A modern React player with headless primitives and its own styling layer.
- **Pros:** Production-quality controls now; React-native API; likely a strong candidate for Fase 05 anyway, so the work could carry forward.
- **Cons:** Commits Fase 05's player choice from Fase 03, with no design input — the decision is made where the least is known; adds a substantial dependency to prove a `Range` request works; its styling layer must be reconciled with this project's shadcn/Tailwind token system.

### Option C: video.js
- The long-established, plugin-rich player.
- **Pros:** Maximum maturity and plugin ecosystem; the natural host for HLS when `TD-07`'s roadmap item lands.
- **Cons:** Imperative, non-React core needing lifecycle wrapping; heaviest of the three; same premature-commitment objection as Option B, with a less idiomatic React fit.

**Recommendation:** **Option A.** The job here is to prove the streaming contract end-to-end, and the native element does that with the least machinery between the test and the thing being tested. Deferring is not indecision: Fase 05's bullets name the controls it needs, and choosing its player now — from a phase whose interest in playback is verification — would be deciding with strictly less information than Fase 05 will have. The transitional cost is a handful of markup lines. Keep Vidstack and video.js on the record as the Fase 05 shortlist, with HLS (`phase-03-videos/TD-07`'s roadmap item) as the tiebreaker when it arrives.

**Decision:** A — native `<video controls>`. Restated as `Scope: Cross-layer` (`IC-3`): TD-07 decides the playback/download *contract* the browser consumes — which URL shape, which element — with zero screen commitment. Widened to cover "Download do vídeo pelo usuário" (`MD-1`): the download surface is a plain `<a download>` on the same `/videos/:publicId/preview` verification page, pointing at the TD-06 BFF URL with `downloadFilename` set. Vidstack and video.js stay on record as the Fase 05 shortlist, with HLS as the tiebreaker.

---

## TD-08: Test Strategy for the Direct-to-Storage Byte Path

**Scope:** Frontend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** This slice introduces something the frontend's test architecture has never had: a browser request that does **not** go to the upstream NestJS API. The established model (`next-frontend/CLAUDE.md`, `msw-foundation/TD-02`) fakes only upstream NestJS — `msw/node` in Vitest, and server-side MSW via `instrumentation.ts` for Playwright — with `onUnhandledRequest: "error"` in Vitest. A part `PUT` goes browser → object storage, so in Playwright it originates in the **browser**, where no server-side interceptor sees it. The E2E hard rule forbids browser-intercepting `/api/**`; storage URLs are not `/api/**`, so intercepting *those* breaks no rule, but the choice needs to be explicit. The logic at risk — part accounting, ETag collection, retry, resume — is the most failure-prone code in the slice and is invisible to the existing harness.

**Options:**

### Option A: Vitest with `msw/node` faking both planes; Playwright stubs the storage host
- Integration tests drive the uploader with a small synthetic `File`, MSW faking both the BFF routes and the storage `PUT`s (returning `ETag` headers), asserting part count, ETag ordering, retry, abort and resume. Playwright covers UI states with `page.route()` on the storage origin only.
- **Pros:** Deterministic and fast; drives part boundaries and failure injection (a 403 on part 7, a dropped part) that are impractical against real storage; keeps the browser-level intercept narrowly scoped to a non-`/api/**` origin, so the E2E rule stays intact; no new infrastructure.
- **Cons:** Nothing ever exercises a real signature, a real CORS preflight, or a real `CompleteMultipartUpload` — precisely the integration seams where this slice's known footguns live (checksum headers, `ETag` exposure, host mismatch); green tests would not have caught TD-01.

### Option B: Full-stack Playwright lane against real NestJS + real MinIO
- A second Playwright project, no MSW, pointed at the running Compose stack, uploading a small real file (e.g. 12 MiB → 3 parts).
- **Pros:** Exercises the real signature, real CORS, real multipart completion — the only configuration that would have caught TD-01 automatically; proves the capability rather than a model of it.
- **Cons:** Needs the whole stack up and seeded with a confirmed user; slower and inherently flakier; duplicates the harness (`msw-foundation/TD-02` deliberately has one); real-storage state must be cleaned between runs.

### Option C: Option A plus a documented manual smoke against the real stack
- Automate Option A; verify the real integration once per meaningful change via a written checklist (upload a real file through the running stack, watch it reach `ready`, play it, download it).
- **Pros:** Keeps the automated suite fast and deterministic while ensuring the real seams are exercised by a human before the slice is declared done; no second harness to maintain; proportionate to a project where uploads are occasional.
- **Cons:** Manual steps rot and get skipped under time pressure; catches integration breakage later than CI would.

**Recommendation:** **Option A as the automated baseline, plus Option C's manual smoke as an explicit Definition-of-Done item for this slice** — with Option B recorded as the follow-up once the slice is stable. The reasoning is what TD-01 demonstrated: a fully green suite proved nothing about the browser-facing contract, because every test ran inside Docker. Option A alone would repeat that mistake in a new place, so *something* must touch the real seams; but standing up a second Playwright harness mid-slice adds infrastructure risk to the slice least able to absorb it. The manual smoke is the honest middle — and unlike most manual steps it is cheap here, because the stack is already running and the check is "upload a file, watch it play". If Option B is chosen, it belongs in its own task after this slice lands, not inside it.

**Decision:** A + C — Option A as the automated baseline (Vitest with `msw/node` faking both planes; Playwright stubs the storage host), plus Option C's manual smoke against the real stack as an explicit Definition-of-Done item for this slice. Option B (full-stack Playwright against real NestJS + real MinIO) is recorded as a follow-up task after the slice lands, not inside it.
**Renders in:** frontend-runtime

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Cross-layer | Browser-reachable host for presigned storage URLs | A (dual endpoint — separate internal/public signing clients) | A |
| TD-02 | Frontend | Multipart upload client implementation | A (`@uppy/aws-s3` used headlessly) | A |
| TD-03 | Cross-layer | Part-URL signing cadence (upload control-plane contract) | A (sign one part at a time, on demand) | A |
| TD-04 | Cross-layer | Upload resume across page reload (missing ETag contract) | B (backend exposes `GET /videos/:publicId/upload/parts`) | B |
| TD-05 | Frontend | Processing-status tracking on the client | A (hand-rolled hook; revisit at Fase 04) | A |
| TD-06 | Cross-layer | Playback URL lifetime vs. session length | C (stable same-origin BFF URL, 307 per request) | C + B (Chrome recovery, revised 2026-10-03) |
| TD-07 | Cross-layer | Playback & download contract for this slice | A (native `<video controls>`; defer player to Fase 05) | A |
| TD-08 | Frontend | Test strategy for the direct-to-storage byte path | A + manual smoke (Option B as follow-up) | A + C |
