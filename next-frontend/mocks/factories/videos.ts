import type {
  InitiateUploadResponse,
  PresignPartsResponse,
  PresignedUrlResponse,
  PublicVideo,
  UploadedPartsResponse,
  VideoStatusResponse,
} from "@/lib/api/contracts";

import { STORAGE_ORIGIN } from "../storage-origin";

export const FIXTURE_PUBLIC_ID = "fixturevid01";
export const FIXTURE_UPLOAD_ID = "fixture-upload-id";
export const FIXTURE_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const FIXTURE_RAW_BUCKET = "streamtube-raw";
export const FIXTURE_PROCESSED_BUCKET = "streamtube-processed";

type PresignedPart = NonNullable<PresignPartsResponse["parts"]>[number];
type UploadedPart = NonNullable<UploadedPartsResponse["parts"]>[number];

const baseInitiateUploadResponse: InitiateUploadResponse = {
  public_id: FIXTURE_PUBLIC_ID,
  upload_id: FIXTURE_UPLOAD_ID,
  part_size_bytes: FIXTURE_PART_SIZE_BYTES,
  part_count: 1,
  expires_in: 600,
};
export const buildInitiateUploadResponse = (
  overrides: Partial<InitiateUploadResponse> = {}
): InitiateUploadResponse => ({ ...baseInitiateUploadResponse, ...overrides });

/** A presigned UploadPart URL shaped like MinIO's, on the fake storage origin. */
export const buildPresignedPart = (
  publicId: string,
  partNumber: number,
  uploadId = FIXTURE_UPLOAD_ID
): PresignedPart => ({
  part_number: partNumber,
  url: `${STORAGE_ORIGIN}/${FIXTURE_RAW_BUCKET}/videos/${publicId}/source?partNumber=${partNumber}&uploadId=${uploadId}&X-Amz-Signature=fixture`,
});

export const buildUploadedPart = (
  overrides: Partial<UploadedPart> = {}
): UploadedPart => ({
  part_number: 1,
  etag: '"etag-1"',
  size: FIXTURE_PART_SIZE_BYTES,
  ...overrides,
});

const baseVideoStatus: VideoStatusResponse = {
  public_id: FIXTURE_PUBLIC_ID,
  status: "ready",
  duration_seconds: 42,
  width: 1280,
  height: 720,
  thumbnail_url: `${STORAGE_ORIGIN}/${FIXTURE_PROCESSED_BUCKET}/videos/${FIXTURE_PUBLIC_ID}/thumbnails/auto.jpg?X-Amz-Signature=fixture`,
};
export const buildVideoStatus = (
  overrides: Partial<VideoStatusResponse> = {}
): VideoStatusResponse => ({ ...baseVideoStatus, ...overrides });

const basePublicVideo: PublicVideo = {
  public_id: FIXTURE_PUBLIC_ID,
  title: "Fixture video",
  status: "ready",
  duration_seconds: 42,
  width: 1280,
  height: 720,
  thumbnail_url: baseVideoStatus.thumbnail_url ?? null,
  created_at: "2026-10-02T12:00:00.000Z",
};
export const buildPublicVideo = (
  overrides: Partial<PublicVideo> = {}
): PublicVideo => ({ ...basePublicVideo, ...overrides });

/** Playback/download URL on the fake storage origin; `attachment` adds the download disposition. */
export const buildPresignedUrl = (
  publicId: string,
  options: { attachment?: boolean } = {}
): PresignedUrlResponse => {
  const disposition = options.attachment
    ? `&response-content-disposition=${encodeURIComponent(`attachment; filename="${publicId}.mp4"`)}`
    : "";
  return {
    url: `${STORAGE_ORIGIN}/${FIXTURE_RAW_BUCKET}/videos/${publicId}/source?X-Amz-Signature=fixture${disposition}`,
    expires_in: 300,
  };
};
