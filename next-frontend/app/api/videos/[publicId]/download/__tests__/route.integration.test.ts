import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOT_FOUND_PUBLIC_ID, NOT_READY_PUBLIC_ID } from "@/mocks/handlers/videos";
import { STORAGE_ORIGIN } from "@/mocks/storage-origin";

import { cookieMap, ctx, signIn, type RouteHandler } from "../../__tests__/session-harness";

let GET: RouteHandler;

beforeAll(async () => {
  ({ GET } = await import("@/app/api/videos/[publicId]/download/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const downloadRequest = (publicId: string) =>
  new Request(`http://localhost/api/videos/${publicId}/download`, { method: "GET" });

describe("GET /api/videos/[publicId]/download", () => {
  it("answers 307 to a storage URL carrying the attachment disposition", async () => {
    const res = await GET(downloadRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(STORAGE_ORIGIN)).toBe(true);
    expect(decodeURIComponent(location)).toContain("response-content-disposition=attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the 404 / 409 envelopes as JSON instead of redirecting", async () => {
    const notFound = await GET(downloadRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);

    await signIn();
    const notReady = await GET(downloadRequest(NOT_READY_PUBLIC_ID), ctx(NOT_READY_PUBLIC_ID));
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ error: "VIDEO_NOT_READY" });
  });
});
