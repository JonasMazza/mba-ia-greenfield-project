import { NextResponse } from "next/server";

import { optionalAuthedUpstream } from "@/lib/api/authed";
import type { ApiErrorEnvelope, PublicVideo } from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

type RouteContext = { params: Promise<{ publicId: string }> };

/** Public metadata; the bearer rides along only when a session exists, so the owner sees a not-ready video. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const { data, error, response } = await optionalAuthedUpstream((headers) =>
    upstream.GET("/videos/{publicId}", {
      params: { path: { publicId } },
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<PublicVideo>(data, { status: 200 });
}
