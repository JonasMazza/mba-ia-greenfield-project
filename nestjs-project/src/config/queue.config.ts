import { registerAs } from '@nestjs/config';

/**
 * pg-boss rides on the PostgreSQL instance the app already uses (TD-01), which
 * is what makes the transactional enqueue possible: the job row and the domain
 * row commit together. It keeps its own schema, so it never collides with the
 * tables owned by TypeORM migrations.
 */
export default registerAs('queue', () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  const username = process.env.DB_USERNAME || 'streamtube';
  const password = process.env.DB_PASSWORD || 'streamtube';
  const database = process.env.DB_NAME || 'streamtube';

  return {
    connectionString: `postgres://${encodeURIComponent(username)}:${encodeURIComponent(
      password,
    )}@${host}:${port}/${database}`,
    schema: process.env.QUEUE_SCHEMA || 'pgboss',
    /** Bounded retries before the job lands in the dead-letter queue (TD-09). */
    retryLimit: parseInt(process.env.QUEUE_RETRY_LIMIT || '3', 10),
    retryDelaySeconds: parseInt(
      process.env.QUEUE_RETRY_DELAY_SECONDS || '30',
      10,
    ),
    /** FFmpeg on a 10 GB input can run long — well past pg-boss's 15 min default. */
    expireInSeconds: parseInt(
      process.env.QUEUE_EXPIRE_IN_SECONDS || '3600',
      10,
    ),
  };
});
