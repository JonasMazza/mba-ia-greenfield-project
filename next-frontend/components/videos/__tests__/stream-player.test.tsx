// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StreamPlayer } from "@/components/videos/stream-player"

const STREAM_URL = "/api/videos/abc123def456/stream"
// MediaError codes from the HTML spec — jsdom does not define the interface.
const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

// jsdom has no media pipeline: the element's playback state is faked per test.
function renderPlayer() {
  const { container } = render(<StreamPlayer src={STREAM_URL} controls preload="metadata" />)
  const video = container.querySelector("video") as HTMLVideoElement

  const state = { currentTime: 0, errorCode: 0 }
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value
    },
  })
  // Measured in Chrome: by the time `error` fires, `paused` is already true —
  // with no `pause` event — even if the viewer was watching.
  Object.defineProperty(video, "paused", { configurable: true, get: () => true })
  Object.defineProperty(video, "error", {
    configurable: true,
    get: () => (state.errorCode ? { code: state.errorCode } : null),
  })

  return { video, state }
}

/** What Chrome does when the storage URL it reused has expired (SI-03.17). */
function failWithNetworkError(video: HTMLVideoElement, state: { errorCode: number }) {
  state.errorCode = MEDIA_ERR_NETWORK
  fireEvent.error(video)
}

describe("<StreamPlayer />", () => {
  let load: ReturnType<typeof vi.spyOn>
  let play: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("points a native player at the stable same-origin stream URL", () => {
    const { video } = renderPlayer()

    expect(video.getAttribute("src")).toBe(STREAM_URL)
    expect(video.controls).toBe(true)
    expect(video.getAttribute("preload")).toBe("metadata")
  })

  it("reloads the same-origin URL on a network error and resumes where playback was", () => {
    const { video, state } = renderPlayer()
    fireEvent.play(video)
    state.currentTime = 412.5

    failWithNetworkError(video, state)

    expect(load).toHaveBeenCalledTimes(1)
    expect(video.getAttribute("src")).toBe(STREAM_URL)

    // A fresh load starts from zero; the position comes back once metadata is in.
    state.errorCode = 0
    state.currentTime = 0
    fireEvent.loadedMetadata(video)

    expect(state.currentTime).toBe(412.5)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("keeps a paused player paused after recovering", () => {
    const { video, state } = renderPlayer()
    fireEvent.play(video)
    fireEvent.pause(video)
    state.currentTime = 90

    failWithNetworkError(video, state)
    state.currentTime = 0
    fireEvent.loadedMetadata(video)

    expect(state.currentTime).toBe(90)
    expect(play).not.toHaveBeenCalled()
  })

  it("gives up when the reload fails again right away", () => {
    const { video, state } = renderPlayer()

    failWithNetworkError(video, state)
    vi.advanceTimersByTime(2_000)
    failWithNetworkError(video, state)

    // The video is gone or the session lost access: the native error stays.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("recovers again once playback has run for a while", () => {
    const { video, state } = renderPlayer()

    failWithNetworkError(video, state)
    vi.advanceTimersByTime(60_000)
    failWithNetworkError(video, state)

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not reload on errors that a fresh URL cannot fix", () => {
    const { video, state } = renderPlayer()

    state.errorCode = MEDIA_ERR_SRC_NOT_SUPPORTED
    fireEvent.error(video)

    expect(load).not.toHaveBeenCalled()
  })
})
