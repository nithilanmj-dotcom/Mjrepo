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

const { createFalClient, falEndpointFor } = await import("../generation/fal-platform.ts");

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

test("catalog paths map to fal-ai endpoint IDs", () => {
  assert.equal(
    falEndpointFor("kling-video/v2.5-turbo/standard/image-to-video"),
    "fal-ai/kling-video/v2.5-turbo/standard/image-to-video"
  );
});

test("submit uses the user's key and returns a composite request id", async () => {
  const { fn, calls } = fakeFetch([
    { match: "POST queue.fal.run/fal-ai/kling-video/v2.5-turbo/standard/image-to-video", body: { request_id: "r1" } },
  ]);
  const client = createFalClient({ apiKey: " fal_test ", fetch: fn });
  const queued = await client.submit("kling-video/v2.5-turbo/standard/image-to-video", { prompt: "hi" });
  assert.equal(queued.requestId, "fal-ai/kling-video/v2.5-turbo/standard/image-to-video::r1");
  assert.equal(calls[0].init.headers.Authorization, "Key fal_test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: "hi" });
});

test("status walks queue -> completed and maps the video output", async () => {
  const base = "fal-ai/kling-video/v2.5-turbo/standard/image-to-video::r1";
  const { fn } = fakeFetch([
    { match: "GET queue.fal.run/fal-ai/kling-video/v2.5-turbo/standard/image-to-video/requests/r1/status", body: { status: "IN_PROGRESS" } },
    { match: "GET queue.fal.run/fal-ai/kling-video/v2.5-turbo/standard/image-to-video/requests/r1", body: { video: { url: "https://v3.fal.media/x.mp4" } } },
  ]);
  const client = createFalClient({ apiKey: "k", fetch: fn });
  assert.equal((await client.status(base)).status, "in_progress");
  // Completed status route is hit only once the status says COMPLETED.
  const done = createFalClient({
    apiKey: "k",
    fetch: fakeFetch([
      { match: "/requests/r1/status", body: { status: "COMPLETED" } },
      { match: "/requests/r1", body: { video: { url: "https://v3.fal.media/x.mp4" } } },
    ]).fn,
  });
  const s = await done.status(base);
  assert.equal(s.status, "completed");
  assert.deepEqual(s.video, { url: "https://v3.fal.media/x.mp4" });
});

test("cancel uses PUT on the cancel route", async () => {
  const { fn, calls } = fakeFetch([
    { match: "/requests/r1/cancel", body: { status: "CANCELLATION_REQUESTED" }, status: 202 },
  ]);
  const client = createFalClient({ apiKey: "k", fetch: fn });
  await client.cancel("fal-ai/x/y::r1");
  assert.equal(calls[0].method, "PUT");
});

test("higgsfield-only models are rejected with a clear message", async () => {
  const client = createFalClient({ apiKey: "k", fetch: fakeFetch([]).fn });
  await assert.rejects(
    () => client.submit("higgsfield-ai/soul/cinema", {}),
    /only available on Higgsfield/
  );
});

test("upload tickets come from fal storage and are validated", async () => {
  const { fn } = fakeFetch([
    { match: "POST rest.alpha.fal.ai/storage/upload/initiate", body: { upload_url: "https://storage.fal.media/put", file_url: "https://v3.fal.media/f.png" } },
  ]);
  const client = createFalClient({ apiKey: "k", fetch: fn });
  const ticket = await client.createUpload("image/png");
  assert.equal(ticket.upload_url, "https://storage.fal.media/put");
  assert.equal(ticket.public_url, "https://v3.fal.media/f.png");
  assert.equal(ticket.upload_headers["content-type"], "image/png");
});
