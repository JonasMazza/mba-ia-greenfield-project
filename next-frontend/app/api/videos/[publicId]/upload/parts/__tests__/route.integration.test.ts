import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOT_FOUND_PUBLIC_ID,
  NO_DRAFT_PUBLIC_ID,
  RESUMABLE_PUBLIC_ID,
} from "@/mocks/handlers/videos";
import { STORAGE_ORIGIN } from "@/mocks/storage-origin";

const cookieMap = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (name: string) =>
      cookieMap.has(name) ? { name, value: cookieMap.get(name)! } : undefined,
    set: (name: string, value: string) => {
      cookieMap.set(name, value);
    },
    delete: (name: string) => {
      cookieMap.delete(name);
    },
  }),
}));

type Handler = (
  req: Request,
  ctx: { params: Promise<{ publicId: string }> }
) => Promise<Response>;

let POST: Handler;
let GET: Handler;
let setSession: typeof import("@/lib/auth/session").setSession;

beforeAll(async () => {
  ({ POST, GET } = await import("@/app/api/videos/[publicId]/upload/parts/route"));
  ({ setSession } = await import("@/lib/auth/session"));
});

beforeEach(() => {
  cookieMap.clear();
});

async function signIn() {
  await setSession({
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    userId: "user-1",
    email: "alice@example.com",
    channelSlug: "alice",
  });
}

const ctx = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

function presignRequest(publicId: string, partNumbers: number[]) {
  return new Request(`http://localhost/api/videos/${publicId}/upload/parts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part_numbers: partNumbers }),
  });
}

function listRequest(publicId: string) {
  return new Request(`http://localhost/api/videos/${publicId}/upload/parts`, {
    method: "GET",
  });
}

describe("POST /api/videos/[publicId]/upload/parts", () => {
  it("returns 200 with one presigned URL per requested part, on the storage origin", async () => {
    await signIn();

    const res = await POST(presignRequest("fixturevid01", [7]), ctx("fixturevid01"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { parts: { part_number: number; url: string }[]; expires_in: number };
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].part_number).toBe(7);
    expect(body.parts[0].url.startsWith(STORAGE_ORIGIN)).toBe(true);
    expect(body.parts[0].url).toContain("partNumber=7");
    expect(body.expires_in).toBe(600);
  });

  it("returns 401 without a session", async () => {
    const res = await POST(presignRequest("fixturevid01", [1]), ctx("fixturevid01"));

    expect(res.status).toBe(401);
  });

  it("passes 404 VIDEO_NOT_FOUND and 409 INVALID_UPLOAD_STATE through", async () => {
    await signIn();

    const notFound = await POST(presignRequest(NOT_FOUND_PUBLIC_ID, [1]), ctx(NOT_FOUND_PUBLIC_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "VIDEO_NOT_FOUND" });

    const noDraft = await POST(presignRequest(NO_DRAFT_PUBLIC_ID, [1]), ctx(NO_DRAFT_PUBLIC_ID));
    expect(noDraft.status).toBe(409);
    expect(await noDraft.json()).toMatchObject({ error: "INVALID_UPLOAD_STATE" });
  });
});

describe("GET /api/videos/[publicId]/upload/parts", () => {
  it("returns 200 with the parts the storage already holds", async () => {
    await signIn();

    const res = await GET(listRequest(RESUMABLE_PUBLIC_ID), ctx(RESUMABLE_PUBLIC_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      parts: [{ part_number: 1, etag: '"etag-1"', size: 5 * 1024 * 1024 }],
    });
  });

  it("returns an empty list for a fresh draft", async () => {
    await signIn();

    const res = await GET(listRequest("fixturevid01"), ctx("fixturevid01"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ parts: [] });
  });

  it("returns 401 without a session and passes 404/409 through", async () => {
    expect((await GET(listRequest("fixturevid01"), ctx("fixturevid01"))).status).toBe(401);

    await signIn();
    expect((await GET(listRequest(NOT_FOUND_PUBLIC_ID), ctx(NOT_FOUND_PUBLIC_ID))).status).toBe(404);
    expect((await GET(listRequest(NO_DRAFT_PUBLIC_ID), ctx(NO_DRAFT_PUBLIC_ID))).status).toBe(409);
  });
});
