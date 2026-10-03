// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProcessingStatus } from "@/components/videos/processing-status"
import type { VideoStatusResponse } from "@/lib/api/contracts"
import { FIXTURE_PUBLIC_ID, buildVideoStatus } from "@/mocks/factories/videos"
import { server } from "@/mocks/server"

// Captured before the clock is faked: lets MSW and React finish their real
// async work without moving fake time.
const realSetTimeout = globalThis.setTimeout

async function settle() {
  await act(async () => {
    await new Promise((resolve) => realSetTimeout(resolve, 20))
  })
}

function respondWith(...responses: VideoStatusResponse[]) {
  let calls = 0
  server.use(
    http.get("/api/videos/:publicId/status", () => {
      calls += 1
      return HttpResponse.json(responses[Math.min(calls, responses.length) - 1])
    })
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe("<ProcessingStatus />", () => {
  it("shows processing, then the metadata and a preview link once ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const ready = buildVideoStatus({ public_id: FIXTURE_PUBLIC_ID })
    respondWith({ public_id: FIXTURE_PUBLIC_ID, status: "processing" }, ready)

    render(<ProcessingStatus publicId={FIXTURE_PUBLIC_ID} />)
    await settle()
    expect(screen.getByRole("status")).toHaveTextContent("Processing your video…")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await settle()

    expect(screen.getByRole("status")).toHaveTextContent("Your video is ready.")
    expect(screen.getByText("0:42")).toBeInTheDocument()
    expect(screen.getByText("1280 × 720")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Video thumbnail" })).toHaveAttribute(
      "src",
      ready.thumbnail_url
    )
    expect(screen.getByRole("link", { name: "Open preview" })).toHaveAttribute(
      "href",
      `/videos/${FIXTURE_PUBLIC_ID}/preview`
    )
  })

  it("shows the failure_reason when processing failed", async () => {
    respondWith({
      public_id: FIXTURE_PUBLIC_ID,
      status: "failed",
      failure_reason: "ffprobe could not read the container",
    })

    render(<ProcessingStatus publicId={FIXTURE_PUBLIC_ID} />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Processing failed: ffprobe could not read the container"
    )
    expect(screen.queryByRole("link", { name: "Open preview" })).not.toBeInTheDocument()
  })
})
