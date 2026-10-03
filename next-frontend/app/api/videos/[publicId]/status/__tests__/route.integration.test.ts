import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FAILED_PUBLIC_ID,
  NOT_FOUND_PUBLIC_ID,
  NOT_READY_PUBLIC_ID,
} from "@/mocks/handlers/videos";
import { STORAGE_ORIGIN } from "@/mocks/storage-origin";

import { cookieMap, ctx, signIn, type RouteHandler } from "../../__tests__/session-harness";

let GET: RouteHandler;

beforeAll(async () => {
  ({ GET } = await import("@/app/api/videos/[publicId]/status/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const statusRequest = (publicId: string) =>
  new Request(`http://localhost/api/videos/${publicId}/status`, { method: "GET" });

describe("GET /api/videos/[publicId]/status", () => {
  it("returns the ready projection with metadata, a storage thumbnail url and no-store", async () => {
    await signIn();

    const res = await GET(statusRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      public_id: "fixturevid01",
      status: "ready",
      duration_seconds: 42,
      width: 1280,
      height: 720,
    });
    expect(String(body.thumbnail_url).startsWith(STORAGE_ORIGIN)).toBe(true);
  });

  it("returns processing without metadata keys for a not-ready video", async () => {
    await signIn();

    const res = await GET(statusRequest(NOT_READY_PUBLIC_ID), ctx(NOT_READY_PUBLIC_ID));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("processing");
    expect(body).not.toHaveProperty("duration_seconds");
    expect(body).not.toHaveProperty("thumbnail_url");
  });

  it("returns failed with the failure reason", async () => {
    await signIn();

    const res = await GET(statusRequest(FAILED_PUBLIC_ID), ctx(FAILED_PUBLIC_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "failed",
      failure_reason: expect.any(String),
    });
  });

  it("returns 401 without a session and 404 VIDEO_NOT_FOUND pass-through", async () => {
    expect((await GET(statusRequest("fixturevid01"), ctx("fixturevid01"))).status).toBe(401);

    await signIn();
    const notFound = await GET(statusRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });
  });
});
