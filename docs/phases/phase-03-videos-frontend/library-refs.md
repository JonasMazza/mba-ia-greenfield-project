---
libs:
  "@uppy/core":
    version: "^5.2.0"
    context7_id: "/websites/uppy_io"
    fetched_at: "2026-08-22T15:21:48-03:00"
  "@uppy/aws-s3":
    version: "^5.1.0"
    context7_id: "/websites/uppy_io"
    fetched_at: "2026-08-22T15:21:48-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos-frontend.md: "2026-08-22T15:16:51-03:00"
---

# Library References — phase-03-videos-frontend

Cache for the libraries introduced by `phase-03-videos-frontend/TD-02` (multipart upload client, Option A: `@uppy/aws-s3` used **headlessly**). Neither package is installed yet — versions above are the current npm `latest` at fetch time; `@uppy/react` (5.2.0) is optional and only needed for the `useUppyState` / `useUppyEvent` hooks.

## @uppy/core

Instantiate once and never re-instantiate on render. In React the load-bearing detail is the **initializer function** passed to `useState`:

```tsx
// IMPORTANT: initializer function prevents Uppy from being reinstantiated on every render.
const [uppy] = useState(() => new Uppy());

const files = useUppyState(uppy, (state) => state.files);
const totalProgress = useUppyState(uppy, (state) => state.totalProgress);
```

Event subscription from React:

```ts
const [results, clearResults] = useUppyEvent(uppy, 'upload-success');
useUppyEvent(uppy, 'cancel-all', clearResults);
```

`useUppyEvent(uppy, event, callback)` returns `[results, clearResults]`; values stay in state until the next event fires, so clear them explicitly when the surface resets.

**Headless usage.** Per _Building your own UI with Uppy_: instantiate the `Uppy` class, call methods on the instance, and hook into events — no Dashboard, no `@uppy/dashboard` CSS. This is exactly what TD-02 Option A specifies ("Uppy core + `@uppy/aws-s3`, this project's own React UI on top"). Uppy's own headless components expose `data-uppy-element` / `data-state` attributes for styling, but this slice supplies its own components instead.

## @uppy/aws-s3

Multipart mode. All five override hooks below must point at this slice's BFF Route Handlers under `app/api/videos/**` — **not** at Companion, whose signing endpoints are the default implementation. This is the "configuration rather than translation" property TD-02 relies on, and it is what keeps the strict-BFF partition intact (control plane through Next, byte path browser ⇄ MinIO).

### createMultipartUpload(file)

Calls the S3 Multipart API to create a new upload.

- **Params:** `file` — the file object from Uppy's state (`file.name`, `file.type`).
- **Returns:** `Promise<{ uploadId: string, key: string }>`.

### signPart(file, partData)

Generates a signed URL for one part. **This is the hook that implements TD-03 (sign one part at a time, on demand)** — it is Uppy's native cadence, so Option A of TD-03 is the default here rather than a customization.

```js
signPart(file, partData) {
  // partData: { uploadId, key, partNumber, body }
  // Returns a Promise for an object with url and optional headers
}
```

```json
{
  "url": "https://bucket.region.amazonaws.com/path/to/file.jpg?partNumber=1&...",
  "headers": { "Content-MD5": "foo" }
}
```

The returned `url` must be signed for a **browser-reachable host** — this is precisely the defect `TD-01` (Option A, dual endpoint) repairs. SigV4 signs the `host` header, so rewriting the host client-side yields `SignatureDoesNotMatch`.

### listParts(file, { uploadId, key })

Lists parts already uploaded.

- **Returns:** `Promise<Array<{ PartNumber: number, Size: number, ETag: string }>>`.

**This hook is the consumer of `TD-04` (Option B).** It maps one-to-one onto the new owner-scoped `GET /videos/:publicId/upload/parts` endpoint, which is why TD-04 Option B and TD-02 Option A compose without glue: resume becomes "call `listParts`, upload what is missing".

### completeMultipartUpload(file, { uploadId, key, parts })

- **Params:** `parts` — S3-style array of `{ ETag, PartNumber }`.
- **Returns:** `Promise<{ location?: string }>`.

### abortMultipartUpload(file, { uploadId, key })

Aborts the upload and removes uploaded parts; called on user cancellation. The result is ignored — cancellation cannot fail in Uppy.

### Gotchas carried over from `phase-03-videos/TD-03`

- **MinIO CORS must expose `ETag`** — otherwise `signPart`'s response is fine but the browser cannot read the ETag, and `completeMultipartUpload` receives an incomplete `parts` array.
- Per-part signed URLs are short-lived (~10 min) and must be re-fetchable — which the on-demand cadence gives for free.
- Part size ≥ 5MB except the last part.
- An abort endpoint plus a bucket lifecycle rule are required so cancelled 10GB uploads do not accumulate.
