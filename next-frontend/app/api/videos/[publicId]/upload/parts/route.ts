import { NextResponse } from "next/server";

import { authedUpstream } from "@/lib/api/authed";
import type {
  ApiErrorEnvelope,
  PresignPartsDto,
  PresignPartsResponse,
  UploadedPartsResponse,
} from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

type RouteContext = { params: Promise<{ publicId: string }> };

/** Signs the requested part numbers — the uploader asks for one part at a time. */
export async function POST(request: Request, { params }: RouteContext) {
  const { publicId } = await params;
  const body = (await request.json()) as PresignPartsDto;

  const { data, error, response } = await authedUpstream((headers) =>
    upstream.POST("/videos/{publicId}/upload/parts", {
      params: { path: { publicId } },
      body,
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<PresignPartsResponse>(data, { status: 200 });
}

/** Lists the parts the storage already holds — the resume path after a reload. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const { data, error, response } = await authedUpstream((headers) =>
    upstream.GET("/videos/{publicId}/upload/parts", {
      params: { path: { publicId } },
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<UploadedPartsResponse>(data, { status: 200 });
}
