// =============================================================================
// test/degraded.test.js — the paths that decide whether a bad day looks like a
// bad day or looks like a broken product.
//
// Every case here ends with the user being told something true and specific.
// "Nothing happened" is the failure mode this file exists to prevent.
// =============================================================================

import { startServer, check, section, summary, eq, ok } from "./harness.js";

const COMPETITORS = [
  { label: "Campus Federal", domain: "campusfederal.org" },
  { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
];

async function runWith(env, competitors = COMPETITORS) {
  const S = await startServer(env);
  try {
    const { body: started } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", product: "checking", days: 30, competitors,
    });
    if (!started.ok) return { started, run: null, S };
    const run = await S.awaitRun(started.runId);
    return { started, run, S };
  } finally { S.stop(); }
}

// ------------------------------------------------------------ provider quota
section("provider quota exhausted");
{
  const { run } = await runWith({ RI_MOCK_FAIL: "quota" });
  await check("the run still completes rather than hanging", () => eq(run.status, "done", "status"));
  await check("every target reports the quota reason, not a generic failure", () => {
    for (const [domain, p] of Object.entries(run.progress)) {
      eq(p.status, "failed", `${domain} status`);
      eq(p.reason, "quota", `${domain} reason`);
    }
  });
  await check("no ads are invented to fill the gap", () => eq(run.ads.length, 0, "ad count"));
}

// --------------------------------------------------------------- bad api key
section("provider key rejected");
{
  const { run } = await runWith({ RI_MOCK_FAIL: "auth" });
  await check("an auth failure is reported as auth, not as 'no ads'", () => {
    ok(Object.values(run.progress).every((p) => p.reason === "auth"),
      `got reasons ${JSON.stringify(Object.values(run.progress).map((p) => p.reason))}`);
  });
}

// -------------------------------------------------------- one target times out
section("one target times out, the other works");
{
  const { run } = await runWith({ RI_MOCK_FAIL_DOMAIN: "neighborsfcu.org" });
  await check("the working target still produces ads", () => eq(run.progress["campusfederal.org"].read, 4, "read"));
  await check("the timed-out target says timeout", () => {
    eq(run.progress["neighborsfcu.org"].status, "failed", "status");
    eq(run.progress["neighborsfcu.org"].reason, "timeout", "reason");
  });
  await check("the wall renders what did come back", () => ok(run.creative.clusters.length > 0, "wall is empty"));
}

// ---------------------------------------------------------- vision unreadable
section("the vision model returns prose instead of JSON");
{
  const { run } = await runWith({ RI_MOCK_VISION_FAIL: "1" });
  await check("the run completes", () => eq(run.status, "done", "status"));
  await check("creatives found but none read is reported as empty, not as done", () => {
    const p = run.progress["campusfederal.org"];
    eq(p.status, "empty", "status");
    eq(p.reason, "extraction_failed", "reason");
    eq(p.found, 4, "found count is still reported");
    eq(p.extractionFailed, 4, "failed extraction count");
  });
  await check("no half-built ad records leak into the payload", () => eq(run.ads.length, 0, "ad count"));
}

// ------------------------------------------------------------ CDN hotlink block
section("the image CDN refuses server-side download");
{
  const { run } = await runWith({ RI_MOCK_IMG_403: "1" });
  await check("the run completes rather than throwing", () => eq(run.status, "done", "status"));
  await check("creatives found is still reported even though none downloaded", () => {
    const p = run.progress["campusfederal.org"];
    eq(p.found, 4, "found count");
    eq(p.status, "empty", "status");
  });
}

// -------------------------------------------------------------- the image proxy
section("image proxy");
{
  const S = await startServer();
  try {
    const good = await fetch(`${S.base}/api/img?u=${encodeURIComponent("https://tpc.googlesyndication.com/archive/simgad/CAMP1")}`);
    await check("a real creative URL proxies through", () => {
      eq(good.status, 200, "status");
      eq(good.headers.get("content-type"), "image/png", "content-type");
    });

    for (const [what, u] of [
      ["an arbitrary external host", "https://example.com/x.png"],
      ["a loopback address", "http://127.0.0.1:22/x.png"],
      ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
      ["a file URL", "file:///etc/passwd"],
      ["plain http on an allowed host", "http://tpc.googlesyndication.com/archive/simgad/CAMP1"],
    ]) {
      const r = await fetch(`${S.base}/api/img?u=${encodeURIComponent(u)}`);
      await check(`the proxy refuses ${what}`, () => eq(r.status, 400, "status"));
    }

    const empty = await fetch(`${S.base}/api/img`);
    await check("the proxy refuses a missing url", () => eq(empty.status, 400, "status"));
  } finally { S.stop(); }
}

// ----------------------------------------------------------- unknown run ids
section("unknown identifiers");
{
  const S = await startServer();
  try {
    const { status, body } = await S.get("/api/run/nope");
    await check("an unknown run id 404s with a reason", () => {
      eq(status, 404, "status"); eq(body.reason, "not_found", "reason");
    });
    const { status: s2 } = await S.get("/api/run/..%2F..%2Fetc%2Fpasswd");
    await check("a traversal-shaped run id does not read the filesystem", () => eq(s2, 404, "status"));
  } finally { S.stop(); }
}

summary();
