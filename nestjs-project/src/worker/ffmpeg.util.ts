import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** ffprobe JSON for a long input can be sizeable; the 1 MB default is not enough. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A failed ffprobe/ffmpeg run, described without its command line. execFile's
 * own error message is the full command — for a presigned input, the internal
 * URL with its signature and access key id — and so is the tools' stderr. The
 * message ends up in `failure_reason`, which the owner reads, so it carries
 * only what failed and how the process exited.
 */
export class MediaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaToolError';
  }
}

interface ExecFileFailure {
  code?: number | string;
  signal?: NodeJS.Signals | null;
}

function describeExit(error: unknown): string {
  const { code, signal } = (error ?? {}) as ExecFileFailure;
  if (signal) return `killed by ${signal}`;
  if (typeof code === 'number') return `exit code ${code}`;
  if (code === 'ENOENT') return 'executable not found';
  return 'unknown error';
}

async function runMediaTool(
  file: 'ffprobe' | 'ffmpeg',
  args: string[],
  failure: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    throw new MediaToolError(`${failure} (${describeExit(error)})`);
  }
}

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
  const stdout = await runMediaTool(
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
    'ffprobe could not read the source video',
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
  await runMediaTool(
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
    'ffmpeg could not extract a thumbnail',
  );
}
