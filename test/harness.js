// Minimal test harness + server runner. Kept dependency-free on purpose: the
// point of `npm test` here is that it works on a clean checkout with no keys.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0, failed = 0;
const failures = [];

/** Runs `fn` and records the outcome. Async-aware: always await the call. */
export async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

export function section(title) { console.log(`\n── ${title}`); }

export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  · ${f.name}: ${f.message}`);
    process.exitCode = 1;
  }
  return failed === 0;
}

export function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || "value"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function ok(cond, what) { if (!cond) throw new Error(what || "expected truthy"); }

/** Boot the real server with the fake network underneath it. */
export async function startServer(env = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ri-run-"));
  const port = 3000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", "./test/mock-net.js", "server.js"], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), RI_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`server did not start:\n${log}`); }
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    base, port, dataDir,
    log: () => log,
    async get(p) { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; },
    async post(p, body) {
      const r = await fetch(base + p, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: r.status, body: await r.json() };
    },
    /** Raw response, for endpoints that do not return JSON (media, images). */
    async raw(p) {
      const r = await fetch(base + p);
      return { status: r.status, headers: Object.fromEntries(r.headers), buffer: Buffer.from(await r.arrayBuffer()) };
    },
    /** Poll a run to completion. Returns the final payload. */
    async awaitRun(runId, ms = 20000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const { body } = await this.get(`/api/run/${runId}`);
        if (body.status === "done" || body.status === "error") return body;
        if (Date.now() > deadline) throw new Error(`run ${runId} did not finish; last status ${body.status}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop() {
      child.kill("SIGKILL");
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
