// fal.ai provider adapter. Exposes the same client surface as createPlatformClient
// (platform.ts) so the studio's generation layer is unchanged: submit / status /
// cancel / createUpload. The API key is the user's own fal key.
//
// Request IDs handed to the UI are composite: "<endpoint>::<fal request id>".
// fal's status/cancel URLs are scoped by endpoint, so the endpoint has to travel
// with the id.

import { PlatformError } from "./errors"
import type { GenerationStatus, QueuedGeneration } from "./platform"
import { parseUploadTicket, requireUploadContentType } from "./upload-contract"
import type { UploadTicket } from "./upload-contract"

const QUEUE_BASE = "https://queue.fal.run"
const STORAGE_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate"
const SEPARATOR = "::"

export type FalClientOptions = {
  apiKey: string
  fetch?: typeof fetch
}

/** Catalog paths are Higgsfield-style ("kling-video/v2.5-turbo/standard/image-to-video");
    fal endpoint IDs are the same path under the "fal-ai/" namespace. */
export function falEndpointFor(path: string): string {
  return `fal-ai/${path.replace(/^\/+/, "")}`
}

function endpointPath(endpoint: string): string {
  return endpoint.split("/").map(encodeURIComponent).join("/")
}

function splitRequestId(composite: string): { endpoint: string; id: string } {
  const at = composite.lastIndexOf(SEPARATOR)
  if (at <= 0 || at === composite.length - SEPARATOR.length)
    throw new PlatformError(400, { detail: "Invalid request id" })
  return {
    endpoint: composite.slice(0, at),
    id: composite.slice(at + SEPARATOR.length),
  }
}

export function createFalClient(options: FalClientOptions) {
  const fetchImpl = options.fetch ?? fetch
  const key = options.apiKey.trim()
  const headers = { Authorization: `Key ${key}` }

  async function call(
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: unknown
  ): Promise<unknown> {
    // Never log headers (they carry the key) or signed upload URLs.
    console.info("[fal] request", { method, url: stripQuery(url) })
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await readJson(response)
    console.info("[fal] response", {
      method,
      status: response.status,
      url: stripQuery(url),
    })
    if (!response.ok) throw new PlatformError(response.status, payload)
    return payload
  }

  return {
    async createUpload(contentType: unknown): Promise<UploadTicket> {
      const type = requireUploadContentType(contentType)
      const payload = (await call(
        "POST",
        `${STORAGE_INITIATE}?storage_type=fal-cdn-v3`,
        { content_type: type, file_name: `upload.${extensionFor(type)}` }
      )) as Record<string, unknown>
      return parseUploadTicket(
        {
          upload_url: payload.upload_url,
          public_url: payload.file_url,
          content_type: type,
          upload_headers: { "content-type": type },
        },
        type
      )
    },

    async submit(
      path: string,
      input: Record<string, unknown>
    ): Promise<QueuedGeneration> {
      // Higgsfield-hosted models (higgsfield-ai/...) have no fal endpoint.
      if (path.startsWith("higgsfield-ai/"))
        throw new PlatformError(400, {
          detail: "This model is only available on Higgsfield. Pick a fal.ai model.",
        })
      const endpoint = falEndpointFor(path)
      const data = asRecord(
        await call("POST", `${QUEUE_BASE}/${endpointPath(endpoint)}`, input)
      )
      const requestId = stringField(data, "request_id")
      if (!requestId)
        throw new PlatformError(502, {
          detail: "fal response missing request_id",
        })
      return {
        status: "queued",
        requestId: `${endpoint}${SEPARATOR}${requestId}`,
        statusUrl: stringField(data, "status_url") ?? "",
        cancelUrl: stringField(data, "cancel_url") ?? "",
      }
    },

    async status(composite: string): Promise<GenerationStatus> {
      const { endpoint, id } = splitRequestId(composite)
      const base = `${QUEUE_BASE}/${endpointPath(endpoint)}/requests/${encodeURIComponent(id)}`
      const state = asRecord(await call("GET", `${base}/status`))
      const raw = stringField(state, "status") ?? ""

      if (raw === "COMPLETED") {
        if (state.error) {
          return {
            status: "failed",
            requestId: composite,
            error: state.error,
          }
        }
        const output = asRecord(await call("GET", base))
        return { ...mapOutput(output), status: "completed", requestId: composite }
      }
      if (raw === "IN_PROGRESS") {
        return { status: "in_progress", requestId: composite }
      }
      if (raw === "IN_QUEUE") {
        return { status: "queued", requestId: composite }
      }
      return { status: "unknown", requestId: composite }
    },

    /** fal removes a queued request immediately; a running one may still finish. */
    async cancel(composite: string): Promise<void> {
      const { endpoint, id } = splitRequestId(composite)
      await call(
        "PUT",
        `${QUEUE_BASE}/${endpointPath(endpoint)}/requests/${encodeURIComponent(id)}/cancel`
      )
    },
  }
}

/** Fold fal's model-specific output into the shape the UI reads. */
function mapOutput(output: Record<string, unknown>): Partial<GenerationStatus> {
  const video = asRecord(output.video).url
  const images = Array.isArray(output.images)
    ? output.images.flatMap((item) => {
        const url = asRecord(item).url
        return typeof url === "string" ? [{ url }] : []
      })
    : []
  return {
    ...(typeof video === "string" ? { video: { url: video } } : {}),
    ...(images.length ? { images } : {}),
  }
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "video/mp4": "mp4",
  }
  return map[contentType] ?? "bin"
}

function stripQuery(url: string): string {
  return url.split("?")[0] ?? url
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
