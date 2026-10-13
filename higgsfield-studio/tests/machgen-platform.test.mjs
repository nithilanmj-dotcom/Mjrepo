import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Match the extensionless TypeScript imports accepted by Next.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const { createMachgenClient, isMachgenRequestId } = await import("../generation/machgen-platform.ts");
const { default: wan } = await import("../generation/catalog/models/machgen-wan-2.2.ts");

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", init });
    const key = `${init.method ?? "GET"} ${String(url).split("?")[0].replace(/^https?:\/\//, "")}`;
    const hit = routes.find((r) => key.endsWith(r.match));
    if (!hit) return new Response(JSON.stringify({ detail: "no route" }), { status: 404 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

test("submit posts model + task body with Bearer auth and returns a machgen id", async () => {
  const { fn, calls } = fakeFetch([{ match: "POST api.machgen.ai/api/v0/generate", body: { task_id: "t-abc123" } }]);
  const client = createMachgenClient({ apiKey: "MGA_x:y", fetch: fn });
  const queued = await client.submit("Wan2.2-A14B", { task_type: "T2V", prompt: "hi" });
  assert.equal(queued.requestId, "machgen::t-abc123");
  assert.equal(calls[0].init.headers.Authorization, "Bearer MGA_x:y");
  assert.deepEqual(JSON.parse(calls[0].init.body), { task_type: "T2V", prompt: "hi", model: "Wan2.2-A14B" });
});

test("status maps RUNNING, COMPLETED (to the key-gated proxy) and FAILED", async () => {
  const running = createMachgenClient({ apiKey: "k", fetch: fakeFetch([{ match: "/tasks/t-abc123", body: { status: "RUNNING" } }]).fn });
  assert.equal((await running.status("machgen::t-abc123")).status, "in_progress");

  const done = createMachgenClient({
    apiKey: "k",
    fetch: fakeFetch([{ match: "/tasks/t-abc123", body: { status: "COMPLETED", task_output: { video: "https://api.machgen.ai/api/v0/assets/t-abc123" } } }]).fn,
  });
  const s = await done.status("machgen::t-abc123");
  assert.equal(s.status, "completed");
  assert.deepEqual(s.video, { url: "/api/machgen/assets/t-abc123" });

  const failed = createMachgenClient({
    apiKey: "k",
    fetch: fakeFetch([{ match: "/tasks/t-abc123", body: { status: "FAILED", error_msg: "boom" } }]).fn,
  });
  assert.deepEqual(await failed.status("machgen::t-abc123"), { status: "failed", requestId: "machgen::t-abc123", error: "boom" });
});

test("cancel posts to the task cancel route", async () => {
  const { fn, calls } = fakeFetch([{ match: "/tasks/t-abc123/cancel", body: { status: "FAILED" } }]);
  await createMachgenClient({ apiKey: "k", fetch: fn }).cancel("machgen::t-abc123");
  assert.equal(calls[0].method, "POST");
});

test("malformed task ids never reach the network", async () => {
  const { fn, calls } = fakeFetch([]);
  const client = createMachgenClient({ apiKey: "k", fetch: fn });
  await assert.rejects(() => client.status("machgen::../../x"), /Invalid MachGen request id/);
  await assert.rejects(() => client.fetchAsset("../x"), /Invalid task id/);
  assert.equal(calls.length, 0);
});

test("routing recognises machgen ids only", () => {
  assert.equal(isMachgenRequestId("machgen::t-1"), true);
  assert.equal(isMachgenRequestId("fal-ai/kling-video/x::abc"), false);
});

test("Wan 2.2 maps resolution to height and only documented values", () => {
  const plane = (resolution) => ({ model: "machgen-wan-2.2", prompt: { text: "a fox" }, media: {}, settings: { aspectRatio: "16:9", resolution } });
  const r720 = wan.toPlatform(plane("720p"));
  assert.equal(r720.path, "Wan2.2-A14B");
  assert.equal(r720.body.task_type, "T2V");
  assert.equal(r720.body.video_config.height, 720);
  assert.equal(r720.body.video_config.duration_secs, 5);
  assert.equal(wan.toPlatform(plane("480p")).body.video_config.height, 480);
  assert.equal(wan.provider, "machgen");
});
