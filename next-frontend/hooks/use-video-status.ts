"use client"

import { useEffect, useState } from "react"

import type { VideoStatusResponse } from "@/lib/api/contracts"

export type VideoStatusState = {
  status: "idle" | "polling" | "ready" | "failed" | "error"
  video: VideoStatusResponse | null
  error: Error | null
}

type Snapshot = VideoStatusState & { publicId: string }

const IDLE: VideoStatusState = { status: "idle", video: null, error: null }
const POLLING: VideoStatusState = { status: "polling", video: null, error: null }

/**
 * Polls `GET /api/videos/{publicId}/status` until the video is `ready` or
 * `failed` (TD-05): a recursive `setTimeout` whose interval grows ×1.5 up to
 * `maxIntervalMs`, paused while the tab is hidden and resumed when it is
 * visible again. Unmounting aborts the request in flight. Any failed request
 * ends the loop in `error`.
 */
export function useVideoStatus(
  publicId: string | null,
  { intervalMs = 2000, maxIntervalMs = 10000 }: { intervalMs?: number; maxIntervalMs?: number } = {}
): VideoStatusState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useEffect(() => {
    if (!publicId) return
    const id = publicId

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = intervalMs
    let inFlight = false
    let done = false

    const hidden = () => document.visibilityState === "hidden"

    function schedule() {
      if (hidden()) return // resumed by the visibilitychange listener
      timer = setTimeout(poll, delay)
      delay = Math.min(delay * 1.5, maxIntervalMs)
    }

    async function poll() {
      timer = undefined
      inFlight = true
      try {
        const res = await fetch(`/api/videos/${encodeURIComponent(id)}/status`, {
          cache: "no-store",
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Status request failed with ${res.status}`)
        const video = (await res.json()) as VideoStatusResponse

        if (video.status === "ready" || video.status === "failed") {
          done = true
          setSnapshot({ publicId: id, status: video.status, video, error: null })
          return
        }
        setSnapshot({ publicId: id, status: "polling", video, error: null })
        schedule()
      } catch (error) {
        if (controller.signal.aborted) return
        done = true
        setSnapshot({
          publicId: id,
          status: "error",
          video: null,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      } finally {
        inFlight = false
      }
    }

    function onVisibilityChange() {
      if (hidden()) {
        clearTimeout(timer)
        timer = undefined
      } else if (!done && !inFlight && timer === undefined) {
        void poll()
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    if (!hidden()) void poll()

    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [publicId, intervalMs, maxIntervalMs])

  if (!publicId) return IDLE
  if (snapshot?.publicId !== publicId) return POLLING
  const { status, video, error } = snapshot
  return { status, video, error }
}
