import { forwardedFor } from "@/lib/api/client-ip";
import { env } from "@/lib/env";

import { destroySession, getSession, setSession } from "./session";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * How long a rotation is handed out to requests that still present the token
 * it replaced. Matches the API's reuse grace (`TOKEN_REUSE_GRACE_PERIOD_MS`):
 * inside it the API would answer with the *revoked* refresh token, and saving
 * that one gets the whole session revoked on the next refresh.
 */
const ROTATION_REUSE_MS = 10_000;

/**
 * Refreshes keyed by the refresh token they present. Concurrent requests of one
 * session share a single call and its result — a second call would present an
 * already-rotated token — while other sessions never wait on it.
 */
const rotations = new Map<string, Promise<TokenPair | null>>();

async function requestRefresh(refreshToken: string): Promise<TokenPair | null> {
  const clientIp = await forwardedFor();

  const res = await fetch(`${env.API_URL}/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clientIp && { "X-Forwarded-For": clientIp }),
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.access_token || !data.refresh_token) {
    return null;
  }

  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

function rotate(refreshToken: string): Promise<TokenPair | null> {
  let rotation = rotations.get(refreshToken);
  if (!rotation) {
    rotation = requestRefresh(refreshToken).then(
      (tokens) => {
        if (tokens) {
          setTimeout(() => rotations.delete(refreshToken), ROTATION_REUSE_MS).unref();
        } else {
          rotations.delete(refreshToken);
        }
        return tokens;
      },
      (error: unknown) => {
        rotations.delete(refreshToken);
        throw error;
      }
    );
    rotations.set(refreshToken, rotation);
  }
  return rotation;
}

async function tryRefresh(): Promise<boolean> {
  const session = await getSession();
  const tokens = await rotate(session.refreshToken);

  if (!tokens) {
    await destroySession();
    return false;
  }

  // Every request that shared the rotation saves it in its own cookie: its
  // retry re-reads the session, and its jar still holds the expired pair.
  await setSession({
    ...tokens,
    userId: session.userId,
    email: session.email,
    channelSlug: session.channelSlug,
  });

  return true;
}

export async function withRefresh(
  fetcher: () => Promise<Response>
): Promise<Response> {
  const response = await fetcher();

  if (response.status !== 401) {
    return response;
  }

  const refreshed = await tryRefresh();

  if (!refreshed) {
    return new Response(
      JSON.stringify({
        statusCode: 401,
        error: "UNAUTHORIZED",
        message: "Session expired",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  return fetcher();
}
