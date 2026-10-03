import { vi } from "vitest";

/**
 * Cookie-store mock for iron-session shared by the videos BFF route tests.
 * Call `mockCookies()` at module top level (it registers `vi.mock`) and
 * `signIn()` inside a test to seal a fixture session.
 */
export const cookieMap = new Map<string, string>();

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

export async function signIn(accessToken = "fixture-access-token") {
  const { setSession } = await import("@/lib/auth/session");
  await setSession({
    accessToken,
    refreshToken: "fixture-refresh-token",
    userId: "user-1",
    email: "alice@example.com",
    channelSlug: "alice",
  });
}

export const ctx = (publicId: string) => ({ params: Promise.resolve({ publicId }) });

export type RouteHandler = (
  req: Request,
  ctx: { params: Promise<{ publicId: string }> }
) => Promise<Response>;
