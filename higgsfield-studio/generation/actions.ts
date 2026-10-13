"use server"

import { cookies } from "next/headers"

import { getModel, parseSettings } from "./catalog"
import type { GenerationPlane } from "./catalog/types"
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials"
import { createFalClient } from "./fal-platform"
import { createMachgenClient, isMachgenRequestId } from "./machgen-platform"
import type { StatusResult } from "./platform"
import { toPlatform } from "./to-platform"

export async function savePlatformCredentials(data: unknown) {
  const { apiKey } = parseCredentialInput(data)
  const jar = await cookies()
  jar.set(
    PLATFORM_KEY_COOKIE,
    encodeCredentials(apiKey),
    PLATFORM_KEY_COOKIE_OPTIONS
  )
}

export async function clearPlatformCredentials() {
  const jar = await cookies()
  jar.set(PLATFORM_KEY_COOKIE, "", {
    ...PLATFORM_KEY_COOKIE_OPTIONS,
    maxAge: 0,
  })
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null
}

export async function submitGeneration(plane: GenerationPlane) {
  const model = getModel(plane.model)
  const parsed: GenerationPlane = {
    ...plane,
    settings: parseSettings(model, plane.settings),
  }
  const { path, body } = toPlatform(parsed)
  if (model.provider === "machgen")
    return createMachgenClient({ apiKey: readMachgenKey() }).submit(path, body)
  return createFalClient(await readCredentials()).submit(path, body)
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. Each id is routed to the backend that issued it. */
export async function getGenerationStatuses(
  data: unknown
): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data)
  const clients = await clientsFor(requestIds)
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await clients(requestId).status(requestId) }
      } catch (caught) {
        return {
          requestId,
          error: caught instanceof Error ? caught.message : String(caught),
        }
      }
    })
  )
}

export async function cancelGeneration(data: unknown) {
  const [requestId] = parseRequestIds(data)
  const clients = await clientsFor([requestId!])
  await clients(requestId!).cancel(requestId!)
}

async function clientsFor(requestIds: string[]) {
  const fal = requestIds.some((id) => !isMachgenRequestId(id))
    ? createFalClient(await readCredentials())
    : null
  const machgen = requestIds.some(isMachgenRequestId)
    ? createMachgenClient({ apiKey: readMachgenKey() })
    : null
  return (requestId: string) => {
    if (isMachgenRequestId(requestId)) {
      if (!machgen) throw new Error("MachGen is not configured for this request")
      return machgen
    }
    if (!fal) throw new Error("fal.ai is not configured for this request")
    return fal
  }
}

/** MachGen runs server-side on the operator's key; the browser never sees it. */
function readMachgenKey(): string {
  const key = process.env.MACHGEN_API_KEY?.trim()
  if (!key)
    throw new Error(
      "MachGen models need MACHGEN_API_KEY set in the server environment (.env.local)."
    )
  return key
}

async function readStoredCredentials() {
  const jar = await cookies()
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value)
}

async function readCredentials() {
  const stored = await readStoredCredentials()
  if (!stored) throw new MissingCredentialsError()
  return stored
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload")
  const requestIds = payload.requestIds
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids")
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId)
      throw new Error("Invalid request id")
    return requestId
  })
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new Error(message)
  return data as Record<string, unknown>
}
