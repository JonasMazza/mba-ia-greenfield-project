import { NextResponse } from "next/server";

import { authedUpstream } from "@/lib/api/authed";
import type { ApiErrorEnvelope, VideoStatusResponse } from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

type RouteContext = { params: Promise<{ publicId: string }> };

/** Owner polling of `draft → processing → ready | failed`; never cached, so a poll never reads a stale status. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const { data, error, response } = await authedUpstream((headers) =>
    upstream.GET("/videos/{publicId}/status", {
      params: { path: { publicId } },
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<VideoStatusResponse>(data, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
