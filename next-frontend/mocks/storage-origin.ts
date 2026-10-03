/**
 * Origin every presigned URL in the fixtures points at. It resolves nowhere on
 * purpose: a byte-plane request the storage fake does not intercept fails
 * loudly instead of silently reaching a real bucket. Shared by the Vitest
 * handlers (`handlers/storage.ts`) and the Playwright stub (`tests/storage-stub.ts`).
 */
export const STORAGE_ORIGIN = "http://storage.local:9000";
