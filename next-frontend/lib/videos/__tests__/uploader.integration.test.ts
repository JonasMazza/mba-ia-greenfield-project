// @vitest-environment jsdom
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cookieMap,
  ctx,
  signIn,
  type RouteHandler,
} from "@/app/api/videos/[publicId]/__tests__/session-harness";
import {
  createVideoUploader,
  VideoUploadError,
  type VideoUploader,
  type VideoUploaderEvents,
} from "@/lib/videos/uploader";
import { FIXTURE_PART_SIZE_BYTES, FIXTURE_PUBLIC_ID } from "@/mocks/factories/videos";
import { RESUMABLE_PUBLIC_ID, TOO_LARGE_FILENAME } from "@/mocks/handlers/videos";
import { server } from "@/mocks/server";
import { STORAGE_ORIGIN } from "@/mocks/storage-origin";

/** Two full parts plus a 1 KiB tail — three parts at the fixture part size. */
const THREE_PART_SIZE = 2 * FIXTURE_PART_SIZE_BYTES + 1024;

type BffCall = { method: string; path: string; body?: unknown };

let createDraft: (request: Request) => Promise<Response>;
let signParts: RouteHandler;
let listParts: RouteHandler;
let completeUpload: RouteHandler;
let abortUpload: RouteHandler;

beforeAll(async () => {
  ({ POST: createDraft } = await import("@/app/api/videos/route"));
  ({ POST: signParts, GET: listParts } = await import(
    "@/app/api/videos/[publicId]/upload/parts/route"
  ));
  ({ POST: completeUpload } = await import("@/app/api/videos/[publicId]/upload/complete/route"));
  ({ DELETE: abortUpload } = await import("@/app/api/videos/[publicId]/upload/route"));
});

let bffCalls: BffCall[];
let storagePuts: URL[];

const recordStoragePut = ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  if (request.method === "PUT" && url.origin === STORAGE_ORIGIN) storagePuts.push(url);
};

/**
 * The control plane runs for real: each `/api/videos/**` request the uploader
 * makes is handed to the actual Route Handler, whose upstream call is answered
 * by the shared `mocks/handlers/videos.ts` fixture. Part `PUT`s land on the
 * storage fake (`mocks/handlers/storage.ts`).
 */
function bridge(method: "get" | "post" | "delete", path: string, route: RouteHandler) {
  return http[method](path, async ({ request, params }) => {
    const body = request.method === "POST" ? await request.clone().json() : undefined;
    bffCalls.push({ method: request.method, path: new URL(request.url).pathname, body });
    return route(request, ctx(String(params.publicId)));
  });
}

beforeEach(async () => {
  bffCalls = [];
  storagePuts = [];
  cookieMap.clear();
  await signIn();
  server.events.on("request:start", recordStoragePut);
  server.use(
    bridge("post", "/api/videos", (request) => createDraft(request)),
    bridge("post", "/api/videos/:publicId/upload/parts", (request, context) =>
      signParts(request, context)
    ),
    bridge("get", "/api/videos/:publicId/upload/parts", (request, context) =>
      listParts(request, context)
    ),
    bridge("post", "/api/videos/:publicId/upload/complete", (request, context) =>
      completeUpload(request, context)
    ),
    bridge("delete", "/api/videos/:publicId/upload", (request, context) =>
      abortUpload(request, context)
    )
  );
});

afterEach(() => {
  server.events.removeListener("request:start", recordStoragePut);
});

function videoFile(size: number, name = "clip.mp4") {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

function capture(uploader: VideoUploader) {
  const seen: { [E in keyof VideoUploaderEvents]: VideoUploaderEvents[E][] } = {
    draft: [],
    progress: [],
    complete: [],
    error: [],
  };
  uploader.on("draft", (payload) => seen.draft.push(payload));
  uploader.on("progress", (payload) => seen.progress.push(payload));
  uploader.on("complete", (payload) => seen.complete.push(payload));
  uploader.on("error", (payload) => seen.error.push(payload));
  return seen;
}

const callsTo = (method: string, suffix: string) =>
  bffCalls.filter((call) => call.method === method && call.path.endsWith(suffix));

const putPartNumbers = () =>
  storagePuts.map((url) => Number(url.searchParams.get("partNumber"))).sort();

describe("createVideoUploader — multipart over the BFF", () => {
  it("uploads 3 parts: one draft, one signature per part, 3 PUTs and a complete with the storage ETags in order", async () => {
    const uploader = createVideoUploader({ partSizeBytes: FIXTURE_PART_SIZE_BYTES });
    const seen = capture(uploader);

    uploader.addFile(videoFile(THREE_PART_SIZE));
    await uploader.upload();

    expect(seen.error).toEqual([]);
    expect(callsTo("POST", "/api/videos")).toEqual([
      {
        method: "POST",
        path: "/api/videos",
        body: {
          filename: "clip.mp4",
          content_type: "video/mp4",
          size_bytes: THREE_PART_SIZE,
          part_size_bytes: FIXTURE_PART_SIZE_BYTES,
        },
      },
    ]);
    expect(seen.draft).toEqual([{ publicId: FIXTURE_PUBLIC_ID, sizeBytes: THREE_PART_SIZE }]);

    const signatures = callsTo("POST", "/upload/parts");
    expect(signatures).toHaveLength(3);
    // TD-03: never more than one part per signature request.
    const signed = signatures.map((call) => (call.body as { part_numbers: number[] }).part_numbers);
    signed.forEach((partNumbers) => expect(partNumbers).toHaveLength(1));
    expect(signed.flat().sort()).toEqual([1, 2, 3]);

    expect(putPartNumbers()).toEqual([1, 2, 3]);
    expect(callsTo("GET", "/upload/parts")).toEqual([]);

    expect(callsTo("POST", "/upload/complete")).toEqual([
      {
        method: "POST",
        path: `/api/videos/${FIXTURE_PUBLIC_ID}/upload/complete`,
        body: {
          parts: [
            { part_number: 1, etag: '"etag-1"' },
            { part_number: 2, etag: '"etag-2"' },
            { part_number: 3, etag: '"etag-3"' },
          ],
        },
      },
    ]);
    expect(seen.complete).toEqual([{ publicId: FIXTURE_PUBLIC_ID }]);
    expect(seen.progress.at(-1)).toEqual({
      bytesUploaded: THREE_PART_SIZE,
      bytesTotal: THREE_PART_SIZE,
      partsUploaded: 3,
      partCount: 3,
    });
  });

  it("cancel() during the upload aborts the multipart and never completes it", async () => {
    // The PUT never answers: MSW's XHR interceptor would deliver a late response
    // even to an aborted request, which no real browser does.
    const putStarted = new Promise<void>((resolve) => {
      server.use(
        http.put(`${STORAGE_ORIGIN}/*`, async () => {
          resolve();
          await new Promise<never>(() => {});
          return new HttpResponse(null, { status: 200 });
        })
      );
    });
    const uploader = createVideoUploader({ partSizeBytes: FIXTURE_PART_SIZE_BYTES });
    const seen = capture(uploader);

    uploader.addFile(videoFile(THREE_PART_SIZE));
    const uploading = uploader.upload();
    await putStarted;
    uploader.cancel();
    await uploading;

    await vi.waitFor(() =>
      expect(callsTo("DELETE", "/upload")).toEqual([
        { method: "DELETE", path: `/api/videos/${FIXTURE_PUBLIC_ID}/upload`, body: undefined },
      ])
    );
    expect(callsTo("POST", "/upload/complete")).toEqual([]);
    expect(seen.complete).toEqual([]);
    expect(seen.error).toEqual([]);
  });

  it("resumes from listParts: signs and PUTs only the missing parts, completes with all three", async () => {
    const uploader = createVideoUploader({
      partSizeBytes: FIXTURE_PART_SIZE_BYTES,
      resume: { publicId: RESUMABLE_PUBLIC_ID, sizeBytes: THREE_PART_SIZE },
    });
    const seen = capture(uploader);

    uploader.addFile(videoFile(THREE_PART_SIZE));
    await uploader.upload();

    expect(seen.error).toEqual([]);
    expect(callsTo("POST", "/api/videos")).toEqual([]);
    expect(seen.draft).toEqual([]);
    expect(callsTo("GET", "/upload/parts")).toHaveLength(1);

    const signed = callsTo("POST", "/upload/parts").flatMap(
      (call) => (call.body as { part_numbers: number[] }).part_numbers
    );
    expect(signed.sort()).toEqual([2, 3]);
    expect(putPartNumbers()).toEqual([2, 3]);

    expect(callsTo("POST", "/upload/complete").map((call) => call.body)).toEqual([
      {
        parts: [
          { part_number: 1, etag: '"etag-1"' },
          { part_number: 2, etag: '"etag-2"' },
          { part_number: 3, etag: '"etag-3"' },
        ],
      },
    ]);
    expect(seen.complete).toEqual([{ publicId: RESUMABLE_PUBLIC_ID }]);
  });

  it("rejects a re-selected file whose size differs from the draft before any request", () => {
    const uploader = createVideoUploader({
      partSizeBytes: FIXTURE_PART_SIZE_BYTES,
      resume: { publicId: RESUMABLE_PUBLIC_ID, sizeBytes: THREE_PART_SIZE },
    });

    expect(() => uploader.addFile(videoFile(THREE_PART_SIZE - 1))).toThrow(
      expect.objectContaining({ name: "VideoUploadError", code: "RESUME_SIZE_MISMATCH" })
    );
    expect(bffCalls).toEqual([]);
    expect(storagePuts).toEqual([]);
  });

  it("surfaces a BFF error envelope as an error event with its status and code, before any PUT", async () => {
    const uploader = createVideoUploader({ partSizeBytes: FIXTURE_PART_SIZE_BYTES });
    const seen = capture(uploader);

    uploader.addFile(videoFile(1024, TOO_LARGE_FILENAME));
    await uploader.upload();

    expect(seen.error).toHaveLength(1);
    expect(seen.error[0]).toBeInstanceOf(VideoUploadError);
    expect(seen.error[0]).toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    expect(storagePuts).toEqual([]);
    expect(callsTo("POST", "/upload/parts")).toEqual([]);
    expect(seen.complete).toEqual([]);
  });
});
