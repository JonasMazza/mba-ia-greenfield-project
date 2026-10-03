/**
 * BFF ↔ Components contracts barrel.
 *
 * This file is the **only** module in the project authorized to import `paths`
 * from `./types.gen`. Every Route Handler and every Component consumes BFF
 * shapes via named aliases exported from here — never by indexing `paths`
 * directly elsewhere.
 *
 * Two alias forms by convention:
 *
 * 1. **Pass-through alias** — BFF returns the upstream NestJS shape as-is.
 *    The alias indexes `paths` for the route's success-content type:
 *
 *      export type Video =
 *        paths["/videos/{id}"]["get"]["responses"][200]["content"]["application/json"];
 *
 * 2. **Reshape alias** — BFF projects a subset or composed shape. The alias
 *    name is named-only (does NOT index `paths`), making reshapes greppable
 *    against the wire shape:
 *
 *      export type VideoCard = Pick<Video, "id" | "title" | "thumbnailUrl">;
 *
 * Feature SIs append aliases here as endpoints are wired through the BFF.
 * The barrel starts empty by design.
 */
import type { paths } from "./types.gen";

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Request bodies (fields are empty in the current openapi.json — will expand as the upstream spec grows)
export type RegisterDto =
  paths["/auth/register"]["post"]["requestBody"]["content"]["application/json"];

export type LoginDto =
  paths["/auth/login"]["post"]["requestBody"]["content"]["application/json"];

export type ForgotPasswordDto =
  paths["/auth/forgot-password"]["post"]["requestBody"]["content"]["application/json"];

export type RefreshTokenDto =
  paths["/auth/refresh"]["post"]["requestBody"]["content"]["application/json"];

// Upstream success response bodies
export type RegisterResponse =
  paths["/auth/register"]["post"]["responses"][201]["content"]["application/json"];

// LoginTokenPair: upstream 200 body — BFF reads it to seal into the iron-session cookie;
// tokens never cross to the browser (per phase-02-auth-frontend/TD-02).
export type LoginTokenPair =
  paths["/auth/login"]["post"]["responses"][200]["content"]["application/json"];

export type RefreshTokenPair =
  paths["/auth/refresh"]["post"]["responses"][200]["content"]["application/json"];

// Shared error envelope (all auth 4xx responses)
export type ApiErrorEnvelope =
  paths["/auth/register"]["post"]["responses"][400]["content"]["application/json"];

// ─── Videos ───────────────────────────────────────────────────────────────────
// Phase 03 (frontend slice). Every alias below is a pass-through of the upstream
// shape; the BFF under `app/api/videos/**` proxies them without reshaping.
// Response fields are optional in `openapi.json` (inline schemas carry no
// `required`), so consumers narrow at the boundary instead of trusting presence.

// Request bodies
export type InitiateUploadDto =
  paths["/videos"]["post"]["requestBody"]["content"]["application/json"];

export type PresignPartsDto =
  paths["/videos/{publicId}/upload/parts"]["post"]["requestBody"]["content"]["application/json"];

export type CompleteUploadDto =
  paths["/videos/{publicId}/upload/complete"]["post"]["requestBody"]["content"]["application/json"];

// Upload control plane — success response bodies
export type InitiateUploadResponse =
  paths["/videos"]["post"]["responses"][201]["content"]["application/json"];

export type PresignPartsResponse =
  paths["/videos/{publicId}/upload/parts"]["post"]["responses"][200]["content"]["application/json"];

export type UploadedPartsResponse =
  paths["/videos/{publicId}/upload/parts"]["get"]["responses"][200]["content"]["application/json"];

export type CompleteUploadResponse =
  paths["/videos/{publicId}/upload/complete"]["post"]["responses"][200]["content"]["application/json"];

// Processing status (owner polling)
export type VideoStatusResponse =
  paths["/videos/{publicId}/status"]["get"]["responses"][200]["content"]["application/json"];

// Playback surface
export type PublicVideo =
  paths["/videos/{publicId}"]["get"]["responses"][200]["content"]["application/json"];

export type PresignedUrlResponse =
  paths["/videos/{publicId}/stream"]["get"]["responses"][200]["content"]["application/json"];
