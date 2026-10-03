"use client"

import { useRef, type ComponentProps } from "react"

/** `MediaError.MEDIA_ERR_NETWORK` — the code Chrome reports for an expired storage URL. */
const MEDIA_ERR_NETWORK = 2
/**
 * A reload that fails again within this window did not fail for an expired
 * URL — the video is gone or the session lost access — so the native error
 * stays instead of looping.
 */
const RECOVERY_COOLDOWN_MS = 10_000

type StreamPlayerProps = Omit<ComponentProps<"video">, "src" | "onError" | "onLoadedMetadata" | "onPlay" | "onPause"> & {
  src: string
}

/**
 * Native player on the stable same-origin stream URL (TD-06 C), plus the
 * recovery TD-06 B describes. Chrome follows the 307 once and keeps reusing
 * the redirected storage URL for every later Range request, so after the
 * playback TTL a seek outside the buffer fails with a network error. Reloading
 * the same-origin URL goes through the BFF again, which answers with a freshly
 * signed redirect; the position (and playing state) is restored once the new
 * metadata is in. Chrome flips `paused` before firing the error without a
 * `pause` event, so whether the viewer wanted playback is tracked from the
 * `play`/`pause` events instead of read at error time.
 */
export function StreamPlayer({ src, ...props }: StreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingRestore = useRef<{ position: number; resume: boolean } | null>(null)
  const lastRecoveryAt = useRef<number | null>(null)
  const wantsPlayback = useRef(false)

  function handleError() {
    const video = videoRef.current
    if (!video || video.error?.code !== MEDIA_ERR_NETWORK) return

    const now = Date.now()
    if (lastRecoveryAt.current !== null && now - lastRecoveryAt.current < RECOVERY_COOLDOWN_MS) return
    lastRecoveryAt.current = now

    pendingRestore.current = {
      position: video.currentTime,
      resume: wantsPlayback.current,
    }
    video.load()
  }

  function handleLoadedMetadata() {
    const video = videoRef.current
    const restore = pendingRestore.current
    if (!video || !restore) return
    pendingRestore.current = null

    video.currentTime = restore.position
    if (restore.resume) {
      // Autoplay policies may refuse a programmatic play; the controls stay usable.
      video.play().catch(() => undefined)
    }
  }

  return (
    <video
      {...props}
      ref={videoRef}
      src={src}
      onPlay={() => {
        wantsPlayback.current = true
      }}
      onPause={() => {
        wantsPlayback.current = false
      }}
      onError={handleError}
      onLoadedMetadata={handleLoadedMetadata}
    />
  )
}
