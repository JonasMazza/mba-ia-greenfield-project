> Part of the `testing-guide-next-frontend` skill (see `../SKILL.md`).

# External Systems — Real vs Fake

`next-frontend` owns the contract with two external systems: the **NestJS upstream API**, which the browser never reaches (strict BFF model), and **object storage**, which the browser reaches directly for video bytes only, on presigned URLs the BFF hands out.

| External system | Strategy | Mechanism | Why |
|---|---|---|---|
| **NestJS upstream API** (reached via `lib/api/upstream.ts`) | **Fake** | Vitest: `msw/node` (`mocks/server.ts` + `mocks/setup.ts`). E2E: server-side MSW booted by `instrumentation.ts` when `MSW_ENABLED=true`. | The upstream has its own test suite; hitting it from `next-frontend` tests would be slow, flaky, cross-project-coupled, and non-deterministic. |
| **Object Storage (S3/MinIO)** | **Fake** | Every presigned fixture points at `STORAGE_ORIGIN` (`mocks/storage-origin.ts`, resolves nowhere). Vitest: `mocks/handlers/storage.ts` answers part `PUT`s with an `ETag` and the CORS headers that expose it. E2E: `tests/storage-stub.ts` stubs that origin — and only it — in the browser. Real MinIO: manual smoke (`docs/phases/phase-03-videos-frontend/smoke-checklist.md`). | Network + cost + flakiness; and a byte-plane request that escapes the fake must fail loudly instead of reaching a real bucket. |
| **Same-origin `/api/**` Route Handlers** | **Real** in E2E; **as functions** in Vitest integration | E2E: real handlers run server-side in the containerized app. Vitest: imported and called directly. | The BFF logic IS the unit under test — never fake it; only fake what it calls (upstream). |

## The MSW boundary — non-negotiable

- **No Vitest test may open a real network connection to the upstream host.** `mocks/setup.ts` runs `server.listen({ onUnhandledRequest: "error" })` — any unintercepted fetch fails with `"request unhandled"`. That error is the contract-coverage signal; do not weaken it to `"warn"`/`"bypass"` in Vitest.
- **`onUnhandledRequest` differs by runtime:** `"error"` in `mocks/setup.ts` (Vitest), **`"bypass"`** in `instrumentation.ts` (E2E, so Next's own internal requests pass through). Never copy `"error"` into `instrumentation.ts`, never copy `"bypass"` into `mocks/setup.ts`.
- **One handler per `(method, path)` from OpenAPI `paths`.** Per-domain modules: `mocks/handlers/<domain>.ts` (e.g., `auth.ts`), one barrel line in `mocks/handlers/index.ts`, factories in `mocks/factories/<domain>.ts`. Every endpoint a BFF handler hits MUST have a hand-written handler before its integration test can run.
- **Fixture bodies are typed via `paths`.** Modules under `mocks/` are the documented exception to the "only `contracts.ts` imports `paths`" rule (`.claude/rules/next-frontend-msw-mocks.md`). A stale fixture fails `tsc --noEmit` after `types.gen.ts` regenerates.
- **Compose URLs as `${env.API_URL}/...`.** Never hardcode the upstream host — the handler must match whatever the BFF actually calls in the test runtime.
- **Per-test deviations via `server.use(...)`** inside `beforeEach`/`it`; `afterEach(() => server.resetHandlers())` (already in `mocks/setup.ts`) prevents leakage.

## E2E reserved-trigger fixtures (no per-test overrides)

E2E shares the **same** `mocks/` handler set as Vitest — no E2E-only fork, no `server.use()` at runtime, no `tests/handlers/`. Per-scenario outcomes come from a small **reserved trigger table** baked into the shared handlers (e.g., `email: "conflict@example.com"` → 409, `"badrequest@example.com"` → 400, else success). Trigger values **must not collide** with Vitest fixture values. Keep the table small. E2E specs **MUST NOT** `page.route()` or browser-intercept `/api/**` (it short-circuits the real Route Handlers) and **MUST NOT** reach a real NestJS API.

## Factories

Hand-written deterministic factories in `mocks/factories/<domain>.ts`: each shape exports `buildX(overrides?: Partial<X>): X` composing a hand-coded `baseX: X` literal (typed off `@/lib/api/contracts` or `paths`) with overrides. `@faker-js/faker` is opt-in, scoped to bulk-collection builders only, with a local `faker.seed(N)` immediately before generation — it is not installed at foundation (the first `buildXList` triggers the install).
