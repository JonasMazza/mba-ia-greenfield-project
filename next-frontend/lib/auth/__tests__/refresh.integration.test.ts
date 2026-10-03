import { AsyncLocalStorage } from "node:async_hooks";

import { http, HttpResponse } from "msw";
import { vi, describe, it, expect, beforeEach } from "vitest";

import { server } from "@/mocks/server";

// Shared cookie store for the session mock — same pattern as session.test.ts.
const cookieMap = new Map<string, string>();

// A browser request carries its own cookie jar: `inRequest` runs a callback
// against a separate jar, the way two concurrent route handlers would.
const requestJar = new AsyncLocalStorage<Map<string, string>>();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    const jar = requestJar.getStore() ?? cookieMap;
    return {
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    };
  }),
}));

const { withRefresh } = await import("@/lib/auth/refresh");
const { setSession, getSession } = await import("@/lib/auth/session");
const { env } = await import("@/lib/env");

const UPSTREAM_URL = `${env.API_URL}/protected-resource`;

const BASE_SESSION = {
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
  userId: "user-1",
  email: "alice@example.com",
  channelSlug: "alice",
};

// The BFF remembers a rotation for a few seconds by the refresh token it
// replaced; a fresh token per test keeps one test's rotation out of the next.
let SEED_SESSION = BASE_SESSION;
let seedCount = 0;

beforeEach(async () => {
  cookieMap.clear();
  SEED_SESSION = { ...BASE_SESSION, refreshToken: `old-refresh-token-${++seedCount}` };
  await setSession(SEED_SESSION);
});

function inRequest<T>(jar: Map<string, string>, fn: () => Promise<T>): Promise<T> {
  return requestJar.run(jar, fn);
}

/** A jar holding a sealed session, as the browser would send it. */
async function jarWith(session: typeof SEED_SESSION): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  await inRequest(jar, () => setSession(session));
  return jar;
}

/** Like `callWithBearer`: every attempt re-reads the access token from the session. */
function bearerFetch() {
  return async () => {
    const { accessToken } = await getSession();
    return fetch(UPSTREAM_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  };
}

/** Upstream that accepts only the given access tokens. */
function acceptOnly(...tokens: string[]) {
  return http.get(UPSTREAM_URL, ({ request }) =>
    tokens.some((t) => request.headers.get("authorization") === `Bearer ${t}`)
      ? HttpResponse.json({ ok: true })
      : new HttpResponse(null, { status: 401 })
  );
}

describe("withRefresh", () => {
  it("passes through a non-401 response without refreshing", async () => {
    let refreshCalls = 0;
    server.use(
      http.get(UPSTREAM_URL, () => HttpResponse.json({ ok: true })),
      http.post(`${env.API_URL}/auth/refresh`, () => {
        refreshCalls++;
        return HttpResponse.json({ access_token: "new-at", refresh_token: "new-rt" });
      })
    );

    const res = await withRefresh(() => fetch(UPSTREAM_URL));
    expect(res.status).toBe(200);
    expect(refreshCalls).toBe(0);
  });

  it("refreshes and retries on 401 — updates the session with new tokens", async () => {
    let callCount = 0;
    server.use(
      http.get(UPSTREAM_URL, () => {
        callCount++;
        // First call → 401; subsequent → 200 (simulating successful retry after refresh)
        return callCount === 1
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ data: "protected" });
      }),
      http.post(`${env.API_URL}/auth/refresh`, () =>
        HttpResponse.json({ access_token: "refreshed-at", refresh_token: "refreshed-rt" })
      )
    );

    const res = await withRefresh(() => fetch(UPSTREAM_URL));
    expect(res.status).toBe(200);

    const session = await getSession();
    expect(session.accessToken).toBe("refreshed-at");
    expect(session.refreshToken).toBe("refreshed-rt");
  });

  it("single-flight: two concurrent 401s trigger exactly one refresh", async () => {
    let refreshCalls = 0;
    server.use(
      http.get(UPSTREAM_URL, () => new HttpResponse(null, { status: 401 })),
      http.post(`${env.API_URL}/auth/refresh`, () => {
        refreshCalls++;
        return HttpResponse.json({ access_token: "new-at", refresh_token: "new-rt" });
      })
    );

    await Promise.all([
      withRefresh(() => fetch(UPSTREAM_URL)),
      withRefresh(() => fetch(UPSTREAM_URL)),
    ]);

    expect(refreshCalls).toBe(1);
  });

  it("destroys the session and returns 401 when refresh itself fails", async () => {
    server.use(
      http.get(UPSTREAM_URL, () => new HttpResponse(null, { status: 401 })),
      http.post(`${env.API_URL}/auth/refresh`, () =>
        new HttpResponse(null, { status: 401 })
      )
    );

    const res = await withRefresh(() => fetch(UPSTREAM_URL));
    expect(res.status).toBe(401);

    const session = await getSession();
    expect(session.isLoggedIn).toBeFalsy();
  });

  describe("across requests (each with its own cookie jar)", () => {
    it("same session: one refresh, and every waiting request retries with the new token", async () => {
      let refreshCalls = 0;
      server.use(
        acceptOnly("new-at"),
        http.post(`${env.API_URL}/auth/refresh`, async () => {
          refreshCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return HttpResponse.json({ access_token: "new-at", refresh_token: "new-rt" });
        })
      );
      const first = await jarWith(SEED_SESSION);
      const second = new Map(first);

      const [a, b] = await Promise.all([
        inRequest(first, () => withRefresh(bearerFetch())),
        inRequest(second, () => withRefresh(bearerFetch())),
      ]);

      expect(refreshCalls).toBe(1);
      expect([a.status, b.status]).toEqual([200, 200]);
      // Both responses carry the rotated pair — whichever cookie lands last is valid.
      for (const jar of [first, second]) {
        const session = await inRequest(jar, () => getSession());
        expect(session.refreshToken).toBe("new-rt");
      }
    });

    it("different sessions refresh independently, each with its own token", async () => {
      const presented: string[] = [];
      server.use(
        acceptOnly("alice-new-at", "bob-new-at"),
        http.post(`${env.API_URL}/auth/refresh`, async ({ request }) => {
          const { refresh_token } = (await request.json()) as { refresh_token: string };
          presented.push(refresh_token);
          await new Promise((r) => setTimeout(r, 20));
          const who = refresh_token.startsWith("alice") ? "alice" : "bob";
          return HttpResponse.json({ access_token: `${who}-new-at`, refresh_token: `${who}-new-rt` });
        })
      );
      const alice = await jarWith({ ...SEED_SESSION, accessToken: "alice-old-at", refreshToken: "alice-old-rt" });
      const bob = await jarWith({
        ...SEED_SESSION,
        accessToken: "bob-old-at",
        refreshToken: "bob-old-rt",
        userId: "user-2",
        email: "bob@example.com",
        channelSlug: "bob",
      });

      const [a, b] = await Promise.all([
        inRequest(alice, () => withRefresh(bearerFetch())),
        inRequest(bob, () => withRefresh(bearerFetch())),
      ]);

      expect(presented.sort()).toEqual(["alice-old-rt", "bob-old-rt"]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await inRequest(bob, () => getSession())).accessToken).toBe("bob-new-at");
    });

    it("a request that arrives just after the refresh reuses the rotated pair instead of presenting the old token again", async () => {
      let refreshCalls = 0;
      server.use(
        acceptOnly("new-at"),
        http.post(`${env.API_URL}/auth/refresh`, () => {
          refreshCalls++;
          return HttpResponse.json({ access_token: "new-at", refresh_token: "new-rt" });
        })
      );
      const first = await jarWith(SEED_SESSION);
      const late = new Map(first);

      await inRequest(first, () => withRefresh(bearerFetch()));
      const res = await inRequest(late, () => withRefresh(bearerFetch()));

      expect(refreshCalls).toBe(1);
      expect(res.status).toBe(200);
      expect((await inRequest(late, () => getSession())).refreshToken).toBe("new-rt");
    });

    it("a failed refresh ends every waiting request's session", async () => {
      server.use(
        acceptOnly("never"),
        http.post(`${env.API_URL}/auth/refresh`, async () => {
          await new Promise((r) => setTimeout(r, 20));
          return new HttpResponse(null, { status: 401 });
        })
      );
      const first = await jarWith(SEED_SESSION);
      const second = new Map(first);

      const [a, b] = await Promise.all([
        inRequest(first, () => withRefresh(bearerFetch())),
        inRequest(second, () => withRefresh(bearerFetch())),
      ]);

      expect([a.status, b.status]).toEqual([401, 401]);
      for (const jar of [first, second]) {
        expect((await inRequest(jar, () => getSession())).isLoggedIn).toBeFalsy();
      }
    });
  });
});
