import { NextResponse } from "next/server";

import { authedUpstream } from "@/lib/api/authed";
import type {
  ApiErrorEnvelope,
  CompleteUploadDto,
  CompleteUploadResponse,
} from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

type RouteContext = { params: Promise<{ publicId: string }> };

/** Finalizes the multipart upload; upstream moves the video to `processing` and enqueues the job. */
export async function POST(request: Request, { params }: RouteContext) {
  const { publicId } = await params;
  const body = (await request.json()) as CompleteUploadDto;

  const { data, error, response } = await authedUpstream((headers) =>
    upstream.POST("/videos/{publicId}/upload/complete", {
      params: { path: { publicId } },
      body,
      headers,
    })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<CompleteUploadResponse>(data, { status: 200 });
}
