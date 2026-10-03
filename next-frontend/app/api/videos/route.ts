import { NextResponse } from "next/server";

import { authedUpstream } from "@/lib/api/authed";
import type {
  ApiErrorEnvelope,
  InitiateUploadDto,
  InitiateUploadResponse,
} from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

/** Pre-registers the draft and opens the multipart upload — the uploader's first hook. */
export async function POST(request: Request) {
  const body = (await request.json()) as InitiateUploadDto;

  const { data, error, response } = await authedUpstream((headers) =>
    upstream.POST("/videos", { body, headers })
  );

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error, { status: response.status });
  }
  return NextResponse.json<InitiateUploadResponse>(data, { status: 201 });
}
