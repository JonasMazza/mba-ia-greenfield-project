// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useVideoStatus } from "@/hooks/use-video-status"
import type { VideoStatusResponse } from "@/lib/api/contracts"
import { buildVideoStatus } from "@/mocks/factories/videos"
import { server } from "@/mocks/server"

const PUBLIC_ID = "pollvideo001"
const processing: VideoStatusResponse = { public_id: PUBLIC_ID, status: "processing" }

// Captured before the clock is faked: lets MSW and React finish their real
// async work without moving fake time.
const realSetTimeout = globalThis.setTimeout

async function settle() {
  await act(async () => {
    await new Promise((resolve) => realSetTimeout(resolve, 20))
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await settle()
}

/** Answers the status route with `responses` in order, repeating the last one. */
function respondWith(...responses: VideoStatusResponse[]) {
  const requests: Request[] = []
  server.use(
    http.get("/api/videos/:publicId/status", ({ request }) => {
      requests.push(request)
      const body = responses[Math.min(requests.length, responses.length) - 1]
      return HttpResponse.json(body, { headers: { "Cache-Control": "no-store" } })
    })
  )
  return requests
}

let visibility: DocumentVisibilityState = "visible"

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useVideoStatus", () => {
  it("polls processing → processing → ready, then stops and exposes the metadata", async () => {
    const requests = respondWith(processing, processing, buildVideoStatus({ public_id: PUBLIC_ID }))

    const { result } = renderHook(() => useVideoStatus(PUBLIC_ID))
    expect(result.current.status).toBe("polling")
    await settle()
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe(`/api/videos/${PUBLIC_ID}/status`)

    await advance(2000)
    expect(requests).toHaveLength(2)
    expect(result.current.status).toBe("polling")

    await advance(3000)
    expect(requests).toHaveLength(3)
    expect(result.current.status).toBe("ready")
    expect(result.current.video).toMatchObject({
      duration_seconds: 42,
      thumbnail_url: expect.stringContaining("thumbnails/auto.jpg"),
    })

    await advance(60_000)
    expect(requests).toHaveLength(3)
  })

  it("stops on failed and exposes the failure_reason", async () => {
    const requests = respondWith({
      public_id: PUBLIC_ID,
      status: "failed",
      failure_reason: "ffprobe could not read the container",
    })

    const { result } = renderHook(() => useVideoStatus(PUBLIC_ID))
    await settle()

    expect(result.current.status).toBe("failed")
    expect(result.current.video?.failure_reason).toBe("ffprobe could not read the container")
    await advance(60_000)
    expect(requests).toHaveLength(1)
  })

  it("backs the interval off ×1.5 per attempt up to maxIntervalMs", async () => {
    const requests = respondWith(processing)

    renderHook(() => useVideoStatus(PUBLIC_ID, { intervalMs: 2000, maxIntervalMs: 10000 }))
    await settle()
    expect(requests).toHaveLength(1)

    for (const interval of [2000, 3000, 4500, 6750, 10000, 10000]) {
      const before = requests.length
      await advance(interval - 1)
      expect(requests).toHaveLength(before)
      await advance(1)
      expect(requests).toHaveLength(before + 1)
    }
  })

  it("schedules nothing after an unmount between attempts", async () => {
    const requests = respondWith(processing)

    const { unmount } = renderHook(() => useVideoStatus(PUBLIC_ID))
    await settle()
    expect(requests).toHaveLength(1)

    unmount()
    await advance(60_000)
    expect(requests).toHaveLength(1)
  })

  it("aborts the request in flight on unmount", async () => {
    const signals: AbortSignal[] = []
    server.use(
      http.get("/api/videos/:publicId/status", async ({ request }) => {
        signals.push(request.signal)
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve))
        return HttpResponse.json(processing)
      })
    )

    const { unmount } = renderHook(() => useVideoStatus(PUBLIC_ID))
    await settle()
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)

    unmount()
    await settle()
    expect(signals[0].aborted).toBe(true)
    await advance(60_000)
    expect(signals).toHaveLength(1)
  })

  it("pauses while the tab is hidden and resumes when it becomes visible", async () => {
    const requests = respondWith(processing)

    renderHook(() => useVideoStatus(PUBLIC_ID))
    await settle()
    expect(requests).toHaveLength(1)

    act(() => setVisibility("hidden"))
    await advance(60_000)
    expect(requests).toHaveLength(1)

    act(() => setVisibility("visible"))
    await settle()
    expect(requests).toHaveLength(2)
  })

  it("stays idle without a publicId", async () => {
    const requests = respondWith(processing)

    const { result } = renderHook(() => useVideoStatus(null))
    await settle()

    expect(result.current).toEqual({ status: "idle", video: null, error: null })
    expect(requests).toHaveLength(0)
  })
})
