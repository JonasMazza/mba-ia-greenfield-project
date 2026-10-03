import { registerAs } from '@nestjs/config';

/**
 * `endpoint` is a Docker Compose service name — never `localhost`, which inside
 * a container resolves to the container itself. `forcePathStyle` is required by
 * MinIO, which does not support virtual-host-style bucket addressing.
 *
 * `publicEndpoint` is the host the *browser* reaches the storage through (the
 * published port in development, a public or CDN edge in production). SigV4
 * signs the `host` header, so a URL meant for the browser must be signed for
 * this host from the start — it cannot be rewritten after signing.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  forcePathStyle: true,
  rawBucket: process.env.STORAGE_RAW_BUCKET || 'streamtube-raw',
  processedBucket:
    process.env.STORAGE_PROCESSED_BUCKET || 'streamtube-processed',
  uploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS || '600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS || '300',
    10,
  ),
}));
