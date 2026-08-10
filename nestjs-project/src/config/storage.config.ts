import { registerAs } from '@nestjs/config';

/**
 * `endpoint` is a Docker Compose service name — never `localhost`, which inside
 * a container resolves to the container itself. `forcePathStyle` is required by
 * MinIO, which does not support virtual-host-style bucket addressing.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
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
