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

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const CACHE = path.join(ROOT, "_extractions");

for (const dir of [ROOT, CACHE]) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

export function newRunId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

const runPath = (id) => path.join(ROOT, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);

export function saveRun(run) {
  try {
    writeFileSync(runPath(run.id), JSON.stringify(run, null, 2), "utf8");
    return true;
  } catch (e) {
    // Persistence is best-effort and must never take a capture down with it.
    // A run that completed but failed to save is still a run the user can see.
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
// EXTRACTION CACHE — keyed on creativeId, which the provider guarantees is
// stable and deterministic across runs.
//
// A creative's pixels never change, so its transcription never needs to be
// bought twice. At ~100 creatives per run this is the difference between paying
// for every refresh and paying only for what is genuinely new.
// ---------------------------------------------------------------------------
const cachePath = (creativeId) =>
  path.join(CACHE, `${String(creativeId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}.json`);

export function getCachedExtraction(creativeId) {
  try {
    const p = cachePath(creativeId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

export function putCachedExtraction(creativeId, ad) {
  try { writeFileSync(cachePath(creativeId), JSON.stringify(ad), "utf8"); } catch { /* best effort */ }
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
        // SOURCE is part of comparability. A Meta capture diffed against a
        // Google one would report every record as "new", because the two
        // sources do not share an identifier space, a grain, or a meaning.
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
