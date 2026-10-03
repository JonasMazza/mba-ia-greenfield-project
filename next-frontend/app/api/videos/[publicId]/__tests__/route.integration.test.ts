import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOT_FOUND_PUBLIC_ID, NOT_READY_PUBLIC_ID } from "@/mocks/handlers/videos";

import { cookieMap, ctx, signIn, type RouteHandler } from "./session-harness";

let GET: RouteHandler;

beforeAll(async () => {
  ({ GET } = await import("@/app/api/videos/[publicId]/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const metadataRequest = (publicId: string) =>
  new Request(`http://localhost/api/videos/${publicId}`, { method: "GET" });

describe("GET /api/videos/[publicId]", () => {
  it("returns the public metadata of a ready video to an anonymous caller", async () => {
    const res = await GET(metadataRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      public_id: "fixturevid01",
      status: "ready",
      duration_seconds: 42,
      created_at: expect.any(String),
    });
  });

  it("hides a not-ready video from an anonymous caller but shows it to the owner", async () => {
    const anonymous = await GET(metadataRequest(NOT_READY_PUBLIC_ID), ctx(NOT_READY_PUBLIC_ID));
    expect(anonymous.status).toBe(404);

    await signIn();
    const owner = await GET(metadataRequest(NOT_READY_PUBLIC_ID), ctx(NOT_READY_PUBLIC_ID));
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ status: "processing" });
  });

  it("passes 404 VIDEO_NOT_FOUND through", async () => {
    const res = await GET(metadataRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });
  });
});
