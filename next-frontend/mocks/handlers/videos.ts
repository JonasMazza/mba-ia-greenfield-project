import { http, HttpResponse } from "msw";

import type { ApiErrorEnvelope } from "@/lib/api/contracts";
import type { paths } from "@/lib/api/types.gen";
import { env } from "@/lib/env";

import {
  FIXTURE_PART_SIZE_BYTES,
  buildInitiateUploadResponse,
  buildPresignedPart,
  buildPresignedUrl,
  buildPublicVideo,
  buildUploadedPart,
  buildVideoStatus,
} from "../factories/videos";

type InitiateOk = paths["/videos"]["post"]["responses"][201]["content"]["application/json"];
type PresignOk =
  paths["/videos/{publicId}/upload/parts"]["post"]["responses"][200]["content"]["application/json"];
type UploadedPartsOk =
  paths["/videos/{publicId}/upload/parts"]["get"]["responses"][200]["content"]["application/json"];
type CompleteOk =
  paths["/videos/{publicId}/upload/complete"]["post"]["responses"][200]["content"]["application/json"];
type StatusOk =
  paths["/videos/{publicId}/status"]["get"]["responses"][200]["content"]["application/json"];
type PublicVideoOk =
  paths["/videos/{publicId}"]["get"]["responses"][200]["content"]["application/json"];
type PresignedUrlOk =
  paths["/videos/{publicId}/stream"]["get"]["responses"][200]["content"]["application/json"];

// Reserved trigger table (shared with E2E — values must not collide with the
// auth triggers nor with Vitest fixture values). Any other id → success/ready.
export const TOO_LARGE_FILENAME = "toolarge.mp4";
export const NOT_FOUND_PUBLIC_ID = "notfound0000";
export const NOT_READY_PUBLIC_ID = "notready0000";
export const FAILED_PUBLIC_ID = "failedvid000";
export const NO_DRAFT_PUBLIC_ID = "nodraft00000";
/** A draft whose storage already holds part 1 — the resume scenario. */
export const RESUMABLE_PUBLIC_ID = "resumable000";

function errorEnvelope(statusCode: number, error: string, message: string): ApiErrorEnvelope {
  return { statusCode, error, message, code: null };
}

const notFound = () =>
  HttpResponse.json(errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"), {
    status: 404,
  });
const notReady = () =>
  HttpResponse.json(
    errorEnvelope(409, "VIDEO_NOT_READY", "Video is not ready for playback yet"),
    { status: 409 }
  );
const invalidUploadState = () =>
  HttpResponse.json(
    errorEnvelope(409, "INVALID_UPLOAD_STATE", "The video has no active multipart upload"),
    { status: 409 }
  );

/** Public routes answer differently for the owner; the fixture reads ownership from the bearer. */
const hasBearer = (request: Request) =>
  (request.headers.get("authorization") ?? "").startsWith("Bearer ");

/** Owner-only upload-cycle gate shared by presign / list / complete / abort. */
function uploadCycleGate(publicId: string) {
  if (publicId === NOT_FOUND_PUBLIC_ID) return notFound();
  if (publicId === NO_DRAFT_PUBLIC_ID) return invalidUploadState();
  return null;
}

export const handlers = [
  // POST /videos
  http.post(`${env.API_URL}/videos`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const filename = typeof body.filename === "string" ? body.filename : "";
    const contentType = typeof body.content_type === "string" ? body.content_type : "";
    const sizeBytes = typeof body.size_bytes === "number" ? body.size_bytes : 0;

    if (!contentType.startsWith("video/")) {
      return HttpResponse.json(
        errorEnvelope(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          `Content type "${contentType}" is not a supported video type`
        ),
        { status: 415 }
      );
    }
    if (filename === TOO_LARGE_FILENAME) {
      return HttpResponse.json(
        errorEnvelope(413, "FILE_TOO_LARGE", "File exceeds the maximum upload size"),
        { status: 413 }
      );
    }
    return HttpResponse.json<InitiateOk>(
      buildInitiateUploadResponse({
        part_count: Math.max(1, Math.ceil(sizeBytes / FIXTURE_PART_SIZE_BYTES)),
      }),
      { status: 201 }
    );
  }),

  // POST /videos/:publicId/upload/parts
  http.post(`${env.API_URL}/videos/:publicId/upload/parts`, async ({ request, params }) => {
    const publicId = String(params.publicId);
    const gated = uploadCycleGate(publicId);
    if (gated) return gated;

    const body = (await request.json()) as Record<string, unknown>;
    const partNumbers = Array.isArray(body.part_numbers)
      ? (body.part_numbers as number[])
      : [];
    return HttpResponse.json<PresignOk>(
      {
        parts: partNumbers.map((partNumber) => buildPresignedPart(publicId, partNumber)),
        expires_in: 600,
      },
      { status: 200 }
    );
  }),

  // GET /videos/:publicId/upload/parts
  http.get(`${env.API_URL}/videos/:publicId/upload/parts`, ({ params }) => {
    const publicId = String(params.publicId);
    const gated = uploadCycleGate(publicId);
    if (gated) return gated;

    return HttpResponse.json<UploadedPartsOk>(
      { parts: publicId === RESUMABLE_PUBLIC_ID ? [buildUploadedPart()] : [] },
      { status: 200 }
    );
  }),

  // POST /videos/:publicId/upload/complete
  http.post(`${env.API_URL}/videos/:publicId/upload/complete`, ({ params }) => {
    const publicId = String(params.publicId);
    const gated = uploadCycleGate(publicId);
    if (gated) return gated;

    return HttpResponse.json<CompleteOk>(
      { public_id: publicId, status: "processing" },
      { status: 200 }
    );
  }),

  // DELETE /videos/:publicId/upload
  http.delete(`${env.API_URL}/videos/:publicId/upload`, ({ params }) => {
    const gated = uploadCycleGate(String(params.publicId));
    if (gated) return gated;

    return new HttpResponse(null, { status: 204 });
  }),

  // GET /videos/:publicId/status
  http.get(`${env.API_URL}/videos/:publicId/status`, ({ params }) => {
    const publicId = String(params.publicId);
    if (publicId === NOT_FOUND_PUBLIC_ID) return notFound();
    if (publicId === NOT_READY_PUBLIC_ID) {
      return HttpResponse.json<StatusOk>(
        { public_id: publicId, status: "processing" },
        { status: 200 }
      );
    }
    if (publicId === FAILED_PUBLIC_ID) {
      return HttpResponse.json<StatusOk>(
        {
          public_id: publicId,
          status: "failed",
          failure_reason: "ffprobe could not read the container",
        },
        { status: 200 }
      );
    }
    return HttpResponse.json<StatusOk>(buildVideoStatus({ public_id: publicId }), {
      status: 200,
    });
  }),

  // GET /videos/:publicId
  http.get(`${env.API_URL}/videos/:publicId`, ({ request, params }) => {
    const publicId = String(params.publicId);
    if (publicId === NOT_FOUND_PUBLIC_ID) return notFound();
    if (publicId === NOT_READY_PUBLIC_ID) {
      // Non-owners cannot tell a not-ready video from a nonexistent one.
      if (!hasBearer(request)) return notFound();
      return HttpResponse.json<PublicVideoOk>(
        buildPublicVideo({
          public_id: publicId,
          status: "processing",
          duration_seconds: null,
          width: null,
          height: null,
          thumbnail_url: null,
        }),
        { status: 200 }
      );
    }
    return HttpResponse.json<PublicVideoOk>(buildPublicVideo({ public_id: publicId }), {
      status: 200,
    });
  }),

  // GET /videos/:publicId/stream
  http.get(`${env.API_URL}/videos/:publicId/stream`, ({ request, params }) => {
    const publicId = String(params.publicId);
    if (publicId === NOT_FOUND_PUBLIC_ID) return notFound();
    if (publicId === NOT_READY_PUBLIC_ID) return hasBearer(request) ? notReady() : notFound();
    return HttpResponse.json<PresignedUrlOk>(buildPresignedUrl(publicId), { status: 200 });
  }),

  // GET /videos/:publicId/download
  http.get(`${env.API_URL}/videos/:publicId/download`, ({ request, params }) => {
    const publicId = String(params.publicId);
    if (publicId === NOT_FOUND_PUBLIC_ID) return notFound();
    if (publicId === NOT_READY_PUBLIC_ID) return hasBearer(request) ? notReady() : notFound();
    return HttpResponse.json<PresignedUrlOk>(buildPresignedUrl(publicId, { attachment: true }), {
      status: 200,
    });
  }),
];
