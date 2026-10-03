import { NextResponse } from "next/server";

import type { UpstreamResult } from "@/lib/api/authed";
import type { ApiErrorEnvelope, PresignedUrlResponse } from "@/lib/api/contracts";

/**
 * TD-06: the browser holds a stable same-origin URL; every request to it is
 * authorized upstream and answered with a 307 to a URL signed seconds ago.
 * The redirect is never cacheable, so an expired URL is never replayed, and
 * the bytes still flow browser ⇄ storage — a redirect is not a proxy.
 */
export function redirectToPresigned(result: UpstreamResult<PresignedUrlResponse>): Response {
  if (result.error) {
    return NextResponse.json<ApiErrorEnvelope>(result.error, {
      status: result.response.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!result.data.url) {
    return NextResponse.json<ApiErrorEnvelope>(
      {
        statusCode: 502,
        error: "UPSTREAM_CONTRACT",
        message: "Upstream answered without a playback url",
        code: null,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.redirect(result.data.url, {
    status: 307,
    headers: { "Cache-Control": "no-store" },
  });
}
