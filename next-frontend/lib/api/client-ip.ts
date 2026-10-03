import "server-only";
import { headers } from "next/headers";

/**
 * The browser's address as the hop in front of the BFF saw it — the last
 * `X-Forwarded-For` entry. Next sets the header from the socket when the
 * request arrives without one, and a reverse proxy in front of Next appends
 * its peer. The API rate-limits auth per this address (it trusts the BFF's
 * hop), so without it every user would share the BFF's budget.
 *
 * Next keeps a header the browser sent itself, so in production Next must sit
 * behind a proxy that appends the real peer.
 */
export async function forwardedFor(): Promise<string | null> {
  let forwarded: string | null;
  try {
    forwarded = (await headers()).get("x-forwarded-for");
  } catch {
    // Outside a request there is no browser to speak for.
    return null;
  }
  return forwarded?.split(",").at(-1)?.trim() || null;
}
