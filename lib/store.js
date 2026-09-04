// =============================================================================
// lib/store.js — flat-file persistence for capture runs.
//
// The SEM tool deliberately has no store: it runs a few times a month and
// throws everything away. This tool must not, for two reasons:
//
//   1. VISION COST IS PER CREATIVE, PER RUN. A creative's transcription never
//      changes, so paying to read the same banner twice is pure waste. Keyed on
//      creativeId, an extraction is bought once and reused forever.
//   2. CHANGE OVER TIME is the thing the manual workflow can never produce, and
//      it falls out of storing snapshots and diffing on creativeId. No special
//      machinery required — but only if the snapshots exist.
//
// Flat JSON per run, deliberately. A database is a deployment dependency, an
// ops burden and a migration story; at RAIN's volume it buys nothing that a
// directory of files does not. When runs outgrow this, the shape here maps
// cleanly onto rows.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const CACHE = path.join(ROOT, "_extractions");

for (const dir of [ROOT, CACHE]) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// CACHE MANIFEST — what wrote this directory, and when.
//
// The cache is deliberately portable: no absolute paths, no hostnames, no
// window baked into a key. Copy RI_DATA_DIR from a laptop to a Render disk to
// an S3-backed volume and every entry is a hit, with no SerpApi and no vision
// spend at any hop.
//
// What portability cannot give you is PROVENANCE. A directory of JSON looks
// identical whichever build produced it, and the one thing that has actually
// bitten this project is a cache that was silently older than the code reading
// it. Per-entry versioning handles extractions; this file covers the rest, so
// a copied cache can say where it came from instead of being inferred from.
// ---------------------------------------------------------------------------
export const CACHE_SCHEMA = 3;

export function writeManifest(extra = {}) {
  try {
    const p = path.join(ROOT, "manifest.json");
    const prior = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    writeAtomic(p, JSON.stringify({
      schema: CACHE_SCHEMA,
      createdAt: prior.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    }, null, 2));
  } catch { /* a manifest that fails to write must never take the app down */ }
}

/** null when there is no manifest — an empty or pre-manifest cache directory. */
export function readManifest() {
  try {
    const p = path.join(ROOT, "manifest.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// CAN THIS PROCESS ACTUALLY STORE ANYTHING?
//
// /api/health reported which API keys were present and called that healthy. But
// every capture ends in a write, and a data directory that is missing, read-only
// or full fails that write while the health line stays green — so the one thing
// health is for, saying whether a capture will work before somebody spends
// money finding out, was the one thing it did not check.
//
// The probe is a real write and delete, not a permission-bit inspection: bits
// are not the only reason a write fails (a full disk, a read-only mount, and a
// root process that ignores the bits entirely all pass an inspection and fail a
// write).
// ---------------------------------------------------------------------------
export function storageHealth() {
  const out = { dir: ROOT, writable: false, reason: null, freeBytes: null };
  try {
    const probe = path.join(ROOT, `.write-probe.${process.pid}`);
    writeFileSync(probe, "ok", "utf8");
    unlinkSync(probe);
    out.writable = true;
  } catch (e) {
    out.reason = e?.code || e?.message || "write_failed";
  }
  try {
    const st = statfsSync(ROOT);
    out.freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    // Not every filesystem answers statfs. Unknown free space is reported as
    // unknown; it is not a reason to call storage unhealthy.
  }
  return out;
}

export function newRunId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

const runPath = (id) => path.join(ROOT, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);

// ---------------------------------------------------------------------------
// ATOMIC WRITE.
//
// writeFileSync truncates the target and then writes into it. Interrupt it —
// full disk, killed process, the Windows restart trap in the handover notes —
// and what is left on disk is a truncated file that is still valid JSON right up
// to the point it stops being valid JSON. loadRun() then returns null and the
// run reads as "never existed", which is the most expensive possible failure:
// the capture is paid for, gone, and indistinguishable from one that never ran.
//
// Temp file plus rename is atomic on the same filesystem, so a reader sees the
// old complete file or the new complete file and never a half of either.
// ---------------------------------------------------------------------------
function writeAtomic(target, text) {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
    return true;
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Persist a run. Returns whether it actually reached disk.
 *
 * The return value used to be a boolean nobody read, so a full or unwritable
 * data directory produced one console line and a user who was told their run
 * completed. It did complete — and it is not on disk, which means it cannot be
 * reopened, cannot be diffed against next month, and every cached extraction it
 * would have spared has to be bought again. Every call site now reads this, and
 * the answer travels to the UI as run.persisted.
 */
export function saveRun(run) {
  try {
    writeAtomic(runPath(run.id), JSON.stringify(run, null, 2));
    return true;
  } catch (e) {
    // Still never throws: persistence failing must not take a capture down with
    // it. What changed is that the caller is now told, instead of the failure
    // living only in a log nobody is reading.
    console.error("[store] save failed:", e.message);
    return false;
  }
}

export function loadRun(id) {
  try {
    const p = runPath(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

export function listRuns({ limit = 25 } = {}) {
  try {
    return readdirSync(ROOT)
      .filter((f) => f.startsWith("run_") && f.endsWith(".json"))
      .map((f) => {
        try {
          const r = JSON.parse(readFileSync(path.join(ROOT, f), "utf8"));
          return {
            id: r.id, mode: r.mode, source: r.source || "google_display", product: r.product,
            client: r.client?.label || r.client?.domain,
            competitors: (r.competitors || []).map((c) => c.label || c.domain),
            createdAt: r.createdAt, status: r.status,
            adCount: r.stats?.adsRead ?? r.stats?.messagesRead ?? 0,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// EXTRACTION CACHE — keyed on creativeId AND the reader that produced the
// record. The provider guarantees creativeId is stable; the reader is what
// makes a stored record meaningful.
//
// A creative's pixels never change, so its transcription never needs to be
// bought twice. At ~100 creatives per run this is the difference between paying
// for every refresh and paying only for what is genuinely new.
//
// The reader belongs in the key because the banner reader and the search reader
// emit DIFFERENT SHAPES: description, sitelinks and the economic facts living
// inside them exist only in the search shape. Keyed on creativeId alone, a
// banner record satisfies a benchmark run's lookup and silently drops exactly
// the fields the board counts — with no cache miss anywhere to show for it.
// Pre-upgrade records sit at the old unsuffixed path and are simply never read.
// ---------------------------------------------------------------------------
// The reader component carries its VERSION — "search-v2", not "search" — so a
// prompt change invalidates old readings automatically. Digits and hyphens are
// preserved here for exactly that reason; stripping them would collapse every
// version back onto one filename and reinstate the problem.
const cachePath = (creativeId, reader) =>
  path.join(CACHE, `${String(creativeId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}.${
    String(reader).replace(/[^a-z0-9-]/g, "") || "banner-v1"}.json`);

export function getCachedExtraction(creativeId, reader) {
  try {
    const p = cachePath(creativeId, reader);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

export function putCachedExtraction(creativeId, ad, reader) {
  // Atomic for the same reason a run is: a half-written extraction is valid
  // JSON often enough to be read back as a creative with no facts, and it would
  // then be reused forever without a cache miss to show for it.
  try { writeAtomic(cachePath(creativeId, reader), JSON.stringify(ad)); } catch { /* best effort */ }
}

/**
 * Diff two runs on creativeId.
 *
 * This is the whole of "change over time". It needs no model and no extra
 * provider calls — the identity key was already deterministic.
 */
/**
 * The most recent earlier run that is COMPARABLE to this one.
 *
 * Comparable means same client, same mode and same product scope. Diffing
 * against a run with a different scope would report a product filter change as
 * "12 new ads appeared", which is worse than reporting nothing.
 *
 * This exists because the Transparency Center is not a stable list: the same
 * query issued twice returns overlapping but different creatives, since Google
 * serves a sample and rotates it. One capture is therefore a SAMPLE AT A MOMENT,
 * never an inventory — and the honest way to show that is to compare samples,
 * which needs the previous one on disk. It already is.
 */
export function findPreviousRun(run) {
  try {
    const candidates = readdirSync(ROOT)
      .filter((f) => f.startsWith("run_") && f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(path.join(ROOT, f), "utf8")); } catch { return null; } })
      .filter((r) => r && r.id !== run.id
        && r.status === "done"
        && r.mode === run.mode
        // SOURCE is part of comparability. A display capture diffed against a
        // search one would report every record as "new", because the two
        // surfaces do not share an identifier space, a grain, or a meaning.
        && (r.source || "google_display") === (run.source || "google_display")
        && r.product === run.product
        && r.client?.domain === run.client?.domain
        && String(r.createdAt) < String(run.createdAt))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return candidates[0] || null;
  } catch { return null; }
}

export function diffRuns(prev, next) {
  const idsOf = (r) => new Set((r?.ads || []).map((a) => a.creativeId));
  const a = idsOf(prev), b = idsOf(next);
  const stillRunning = [...b].filter((id) => a.has(id));
  const appeared = [...b].filter((id) => !a.has(id));
  const gone = [...a].filter((id) => !b.has(id));
  return {
    stillRunning: stillRunning.length,
    appeared: appeared.length,
    previousTotal: a.size,
    currentTotal: b.size,
    // "No longer observed" — NOT "stopped running". An ad absent from a sampled
    // capture may simply not have been sampled this time.
    noLongerObserved: gone.length,
    appearedIds: appeared,
    goneIds: gone,
  };
}
