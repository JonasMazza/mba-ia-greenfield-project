---
kind: phase
name: phase-03-videos-frontend
sources_mtime:
  docs/project-plan.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos-frontend.md: "2026-08-22T15:16:51-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20T13:23:34-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-20T13:23:34-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-20T13:23:34-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-20T13:23:34-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-24T20:07:02-03:00"
  .claude/skills/testing-guide-next-frontend/SKILL.md: "2026-07-20T13:23:33-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-20T13:23:33-03:00"
  docs/phases/phase-03-videos-frontend/library-refs.md: "2026-08-22T15:22:06-03:00"
---

# phase-03-videos-frontend — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Slice:** `phase-03-videos-frontend` — frontend slice. Sibling slice `phase-03-videos` (backend) is `status: decided` and built.

**Capabilities owned by this slice** (literal, `covers_capabilities` frontmatter):

- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Capabilities of the phase owned by the sibling slice** (`phase-03-videos`, not this slice's responsibility):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos

**Out of scope:** _Not specified in project-plan.md._ The slice's decisions doc additionally declares an explicit boundary with Fase 05: the watch page (`Player de vídeo com controles`, layout, description, suggestions, `Botão de download do vídeo`) belongs to Fase 05; this slice builds only the minimal surface that proves the streaming/download contract.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `next-frontend/` — primary. Upload screen + multipart client, BFF Route Handlers under `app/api/videos/**`, processing-status surface, minimal playback/download surface, `mocks/handlers/videos.ts`, video aliases in `lib/api/contracts.ts`.
- `nestjs-project/` — two open decisions only (TD-01, TD-04), both repairing browser-facing contract defects, not adding features.

**Deferred subprojects:** _None._

**Sequencing notes:** `> Depende de: Fase 01, Fase 02`. Additionally `depends_on_slices: [phase-03-videos]` — the sibling backend slice's maturity gate PASSES (`status: decided`, plan-build artifact present on disk).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — `> Depende de: Fase 01`
- **Phase 04:** Gerenciamento de Vídeos e Canal — `> Depende de: Fase 02, Fase 03`

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries | Renders in |
|-----|--------|-------|-------|--------|----------|-----------|------------|
| phase-03-videos-frontend/TD-01 | phase | Cross-layer | Browser-Reachable Host for Presigned Storage URLs | decided | A — dual endpoint (separate internal/public signing clients) | — | — |
| phase-03-videos-frontend/TD-02 | phase | Frontend | Multipart Upload Client Implementation | decided | A — `@uppy/aws-s3` multipart, used headlessly | @uppy/core, @uppy/aws-s3 | frontend-runtime |
| phase-03-videos-frontend/TD-03 | phase | Cross-layer | Part-URL Signing Cadence — Upload Control-Plane Contract | decided | A — sign one part at a time, on demand | — | — |
| phase-03-videos-frontend/TD-04 | phase | Cross-layer | Upload Resume Across Page Reload — Missing ETag Contract | decided | B — backend exposes owner-scoped `GET /videos/:publicId/upload/parts` | — | — |
| phase-03-videos-frontend/TD-05 | phase | Frontend | Processing-Status Tracking on the Client | decided | A — hand-rolled `useVideoStatus` hook (revisit TanStack Query at Fase 04) | — | frontend-runtime |
| phase-03-videos-frontend/TD-06 | phase | Cross-layer | Playback URL Lifetime vs. Session Length | decided | C — stable same-origin BFF URL, fresh redirect per request | — | — |
| phase-03-videos-frontend/TD-07 | phase | Cross-layer | Playback & Download Contract for This Slice | decided | A — native `<video controls>` + plain `<a download>`; player deferred to Fase 05 | — | — |
| phase-03-videos-frontend/TD-08 | phase | Frontend | Test Strategy for the Direct-to-Storage Byte Path | decided | A + C — `msw/node` baseline + manual smoke as DoD (B as follow-up) | — | frontend-runtime |

_Source files:_

- phase-03-videos-frontend — `docs/decisions/technical-decisions-phase-03-videos-frontend.md` (scope_type: phase, related_phases: [3])

_No ad-hoc decisions doc carries `3` in `related_phases`; all four ad-hoc docs are globally scoped (`related_phases: []`) and enter via the correlator instead (see `## Inherited Decisions Detail`)._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | — _(owned by sibling slice `phase-03-videos`)_ |
| Serviço de processamento em segundo plano (filas) | — _(owned by sibling slice `phase-03-videos`)_ |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos-frontend/TD-01, TD-02, TD-03, TD-04, TD-08 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos-frontend/TD-02, TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos-frontend/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | — _(owned by sibling slice `phase-03-videos`)_ |
| URL única por vídeo, sem conflito com outros vídeos | — _(owned by sibling slice `phase-03-videos`)_ |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos-frontend/TD-01, TD-06, TD-07 |
| Download do vídeo pelo usuário | phase-03-videos-frontend/TD-01, TD-06, TD-07 |

## Decisions Detail

### phase-03-videos-frontend/TD-01

**Recommendation:** It is the only option that survives contact with production, where the internal and public endpoints genuinely differ and Option B's single-hostname trick has no analogue. It also fixes the worker by construction: the bug that hid from 282 passing tests did so precisely because "which host should this URL carry?" was never an explicit question, and Option A makes it one at every call site. Option B is a legitimate lower-cost choice if the priority is zero backend churn during a frontend slice — the trade is a deferred migration plus an offline-DNS dependency, and it is defensible if accepted knowingly. Option C is out.
**Libraries:** —

### phase-03-videos-frontend/TD-02

**Recommendation:** Used headlessly (Uppy core + `@uppy/aws-s3`, this project's own React UI on top). The four override hooks map one-to-one onto the four endpoints already shipped, so the integration is configuration rather than translation, and the risky mechanics — retry, concurrency, ETag accounting, cancellation — arrive tested. Option B is defensible if dependency minimalism outweighs that, but it should be chosen with eyes open: the code it replaces is small in volume and large in failure modes, and the failure modes appear only under conditions this project cannot easily reproduce. Note the choice is not fully independent of TD-04 — Option A brings a resume story with it.
**Renders in:** frontend-runtime
**Libraries:** @uppy/core, @uppy/aws-s3

### phase-03-videos-frontend/TD-03

**Recommendation:** It removes an entire failure class rather than tuning it: no window size to calibrate against unknown link speeds, no 403-and-retry path to write and test, and the resume flow reduces to "ask for the parts still missing" with no branch. The cost is ~160 lightweight control-plane calls against a payload three orders of magnitude larger. It is also what Option A of TD-02 does natively, so if Uppy is chosen this cadence is the default rather than a customization. Option B is a reasonable optimization **later**, if control-plane chattiness ever measures as a real problem; adopting it up front buys latency that does not matter and pays with a tunable that does.
**Libraries:** —

### phase-03-videos-frontend/TD-04

**Recommendation:** The information needed to resume already exists in MinIO and is already retrievable by code that is already written and tested; Option A's alternative is to have the browser keep a private, losable copy of it. For a capability whose entire purpose is surviving failure, storing the recovery key only in the client is the wrong custodian — Option A survives a reload but not a cleared cache, a different browser, or a different machine, and those are ordinary events across a multi-hour upload. The backend cost is genuinely small: `listUploadedParts()` is done, and the addition is one owner-scoped read endpoint with the same 404-not-403 ownership semantics as its siblings. This is the second and last backend change this slice proposes, and like TD-01 it exists to repair a browser-facing contract, not to add a feature. Option C should be chosen only if the §4 requirement is explicitly relaxed.
**Libraries:** —

### phase-03-videos-frontend/TD-05

**Recommendation:** For this slice. Adopting a data layer for the whole application on the strength of one polling loop is a large decision resting on a small case, and Option B's benefits — cache, dedup, invalidation — are mostly about *lists and mutations*, which is Fase 04's dashboard, not this slice. The hook is small, mirrors `use-session.ts`, and is straightforwardly replaced. The honest caveat: if Option B is going to be adopted, adopting it at Fase 04 with the dashboard's real requirements in hand is better-informed than adopting it here — but arriving at Fase 04 having written two bespoke fetching hooks is the failure mode to watch for. **Flag for Fase 04's research: revisit as a deliberate agenda item, not by default.** Option C is not competitive for a single polled field.
**Renders in:** frontend-runtime
**Libraries:** —

### phase-03-videos-frontend/TD-06

**Recommendation:** It is the only option that resolves the tension instead of trading one side away: Option A buys simplicity with a weaker credential, Option B keeps the credential and pays with permanent player-side complexity that Fase 05 would inherit, and Option C keeps the short TTL *and* leaves the player trivial, because the expiry problem stops existing rather than being handled. It also improves on the access control `TD-07` explicitly listed as its own weakness — issuance-time-only authorization becomes per-request authorization — while keeping Node out of the byte path, which was `TD-07`'s reason for existing. The download button is the same mechanism with `downloadFilename` set. Note this does **not** remove the need for TD-01: the `Location` header still names a host the browser must resolve.
**Libraries:** —

### phase-03-videos-frontend/TD-07

**Recommendation:** The job here is to prove the streaming contract end-to-end, and the native element does that with the least machinery between the test and the thing being tested. Deferring is not indecision: Fase 05's bullets name the controls it needs, and choosing its player now — from a phase whose interest in playback is verification — would be deciding with strictly less information than Fase 05 will have. The transitional cost is a handful of markup lines. Keep Vidstack and video.js on the record as the Fase 05 shortlist, with HLS (`phase-03-videos/TD-07`'s roadmap item) as the tiebreaker when it arrives.
**Libraries:** —

### phase-03-videos-frontend/TD-08

**Recommendation:** **Option A as the automated baseline, plus Option C's manual smoke as an explicit Definition-of-Done item for this slice** — with Option B recorded as the follow-up once the slice is stable. The reasoning is what TD-01 demonstrated: a fully green suite proved nothing about the browser-facing contract, because every test ran inside Docker. Option A alone would repeat that mistake in a new place, so *something* must touch the real seams; but standing up a second Playwright harness mid-slice adds infrastructure risk to the slice least able to absorb it. The manual smoke is the honest middle — and unlike most manual steps it is cheap here, because the stack is already running and the check is "upload a file, watch it play". If Option B is chosen, it belongs in its own task after this slice lands, not inside it.
**Renders in:** frontend-runtime
**Libraries:** —

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

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### phase-03-videos/TD-01 _(from slice phase-03-videos)_

**Recommendation:** PostgreSQL 17 is already in Compose, the project has an explicit minimal-infra preference, and video jobs need durability more than raw throughput. pg-boss delivers durable, WAL-backed jobs with retry/backoff, a real DLQ, and `singletonKey` idempotency **without adding a container**, and uniquely lets the processing job be enqueued in the same transaction as the draft-video insert. Honest cost: a thin hand-written provider and non-context7 docs. **BullMQ + Redis is a strong runner-up** — pick it if job dashboards, progress reporting, or higher throughput later outweigh adding a second datastore.
**Libraries:** —

### phase-03-videos/TD-02 _(from slice phase-03-videos)_

**Recommendation:** pinned to a specific `3.10xx`. TD-03's viable path is presigned **S3 multipart**, and the AWS SDK is the only option with dedicated, individually-presignable command classes for every step; it signs correctly against MinIO with `forcePathStyle: true` and gives a zero-change path to real S3 in prod.
**Libraries:** —

### phase-03-videos/TD-03 _(from slice phase-03-videos)_

**Recommendation:** with AWS SDK v3 on the backend and Uppy `@uppy/aws-s3` (multipart mode) or a thin `fetch`/`File.slice` client on the Next.js side. It is the only option that keeps the 10GB payload off the API (the decisive constraint), is physically capable of 10GB (Option A is not), and resumes by re-presigning missing parts. Bake in the gotchas: MinIO CORS exposing `ETag`, ~10-min re-fetchable per-part URLs, an abort endpoint + lifecycle rule, and part size ≥5MB except the last.
**Libraries:** —

### phase-03-videos/TD-04 _(from slice phase-03-videos)_

**Recommendation:** in its own Compose service + Dockerfile with FFmpeg — it maximizes reuse of the API's entities/DataSource/config (needed since the worker updates the video row) while dropping the unnecessary HTTP server. If TD-01 lands on BullMQ (which ships first-class Nest processor decorators), escalating to Option B is reasonable for idiomatic consumer wiring; with pg-boss (recommended), Option A's manual `boss.work` loop is trivial.
**Libraries:** —

### phase-03-videos/TD-05 _(from slice phase-03-videos)_

**Recommendation:** Taking a hard dependency on an archived wrapper for a brand-new worker is unjustified risk when its only value is generating CLI args the worker can write directly, and the metadata + single-frame-thumbnail surface here is small and stable. **Technical notes for `implement`:** duration `format.duration`, resolution `streams[].width/height`, codec `codec_name`, bitrate `format.bit_rate`; use input-seeking (`-ss` before `-i`) for speed; ffprobe/ffmpeg can read a **short-lived presigned MinIO URL directly** (range-reads only the needed bytes), so 10GB inputs need not be downloaded whole — keep a temp-disk fallback for non-faststart MP4s. Base image: `node:<ver>-slim` + `apt-get install -y ffmpeg` (or multi-stage `COPY --from=mwader/static-ffmpeg` for a pinned build).
**Libraries:** —

### phase-03-videos/TD-06 _(from slice phase-03-videos)_

**Recommendation:** with a **62-char alphabet** (`0-9a-zA-Z`, dropping `_`/`-` for clean double-click copy) and **length 12**. 62¹² ≈ 3.2×10²¹ ids: even at 100M videos the collision probability is ~10⁻⁶, and a DB unique constraint + generate-retry loop makes an actual duplicate impossible, while `/watch/aB3xK9mZ0qWp` stays YouTube-short. Keep the internal PK as **UUID v7** (or bigint) for index locality — nanoid `public_id` is the only value ever exposed.
**Libraries:** —

### phase-03-videos/TD-07 _(from slice phase-03-videos)_

**Recommendation:** as the primary playback path; **HLS (Option C) is the roadmap target** once the worker's transcoding matures. MinIO serves Range natively against presigned URLs, so seeking/partial playback works with zero API byte-proxying — decisive at 10GB where Option A makes Node the bottleneck. Access stays correct because the API authorizes each URL issuance (public → anyone; unlisted → only visitors holding the `/watch/:publicId` link), with short TTL and a private bucket. Keep the API-proxy pattern available only for cases needing hard per-byte gating.
**Libraries:** —

### phase-03-videos/TD-08 _(from slice phase-03-videos)_

**Recommendation:** it reuses TD-07's presigned-URL mechanism (one authorization + signing helper serves both play and download; the only difference is the disposition param). The API authorizes the request (respecting a per-video "downloads allowed" flag if one is later added), then hands bytes to MinIO. Sanitize/URL-encode `filename` to avoid the `SignatureDoesNotMatch` issue.
**Libraries:** —

### phase-03-videos/TD-09 _(from slice phase-03-videos)_

**Recommendation:** for the notification mechanism, with the `draft→processing→ready|failed` state machine and bounded retry-then-fail above. Uploads are occasional and "your video finished" tolerates seconds of latency — the regime where polling beats SSE — and it reuses the existing Next.js 16 + openapi-fetch + iron-session HTTP path with no long-lived connections or worker→API push to build. Keep SSE as a clean upgrade path (NestJS 11 `@Sse()` is ready) if live progress percentages or high upload volume arrive later.
**Libraries:** —

### next-frontend-config-base/TD-01 _(correlator-confirmed)_

**Recommendation:** **Option A (Zod 4)**. Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts, satisfying the project's "Type Safety" working principle. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation), so introducing it once at the env layer compounds value for forms in Phase 02+. (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator. Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE (different runtimes, different key sets); two validators across two subprojects is a bounded cost.
**Libraries:** —

### next-frontend-config-base/TD-02 _(correlator-confirmed)_

**Recommendation:** **Option A (`@t3-oss/env-nextjs`)**. The only option that combines (i) **type-level NEXT_PUBLIC_ prefix enforcement**, (ii) **runtime Proxy-based leak detection**, and (iii) **single-file, single-import-path consumer ergonomics**. Option B reaches roughly the same _structural_ outcome at higher implementation and maintenance cost, with a weaker guarantee (no prefix enforcement, no proxy). Option C is unsafe at any non-trivial team size. The marginal cost over B is one ~3KB dep — well-spent for the strongest boundary among the three.
**Libraries:** —

### next-frontend-config-base/TD-03 _(correlator-confirmed)_

**Recommendation:** **Option A (Strict BFF — single server-only `API_URL`)**. Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below. > **Out-of-scope ancillary note (NOT a TD here):** Once Option A is chosen, the concrete _value_ of `API_URL` in dev (`http://host.docker.internal:3000` vs joining the two Compose stacks into a shared network with `http://nestjs-api:3000`) is a Docker-Compose-topology decision that this research does not resolve. It belongs in either Phase 02's pre-work or a dedicated infra ad-hoc TD. The env-key contract (this TD) is intentionally independent of how the value is resolved at runtime.
**Libraries:** —

### next-frontend-msw-foundation/TD-01 _(correlator-confirmed)_

**Recommendation:** **Option B (per-domain modules + barrel)**. Three reasons. (1) **MSW's own best-practice recommends it** — the project should not invent its own scheme when the official one is documented and matches the codebase's domain orientation. (2) **Domain ownership tracks the codebase**, not the project plan — `components/`, `app/api/`, and any future feature folders will be organized by domain (auth, videos, channels), so handler files mirror that vocabulary and remain stable as phases come and go. (3) **Append-only growth with minimal merge conflicts** — each phase touches a new file plus one line in the barrel, which is the smallest practical concurrent-PR footprint. Option A is acceptable through Phase 02 alone (~5–7 endpoints) but accumulates costs that B avoids from day one; bootstrapping directly into B costs one extra file and one barrel and pays off by Phase 03. Option C's phase coupling is rejected outright — domain-by-phase is a category error. > **File naming inside each domain module.** Inside `handlers/<domain>.ts`, group handlers by **HTTP method + path** rather than by test scenario — a single handler is the happy-path default; per-test error/edge scenarios are added via `server.use(...)` in the test file, never as additional handlers in the domain file. This keeps the domain file small and stable (one handler per `paths` entry, not one handler per assertion case).
**Libraries:** —

### next-frontend-msw-foundation/TD-02 _(correlator-confirmed)_

**Recommendation:** **Option A (test-only, `setupServer` only at the foundation)**. The browser worker is a future capability with no documented current consumer; wiring it now (Option B) is speculative investment, and wiring it incoherently (Option C) actively misleads developers into thinking interception works when it doesn't under strict BFF. Option A keeps the foundation minimal, aligns 1:1 with everything CLAUDE.md and the existing rules currently document, and is non-breaking to extend.
**Libraries:** —

### next-frontend-msw-foundation/TD-03 _(correlator-confirmed)_

**Recommendation:** **Option D (hand-written defaults as the default + opt-in seeded faker for bulk collections)**. Reasons: (1) **Option B's determinism + readability is the right baseline** — every fixture in Phase 02 (5–7 endpoints, single-record-mostly) is naturally hand-written, and the diff-revealing override pattern is the highest-value benefit. (2) **Bulk-collection cases will arrive (Phase 07 home page grid, Phase 06 comment threads) and inline hand-written lists of 20+ items are genuinely tedious** — keeping faker available as a scoped tool is pragmatic. (3) **Per-fixture local seeding eliminates the global-cursor pitfall** that makes Option C structurally fragile — using `faker.seed(N)` immediately before a collection-builder run scopes the determinism to that fixture and isolates it from upstream changes to other factories. _(Concrete `buildVideo` / `buildVideoList` code example omitted here — see the decisions doc.)_ If the project never reaches a real bulk-collection use case, faker is simply never installed — Option D collapses into Option B in practice, with zero retroactive cost. Add `@faker-js/faker` to `devDependencies` only when the first `buildXList` is authored.
**Libraries:** —

### next-frontend-msw-foundation/TD-04 _(correlator-confirmed)_

**Recommendation:** **Option A (universal handler set + `server.use(...)` overrides + `onUnhandledRequest: "error"`)**. The user's "import only what it needs" requirement is satisfied at the *authoring* layer by TD-01 (per-domain files; each phase adds one file). At the *runtime* layer, loading all handlers is the canonical MSW v2 model and imposes no cost on tests that don't fetch the extra URLs. `onUnhandledRequest: "error"` enforces that a phase's test cannot accidentally invoke a route outside its scope (the fetch fails loudly with "no handler matched"), which is the strongest version of "stays inside its phase" available. Option B's per-suite composition pays real boilerplate cost for an explicitness gain that TD-01 already provides at a different layer. Option C invents a Vitest-projects-shaped problem for a phase-shaped concern. _(Concrete `vitest.config.ts` / `mocks/setup.ts` wiring example omitted here — see the decisions doc.)_ Phase 02+ tests need no additional setup — they `import { POST } from "@/app/api/auth/signup/route"`, build a `Request`, await the handler, and assert. Per-test deviations call `server.use(...)` inline.
**Libraries:** —

### next-frontend-openapi-typing/TD-01 _(correlator-confirmed)_

**Recommendation:** **Option A (`openapi-typescript` + `openapi-fetch`)**. Three reinforcing reasons. (1) **Strict BFF makes the SDK surface valueless on the client.** Only Route Handlers ever call the upstream Nest; they already use `fetch` (Next 16's caching extensions sit on top of native `fetch`); a generated SDK adds a third client style to learn for zero functional gain. (2) **Types-first matches the rest of the FE foundation.** Env validation is Zod-derived types; component variants are `cva` types; both are TS-first with zero generated runtime. `paths` is the natural extension — one `.d.ts` file imported wherever the contract is touched. (3) **MSW typing is solved by the same `paths` symbol.** Hand-written handlers in `mocks/handlers.ts` type their resolver returns off `paths["/videos"]["get"]["responses"][200]`, giving the contract guarantee without orval/kubb's verbose generated handlers (which would be overridden per-test anyway). The marginal cost of adding `openapi-fetch` (~6KB, server-side only) is small enough that we recommend the **types + thin-client** pair, not types alone — `openapi-fetch` removes the `fetch(API_URL + path, { method, headers, body })` boilerplate in each Route Handler while staying within the BFF model. Options B/C/D may be revisited if (a) client-side data-fetching enters the stack with TanStack Query and per-endpoint hooks are wanted, or (b) the API grows beyond ~20 operations and per-call boilerplate becomes painful.
**Libraries:** —

### next-frontend-openapi-typing/TD-02 _(correlator-confirmed)_

**Recommendation:** **Option B (committed local copy + repo-root sync script)**. Three reasons. (1) **Preserves the compose-stack independence** that `next-frontend-config-base/TD-03` Context calls out as the current architecture — neither subproject's compose file references the other. (2) **Drift is eliminated structurally when paired with TD-03's CI freshness check** — the check runs the sync script and asserts no diff on either `openapi.json` or `types.gen.ts`, so a backend PR that forgets to re-sync fails CI with a clear message. (3) **The committed local file is a real artifact in PR review** — reviewers see the contract change in `next-frontend/openapi.json`'s diff at the same time as the backend change, doubling the visibility (an `openapi.json`-only diff in a feature PR is a red flag for accidental drift). Option A is acceptable as a pre-CI fallback; Option C is rejected because the cross-stack file dependency in `docker-compose.yaml` introduces coupling that the current architecture explicitly avoids, and the "no drift" gain over B is small once TD-03 lands.
**Libraries:** —

### next-frontend-openapi-typing/TD-03 _(correlator-confirmed)_

**Recommendation:** **Option C (committed + CI freshness check)**. It is the only option that makes contract drift _both_ visible (in PR diffs) _and_ impossible to merge accidentally (CI fail). The complexity premium over Option A is one CI step. Option B's "no committed artifacts" purity is poorly paid for in a monorepo where the cross-subproject build coupling becomes a real ergonomic cost, and it wastes the PR visibility that TD-02 Option B's committed `openapi.json` is specifically designed to deliver. Option A is acceptable as a temporary state until the CI pipeline lands; downgrading from C to A is reversible (just remove the CI step) but upgrading to C later requires explaining `types.gen.ts` history in a separate commit. Start at C. Apply the same script-and-check pattern to any future generated artifact (e.g., if `openapi-fetch` is wrapped, the wrapper file is hand-written; the only generated artifact remains `types.gen.ts`).
**Libraries:** —

### next-frontend-openapi-typing/TD-04 _(correlator-confirmed)_

**Recommendation:** **Option A (single `lib/api/contracts.ts` with explicit aliases)**. It is the only option that (i) handles pass-through and reshape with the same mechanism, (ii) gives a single grep target for "what shape does the BFF expose", and (iii) decouples Component imports from App Router file paths (Components import `from "@/lib/api/contracts"`, not `from "@/app/api/videos/route"`). Option B is theoretically minimal but fragile against Next's actual RSC/Client/Route-Handler typing; Option C scatters the contract surface and creates drift opportunities. The "long file" concern is bounded — for the scope of StreamTube, the BFF will likely have <30 contract aliases at peak; sectioning by feature header comments is sufficient. Make `lib/api/contracts.ts` the only file that imports `paths` from `types.gen.ts` (lintable later); every other consumer imports from `contracts.ts`.
**Libraries:** —

### next-frontend-openapi-typing/TD-05 _(correlator-confirmed)_

**Recommendation:** **Option A (hand-written, typed via `paths`)**. Reasons: (1) **Determinism over auto-generation** — BFF integration tests assert on specific values; randomized fixtures are anti-helpful. (2) **Coherence with TD-01 recommendation** — `openapi-typescript`'s `paths` type is the single contract anchor; reusing it in MSW handlers means "spec ↔ handler ↔ assertion" is one type chain. (3) **Scale fit** — Phase 02 introduces few endpoints; the manual cost is negligible at this stage. If the API grows to dozens of endpoints and authoring overhead becomes real, this TD can be superseded with a Kubb-or-hey-api MSW plugin without touching TD-01's `paths` import sites (the generator just produces additional handler files; the existing manual handlers stay valid). Option B locks the project into a heavier TD-01 choice for marginal mock-authoring savings; Option C is Option A with an unnecessary detour.
**Libraries:** —

### openapi-docs-nestjs/TD-01 _(correlator-confirmed)_

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** —

### openapi-docs-nestjs/TD-02 _(correlator-confirmed)_

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03 _(correlator-confirmed)_

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: ... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | deferred_to_next_phase — a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. Refs: phase-02-auth-frontend/TD-01, phase-02-auth-frontend/TD-04. |

## UI Inventory

_Frontend-runtime only — no screen inventory needed for this phase.
Run /screen-inventory <arg> if a UI surface is added in a future revision._

> Re-classified 2026-08-22 by `/plan-resolve` (`IC-1`, `IC-2`, `IC-3`, `IC-4`). Every TD of this slice is a runtime or contract decision, not a screen decision: TD-02, TD-05 and TD-08 carry `Renders in: frontend-runtime`, and TD-07 was restated as `Scope: Cross-layer` (the playback/download *contract*, zero screen commitment). The two screens the slice does ship are throwaway verification surfaces whose routes are pinned in the decisions doc (`AMB-1`): `/videos/upload` and `/videos/:publicId/preview` — deliberately non-colliding with Fase 05's `/watch/:publicId`.
>
> Prior deferral reason (2026-08-15, superseded by the above): `/screen-inventory` requires the Figma MCP connector, which is **not present in `.mcp.json`** (only `postgres` and `context7`), and no Fase 03 screens exist in the project's Figma file (`Doz7n3FsRhfvelYrPhTZAG`, used for Fase 02). Promotion path remains non-destructive: connect the Figma MCP, run `/screen-inventory`, rerun `/plan-context`.

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### next-frontend

| Artifact type | Required layers |
|---------------|-----------------|
| Page — sync RSC, static, no logic | None at component level; cover only if part of a critical flow → `*.e2e-spec.ts` |
| Page — sync RSC composing client children | Test client children directly; cover rendered page via `*.e2e-spec.ts` |
| Page — async RSC (`async function Page()` with `await`) | `*.e2e-spec.ts` only — Vitest cannot render it |
| Layout (`layout.tsx`) | None unless it adds logic (auth gate, conditional render); else via E2E |
| Client component (`"use client"`) with state/handlers | `*.test.tsx` — RTL + `jsdom` docblock, mock `next/navigation`, MSW for fetch |
| Feature component (server, composes primitives) | Skip unit; cover via the page's E2E |
| shadcn UI primitive (`components/ui/*`) | None — trust the library; cover via consumers |
| Icon (`components/icons/*`) | None |
| `lib/` utility / boundary module with branching or shape assumptions | `*.test.ts` |
| Custom hook (`hooks/*`) | `*.test.ts(x)` with `renderHook`, `jsdom` docblock |
| Route handler (`app/api/**/route.ts`) — proxy or with branching | `*.integration.test.ts` with MSW (+ `*.test.ts` for extracted pure logic) |
| Server action / middleware / error-loading-not-found / metadata | See `artifacts/future-types.md` — depends on type |

Hard boundaries relevant to this slice:

- MSW (`msw/node`) is the **only** fake for the NestJS upstream. No Vitest test may open a real network connection to the upstream host; `mocks/setup.ts` runs `onUnhandledRequest: "error"`.
- E2E specs **MUST NOT** browser-intercept `/api/**` (`page.route()`) — it short-circuits the real Route Handlers. Upstream is faked server-side via `instrumentation.ts` with `onUnhandledRequest: "bypass"`. _(Note for TD-08: object-storage origins are **not** `/api/**`, so intercepting those does not violate this rule.)_
- Async Server Components are not Vitest-renderable (React 19 / Next 16) — Playwright only.
- JSX/TSX tests require the `// @vitest-environment jsdom` docblock; default env is `node`.

> **Guide staleness note (informational, for `/plan-validate`):** the guide's Tooling-status block (dated 2026-05) states "Playwright is not yet installed". That is no longer true — `next-frontend/package.json` carries `@playwright/test@^1.60.0`, `playwright.config.ts` exists, and a `test:e2e` script is defined. The guide's E2E recipes are the binding contract regardless; only the status line is out of date.

### nestjs-project

_In scope only for TD-01 and TD-04, both of which touch `ObjectStorageService` / `videos` controller-service surface._

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
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

Hard boundaries relevant to this slice:

- Integration and E2E suites share a single test database and **must** run with `--runInBand` / `maxWorkers: 1`.
- Services throw **domain exceptions**, never NestJS HTTP exceptions; filters map them.
- `Test.createTestingModule()` does not execute `main.ts` — global pipes/filters/interceptors must be applied explicitly in E2E.
