export class PlatformError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(messageFromBody(status, body))
    this.name = "PlatformError"
    this.status = status
    this.body = body
  }
}

function messageFromBody(status: number, body: unknown): string {
  const detail =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).detail
      : undefined
  if (typeof detail === "string" && detail) return detail
  return `Platform request failed (${status})`
}
