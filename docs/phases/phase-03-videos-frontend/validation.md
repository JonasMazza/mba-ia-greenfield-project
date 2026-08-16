---
kind: phase
name: phase-03-videos-frontend
status: dirty
issue_count: 19
sources_mtime:
  docs/phases/phase-03-videos-frontend/context.md: "2026-08-15T22:47:33-03:00"
  docs/decisions/technical-decisions-phase-03-videos-frontend.md: "2026-08-15T16:25:06-03:00"
  docs/project-plan.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-24T14:25:37-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-02 Scope: Frontend orphaned — UI Inventory deferred"
  - id: IC-2
    status: open
    summary: "TD-05 Renders in: frontend-runtime but UI Inventory is deferred, not logic-only"
  - id: IC-3
    status: open
    summary: "TD-07 defines a playback screen but slice has no active UI scope"
  - id: IC-4
    status: open
    summary: "TD-08 Scope: Frontend orphaned — UI Inventory deferred"
  - id: IC-5
    status: open
    summary: "Sibling TD-03/TD-07 shown as authoritative while TD-01/TD-04 call them broken"
  - id: IC-6
    status: open
    summary: "next-frontend/openapi.json gitignored vs openapi-typing/TD-02 committed copy"
  - id: IC-7
    status: open
    summary: "No .github/workflows — openapi-typing/TD-03 CI freshness guard absent"
  - id: IC-8
    status: open
    summary: "Testing guide claims Playwright not installed; it is installed"
  - id: AMB-1
    status: open
    summary: "Slice admits it delivers screens but no route/screen is enumerated anywhere"
  - id: MD-1
    status: open
    summary: "No TD decides this slice's download surface (TD-07 covers playback only)"
  - id: DG-1
    status: open
    summary: "types.gen.ts carries no /videos paths; OpenAPI sync is an unplanned prereq"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — browser-reachable host for presigned storage URLs"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — multipart upload client implementation"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — part-URL signing cadence (upload control plane)"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — upload resume across page reload (ETag contract)"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — processing-status tracking on the client"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — playback URL lifetime vs. session length"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — playback surface for this slice"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — test strategy for the direct-to-storage byte path"
advisories: []
---

# phase-03-videos-frontend — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos-frontend/TD-02` (Multipart Upload Client Implementation) carries `Scope: Frontend`, but `## UI Inventory` holds the deferred placeholder (`_No screen inventory — UI↔API sync deferred._`). Per Decisão #17 the TD is filtered out of the backend subsections (Data Model / API Contracts) on Scope mismatch, and no `### UI Contracts` subsection is emitted — so the TD would be **orphaned in the final plan artifact**. Explicit choice: (a) change TD Scope to `Cross-layer` — defensible, since the client's part-fetch cadence is the browser half of the same contract `TD-03` decides on the backend; (b) add active UI scope (run `/screen-inventory phase-03-videos-frontend`, then rerun `/plan-context videos-frontend`); (c) remove the TD; (d) mark `Renders in: frontend-runtime` and flip the inventory placeholder to `logic-only`.

- **IC-2** — `phase-03-videos-frontend/TD-05` already carries `Renders in: frontend-runtime`, which is the correct marker for an FE-runtime architectural TD — but the marker only renders under `ui_in_scope: logic-only`. The inventory placeholder is `deferred`, not `logic-only`, so the `### Frontend Runtime` subsection is not emitted and TD-05 is orphaned anyway. Explicit choice: (a) flip the `## UI Inventory` placeholder from the deferred token-anchor to the `logic-only` token-anchor (`_Frontend-runtime only —`), which makes TD-05 render and is the cheapest fix — but note this also suppresses the deferral's documented promotion path; (b) resolve IC-3 first (activate real UI scope), which subsumes this; (c) accept the orphan and re-home TD-05 in a later slice.

- **IC-3** — `phase-03-videos-frontend/TD-07` (Playback Surface for This Slice) carries `Scope: Frontend` and is, by its own title, a **screen decision** — yet `## UI Inventory` is deferred and `## Scope` (line 42 of context.md) simultaneously assigns the watch page to Fase 05. So the slice declares it will build a playback surface while declaring it has no UI scope and that the playback screen belongs to a later phase. This is the sharpest instance of the orphan class: the other three Frontend TDs are arguably cross-layer or runtime, but TD-07 is irreducibly a UI surface. Explicit choice: (a) activate UI scope for this slice — either via `/screen-inventory` (needs the Figma MCP connector, absent from `.mcp.json`) or by authoring the inventory by hand for the 1–2 screens this slice actually ships; (b) hand the whole playback surface to Fase 05 and drop `Reprodução via streaming` + TD-07 from this slice; (c) restate TD-07 as `Cross-layer` covering only the playback *contract* (which URL shape the browser consumes), with zero screen commitment.

- **IC-4** — `phase-03-videos-frontend/TD-08` (Test Strategy for the Direct-to-Storage Byte Path) carries `Scope: Frontend` with the inventory deferred → same orphan mechanics as IC-1. Explicit choice: (a) change Scope to `Cross-layer` — the byte path it tests spans browser → MinIO and the decision constrains backend CORS/presign behaviour as much as frontend test wiring; (b) `Renders in: frontend-runtime` + `logic-only` inventory; (c) remove.

- **IC-5** — `## Inherited Decisions Detail` presents `phase-03-videos/TD-03` (presigned S3 multipart handshake) and `phase-03-videos/TD-07` (presigned URL as the primary playback path, "zero API byte-proxying") as settled, authoritative inherited decisions. At the same time `## Scope` (line 49) states that this slice's `TD-01` and `TD-04` exist because the browser-facing half of those very contracts is "provably broken" or "missing", and TD-06 is expected to route playback through a same-origin endpoint instead of handing the browser a raw presigned URL. Nothing on the sibling doc records that its contracts are under revision, so `phase-03-videos`' own `context.md` and built artifact keep asserting the superseded shape. Explicit choice: when `/plan-resolve` decides TD-01 / TD-04 / TD-06, also append a `**Revisions:**` block to `phase-03-videos/TD-03` and `phase-03-videos/TD-07` naming the revising TDs (the "Append revision to TD-YY" primitive), so the sibling stops asserting a contract this slice replaces. Alternative: (b) record the divergence as a deliberate FE-only overlay and leave the sibling untouched — cheaper, but leaves two documents describing the same wire contract differently.

- **IC-6** — Inherited `next-frontend-openapi-typing/TD-02` decided **Option B — committed local copy + repo-root sync script**, and its stated rationale is that the committed `next-frontend/openapi.json` is "a real artifact in PR review" whose diff makes contract drift visible. The repo contradicts this: `next-frontend/.gitignore:42` lists `openapi.json`, the file is untracked, and it is not on disk. The sync script (`scripts/sync-openapi.sh`) exists and is executable. Consequence for this slice: the DG-1 fix (running the sync) produces a file git silently refuses to stage, so the drift-visibility mechanism TD-02 depends on fails without any error. Explicit choice: (a) honor TD-02 — remove `openapi.json` from `next-frontend/.gitignore` and commit both `openapi.json` and `types.gen.ts` in the same PR, per the `next-frontend-bff-api.md` rule; (b) supersede TD-02 to Option A (generate-on-demand, uncommitted) and update the rule doc to match.

- **IC-7** — Inherited `next-frontend-openapi-typing/TD-03` decided **Option C — committed + CI freshness check**, explicitly arguing that Option A ("acceptable as a temporary state until the CI pipeline lands") is the weaker fallback. `next-frontend/CLAUDE.md` and the TD both describe the guard as existing. It does not: there is no `.github/` directory at all, hence no `.github/workflows/openapi-freshness.yml`. Consequence: nothing prevents the `/videos` contract from drifting again after this slice ships — which is exactly the failure DG-1 documents having already happened once. Explicit choice: (a) author the workflow as part of this slice (small: one job running `scripts/sync-openapi.sh` + `npm run openapi:types` and asserting an empty diff) — pairs naturally with IC-6, since the guard only works if the artifacts are committed; (b) downgrade TD-03 to Option A and correct the claims in `next-frontend/CLAUDE.md` so the docs stop asserting a guard that does not exist; (c) record it as a separate infra task and keep this slice's scope clean — respects *Scope Limits*, but leaves (b)'s doc-vs-reality lie in place until that task runs.

- **IC-8** — `## Testing Requirements` carries a note flagging that the `testing-guide-next-frontend` skill's tooling-status block states "Playwright is not yet installed", while `next-frontend/package.json` carries `@playwright/test@^1.60.0`, `playwright.config.ts` exists, and `test:e2e` is defined (all three verified). The note is correct that the guide's E2E recipes remain binding — the plan is not affected. The residual risk is at `/implement` time, which loads the guide skill directly (not context.md) and could scaffold Playwright a second time. This bears on TD-08, whose likely resolution is Playwright-based. Explicit choice: (a) correct the status line in `.claude/skills/testing-guide-next-frontend/SKILL.md` as a standalone chore before `/implement` — note this mutates a `sources_mtime` key and will force one `/plan-context videos-frontend` rerun, so do it *before* `/plan-resolve` or *after* the build; (b) accept as documented-and-known, relying on the context.md note.

### Ambiguities

- **AMB-1** — The deferral note in `## UI Inventory` states plainly that "the slice **does** deliver screens", and `## Affected subprojects` commits to an "Upload screen" and a "minimal playback/download surface" — but no artifact enumerates which screens, at which routes, with which entry points. `/screen-inventory` was skipped, and no TD carries route information. `/plan-build` would therefore have to invent routes to write screen-wiring SIs. The concrete risk is collision: Fase 05 owns the watch page, and the natural route for a "minimal playback surface" is `/watch/:publicId` — the exact route Fase 05 will claim. Explicit choice: (a) run `/screen-inventory phase-03-videos-frontend` (blocked on the Figma MCP connector, absent from `.mcp.json`); (b) hand-author a minimal inventory listing the 2–3 screens and their routes — sufficient to unblock, and it also resolves IC-1..IC-4; (c) add an explicit route list to `## Scope` via a decisions-doc edit and rerun `/plan-context videos-frontend`, deliberately choosing throwaway routes (e.g. `/videos/:publicId/preview`) that cannot collide with Fase 05.

### Missing Decisions

- **MD-1** — The capability **"Download do vídeo pelo usuário"** is claimed by this slice (`covers_capabilities`, verified verbatim against `project-plan.md:81`) and `## Capability Coverage` maps it to TD-01 + TD-06. But both of those decide *URL mechanics* (reachable host; URL lifetime), not a surface — and `## Scope` line 42 explicitly assigns `Botão de download do vídeo` to Fase 05. TD-07 exists as the surface decision for playback; there is no counterpart for download. So the slice owns a capability whose only user-facing surface it has de-scoped, with no TD to decide what it ships instead. Explicit choice: (a) run `/research videos-frontend` to add a TD deciding this slice's download surface (parallel to TD-07 — plausibly "a plain `<a download>` on the same minimal surface, no dedicated screen"); (b) drop `"Download do vídeo pelo usuário"` from this slice's `covers_capabilities` and let Fase 05 own it — cross-slice coverage stays intact because the sibling `phase-03-videos` omits `covers_capabilities` (monolithic semantics = covers all); (c) fold the download surface into TD-07 by widening its `Capability:` field to cover both bullets.

### Dependency Gaps

- **DG-1** — `next-frontend/lib/api/types.gen.ts` contains **zero `/videos` paths** (verified: only `/` and `/auth/*` — 10 path entries, all Fase 02). Every frontend artifact this slice commits to depends on those types: the `paths`-typed BFF Route Handlers under `app/api/videos/**`, the video aliases in `lib/api/contracts.ts` (which inherited `next-frontend-openapi-typing/TD-04` makes the *only* file allowed to import `paths`), and `mocks/handlers/videos.ts` (typed off `paths` per `openapi-typing/TD-05`). The upstream half is already delivered — `nestjs-project/openapi.json` was regenerated and committed in `048aeec` — but the two-step propagation into the frontend has not run, and neither `## Scope`, nor any TD, nor the sibling's `progress.md` records it as a prerequisite. Explicit choice: (a) make it an explicit first SI in `/plan-build` — `bash scripts/sync-openapi.sh` (host) followed by `docker compose exec next-frontend npm run openapi:types` (container) — blocking every other frontend SI in the Dependency Map; (b) run it now as pre-work and note it in the plan as a satisfied precondition. Either way it interacts with **IC-6**: with `openapi.json` gitignored, step (a) produces an artifact git will not stage.

### Inherited Constraint Conflicts

_None._ — Check 5 compares **decided** current-scope TDs against inherited conventions and TDs; all 8 TDs of this slice are `pending`, so the check is vacuous this run. Re-run after `/plan-resolve`: TD-01 and TD-06 are the likely candidates to surface an ICC against `phase-03-videos/TD-03` and `TD-07` (see IC-5, which records the same tension at the documentation level while the decisions are still open).

### Unresolved Open Questions

- **OQ-1** — `phase-03-videos-frontend/TD-01` pending — Browser-Reachable Host for Presigned Storage URLs (`Scope: Cross-layer`). Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos-frontend.md`, then re-run `/plan-validate videos-frontend`.
- **OQ-2** — `phase-03-videos-frontend/TD-02` pending — Multipart Upload Client Implementation (`Scope: Frontend`). Resolution: as OQ-1.
- **OQ-3** — `phase-03-videos-frontend/TD-03` pending — Part-URL Signing Cadence, the upload control-plane contract (`Scope: Cross-layer`). Resolution: as OQ-1.
- **OQ-4** — `phase-03-videos-frontend/TD-04` pending — Upload Resume Across Page Reload, the missing ETag contract (`Scope: Cross-layer`). Resolution: as OQ-1.
- **OQ-5** — `phase-03-videos-frontend/TD-05` pending — Processing-Status Tracking on the Client (`Scope: Frontend`, `Renders in: frontend-runtime`). Resolution: as OQ-1.
- **OQ-6** — `phase-03-videos-frontend/TD-06` pending — Playback URL Lifetime vs. Session Length (`Scope: Cross-layer`). Resolution: as OQ-1.
- **OQ-7** — `phase-03-videos-frontend/TD-07` pending — Playback Surface for This Slice (`Scope: Frontend`). Resolution: as OQ-1. See also IC-3 and AMB-1 — this TD cannot be fully resolved without settling whether the slice has UI scope.
- **OQ-8** — `phase-03-videos-frontend/TD-08` pending — Test Strategy for the Direct-to-Storage Byte Path (`Scope: Frontend`). Resolution: as OQ-1.

_No `### Open Questions from Inventory` block exists — `## UI Inventory` holds the deferred placeholder, so there are no inventory-originated open questions to ingest._

### UI Coverage Gaps

_None._ — Check 7 is skipped entirely: `## UI Inventory` carries the deferred token-anchor (`_No screen inventory —`), and UIG-N never fires when the user has explicitly opted out of the inventory. The consequences of that deferral are captured instead by IC-1..IC-4 (orphaned `Scope: Frontend` TDs) and AMB-1 (no route enumeration).

### Capability Consistency (slicing, phase mode only)

_None._ — Check 8.a ran (phase 03 has 2 slices: `phase-03-videos`, `phase-03-videos-frontend`). All 5 `covers_capabilities` entries of this slice match `docs/project-plan.md:75,76,77,80,81` verbatim. The sibling `phase-03-videos` omits `covers_capabilities` entirely, which the slicing convention reads as monolithic semantics (covers all bullets of its phase) — nothing to verify there, and no restamp is required since its frontmatter was never mutated.

## Cross-slice Advisories

_None._ — Step 8.b ran (zero CC-N). `covered` = union of both slices = all 9 phase-03 bullets, because the sibling's omitted `covers_capabilities` claims the full set; `expected \ covered` is empty. Note the intentional overlap: 5 bullets are claimed by both slices, which is the normal shape of a backend/frontend split (each covers its own half of the same capability), not a coverage defect.

## Resolved Issues

_No issues resolved yet._
