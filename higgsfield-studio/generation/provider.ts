// Chooses the generation backend. The studio talks to fal.ai with the user's own
// key; the Higgsfield platform client (platform.ts) stays in the tree for reference.

import { createFalClient } from "./fal-platform"

export type VideoCredentials = { apiKey: string }

export function createVideoClient(credentials: VideoCredentials) {
  return createFalClient({ apiKey: credentials.apiKey })
}

export type VideoClient = ReturnType<typeof createVideoClient>
