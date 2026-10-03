import AwsS3, { type AwsS3Part, type UploadResultWithSignal } from "@uppy/aws-s3";
import Uppy, { RestrictionError, type Body, type Meta, type UppyFile } from "@uppy/core";

import type {
  ApiErrorEnvelope,
  CompleteUploadDto,
  CompleteUploadResponse,
  InitiateUploadDto,
  InitiateUploadResponse,
  PresignPartsDto,
  PresignPartsResponse,
  UploadedPartsResponse,
} from "@/lib/api/contracts";

/**
 * Part size the client asks for — the backend's own default (64 MiB, ~160
 * parts at the 10 GiB cap). The client owns this number on purpose: Uppy
 * slices the file before `createMultipartUpload` runs, and the backend does
 * not persist the part size, so after a page reload the only way to slice the
 * file exactly as the first attempt did is to ask for the same size again.
 */
export const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;

/**
 * Uppy only takes its restore path (`listParts` before signing) when the file
 * carries both `key` and `uploadId`. The BFF addresses the multipart by
 * `public_id` alone and nothing returns the `upload_id` after a reload, so a
 * resumed upload carries this placeholder — no BFF route ever reads it.
 */
const RESUMED_UPLOAD_ID = "resumed";

/** Failure surfaced to the UI: BFF envelopes keep their status and domain code. */
export class VideoUploadError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, options: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = "VideoUploadError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

export type ResumeTarget = { publicId: string; sizeBytes: number };

export type UploadProgress = {
  bytesUploaded: number;
  bytesTotal: number;
  partsUploaded: number;
  partCount: number;
};

export type VideoUploaderEvents = {
  /** The draft exists — the screen records `?resume=<publicId>&size=<sizeBytes>`. */
  draft: { publicId: string; sizeBytes: number };
  progress: UploadProgress;
  complete: { publicId: string };
  error: VideoUploadError;
};

export type VideoUploader = {
  addFile(file: File): void;
  upload(): Promise<void>;
  cancel(): void;
  on<E extends keyof VideoUploaderEvents>(
    event: E,
    listener: (payload: VideoUploaderEvents[E]) => void
  ): () => void;
  /** Stops in-flight requests without aborting the multipart, so it stays resumable. */
  destroy(): void;
};

type VideoFile = UppyFile<Meta, Body>;

async function bffRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as ApiErrorEnvelope | null;
    // Validation envelopes carry one message per failed constraint.
    const message = [envelope?.message ?? `Request failed with status ${response.status}`].flat().join("; ");
    throw new VideoUploadError(message, {
      status: response.status,
      code: envelope?.error ?? null,
    });
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

const contractError = (message: string) =>
  new VideoUploadError(message, { status: 502, code: "UPSTREAM_CONTRACT" });

const uploadPath = (publicId: string) => `/api/videos/${encodeURIComponent(publicId)}/upload`;

/**
 * Headless multipart uploader (TD-02): Uppy core + `@uppy/aws-s3` drive the
 * mechanics — one part signed at a time (TD-03), per-part retry, ETag
 * accounting, cancellation — while every control-plane call goes to the
 * same-origin BFF under `/api/videos/**` and every byte goes browser ⇄ storage.
 *
 * Resume (TD-04): pass `resume` with the draft's `public_id` and size, then
 * re-select the file; a size mismatch is rejected before any request, and
 * `listParts` tells Uppy which parts the storage already holds. Size is the
 * only identity check available — the backend keeps neither the file name
 * nor its modification time.
 */
export function createVideoUploader(
  options: { resume?: ResumeTarget; partSizeBytes?: number } = {}
): VideoUploader {
  const { resume, partSizeBytes = DEFAULT_PART_SIZE_BYTES } = options;

  const listeners: { [E in keyof VideoUploaderEvents]: Set<(payload: VideoUploaderEvents[E]) => void> } =
    { draft: new Set(), progress: new Set(), complete: new Set(), error: new Set() };
  const emit = <E extends keyof VideoUploaderEvents>(event: E, payload: VideoUploaderEvents[E]) =>
    listeners[event].forEach((listener) => listener(payload));

  let publicId = resume?.publicId ?? null;
  let fileSize = 0;
  let cancelled = false;
  const uploadedParts = new Set<number>();

  const partCountFor = (size: number) => Math.max(1, Math.ceil(size / partSizeBytes));
  const expectedPartSize = (partNumber: number) =>
    Math.min(partSizeBytes, fileSize - (partNumber - 1) * partSizeBytes);

  async function createMultipartUpload(file: VideoFile) {
    const body: InitiateUploadDto = {
      filename: file.name,
      content_type: file.type,
      size_bytes: file.size ?? 0,
      part_size_bytes: partSizeBytes,
    };
    const draft = await bffRequest<InitiateUploadResponse>("/api/videos", jsonInit("POST", body));
    if (!draft.public_id || !draft.upload_id) {
      throw contractError("Upload draft came back without public_id or upload_id");
    }
    if (draft.part_size_bytes !== partSizeBytes) {
      throw contractError(
        `Server part size ${draft.part_size_bytes} differs from the requested ${partSizeBytes}`
      );
    }
    publicId = draft.public_id;
    emit("draft", { publicId: draft.public_id, sizeBytes: body.size_bytes });
    return { key: draft.public_id, uploadId: draft.upload_id };
  }

  async function signPart(
    _file: VideoFile,
    { key, partNumber, signal }: { key: string; partNumber: number; signal?: AbortSignal }
  ) {
    const body: PresignPartsDto = { part_numbers: [partNumber] };
    const signed = await bffRequest<PresignPartsResponse>(
      `${uploadPath(key)}/parts`,
      jsonInit("POST", body, signal)
    );
    const url = signed.parts?.find((part) => part.part_number === partNumber)?.url;
    if (!url) throw contractError(`No presigned URL for part ${partNumber}`);
    return { method: "PUT" as const, url };
  }

  async function listParts(_file: VideoFile, { key, signal }: UploadResultWithSignal) {
    const listed = await bffRequest<UploadedPartsResponse>(`${uploadPath(key)}/parts`, {
      method: "GET",
      signal,
    });
    const parts: AwsS3Part[] = [];
    for (const { part_number, etag, size } of listed.parts ?? []) {
      if (part_number === undefined || !etag) continue;
      // A part sliced at another size would be stitched into a corrupt object.
      if (size !== expectedPartSize(part_number)) {
        throw new VideoUploadError(
          `Stored part ${part_number} has ${size} bytes; this file slices it at ${expectedPartSize(part_number)}`,
          { code: "RESUME_PART_MISMATCH" }
        );
      }
      uploadedParts.add(part_number);
      parts.push({ PartNumber: part_number, ETag: etag, Size: size });
    }
    return parts;
  }

  async function completeMultipartUpload(
    _file: VideoFile,
    { key, parts, signal }: { key: string; parts: AwsS3Part[]; signal: AbortSignal }
  ) {
    const body: CompleteUploadDto = {
      parts: parts
        .map(({ PartNumber, ETag }) => {
          if (PartNumber === undefined || !ETag) throw contractError("A part finished without an ETag");
          return { part_number: PartNumber, etag: ETag };
        })
        .sort((a, b) => a.part_number - b.part_number),
    };
    await bffRequest<CompleteUploadResponse>(`${uploadPath(key)}/complete`, jsonInit("POST", body, signal));
    return {};
  }

  async function abortMultipartUpload(_file: VideoFile, { key, signal }: UploadResultWithSignal) {
    await bffRequest<null>(uploadPath(key), { method: "DELETE", signal });
  }

  const uppy = new Uppy<Meta, Body>({
    autoProceed: false,
    restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["video/*"] },
  });
  uppy.use(AwsS3, {
    shouldUseMultipart: true,
    getChunkSize: () => partSizeBytes,
    limit: 4,
    retryDelays: [0, 1000, 3000, 5000],
    createMultipartUpload,
    signPart,
    listParts,
    completeMultipartUpload,
    abortMultipartUpload,
  });

  let bytesUploaded = 0;
  const emitProgress = () =>
    emit("progress", {
      bytesUploaded,
      bytesTotal: fileSize,
      partsUploaded: uploadedParts.size,
      partCount: partCountFor(fileSize),
    });

  uppy.on("upload-progress", (_file, progress) => {
    bytesUploaded = progress.bytesUploaded;
    emitProgress();
  });
  // Fires after the part's last byte-progress event, so the part count catches up here.
  uppy.on("s3-multipart:part-uploaded", (_file, part) => {
    uploadedParts.add(part.PartNumber);
    emitProgress();
  });
  uppy.on("upload-success", () => {
    if (publicId) emit("complete", { publicId });
  });
  uppy.on("upload-error", (_file, error) => {
    if (cancelled) return;
    emit(
      "error",
      error instanceof VideoUploadError ? error : new VideoUploadError(error.message)
    );
  });

  return {
    addFile(file) {
      if (resume && file.size !== resume.sizeBytes) {
        throw new VideoUploadError(
          `This upload expects a file of ${resume.sizeBytes} bytes; the selected one has ${file.size}`,
          { code: "RESUME_SIZE_MISMATCH" }
        );
      }
      uppy.getFiles().forEach(({ id }) => uppy.removeFile(id));

      let fileId: string;
      try {
        fileId = uppy.addFile({ name: file.name, type: file.type, data: file, source: "local" });
      } catch (error) {
        if (error instanceof RestrictionError) {
          throw new VideoUploadError(error.message, { code: "UNSUPPORTED_MEDIA_TYPE" });
        }
        throw error;
      }
      fileSize = file.size;
      bytesUploaded = 0;
      uploadedParts.clear();

      if (resume) {
        // `s3Multipart` is the aws-s3 plugin's restore marker; @uppy/core's
        // `UppyFile` type does not declare it.
        const restore = { s3Multipart: { key: resume.publicId, uploadId: RESUMED_UPLOAD_ID } };
        uppy.setFileState(fileId, restore as Partial<VideoFile>);
      }
    },

    async upload() {
      if (uppy.getFiles().length === 0) {
        throw new VideoUploadError("Select a video file first");
      }
      cancelled = false;
      await uppy.upload();
    },

    cancel() {
      cancelled = true;
      uppy.cancelAll();
    },

    on(event, listener) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },

    destroy() {
      uppy.pauseAll();
      Object.values(listeners).forEach((set) => set.clear());
    },
  };
}
