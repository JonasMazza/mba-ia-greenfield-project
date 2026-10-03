import type { Page } from "@playwright/test";

import { STORAGE_ORIGIN } from "../mocks/storage-origin";

/**
 * Stubs the object-storage origin — and ONLY that origin — in the browser.
 * The byte plane (part PUTs) is the one request the uploader makes that does
 * not go through `/api/**`, so intercepting it here breaks no E2E rule: the
 * real Route Handlers still run and the upstream stays faked server-side.
 */
export async function stubStorageOrigin(page: Page) {
  const counters = { puts: 0 };
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "ETag",
  };

  await page.route(`${STORAGE_ORIGIN}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (request.method() === "PUT") {
      counters.puts += 1;
      const partNumber = new URL(request.url()).searchParams.get("partNumber") ?? "1";
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, ETag: `"etag-${partNumber}"` },
      });
      return;
    }
    await route.fulfill({ status: 405, headers: corsHeaders });
  });

  return counters;
}
