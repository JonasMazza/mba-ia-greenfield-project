> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — MinIO (Docker)

**Strategy:** real MinIO from `compose.yaml` (S3 API on `minio:9000`; `minio-bootstrap` creates the buckets). No filesystem adapter and no mocked S3 client — `ObjectStorageService` (`src/videos/storage/object-storage.service.ts`) talks to MinIO in integration and E2E tests.

**Approach:**
- Build the testing module with `ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] })` and the real `ObjectStorageService`.
- Use a fresh key per test (`service.buildSourceKey(randomUUID())`) and delete the created keys in `afterAll` with a raw `S3Client` built from the same `storageConfig()`.
- Exercise presigned URLs for real: `fetch(url, { method: 'PUT', body })` against the signed part URL and assert on the `ETag` / status MinIO returns.
- Browser-audience URLs are signed with `STORAGE_PUBLIC_ENDPOINT`, whose host (`localhost:9000`) is unreachable from inside the container. `src/test/jest-env.ts` (loaded by both Jest configs) pins it to the internal endpoint during tests; the browser-facing host is covered by the frontend manual smoke.

**Reference specs:** `src/videos/storage/object-storage.service.integration-spec.ts`, `src/worker/video-processor.service.integration-spec.ts` (synthesizes a tiny MP4 with `ffmpeg` instead of committing a binary fixture).

---

## Message Queue — pg-boss on PostgreSQL (Docker)

**Strategy:** real pg-boss on the Compose PostgreSQL (schema `pgboss`); there is no separate broker container. `QueueService` (`src/videos/queue/queue.service.ts`) wraps it; the production queue is `video.process`.

**Approach:**
- Build the module with `ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] })`, then `await service.start()` in `beforeAll` (generous timeout — pg-boss creates its schema on first start) and `service.stop()` in `afterAll`.
- Isolate tests with a **unique queue name per test** (`test.video.process.<random>`), and call `stopWorking(name)` for every queue a test consumed.
- Delivery is asynchronous: poll with a small `waitFor(predicate)` helper instead of fixed sleeps.
- Publisher assertions (e.g. "completing an upload enqueues a job") query `pgboss.job` directly (`SELECT data FROM pgboss.job WHERE name = $1`) and clean it with `DELETE FROM pgboss.job` in `beforeEach`.

**Reference specs:** `src/videos/queue/queue.service.integration-spec.ts` (consumer side), `src/videos/videos.service.integration-spec.ts` and `test/videos-upload-cycle.e2e-spec.ts` (publisher side).

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
