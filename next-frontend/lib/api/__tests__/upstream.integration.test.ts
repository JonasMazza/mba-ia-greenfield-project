import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "@/lib/env";
import { server } from "@/mocks/server";

const cookieMap = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.7" })),
  cookies: vi.fn().mockResolvedValue({
    get: (name: string) => (cookieMap.has(name) ? { name, value: cookieMap.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookieMap.set(name, value);
    },
    delete: (name: string) => {
      cookieMap.delete(name);
    },
  }),
}));

let upstream: typeof import("@/lib/api/upstream").upstream;
let withRefresh: typeof import("@/lib/auth/refresh").withRefresh;
let setSession: typeof import("@/lib/auth/session").setSession;

// Imported after MSW is listening: the client keeps the `fetch` it sees at creation.
beforeAll(async () => {
  ({ upstream } = await import("@/lib/api/upstream"));
  ({ withRefresh } = await import("@/lib/auth/refresh"));
  ({ setSession } = await import("@/lib/auth/session"));
});

// The API rate-limits the auth endpoints per client address; every call
// leaves from the BFF, so it must say which browser it is acting for.
describe("client address forwarding", () => {
  it("typed upstream calls carry the browser's address", async () => {
    let forwarded: string | null = null;
    server.use(
      http.post(`${env.API_URL}/auth/forgot-password`, ({ request }) => {
        forwarded = request.headers.get("x-forwarded-for");
        return new HttpResponse(null, { status: 204 });
      })
    );

    // Same cast as the route: the generated DTO for this body is empty.
    await upstream.POST("/auth/forgot-password", { body: { email: "alice@example.com" } as never });

    expect(forwarded).toBe("203.0.113.7");
  });

  it("the token refresh carries the browser's address", async () => {
    await setSession({
      accessToken: "old-at",
      refreshToken: "old-rt",
      userId: "user-1",
      email: "alice@example.com",
      channelSlug: "alice",
    });
    let forwarded: string | null = null;
    server.use(
      http.get(`${env.API_URL}/protected-resource`, () => new HttpResponse(null, { status: 401 })),
      http.post(`${env.API_URL}/auth/refresh`, ({ request }) => {
        forwarded = request.headers.get("x-forwarded-for");
        return HttpResponse.json({ access_token: "new-at", refresh_token: "new-rt" });
      })
    );

    await withRefresh(() => fetch(`${env.API_URL}/protected-resource`));

    expect(forwarded).toBe("203.0.113.7");
  });
});
