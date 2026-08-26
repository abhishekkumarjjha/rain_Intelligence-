// =============================================================================
// lib/capture-cache.js — per-ADVERTISER capture cache.
//
// The problem this solves, in one sentence: five people on the team testing
// LaCap in the same week should cost one capture, not five.
//
// ---------------------------------------------------------------------------
// WHY PER-ADVERTISER AND NOT PER-RUN
// ---------------------------------------------------------------------------
// Capture is already product-agnostic — `capture(domain, {format, days})` takes
// no product, because product filtering happens afterwards in analyze.js. That
// is what makes advertiser-level caching worth so much more than run-level:
//
//   · one LaCap capture serves EVERY product scope anyone tests
//   · a run needing 4 competitors where 3 are cached fetches ONE
//   · the cost line can say "1 request" instead of "4" before anyone commits
//
// A run-level cache would miss all three, because no two runs share a key.
//
// ---------------------------------------------------------------------------
// WHY A WEEK
// ---------------------------------------------------------------------------
// Bank and credit-union creative goes through compliance review. New work
// appears on a cycle measured in weeks, not hours. A 7-day TTL means a
// competitor's wall is at most one approval cycle stale, which is the accuracy
// the use case actually needs — and the Re-analyze button exists for the moment
// somebody needs better than that.
//
// The freshness is always SHOWN, never assumed: every cached advertiser reports
// when it was captured, so a strategist can see the age and decide.
// =============================================================================

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const CACHE_DIR = path.join(DATA_DIR, "_captures");

export const TTL_DAYS = Number(process.env.RI_CAPTURE_TTL_DAYS || 7);

try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* best effort */ }

/**
 * The key deliberately omits PRODUCT — that is the whole saving. It includes
 * `days` because a 30-day and a 90-day capture are different questions with
 * different answers, and `source` because a Google and a Meta capture of the
 * same domain are different evidence entirely.
 */
export function cacheKey({ source, domain, days }) {
  const raw = `${source}|${String(domain).toLowerCase()}|${Number(days)}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

const fileFor = (key) => path.join(CACHE_DIR, `${key}.json`);

export function ageDays(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

/**
 * Look up a cached advertiser capture.
 *
 * Returns `{ hit, entry, ageDays, stale }`. A STALE entry is still returned —
 * the caller decides whether to use it, and the peek path uses it to say
 * "captured 9 days ago" rather than pretending nothing exists.
 */
export function peek({ source, domain, days }) {
  const key = cacheKey({ source, domain, days });
  const f = fileFor(key);
  if (!existsSync(f)) return { hit: false, key };
  try {
    const entry = JSON.parse(readFileSync(f, "utf8"));
    const age = ageDays(entry.capturedAt);
    return { hit: true, key, entry, ageDays: age, stale: age > TTL_DAYS };
  } catch {
    return { hit: false, key };
  }
}

/** A usable (fresh, non-forced) entry, or null. */
export function get({ source, domain, days, force = false }) {
  if (force) return null;
  const p = peek({ source, domain, days });
  if (!p.hit || p.stale) return null;
  return { ...p.entry, _cache: { key: p.key, ageDays: Number(p.ageDays.toFixed(2)) } };
}

export function put({ source, domain, days }, payload) {
  const key = cacheKey({ source, domain, days });
  try {
    writeFileSync(fileFor(key), JSON.stringify({
      source, domain, days,
      capturedAt: new Date().toISOString(),
      ...payload,
    }), "utf8");
    return key;
  } catch (e) {
    console.error("[capture-cache] write failed:", e.message);
    return null;
  }
}

/**
 * What a capture would cost right now, per advertiser, BEFORE spending anything.
 * This is what the cost line on the competitor screen reads.
 */
export function planCost({ source, domains, days, force = false }) {
  const rows = domains.map((d) => {
    const domain = typeof d === "string" ? d : d.domain;
    const label = typeof d === "string" ? d : (d.label || d.domain);
    const p = peek({ source, domain, days });
    const usable = !force && p.hit && !p.stale;
    return {
      domain, label,
      cached: !!p.hit,
      ageDays: p.hit ? Number(p.ageDays.toFixed(1)) : null,
      stale: p.hit ? !!p.stale : null,
      willFetch: !usable,
    };
  });
  return {
    source,
    total: rows.length,
    fromCache: rows.filter((r) => !r.willFetch).length,
    willFetch: rows.filter((r) => r.willFetch).length,
    ttlDays: TTL_DAYS,
    rows,
  };
}

/** Drop cached captures older than `days`. Only ever called explicitly. */
export function prune({ olderThanDays = 30 } = {}) {
  let removed = 0;
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(CACHE_DIR, f);
      if ((Date.now() - statSync(p).mtimeMs) / 86400000 > olderThanDays) { unlinkSync(p); removed++; }
    }
  } catch { /* best effort */ }
  return removed;
}
