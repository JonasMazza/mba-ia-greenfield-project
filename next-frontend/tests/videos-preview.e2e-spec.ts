import { FIXTURE_PUBLIC_ID } from "../mocks/factories/videos"
import { STORAGE_ORIGIN } from "../mocks/storage-origin"
import { expect, test } from "./fixtures"

// Upstream is faked server-side by mocks/ MSW via instrumentation.ts; the page
// (async RSC) and the /api/** redirect routes run for real.

// Reserved trigger of mocks/handlers/videos.ts (importing that module here
// would pull lib/env.ts, which validates the server env on the host).
const NOT_FOUND_PUBLIC_ID = "notfound0000"

test.describe("videos-preview", () => {
  test("renders a same-origin <video> and a download link for a ready video", async ({ page }) => {
    await page.goto(`/videos/${FIXTURE_PUBLIC_ID}/preview`)

    const video = page.locator("video")
    await expect(video).toHaveAttribute("controls", "")
    await expect(video).toHaveAttribute("src", `/api/videos/${FIXTURE_PUBLIC_ID}/stream`)

    const download = page.getByRole("link", { name: "Download" })
    await expect(download).toHaveAttribute("href", `/api/videos/${FIXTURE_PUBLIC_ID}/download`)
    await expect(download).toHaveAttribute("download", "")
  })

  test("stream and download answer 307 to the storage origin, never cached", async ({ page }) => {
    const stream = await page.request.get(`/api/videos/${FIXTURE_PUBLIC_ID}/stream`, {
      maxRedirects: 0,
    })
    expect(stream.status()).toBe(307)
    expect(stream.headers()["location"]).toMatch(new RegExp(`^${STORAGE_ORIGIN}/`))
    expect(stream.headers()["cache-control"]).toBe("no-store")

    const download = await page.request.get(`/api/videos/${FIXTURE_PUBLIC_ID}/download`, {
      maxRedirects: 0,
    })
    expect(download.status()).toBe(307)
    const location = new URL(download.headers()["location"])
    expect(location.origin).toBe(STORAGE_ORIGIN)
    expect(location.searchParams.get("response-content-disposition")).toMatch(/^attachment/)
    expect(download.headers()["cache-control"]).toBe("no-store")
  })

  test("an unknown video renders the 404 page", async ({ page }) => {
    const response = await page.goto(`/videos/${NOT_FOUND_PUBLIC_ID}/preview`)

    expect(response?.status()).toBe(404)
    await expect(page.getByRole("heading", { name: "Video unavailable" })).toBeVisible()
  })
})
