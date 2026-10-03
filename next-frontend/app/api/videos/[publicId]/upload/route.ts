import { NextResponse } from "next/server";

import { authedUpstream } from "@/lib/api/authed";
import type { ApiErrorEnvelope } from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

type RouteContext = { params: Promise<{ publicId: string }> };

/** Aborts the multipart upload and discards the draft — the uploader's cancel hook. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const { error, response } = await authedUpstream((headers) =>
    upstream.DELETE("/videos/{publicId}/upload", {
      params: { path: { publicId } },
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return new Response(null, { status: 204 });
}
