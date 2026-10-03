import type { ApiErrorEnvelope } from "@/lib/api/contracts";
import { withRefresh } from "@/lib/auth/refresh";
import { getSession } from "@/lib/auth/session";

/**
 * The `{ data, error, response }` triple `openapi-fetch` returns, narrowed so
 * `if (error)` leaves `data` defined in the else branch.
 */
export type UpstreamResult<T> =
  | { data: T; error?: undefined; response: Response }
  | { data?: undefined; error: ApiErrorEnvelope; response: Response };

/** A call into the typed upstream client; receives the headers the BFF decided to inject. */
export type UpstreamCall<T> = (
  headers: Record<string, string>
) => Promise<UpstreamResult<T>>;

const UNAUTHORIZED: ApiErrorEnvelope = {
  statusCode: 401,
  error: "UNAUTHORIZED",
  message: "Not authenticated",
  code: null,
};

function unauthorizedResult<T>(): UpstreamResult<T> {
  return {
    error: UNAUTHORIZED,
    response: new Response(JSON.stringify(UNAUTHORIZED), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

/**
 * Runs an upstream call on behalf of the signed-in user: the access token is
 * read from the iron-session cookie and injected as a bearer; an upstream 401
 * goes through the single-flight refresh and the call is retried once with
 * the rotated token. Without a session the BFF answers 401 itself — the
 * upstream is never contacted.
 */
export async function authedUpstream<T>(call: UpstreamCall<T>): Promise<UpstreamResult<T>> {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return unauthorizedResult();
  }
  return callWithBearer(call);
}

/**
 * Same as `authedUpstream` for a signed-in user; anonymous callers reach the
 * upstream without a bearer. For public routes whose answer depends on who is
 * asking (the owner sees a not-ready video, everyone else gets 404).
 */
export async function optionalAuthedUpstream<T>(
  call: UpstreamCall<T>
): Promise<UpstreamResult<T>> {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return call({});
  }
  return callWithBearer(call);
}

/**
 * `optionalAuthedUpstream` for Server Components, which cannot write cookies
 * (Next throws outside a Server Action or Route Handler). The bearer rides
 * along while it is valid, but it is never refreshed here: the rotated pair
 * could not be saved, and the next refresh would then present a revoked token
 * — which the API treats as reuse and answers by revoking the whole session.
 * An upstream 401 falls back to the anonymous answer; the next `/api/**`
 * request (a Route Handler) does the refresh.
 */
export async function optionalAuthedUpstreamReadOnly<T>(
  call: UpstreamCall<T>
): Promise<UpstreamResult<T>> {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return call({});
  }
  const result = await call({ Authorization: `Bearer ${session.accessToken}` });
  return result.response.status === 401 ? call({}) : result;
}

async function callWithBearer<T>(call: UpstreamCall<T>): Promise<UpstreamResult<T>> {
  let last: UpstreamResult<T> | undefined;

  const finalResponse = await withRefresh(async () => {
    // Re-read on every attempt: the refresh rotates the token between them.
    const current = await getSession();
    last = await call({ Authorization: `Bearer ${current.accessToken}` });
    return last.response;
  });

  // The refresh failed: withRefresh hands back a synthetic 401 (session destroyed).
  if (!last || finalResponse !== last.response) {
    return {
      error: (await finalResponse.json()) as ApiErrorEnvelope,
      response: finalResponse,
    };
  }
  return last;
}
