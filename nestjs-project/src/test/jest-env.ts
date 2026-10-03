/**
 * Test processes run inside the `nestjs-api` container, where the host-published
 * MinIO port (`localhost:9000`) resolves to the container itself. Browser-audience
 * URLs are therefore signed for the internal host during tests; the real
 * browser-reachable host is exercised by the manual smoke of the frontend slice.
 */
process.env.STORAGE_PUBLIC_ENDPOINT =
  process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
