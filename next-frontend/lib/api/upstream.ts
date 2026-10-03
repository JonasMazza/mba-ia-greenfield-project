import "server-only";
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./types.gen";
import { forwardedFor } from "./client-ip";
import { env } from "@/lib/env";

export const upstream = createClient<paths>({ baseUrl: env.API_URL });

// Every call leaves from the BFF; tell the API which browser it acts for.
const forwardedForMiddleware: Middleware = {
  async onRequest({ request }) {
    const clientIp = await forwardedFor();
    if (clientIp) {
      request.headers.set("X-Forwarded-For", clientIp);
    }
    return request;
  },
};

upstream.use(forwardedForMiddleware);
