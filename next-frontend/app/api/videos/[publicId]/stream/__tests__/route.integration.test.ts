import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOT_FOUND_PUBLIC_ID, NOT_READY_PUBLIC_ID } from "@/mocks/handlers/videos";
import { STORAGE_ORIGIN } from "@/mocks/storage-origin";

import { cookieMap, ctx, signIn, type RouteHandler } from "../../__tests__/session-harness";

let GET: RouteHandler;

beforeAll(async () => {
  ({ GET } = await import("@/app/api/videos/[publicId]/stream/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const streamRequest = (publicId: string) =>
  new Request(`http://localhost/api/videos/${publicId}/stream`, { method: "GET" });

describe("GET /api/videos/[publicId]/stream", () => {
  it("answers 307 to the storage origin with no body and no-store", async () => {
    const res = await GET(streamRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")?.startsWith(STORAGE_ORIGIN)).toBe(true);
    expect(res.headers.get("location")).toContain("X-Amz-Signature=");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("repeats the handshake on every request — two calls, two redirects", async () => {
    const first = await GET(streamRequest("fixturevid01"), ctx("fixturevid01"));
    const second = await GET(streamRequest("fixturevid01"), ctx("fixturevid01"));

    expect(first.status).toBe(307);
    expect(second.status).toBe(307);
    expect(second.headers.get("location")).toBeTruthy();
  });

  it("returns the 404 / 409 envelopes as JSON instead of redirecting", async () => {
    const notFound = await GET(streamRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });

    await signIn();
    const notReady = await GET(streamRequest(NOT_READY_PUBLIC_ID), ctx(NOT_READY_PUBLIC_ID));
    expect(notReady.status).toBe(409);
    expect(notReady.headers.get("location")).toBeNull();
    expect(await notReady.json()).toMatchObject({ error: "VIDEO_NOT_READY" });
  });
});
