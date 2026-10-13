// MachGen provider adapter (REST API, https://api.machgen.ai). Same client surface as
// fal-platform.ts: submit / status / cancel. Request IDs are "machgen::<task_id>" so the
// router can send status and cancel calls back here.
//
// The MachGen key is server-side only (MACHGEN_API_KEY). Finished assets require the
// key to download, so playback goes through app/api/machgen/assets/[taskId] instead of
// exposing the raw asset URL to the browser.

import { PlatformError } from "./errors"
import type { GenerationStatus, QueuedGeneration } from "./platform"

export const MACHGEN_PREFIX = "machgen::"
const API_BASE = "https://api.machgen.ai/api/v0"
const TASK_ID = /^t-[A-Za-z0-9_-]+$/

export type MachgenClientOptions = {
  apiKey: string
  fetch?: typeof fetch
}

export function isMachgenRequestId(requestId: string): boolean {
  return requestId.startsWith(MACHGEN_PREFIX)
}

export function machgenAssetPath(taskId: string): string {
  return `/api/machgen/assets/${taskId}`
}

export function isMachgenTaskId(value: string): boolean {
  return TASK_ID.test(value)
}

export function createMachgenClient(options: MachgenClientOptions) {
  const fetchImpl = options.fetch ?? fetch
  const key = options.apiKey.trim()

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    console.info("[machgen] request", { method, path })
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await readJson(response)
    console.info("[machgen] response", { method, path, status: response.status })
    if (!response.ok) throw new PlatformError(response.status, payload)
    return payload
  }

  return {
    async submit(
      model: string,
      input: Record<string, unknown>
    ): Promise<QueuedGeneration> {
      const data = asRecord(
        await call("POST", "/generate", { ...input, model })
      )
      const taskId = stringField(data, "task_id")
      if (!taskId)
        throw new PlatformError(502, {
          detail: "MachGen response missing task_id",
        })
      return {
        status: "queued",
        requestId: `${MACHGEN_PREFIX}${taskId}`,
        statusUrl: "",
        cancelUrl: "",
      }
    },

    async status(requestId: string): Promise<GenerationStatus> {
      const taskId = taskIdFrom(requestId)
      const data = asRecord(await call("GET", `/tasks/${taskId}`))
      const state = stringField(data, "status") ?? ""

      if (state === "COMPLETED") {
        const output = asRecord(data.task_output)
        if (typeof output.video === "string") {
          return {
            status: "completed",
            requestId,
            video: { url: machgenAssetPath(taskId) },
          }
        }
        // Image outputs are not wired yet; report them rather than hide them.
        return {
          status: "failed",
          requestId,
          error: "MachGen returned an output type this studio does not show yet",
        }
      }
      if (state === "FAILED") {
        return {
          status: "failed",
          requestId,
          error: stringField(data, "error_msg") ?? "MachGen generation failed",
        }
      }
      if (state === "RUNNING") return { status: "in_progress", requestId }
      return { status: "queued", requestId }
    },

    /** Best effort: queued tasks stop and are refunded; running ones may finish. */
    async cancel(requestId: string): Promise<void> {
      const taskId = taskIdFrom(requestId)
      await call("POST", `/tasks/${taskId}/cancel`)
    },

    /** Streams the finished asset with the server-side key. */
    async fetchAsset(taskId: string): Promise<Response> {
      if (!isMachgenTaskId(taskId))
        throw new PlatformError(400, { detail: "Invalid task id" })
      const response = await fetchImpl(`${API_BASE}/assets/${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!response.ok)
        throw new PlatformError(response.status, await readJson(response))
      return response
    },
  }
}

function taskIdFrom(requestId: string): string {
  const id = requestId.startsWith(MACHGEN_PREFIX)
    ? requestId.slice(MACHGEN_PREFIX.length)
    : ""
  if (!isMachgenTaskId(id))
    throw new PlatformError(400, { detail: "Invalid MachGen request id" })
  return id
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
