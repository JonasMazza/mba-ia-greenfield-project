import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TOO_LARGE_FILENAME } from "@/mocks/handlers/videos";
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

let POST: (req: Request) => Promise<Response>;
let setSession: typeof import("@/lib/auth/session").setSession;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/videos/route"));
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

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  filename: "clip.mp4",
  content_type: "video/mp4",
  size_bytes: 12 * 1024 * 1024,
};

describe("POST /api/videos", () => {
  it("returns 201 with the upload plan (pass-through) for a signed-in user", async () => {
    await signIn();

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      public_id: expect.any(String),
      upload_id: expect.any(String),
      part_size_bytes: 5 * 1024 * 1024,
      part_count: 3,
      expires_in: 600,
    });
    expect(JSON.stringify(body)).not.toContain(STORAGE_ORIGIN);
  });

  it("returns 401 UNAUTHORIZED without a session", async () => {
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  it("passes a 413 FILE_TOO_LARGE through verbatim", async () => {
    await signIn();

    const res = await POST(makeRequest({ ...VALID_BODY, filename: TOO_LARGE_FILENAME }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ statusCode: 413, error: "FILE_TOO_LARGE" });
  });

  it("passes a 415 UNSUPPORTED_MEDIA_TYPE through verbatim", async () => {
    await signIn();

    const res = await POST(makeRequest({ ...VALID_BODY, content_type: "image/png" }));

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ statusCode: 415, error: "UNSUPPORTED_MEDIA_TYPE" });
  });
});
