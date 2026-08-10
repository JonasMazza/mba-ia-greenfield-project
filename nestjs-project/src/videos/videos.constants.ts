/** Queue names owned by the videos module. */
export const VIDEO_QUEUES = {
  PROCESS: 'video.process',
} as const;

/** S3/MinIO multipart floor: every part but the last must be at least 5 MiB. */
export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** Default part size handed to the client when it does not ask for one. */
export const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;

/** Hard cap on a single upload (10 GiB). */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** nanoid alphabet and length for the only identifier ever exposed (TD-06). */
export const PUBLIC_ID_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const PUBLIC_ID_LENGTH = 12;
