import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** ffprobe JSON for a long input can be sizeable; the 1 MB default is not enough. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface VideoMetadata {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Reads metadata from a local path or a presigned URL. ffprobe range-reads over
 * HTTP, so a 10 GB source is never downloaded whole just to be measured.
 */
export async function probeVideo(input: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ],
    { maxBuffer: MAX_OUTPUT_BYTES },
  );

  const probe = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = probe.streams?.find(
    (stream) => stream.codec_type === 'video',
  );

  return {
    duration_seconds: toInt(probe.format?.duration),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    codec: videoStream?.codec_name ?? null,
    bitrate: toInt(probe.format?.bit_rate),
  };
}

/**
 * A frame a quarter of the way in is more representative than frame zero, which
 * is often black. `-ss` goes *before* `-i` so ffmpeg seeks instead of decoding
 * everything up to that point.
 */
export function thumbnailSeekSeconds(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.max(0, Math.floor(durationSeconds * 0.25));
}

export async function extractThumbnail(
  input: string,
  outputPath: string,
  seekSeconds: number,
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-ss',
      String(seekSeconds),
      '-i',
      input,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-vf',
      'scale=320:-1',
      outputPath,
    ],
    { maxBuffer: MAX_OUTPUT_BYTES },
  );
}
