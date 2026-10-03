import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOT_FOUND_PUBLIC_ID, NO_DRAFT_PUBLIC_ID } from "@/mocks/handlers/videos";

import { cookieMap, ctx, signIn, type RouteHandler } from "../../../__tests__/session-harness";

let POST: RouteHandler;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/videos/[publicId]/upload/complete/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const PARTS = { parts: [{ part_number: 1, etag: '"etag-1"' }] };

function completeRequest(publicId: string) {
  return new Request(`http://localhost/api/videos/${publicId}/upload/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(PARTS),
  });
}

describe("POST /api/videos/[publicId]/upload/complete", () => {
  it("returns 200 with { public_id, status: 'processing' } pass-through", async () => {
    await signIn();

    const res = await POST(completeRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ public_id: "fixturevid01", status: "processing" });
  });

  it("returns 401 UNAUTHORIZED without a session", async () => {
    const res = await POST(completeRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("passes 404 VIDEO_NOT_FOUND and 409 INVALID_UPLOAD_STATE through", async () => {
    await signIn();

    const notFound = await POST(completeRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });

    const noDraft = await POST(completeRequest(NO_DRAFT_PUBLIC_ID), ctx(NO_DRAFT_PUBLIC_ID));
    expect(noDraft.status).toBe(409);
    expect(await noDraft.json()).toMatchObject({ error: "INVALID_UPLOAD_STATE" });
  });
});
