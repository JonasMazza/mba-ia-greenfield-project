import { http, HttpResponse } from "msw";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpstreamResult } from "@/lib/api/authed";
import { env } from "@/lib/env";
import { server } from "@/mocks/server";

// Cookie store mock for iron-session (same pattern as the auth route tests).
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

let authedUpstream: typeof import("@/lib/api/authed").authedUpstream;
let optionalAuthedUpstream: typeof import("@/lib/api/authed").optionalAuthedUpstream;
let optionalAuthedUpstreamReadOnly: typeof import("@/lib/api/authed").optionalAuthedUpstreamReadOnly;
let setSession: typeof import("@/lib/auth/session").setSession;
let getSession: typeof import("@/lib/auth/session").getSession;

beforeAll(async () => {
  ({ authedUpstream, optionalAuthedUpstream, optionalAuthedUpstreamReadOnly } = await import(
    "@/lib/api/authed"
  ));
  ({ setSession, getSession } = await import("@/lib/auth/session"));
});

beforeEach(() => {
  cookieMap.clear();
});

// The BFF remembers a rotation for a few seconds by the refresh token it
// replaced; a fresh token per sign-in keeps one test's rotation out of the next.
let signIns = 0;

async function signIn(accessToken = "fixture-access-token") {
  await setSession({
    accessToken,
    refreshToken: `fixture-refresh-token-${++signIns}`,
    userId: "user-1",
    email: "alice@example.com",
    channelSlug: "alice",
  });
}

/** A fake upstream call that records the headers it was given and hits a probe endpoint. */
function probeCall(path = "/probe") {
  const seen: Record<string, string>[] = [];
  const call = async (headers: Record<string, string>): Promise<UpstreamResult<{ ok: true }>> => {
    seen.push(headers);
    const response = await fetch(`${env.API_URL}${path}`, { headers });
    if (response.ok) {
      return { data: (await response.json()) as { ok: true }, response };
    }
    return {
      error: (await response.json()) as UpstreamResult<never>["error"] & object,
      response,
    };
  };
  return { call, seen };
}

describe("authedUpstream", () => {
  it("answers 401 UNAUTHORIZED without touching the upstream when there is no session", async () => {
    const { call, seen } = probeCall();

    const result = await authedUpstream(call);

    expect(result.error).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
    expect(result.response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("injects the session's access token as a bearer", async () => {
    await signIn("token-abc");
    server.use(http.get(`${env.API_URL}/probe`, () => HttpResponse.json({ ok: true })));
    const { call, seen } = probeCall();

    const result = await authedUpstream(call);

    expect(result.data).toEqual({ ok: true });
    expect(seen).toEqual([{ Authorization: "Bearer token-abc" }]);
  });

  it("refreshes once on an upstream 401 and retries with the rotated token", async () => {
    await signIn("stale-token");
    let refreshCalls = 0;
    let probeCalls = 0;
    server.use(
      http.get(`${env.API_URL}/probe`, ({ request }) => {
        probeCalls += 1;
        if (request.headers.get("authorization") === "Bearer new-fixture-access-token") {
          return HttpResponse.json({ ok: true });
        }
        return HttpResponse.json(
          { statusCode: 401, error: "UNAUTHORIZED", message: "expired" },
          { status: 401 }
        );
      }),
      http.post(`${env.API_URL}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "new-fixture-access-token",
          refresh_token: "new-fixture-refresh-token",
        });
      })
    );
    const { call, seen } = probeCall();

    const result = await authedUpstream(call);

    expect(result.data).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(probeCalls).toBe(2);
    expect(seen[0]).toEqual({ Authorization: "Bearer stale-token" });
    expect(seen[1]).toEqual({ Authorization: "Bearer new-fixture-access-token" });
  });

  it("propagates 401 and destroys the session when the refresh itself fails", async () => {
    await signIn("stale-token");
    server.use(
      http.get(`${env.API_URL}/probe`, () =>
        HttpResponse.json(
          { statusCode: 401, error: "UNAUTHORIZED", message: "expired" },
          { status: 401 }
        )
      ),
      http.post(`${env.API_URL}/auth/refresh`, () =>
        HttpResponse.json(
          { statusCode: 401, error: "INVALID_REFRESH_TOKEN", message: "reused" },
          { status: 401 }
        )
      )
    );
    const { call } = probeCall();

    const result = await authedUpstream(call);

    expect(result.response.status).toBe(401);
    expect(result.error).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
    expect((await getSession()).isLoggedIn).toBeFalsy();
  });
});

describe("optionalAuthedUpstream", () => {
  it("reaches the upstream without a bearer when there is no session", async () => {
    server.use(http.get(`${env.API_URL}/probe`, () => HttpResponse.json({ ok: true })));
    const { call, seen } = probeCall();

    const result = await optionalAuthedUpstream(call);

    expect(result.data).toEqual({ ok: true });
    expect(seen).toEqual([{}]);
  });

  it("injects the bearer when a session exists", async () => {
    await signIn("token-xyz");
    server.use(http.get(`${env.API_URL}/probe`, () => HttpResponse.json({ ok: true })));
    const { call, seen } = probeCall();

    await optionalAuthedUpstream(call);

    expect(seen).toEqual([{ Authorization: "Bearer token-xyz" }]);
  });
});

describe("optionalAuthedUpstreamReadOnly", () => {
  it("injects the bearer when a session exists", async () => {
    await signIn("token-rsc");
    server.use(http.get(`${env.API_URL}/probe`, () => HttpResponse.json({ ok: true })));
    const { call, seen } = probeCall();

    const result = await optionalAuthedUpstreamReadOnly(call);

    expect(result.data).toEqual({ ok: true });
    expect(seen).toEqual([{ Authorization: "Bearer token-rsc" }]);
  });

  it("never refreshes nor writes the session on an upstream 401 — it retries anonymously", async () => {
    await signIn("stale-token");
    const cookiesBefore = new Map(cookieMap);
    let refreshCalls = 0;
    server.use(
      http.get(`${env.API_URL}/probe`, ({ request }) =>
        request.headers.get("authorization")
          ? HttpResponse.json(
              { statusCode: 401, error: "UNAUTHORIZED", message: "expired" },
              { status: 401 }
            )
          : HttpResponse.json({ ok: true })
      ),
      http.post(`${env.API_URL}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "new-fixture-access-token",
          refresh_token: "new-fixture-refresh-token",
        });
      })
    );
    const { call, seen } = probeCall();

    const result = await optionalAuthedUpstreamReadOnly(call);

    // A Server Component cannot write cookies: a rotated pair would be lost and
    // the next refresh would present a revoked token (reuse → forced logout).
    expect(refreshCalls).toBe(0);
    expect(cookieMap).toEqual(cookiesBefore);
    expect(seen).toEqual([{ Authorization: "Bearer stale-token" }, {}]);
    expect(result.data).toEqual({ ok: true });
  });
});
