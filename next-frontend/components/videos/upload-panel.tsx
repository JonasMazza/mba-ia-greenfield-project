"use client"

import * as React from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ProcessingStatus } from "@/components/videos/processing-status"
import {
  createVideoUploader,
  discardUpload,
  VideoUploadError,
  type ResumeTarget,
  type UploadProgress,
  type VideoUploader,
} from "@/lib/videos/uploader"

type Phase =
  | { name: "select" }
  | { name: "uploading"; progress: UploadProgress | null }
  | { name: "processing"; publicId: string }

type UploadFailure = { message: string; signIn?: boolean }

// Error Catalog → inline copy. Anything else (a part that kept failing after
// the retries, the network) leaves the draft resumable.
function describeFailure(error: VideoUploadError): UploadFailure {
  if (error.status === 401) {
    return { message: "Your session has expired.", signIn: true }
  }
  switch (error.code) {
    case "FILE_TOO_LARGE":
      return { message: "This file is larger than the 10 GB upload limit." }
    case "UNSUPPORTED_MEDIA_TYPE":
      return { message: "Only video files can be uploaded." }
    case "RESUME_SIZE_MISMATCH":
      return { message: "This is not the file you started uploading. Select the same file to resume." }
    case "UPLOAD_EXPIRED":
    case "RESUME_PART_MISMATCH":
      return { message: "This upload can no longer be resumed. Discard it to start over." }
    default:
      return { message: `The upload was interrupted: ${error.message}` }
  }
}

/** `?resume=<public_id>&size=<bytes>` is what survives a reload (TD-04). */
function writeResumeParams(target: ResumeTarget | null) {
  const url = new URL(window.location.href)
  if (target) {
    url.searchParams.set("resume", target.publicId)
    url.searchParams.set("size", String(target.sizeBytes))
  } else {
    url.searchParams.delete("resume")
    url.searchParams.delete("size")
  }
  window.history.replaceState(null, "", url)
}

function UploadPanel({ resume = null }: { resume?: ResumeTarget | null }) {
  const [file, setFile] = React.useState<File | null>(null)
  const [draft, setDraft] = React.useState<ResumeTarget | null>(resume)
  const [phase, setPhase] = React.useState<Phase>({ name: "select" })
  const [failure, setFailure] = React.useState<UploadFailure | null>(null)
  const [inputKey, setInputKey] = React.useState(0)
  const [discarding, setDiscarding] = React.useState(false)
  const uploaderRef = React.useRef<VideoUploader | null>(null)

  React.useEffect(() => () => uploaderRef.current?.destroy(), [])

  function start() {
    if (!file) return
    uploaderRef.current?.destroy()
    const uploader = createVideoUploader(draft ? { resume: draft } : {})
    uploaderRef.current = uploader

    uploader.on("draft", (created) => {
      setDraft(created)
      writeResumeParams(created)
    })
    uploader.on("progress", (progress) => setPhase({ name: "uploading", progress }))
    uploader.on("complete", ({ publicId }) => {
      writeResumeParams(null)
      setDraft(null)
      setPhase({ name: "processing", publicId })
    })
    uploader.on("error", (error) => {
      setFailure(describeFailure(error))
      setPhase({ name: "select" })
    })

    try {
      uploader.addFile(file)
    } catch (error) {
      if (!(error instanceof VideoUploadError)) throw error
      setFailure(describeFailure(error))
      return
    }
    setFailure(null)
    setPhase({ name: "uploading", progress: null })
    void uploader.upload()
  }

  /** Back to an empty form with nothing left to resume. */
  function reset() {
    uploaderRef.current?.destroy()
    uploaderRef.current = null
    writeResumeParams(null)
    setDraft(null)
    setFile(null)
    setFailure(null)
    setPhase({ name: "select" })
    setInputKey((key) => key + 1)
  }

  function cancel() {
    uploaderRef.current?.cancel()
    reset()
  }

  async function discard() {
    if (!draft) return
    setDiscarding(true)
    try {
      const outcome = await discardUpload(draft.publicId)
      reset()
      if (outcome === "completed") {
        setPhase({ name: "processing", publicId: draft.publicId })
      }
    } catch (error) {
      if (!(error instanceof VideoUploadError)) throw error
      setFailure(
        error.status === 401
          ? describeFailure(error)
          : { message: `The upload could not be discarded: ${error.message}` }
      )
    } finally {
      setDiscarding(false)
    }
  }

  if (phase.name === "processing") {
    return <ProcessingStatus publicId={phase.publicId} />
  }

  const uploading = phase.name === "uploading"
  const progress = uploading ? phase.progress : null
  const percent = progress && progress.bytesTotal > 0
    ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
    : 0

  return (
    <div className="flex w-full flex-col gap-4" data-slot="upload-panel">
      {draft && !uploading && (
        <p className="text-body-md text-foreground" data-slot="resume-hint">
          An upload is waiting to be finished. Select the same file ({draft.sizeBytes.toLocaleString("en-US")} bytes) to resume it.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="video-file">Video file</Label>
        <Input
          key={inputKey}
          id="video-file"
          type="file"
          accept="video/*"
          disabled={uploading}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setFailure(null)
          }}
        />
      </div>

      {failure && (
        <div role="alert" className="flex flex-col gap-1 text-caption text-destructive" data-slot="form-error">
          <p>{failure.message}</p>
          {failure.signIn && (
            <Link
              href="/login"
              className="text-link hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-[var(--radius-0-5)]"
            >
              Sign in again
            </Link>
          )}
        </div>
      )}

      {uploading ? (
        <div className="flex flex-col gap-2">
          <progress
            aria-label="Upload progress"
            value={progress?.bytesUploaded ?? 0}
            max={progress?.bytesTotal || 1}
            className="h-2 w-full accent-primary"
          />
          <p className="text-body-md text-foreground" data-slot="upload-progress">
            {percent}% · {progress?.partsUploaded ?? 0}/{progress?.partCount ?? "–"} parts
          </p>
          <Button type="button" variant="outline" size="md" onClick={cancel} className="w-full">
            Cancel upload
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button type="button" size="md" disabled={!file || discarding} onClick={start} className="w-full">
            {draft ? "Resume upload" : "Start upload"}
          </Button>
          {draft && (
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={discarding}
              onClick={() => void discard()}
              className="w-full"
            >
              Discard upload
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export { UploadPanel }
