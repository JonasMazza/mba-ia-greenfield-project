import { http, HttpResponse } from "msw";

import { STORAGE_ORIGIN } from "../storage-origin";

/** Reserved trigger: a presigned part URL whose upload id is `expired` answers 403. */
export const EXPIRED_UPLOAD_ID = "expired";

/** What the browser needs from the storage: permission to read the ETag cross-origin. */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "ETag",
};

/**
 * The byte plane. Every presigned fixture points at `STORAGE_ORIGIN`, so a
 * part `PUT` from the uploader lands here and gets the ETag the real MinIO
 * would return — `"etag-<partNumber>"`, derived from the signed query.
 */
export const handlers = [
  http.options(`${STORAGE_ORIGIN}/*`, () => new HttpResponse(null, { status: 204, headers: corsHeaders })),

  http.put(`${STORAGE_ORIGIN}/*`, ({ request }) => {
    const query = new URL(request.url).searchParams;
    if (query.get("uploadId") === EXPIRED_UPLOAD_ID) {
      return new HttpResponse(null, { status: 403, headers: corsHeaders });
    }
    const partNumber = query.get("partNumber") ?? "1";
    return new HttpResponse(null, {
      status: 200,
      headers: { ...corsHeaders, ETag: `"etag-${partNumber}"` },
    });
  }),
];
