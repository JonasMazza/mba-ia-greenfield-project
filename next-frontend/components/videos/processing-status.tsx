"use client"

import Image from "next/image"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { useVideoStatus } from "@/hooks/use-video-status"

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

function ProcessingStatus({ publicId }: { publicId: string }) {
  const { status, video, error } = useVideoStatus(publicId)

  if (status === "ready" && video) {
    return (
      <section className="flex flex-col items-center gap-4" data-slot="processing-ready">
        <p role="status" className="text-body-lg text-foreground">
          Your video is ready.
        </p>
        {video.thumbnail_url && (
          // Presigned storage URL: the browser fetches it as-is; the optimizer
          // would refetch it server-side from a host only the browser reaches.
          <Image
            src={video.thumbnail_url}
            alt="Video thumbnail"
            width={320}
            height={180}
            unoptimized
            className="rounded-[var(--radius-3)] object-cover"
          />
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-body-md text-foreground">
          {video.duration_seconds !== undefined && (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{formatDuration(video.duration_seconds)}</dd>
            </>
          )}
          {video.width !== undefined && video.height !== undefined && (
            <>
              <dt className="text-muted-foreground">Dimensions</dt>
              <dd>
                {video.width} × {video.height}
              </dd>
            </>
          )}
        </dl>
        <Link href={`/videos/${publicId}/preview`} className={buttonVariants({ size: "md" })}>
          Open preview
        </Link>
      </section>
    )
  }

  if (status === "failed") {
    return (
      <p role="alert" className="text-body-md text-destructive" data-slot="processing-failed">
        Processing failed: {video?.failure_reason ?? "unknown reason"}
      </p>
    )
  }

  if (status === "error") {
    return (
      <p role="alert" className="text-body-md text-destructive" data-slot="processing-error">
        Could not check the processing status. {error?.message}
      </p>
    )
  }

  return (
    <p role="status" className="text-body-lg text-foreground" data-slot="processing-pending">
      Processing your video…
    </p>
  )
}

export { ProcessingStatus }
