import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOT_FOUND_PUBLIC_ID, NO_DRAFT_PUBLIC_ID } from "@/mocks/handlers/videos";

import { cookieMap, ctx, signIn, type RouteHandler } from "../../__tests__/session-harness";

let DELETE: RouteHandler;

beforeAll(async () => {
  ({ DELETE } = await import("@/app/api/videos/[publicId]/upload/route"));
});

beforeEach(() => {
  cookieMap.clear();
});

const abortRequest = (publicId: string) =>
  new Request(`http://localhost/api/videos/${publicId}/upload`, { method: "DELETE" });

describe("DELETE /api/videos/[publicId]/upload", () => {
  it("returns 204 with an empty body", async () => {
    await signIn();

    const res = await DELETE(abortRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("returns 401 UNAUTHORIZED without a session", async () => {
    const res = await DELETE(abortRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(401);
  });

  it("passes 404 VIDEO_NOT_FOUND and 409 INVALID_UPLOAD_STATE through", async () => {
    await signIn();

    const notFound = await DELETE(abortRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });

    const noDraft = await DELETE(abortRequest(NO_DRAFT_PUBLIC_ID), ctx(NO_DRAFT_PUBLIC_ID));
    expect(noDraft.status).toBe(409);
    expect(await noDraft.json()).toMatchObject({ error: "INVALID_UPLOAD_STATE" });
  });
});
