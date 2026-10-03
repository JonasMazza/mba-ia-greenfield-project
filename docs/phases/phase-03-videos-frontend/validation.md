---
kind: phase
name: phase-03-videos-frontend
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos-frontend/context.md: "2026-08-15T22:47:33-03:00"
  docs/decisions/technical-decisions-phase-03-videos-frontend.md: "2026-08-15T16:25:06-03:00"
  docs/project-plan.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-24T14:25:37-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-02 Scope: Frontend orphaned — UI Inventory deferred"
    resolved_by: marker_frontend_runtime
  - id: IC-2
    status: resolved
    summary: "TD-05 Renders in: frontend-runtime but UI Inventory is deferred, not logic-only"
    resolved_by: marker_frontend_runtime
  - id: IC-3
    status: resolved
    summary: "TD-07 defines a playback screen but slice has no active UI scope"
    resolved_by: phase-03-videos-frontend/TD-07
  - id: IC-4
    status: resolved
    summary: "TD-08 Scope: Frontend orphaned — UI Inventory deferred"
    resolved_by: marker_frontend_runtime
  - id: IC-5
    status: resolved
    summary: "Sibling TD-03/TD-07 shown as authoritative while TD-01/TD-04 call them broken"
    resolved_by: revision:phase-03-videos/TD-03,phase-03-videos/TD-07
  - id: IC-6
    status: resolved
    summary: "next-frontend/openapi.json gitignored vs openapi-typing/TD-02 committed copy"
    resolved_by: clarification
  - id: IC-7
    status: resolved
    summary: "No .github/workflows — openapi-typing/TD-03 CI freshness guard absent"
    resolved_by: clarification
  - id: IC-8
    status: resolved
    summary: "Testing guide claims Playwright not installed; it is installed"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "Slice admits it delivers screens but no route/screen is enumerated anywhere"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD decides this slice's download surface (TD-07 covers playback only)"
    resolved_by: phase-03-videos-frontend/TD-07
  - id: DG-1
    status: resolved
    summary: "types.gen.ts carries no /videos paths; OpenAPI sync is an unplanned prereq"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — browser-reachable host for presigned storage URLs"
    resolved_by: phase-03-videos-frontend/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — multipart upload client implementation"
    resolved_by: phase-03-videos-frontend/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — part-URL signing cadence (upload control plane)"
    resolved_by: phase-03-videos-frontend/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — upload resume across page reload (ETag contract)"
    resolved_by: phase-03-videos-frontend/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — processing-status tracking on the client"
    resolved_by: phase-03-videos-frontend/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — playback URL lifetime vs. session length"
    resolved_by: phase-03-videos-frontend/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — playback surface for this slice"
    resolved_by: phase-03-videos-frontend/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — test strategy for the direct-to-storage byte path"
    resolved_by: phase-03-videos-frontend/TD-08
advisories: []
---

# phase-03-videos-frontend — Validation

## Findings

### Inconsistencies

_None open._ — IC-1..IC-8 resolved by `/plan-resolve` on 2026-08-22; see `## Resolved Issues`.

### Ambiguities

_None open._ — AMB-1 resolved by `/plan-resolve` on 2026-08-22.

### Missing Decisions

_None open._ — MD-1 resolved by `/plan-resolve` on 2026-08-22 without a new TD (folded into the widened `TD-07`).

### Dependency Gaps

_None open._ — DG-1 resolved by `/plan-resolve` on 2026-08-22 as a blocking first SI for `/plan-build`.

### Inherited Constraint Conflicts

_None._ — Check 5 compares **decided** current-scope TDs against inherited conventions and TDs; at the time this file was written all 8 TDs were `pending`, so the check was vacuous. **All 8 are now decided** — re-run `/plan-validate videos-frontend` so Check 5 executes for real. TD-01 and TD-06 are the expected candidates to surface an ICC against `phase-03-videos/TD-03` and `TD-07`; both sibling TDs now carry a `**Revisions:**` block recording exactly that divergence (see IC-5), which is the intended landing place for it.

### Unresolved Open Questions

_None open._ — OQ-1..OQ-8 resolved by `/plan-resolve` on 2026-08-22; every TD of this slice now carries a filled `**Decision:**`.

_No `### Open Questions from Inventory` block exists — no screen inventory is authored for this slice (see `## UI Inventory`, now `logic-only`)._

### UI Coverage Gaps

_None._ — Check 7 was skipped on the previous run because `## UI Inventory` carried the deferred token-anchor. The placeholder is now the **logic-only** token-anchor (`_Frontend-runtime only —`), which also skips UIG-N by design: the slice has no screen inventory to join against, and every TD is a runtime or contract decision. Re-run `/plan-validate videos-frontend` to confirm under the new placeholder.

### Capability Consistency (slicing, phase mode only)

_None._ — Check 8.a ran (phase 03 has 2 slices: `phase-03-videos`, `phase-03-videos-frontend`). All 5 `covers_capabilities` entries of this slice match `docs/project-plan.md:75,76,77,80,81` verbatim. `covers_capabilities` was **not** mutated by this resolve run (MD-1 was closed by widening `TD-07`, not by dropping a bullet), so the check's verdict stands.

## Cross-slice Advisories

_None._ — Step 8.b ran (zero CC-N). `covered` = union of both slices = all 9 phase-03 bullets, because the sibling's omitted `covers_capabilities` claims the full set; `expected \ covered` is empty. Note the intentional overlap: 5 bullets are claimed by both slices, which is the normal shape of a backend/frontend split (each covers its own half of the same capability), not a coverage defect.

## Resolved Issues

All resolutions below were applied by `/plan-resolve videos-frontend` on **2026-08-22**, from explicit user answers.

### Technical decisions filled (OQ-1..OQ-8)

- **OQ-1** — TD-01 pending — browser-reachable host for presigned storage URLs. `resolved_by: phase-03-videos-frontend/TD-01` — **Option A**, dual endpoint: separate internal and public signing clients. The worker's internal presign at `video-processor.service.ts:79` keeps the internal endpoint; the five browser-facing call sites move to the public one.
- **OQ-2** — TD-02 pending — multipart upload client implementation. `resolved_by: phase-03-videos-frontend/TD-02` — **Option A**, `@uppy/aws-s3` in multipart mode used headlessly (Uppy core + plugin, this project's own React UI on top). Libraries cached in `library-refs.md`.
- **OQ-3** — TD-03 pending — part-URL signing cadence. `resolved_by: phase-03-videos-frontend/TD-03` — **Option A**, sign one part at a time, on demand. This is Uppy's native `signPart` cadence, so TD-02's choice makes it the default rather than a customization.
- **OQ-4** — TD-04 pending — upload resume across page reload. `resolved_by: phase-03-videos-frontend/TD-04` — **Option B**, the backend exposes the uploaded parts via an owner-scoped `GET /videos/:publicId/upload/parts` (404-not-403 semantics, matching its siblings). Maps one-to-one onto Uppy's `listParts` hook. Second and last backend change this slice proposes.
- **OQ-5** — TD-05 pending — processing-status tracking on the client. `resolved_by: phase-03-videos-frontend/TD-05` — **Option A**, hand-rolled `useVideoStatus` hook mirroring `use-session.ts`. Explicitly flagged for Fase 04 research: revisit TanStack Query v5 as a deliberate agenda item, not by default.
- **OQ-6** — TD-06 pending — playback URL lifetime vs. session length. `resolved_by: phase-03-videos-frontend/TD-06` — **Option C**, a stable same-origin BFF URL issuing a fresh redirect per request. Keeps the short TTL and Node out of the byte path, and upgrades issuance-time-only authorization to per-request authorization.
- **OQ-7** — TD-07 pending — playback surface for this slice. `resolved_by: phase-03-videos-frontend/TD-07` — **Option A**, native `<video controls>`. Vidstack and video.js stay on record as the Fase 05 shortlist, with HLS as the tiebreaker.
- **OQ-8** — TD-08 pending — test strategy for the direct-to-storage byte path. `resolved_by: phase-03-videos-frontend/TD-08` — **Option A + C**: Option A as the automated baseline (Vitest with `msw/node` faking both planes; Playwright stubs the storage host) plus Option C's manual smoke against the real stack as an explicit Definition-of-Done item. Option B (full-stack Playwright against real NestJS + MinIO) recorded as a follow-up task after the slice lands.

### Orphaned-TD cluster (IC-1, IC-2, IC-4)

- **IC-1** — TD-02 `Scope: Frontend` orphaned under a deferred inventory. `resolved_by: marker_frontend_runtime` — `**Renders in:** frontend-runtime` injected into `phase-03-videos-frontend/TD-02`; `## UI Inventory` body flipped to the logic-only token-anchor; `## Decisions Detail` + `## Decisions Index` row patched in context.md.
- **IC-2** — TD-05 already carried the marker but it only renders under `logic-only`. `resolved_by: marker_frontend_runtime` — same `## UI Inventory` flip (idempotent, applied once for the whole cluster). TD-05's marker was additionally reordered to the canonical `Decision → Renders in` position in the decisions doc.
- **IC-4** — TD-08 `Scope: Frontend` orphaned, same mechanics as IC-1. `resolved_by: marker_frontend_runtime` — `**Renders in:** frontend-runtime` injected into `phase-03-videos-frontend/TD-08`; same inventory flip.

### Scope and coverage

- **IC-3** — TD-07 was irreducibly a screen decision in a slice with no active UI scope. `resolved_by: phase-03-videos-frontend/TD-07` — TD-07 restated as `Scope: Cross-layer` and retitled *Playback & Download Contract for This Slice*: it now decides the contract the browser consumes (which URL shape, which element) with **zero screen commitment**. Coherent with `## Scope` handing the watch page to Fase 05.
- **MD-1** — no TD decided this slice's download surface. `resolved_by: phase-03-videos-frontend/TD-07` — closed **without** new research by widening TD-07's `**Capability:**` to also cover `"Download do vídeo pelo usuário"`. TD-06 (Option C) already delivers the mechanism — the same BFF redirect with `downloadFilename` set — so the surface is a plain `<a download>` on the verification page. `## Capability Coverage` in context.md updated to `TD-01, TD-06, TD-07`.
- **AMB-1** — no artifact enumerated the slice's screens or routes. `resolved_by: clarification` — an explicit route list was added to the decisions doc, deliberately chosen so it cannot collide with Fase 05's `/watch/:publicId`:
  - `/videos/upload` — upload screen (TD-02, TD-03, TD-04) + processing-status surface (TD-05).
  - `/videos/:publicId/preview` — minimal playback/download surface proving the streaming and download contracts (TD-06, TD-07). Fase 05 replaces it with the real watch page; nothing else may link to it as a permanent destination.

### Sibling-contract divergence

- **IC-5** — the sibling `phase-03-videos` kept asserting contracts this slice replaces. `resolved_by: revision:phase-03-videos/TD-03,phase-03-videos/TD-07` — a `**Revisions:**` block was appended to both sibling TDs, dated 2026-08-22, naming the revising TDs (`TD-01`, `TD-04` for the multipart handshake; `TD-06`, `TD-01` for the playback path) with the rationale *"browser-facing half of the contract revised by the frontend slice"*. The sibling's protocol choices themselves are unchanged.

  > **Sibling restamp needed.** `docs/decisions/technical-decisions-phase-03-videos.md` was mutated, so `docs/phases/phase-03-videos/`'s `context.md`, `validation.md` and built artifact now carry stale `sources_mtime` entries for it. Run `/plan-context phase-03-videos` when convenient — this slice is unaffected (its own `context.md` tracks the sibling's `context.md`, not the sibling's decisions doc).

### Carried into `/plan-build` as plan actions

- **DG-1** — `types.gen.ts` carries no `/videos` paths. `resolved_by: clarification` — becomes an **explicit first SI** in `/plan-build`: `bash scripts/sync-openapi.sh` (host) then `docker compose exec next-frontend npm run openapi:types` (container), blocking every other frontend SI in the Dependency Map.
- **IC-6** — `next-frontend/openapi.json` is gitignored although `openapi-typing/TD-02` calls it committed. `resolved_by: clarification` — **honor TD-02**: remove `openapi.json` from `next-frontend/.gitignore` and commit both `openapi.json` and `types.gen.ts` in the same PR, per `.claude/rules/next-frontend-bff-api.md`. Folded into the DG-1 SI, since the sync step is what produces the artifact git currently refuses to stage.
- **IC-7** — the `openapi-typing/TD-03` CI freshness guard does not exist (no `.github/` at all). `resolved_by: clarification` — **author the workflow in this slice**: `.github/workflows/openapi-freshness.yml`, one job running `scripts/sync-openapi.sh` + `npm run openapi:types` and asserting an empty diff. Pairs with IC-6 — the guard only works once the artifacts are committed.

### Deferred to a post-build chore

- **IC-8** — `testing-guide-next-frontend`'s tooling-status block claims Playwright is not installed, but `@playwright/test@^1.60.0`, `playwright.config.ts` and `test:e2e` all exist. `resolved_by: clarification` — the plan is unaffected; the status line is corrected **after** `/plan-build`, as a standalone chore, so it cannot invalidate a `sources_mtime` key mid-pipeline. Removes the risk that `/implement` (which loads the skill directly, not context.md) scaffolds Playwright a second time while implementing TD-08.
