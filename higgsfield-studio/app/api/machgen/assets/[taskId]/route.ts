import { NextResponse } from "next/server"

import { createMachgenClient, isMachgenTaskId } from "@/generation/machgen-platform"
import { PlatformError } from "@/generation/errors"

// Streams a finished MachGen asset with the server-side key, so the browser can play it
// without ever receiving the key or the authenticated asset URL.
export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const { taskId } = await context.params
  if (!isMachgenTaskId(taskId))
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 })

  const key = process.env.MACHGEN_API_KEY?.trim()
  if (!key)
    return NextResponse.json(
      { error: "MACHGEN_API_KEY is not set on the server." },
      { status: 503 }
    )

  try {
    const upstream = await createMachgenClient({ apiKey: key }).fetchAsset(taskId)
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (error) {
    const status = error instanceof PlatformError ? error.status : 502
    console.error("[machgen] asset fetch failed", { taskId, status })
    return NextResponse.json(
      { error: "Could not load this MachGen asset." },
      { status: status === 404 ? 404 : 502 }
    )
  }
}
