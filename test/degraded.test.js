// =============================================================================
// test/degraded.test.js — the paths that decide whether a bad day looks like a
// bad day or looks like a broken product.
//
// Every case here ends with the user being told something true and specific.
// "Nothing happened" is the failure mode this file exists to prevent.
// =============================================================================

import { startServer, check, section, summary, eq, ok } from "./harness.js";
import { checkPublicUrl, readRatePages } from "../lib/rate-page.js";

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

// ------------------------------------------------------------ the rate-page fetch
//
// The image proxy is safe because it holds a four-host allowlist. This endpoint
// cannot have one — a competitor's rate page is an arbitrary public host — so it
// gets the other guard, and these are the image proxy's own cases pointed at it.
section("rate-page fetch refuses to read this machine");
{
  // A resolver that answers every name with a public address. Any refusal below
  // is therefore the URL itself being refused, never a DNS accident.
  const publicResolver = async () => ["93.184.216.34"];

  for (const [what, url] of [
    ["a loopback address", "https://127.0.0.1/rates"],
    ["loopback by name", "https://localhost/rates"],
    ["IPv6 loopback", "https://[::1]/rates"],
    ["cloud metadata by address", "https://169.254.169.254/latest/meta-data/"],
    ["cloud metadata by name", "https://metadata.google.internal/computeMetadata/v1/"],
    ["an RFC1918 address", "https://10.0.0.5/rates"],
    ["another RFC1918 range", "https://172.16.3.4/rates"],
    ["a home-network address", "https://192.168.1.1/"],
    ["an IPv6 unique-local address", "https://[fd00::1]/rates"],
    ["an IPv6 link-local address", "https://[fe80::1]/rates"],
    ["an IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/rates"],
    ["plain http", "http://campusfederal.org/rates"],
    ["a file URL", "file:///etc/passwd"],
    ["a .internal hostname", "https://vault.internal/rates"],
    ["nothing at all", ""],
  ]) {
    const v = await checkPublicUrl(url, { resolve: publicResolver });
    await check(`the rate-page fetch refuses ${what}`, () => {
      eq(v.ok, false, `${url} was permitted`);
      ok(v.reason, "a refusal must carry a reason the UI can show");
    });
  }

  await check("a public https page is permitted", async () => {
    const v = await checkPublicUrl("https://campusfederal.org/rates", { resolve: publicResolver });
    ok(v.ok, `a normal rate page was refused: ${v.reason}`);
  });

  await check("a hostname that resolves into a private range is refused", async () => {
    const v = await checkPublicUrl("https://rates.example.com/x", { resolve: async () => ["169.254.169.254"] });
    eq(v.ok, false, "a name pointing at cloud metadata was permitted");
    eq(v.reason, "private_address", "reason");
  });

  await check("one private answer among public ones is enough to refuse", async () => {
    const v = await checkPublicUrl("https://rates.example.com/x", { resolve: async () => ["93.184.216.34", "127.0.0.1"] });
    eq(v.ok, false, "a name that can be served either way was permitted");
  });

  await check("a name that will not resolve is refused, not attempted", async () => {
    const v = await checkPublicUrl("https://nope.example/x", { resolve: async () => { throw new Error("ENOTFOUND"); } });
    eq(v.ok, false, "fail closed: 'we could not check' is not 'we checked'");
    eq(v.reason, "dns_failed", "reason");
  });

  await check("a blocked page comes back as a reason beside its domain, never as rates", async () => {
    // The endpoint's contract: a refusal is a per-domain result the UI shows,
    // exactly like a failed capture. It must never look like a competitor with
    // no rates, and it must never take the run down.
    const out = await readRatePages(
      [{ domain: "campusfederal.org", url: "https://169.254.169.254/latest/meta-data/" }],
      { product: "checking", productLabel: "Checking", resolve: publicResolver },
    );
    const r = out["campusfederal.org"];
    eq(r.ok, false, "ok");
    eq(r.reason, "private_address", "reason");
    ok(!r.facts, "a refused fetch must produce no figures at all");
  });
}

summary();
