import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { StreamPlayer } from "@/components/videos/stream-player"
import { optionalAuthedUpstreamReadOnly } from "@/lib/api/authed"
import { upstream } from "@/lib/api/upstream"

type Params = Promise<{ publicId: string }>

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

/**
 * Throwaway playback surface (TD-07) — Fase 05 replaces it with the watch
 * page. Both media URLs are same-origin and stable: every request to them is
 * answered with a 307 to a freshly signed storage URL (TD-06). Chrome reuses
 * the redirected URL for later Range requests, so `StreamPlayer` reloads the
 * same-origin URL when that one expires.
 */
export default async function VideoPreviewPage({ params }: { params: Params }) {
  const { publicId } = await params

  const { data: video, error, response } = await optionalAuthedUpstreamReadOnly((headers) =>
    upstream.GET("/videos/{publicId}", { params: { path: { publicId } }, headers })
  )
  if (response.status === 404) notFound()
  if (error) throw new Error(`Could not load video ${publicId}: ${error.error}`)

  const streamUrl = `/api/videos/${encodeURIComponent(publicId)}/stream`
  const downloadUrl = `/api/videos/${encodeURIComponent(publicId)}/download`

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-[800px] gap-6 px-6 py-10">
        <h1 className="text-h1 text-foreground">{video.title ?? video.public_id}</h1>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-body-md text-foreground">
          <dt className="text-muted-foreground">Video id</dt>
          <dd>{video.public_id}</dd>
          {video.duration_seconds != null && (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{formatDuration(video.duration_seconds)}</dd>
            </>
          )}
          {video.width != null && video.height != null && (
            <>
              <dt className="text-muted-foreground">Dimensions</dt>
              <dd>
                {video.width} × {video.height}
              </dd>
            </>
          )}
        </dl>

        {video.status === "ready" ? (
          <>
            <StreamPlayer
              controls
              preload="metadata"
              src={streamUrl}
              className="aspect-video w-full rounded-[var(--radius-3)] bg-foreground"
            />
            <a href={downloadUrl} download className={buttonVariants({ variant: "outline", size: "md" })}>
              Download
            </a>
          </>
        ) : (
          <p role="status" className="text-body-md text-foreground">
            This video is not ready yet ({video.status}).
          </p>
        )}
      </Card>
    </main>
  )
}
