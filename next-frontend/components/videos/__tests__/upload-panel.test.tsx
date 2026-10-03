// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { UploadPanel } from "@/components/videos/upload-panel"
import type {
  ApiErrorEnvelope,
  InitiateUploadDto,
  PresignPartsDto,
  VideoStatusResponse,
} from "@/lib/api/contracts"
import {
  FIXTURE_PUBLIC_ID,
  buildInitiateUploadResponse,
  buildPresignedPart,
} from "@/mocks/factories/videos"
import { RESUMABLE_PUBLIC_ID, TOO_LARGE_FILENAME } from "@/mocks/handlers/videos"
import { server } from "@/mocks/server"
import { STORAGE_ORIGIN } from "@/mocks/storage-origin"

type BffCall = { method: string; path: string; body?: unknown }

let bffCalls: BffCall[]
let storagePuts: number

const recordStoragePut = ({ request }: { request: Request }) => {
  if (request.method === "PUT" && new URL(request.url).origin === STORAGE_ORIGIN) storagePuts += 1
}

function envelope(statusCode: number, error: string, message: string): ApiErrorEnvelope {
  return { statusCode, error, message, code: null }
}

async function record(request: Request) {
  const body = request.method === "POST" ? await request.clone().json() : undefined
  bffCalls.push({ method: request.method, path: new URL(request.url).pathname, body })
}

const callsTo = (method: string, suffix: string) =>
  bffCalls.filter((call) => call.method === method && call.path.endsWith(suffix))

// Control plane faked at the BFF boundary the panel talks to; part PUTs reach
// the shared storage fake (`mocks/handlers/storage.ts`).
beforeEach(() => {
  bffCalls = []
  storagePuts = 0
  server.events.on("request:start", recordStoragePut)
  server.use(
    http.post("/api/videos", async ({ request }) => {
      await record(request)
      const body = (await request.json()) as InitiateUploadDto
      if (body.filename === TOO_LARGE_FILENAME) {
        return HttpResponse.json(envelope(413, "FILE_TOO_LARGE", "File exceeds the maximum upload size"), {
          status: 413,
        })
      }
      return HttpResponse.json(
        buildInitiateUploadResponse({ part_size_bytes: body.part_size_bytes, part_count: 1 }),
        { status: 201 }
      )
    }),
    http.post("/api/videos/:publicId/upload/parts", async ({ request, params }) => {
      await record(request)
      const { part_numbers } = (await request.json()) as PresignPartsDto
      return HttpResponse.json({
        parts: part_numbers.map((partNumber) => buildPresignedPart(String(params.publicId), partNumber)),
        expires_in: 600,
      })
    }),
    http.get("/api/videos/:publicId/upload/parts", async ({ request }) => {
      await record(request)
      return HttpResponse.json({ parts: [] })
    }),
    http.post("/api/videos/:publicId/upload/complete", async ({ request, params }) => {
      await record(request)
      return HttpResponse.json({ public_id: String(params.publicId), status: "processing" })
    }),
    http.delete("/api/videos/:publicId/upload", async ({ request }) => {
      await record(request)
      return new HttpResponse(null, { status: 204 })
    }),
    http.get("/api/videos/:publicId/status", ({ params }) =>
      HttpResponse.json<VideoStatusResponse>({ public_id: String(params.publicId), status: "processing" })
    )
  )
})

afterEach(() => {
  server.events.removeListener("request:start", recordStoragePut)
  vi.restoreAllMocks()
})

function videoFile(size = 1024, name = "clip.mp4") {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" })
}

describe("<UploadPanel />", () => {
  it("enables the start button only once a file is selected", async () => {
    const user = userEvent.setup()
    render(<UploadPanel />)

    const start = screen.getByRole("button", { name: "Start upload" })
    expect(start).toBeDisabled()

    await user.upload(screen.getByLabelText("Video file"), videoFile())
    expect(start).toBeEnabled()
  })

  it("uploads a 1-part file, records ?resume while it runs and switches to processing", async () => {
    const user = userEvent.setup()
    const replaceState = vi.spyOn(window.history, "replaceState")
    render(<UploadPanel />)

    await user.upload(screen.getByLabelText("Video file"), videoFile(1024))
    await user.click(screen.getByRole("button", { name: "Start upload" }))

    expect(await screen.findByText("Processing your video…")).toBeInTheDocument()
    expect(callsTo("POST", "/api/videos")).toHaveLength(1)
    expect(callsTo("POST", "/upload/parts").map((call) => call.body)).toEqual([{ part_numbers: [1] }])
    expect(storagePuts).toBe(1)
    expect(callsTo("POST", "/upload/complete")).toHaveLength(1)

    const urls = replaceState.mock.calls.map(([, , url]) => new URL(String(url)))
    expect(urls[0].searchParams.get("resume")).toBe(FIXTURE_PUBLIC_ID)
    expect(urls[0].searchParams.get("size")).toBe("1024")
    // Once complete there is nothing left to resume.
    expect(urls.at(-1)?.searchParams.has("resume")).toBe(false)
  })

  it("cancel aborts the multipart and returns to the initial state", async () => {
    const user = userEvent.setup()
    // The PUT never answers, so the upload is still running when cancel lands.
    let putStarted = false
    server.use(
      http.put(`${STORAGE_ORIGIN}/*`, async () => {
        putStarted = true
        await new Promise<never>(() => {})
        return new HttpResponse(null, { status: 200 })
      })
    )
    render(<UploadPanel />)

    await user.upload(screen.getByLabelText("Video file"), videoFile())
    await user.click(screen.getByRole("button", { name: "Start upload" }))
    await waitFor(() => expect(putStarted).toBe(true))
    await user.click(screen.getByRole("button", { name: "Cancel upload" }))

    await waitFor(() =>
      expect(callsTo("DELETE", "/upload")).toEqual([
        { method: "DELETE", path: `/api/videos/${FIXTURE_PUBLIC_ID}/upload`, body: undefined },
      ])
    )
    expect(callsTo("POST", "/upload/complete")).toEqual([])
    expect(screen.getByRole("button", { name: "Start upload" })).toBeDisabled()
    expect((screen.getByLabelText("Video file") as HTMLInputElement).files).toHaveLength(0)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows the 413 inline without any PUT to the storage", async () => {
    const user = userEvent.setup()
    render(<UploadPanel />)

    await user.upload(screen.getByLabelText("Video file"), videoFile(1024, TOO_LARGE_FILENAME))
    await user.click(screen.getByRole("button", { name: "Start upload" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("larger than the 10 GB upload limit")
    expect(storagePuts).toBe(0)
    expect(screen.getByRole("button", { name: "Start upload" })).toBeEnabled()
  })

  it("shows the 415 inline", async () => {
    const user = userEvent.setup()
    server.use(
      http.post("/api/videos", () =>
        HttpResponse.json(envelope(415, "UNSUPPORTED_MEDIA_TYPE", "Not a supported video type"), {
          status: 415,
        })
      )
    )
    render(<UploadPanel />)

    await user.upload(screen.getByLabelText("Video file"), videoFile())
    await user.click(screen.getByRole("button", { name: "Start upload" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Only video files can be uploaded")
    expect(storagePuts).toBe(0)
  })

  it("links to /login when the session has expired", async () => {
    const user = userEvent.setup()
    server.use(
      http.post("/api/videos", () =>
        HttpResponse.json(envelope(401, "UNAUTHORIZED", "Not authenticated"), { status: 401 })
      )
    )
    render(<UploadPanel />)

    await user.upload(screen.getByLabelText("Video file"), videoFile())
    await user.click(screen.getByRole("button", { name: "Start upload" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Your session has expired")
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login")
  })

  it("resumes a draft from ?resume: lists the stored parts instead of creating a new draft", async () => {
    const user = userEvent.setup()
    render(<UploadPanel resume={{ publicId: RESUMABLE_PUBLIC_ID, sizeBytes: 1024 }} />)

    expect(screen.getByText(/Select the same file/)).toBeInTheDocument()
    await user.upload(screen.getByLabelText("Video file"), videoFile(1024))
    await user.click(screen.getByRole("button", { name: "Resume upload" }))

    expect(await screen.findByText("Processing your video…")).toBeInTheDocument()
    expect(callsTo("POST", "/api/videos")).toEqual([])
    expect(callsTo("GET", `/api/videos/${RESUMABLE_PUBLIC_ID}/upload/parts`)).toHaveLength(1)
    expect(callsTo("POST", "/upload/complete")).toHaveLength(1)
  })

  it("rejects a re-selected file of another size before any request", async () => {
    const user = userEvent.setup()
    render(<UploadPanel resume={{ publicId: RESUMABLE_PUBLIC_ID, sizeBytes: 1024 }} />)

    await user.upload(screen.getByLabelText("Video file"), videoFile(2048))
    await user.click(screen.getByRole("button", { name: "Resume upload" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("not the file you started uploading")
    expect(bffCalls).toEqual([])
    expect(storagePuts).toBe(0)
  })
})
