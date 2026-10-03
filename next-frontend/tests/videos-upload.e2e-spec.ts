import type { Page } from "@playwright/test"

import { FIXTURE_PUBLIC_ID } from "../mocks/factories/videos"
import { expect, test } from "./fixtures"
import { stubStorageOrigin } from "./storage-stub"

// Upstream is faked server-side by mocks/ MSW via instrumentation.ts; the real
// /api/** Route Handlers run. Only the storage origin is stubbed in the browser
// (stubStorageOrigin) — it is the one request outside /api/**.

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Email address").fill("user@example.com")
  await page.getByLabel("Password", { exact: true }).fill("secret123")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name.includes("session")))
    .toBe(true)
}

test.describe("videos-upload", () => {
  test("anonymous visitor is redirected to /login", async ({ page }) => {
    const response = await page.request.get("/videos/upload", { maxRedirects: 0 })
    expect(response.status()).toBe(307)
    expect(response.headers()["location"]).toMatch(/\/login$/)

    await page.goto("/videos/upload")
    await expect(page).toHaveURL(/\/login$/)
  })

  test("signed-in user uploads a 1-part file and reaches ready with a preview link", async ({
    page,
  }) => {
    const storage = await stubStorageOrigin(page)
    await signIn(page)

    await page.goto("/videos/upload")
    const start = page.getByRole("button", { name: "Start upload" })
    await expect(start).toBeDisabled()

    await page.getByLabel("Video file").setInputFiles({
      name: "clip.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(1024),
    })
    await start.click()

    await expect(page.getByRole("status")).toHaveText("Your video is ready.")
    await expect(page.getByRole("link", { name: "Open preview" })).toHaveAttribute(
      "href",
      `/videos/${FIXTURE_PUBLIC_ID}/preview`
    )
    expect(storage.puts).toBe(1)
  })
})
