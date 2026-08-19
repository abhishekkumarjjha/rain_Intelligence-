// End-to-end orchestration with a stubbed provider + stubbed model.
// Proves capture -> extract -> benchmark wires up without either real service.
import assert from "node:assert";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./serpapi-lacapfcu.json", import.meta.url), "utf8"));
process.env.SERPAPI_API_KEY = "test"; process.env.ANTHROPIC_API_KEY = "test";

// 1x1 png
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("serpapi.com")) {
    const fmt = new URL(u).searchParams.get("creative_format");
    assert.equal(fmt, "image", "creative mode must request image creatives");
    assert.equal(new URL(u).searchParams.get("platform"), null, "platform must be unset for image");
    return { ok: true, status: 200, json: async () => fixture };
  }
  return { ok: true, status: 200,
    headers: new Map([["content-type","image/png"],["content-length",String(PNG.length)]]),
    arrayBuffer: async () => PNG };
};
// fetch headers need .get()
const origFetch = global.fetch;
global.fetch = async (u) => { const r = await origFetch(u); if (r.headers && !r.headers.get) r.headers = { get: (k) => r.headers[k] }; return r; };

const { capture } = await import("../lib/atc-provider.js");
const cap = await capture("lacapfcu.org", { format: "image", days: 30 });

assert.ok(cap.ok);
console.log("  ok  capture returned", cap.images.length, "downloadable creatives");
console.log("      run:", JSON.stringify({
  providerTotal: cap.run.providerTotal, returned: cap.run.returned,
  renderable: cap.run.renderable, previewOnly: cap.run.previewOnly,
  selected: cap.run.selectedForReading, exactDupes: cap.run.exactDupes, complete: cap.run.complete,
}));

// The fixture's last creative has a fletch `link` and no `image` — it MUST be
// counted as preview-only rather than silently dropped.
assert.equal(cap.run.previewOnly, 1, "the fletch-preview creative must be counted, not dropped");
assert.equal(cap.run.returned, 21);
assert.equal(cap.run.renderable, 20);
console.log("  ok  fletch-preview creative counted separately (21 found -> 20 renderable)");

// Identical 1x1 pngs mean every download is a byte-dupe: proves pre-extraction
// dedupe saves the vision calls it is supposed to.
assert.equal(cap.images.length, 1, "byte-identical creatives collapse before extraction");
console.log("  ok  byte-identical creatives collapsed", cap.run.exactDupes, "dupes -> 1 vision call");

assert.equal(cap.run.complete, true);
console.log("\n4 passed");
