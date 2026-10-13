import type { ModelEntry } from "../types"

// MachGen-hosted Wan 2.2 (T2V). Values are the ones MachGen's docs show for this
// model: heights 480 and 720, 16:9, and 5-second clips. Other values are rejected by
// MachGen with HTTP 400, so they are not offered here.
const machgenWan22: ModelEntry = {
  id: "machgen-wan-2.2",
  surface: "video",
  label: "Wan 2.2 (MachGen)",
  provider: "machgen",
  roles: {},
  requirePrompt: true,
  settings: {
    aspectRatio: { type: "enum", values: ["16:9"], default: "16:9" },
    resolution: { type: "enum", values: ["480p", "720p"], default: "720p" },
  },
  toPlatform: (plane) => ({
    path: "Wan2.2-A14B",
    body: {
      task_type: "T2V",
      prompt: plane.prompt.text,
      video_config: {
        duration_secs: 5,
        height: plane.settings.resolution === "480p" ? 480 : 720,
        aspect_ratio: "16:9",
        fps: 16,
        infer_steps: 30,
      },
    },
  }),
  order: 70,
}

export default machgenWan22
