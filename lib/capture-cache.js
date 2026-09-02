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
 * different answers, and `source` because a display and a search capture of the
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
export function peek({ source, domain, days, ttlDays }) {
  const key = cacheKey({ source, domain, days });
  const f = fileFor(key);
  const ttl = Number.isFinite(ttlDays) ? ttlDays : TTL_DAYS;
  if (!existsSync(f)) return { hit: false, key, ttl };
  try {
    const entry = JSON.parse(readFileSync(f, "utf8"));
    const age = ageDays(entry.capturedAt);
    // TTL is per ADVERTISER, not global. A national benchmark's capture is
    // shared by every client and its rotation moves on a quarterly cycle, so it
    // holds for a month; a local competitor's does not.
    return { hit: true, key, entry, ageDays: age, stale: age > ttl, ttl };
  } catch {
    return { hit: false, key, ttl };
  }
}

/** A usable (fresh, non-forced) entry, or null. */
export function get({ source, domain, days, force = false, ttlDays }) {
  if (force) return null;
  const p = peek({ source, domain, days, ttlDays });
  if (!p.hit || p.stale) return null;
  return { ...p.entry, _cache: { key: p.key, ageDays: Number(p.ageDays.toFixed(2)), ttlDays: p.ttl } };
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
    const tier = (typeof d === "object" && d.tier) || "local";
    const ttlDays = (typeof d === "object" && Number.isFinite(d.ttlDays)) ? d.ttlDays : undefined;
    const p = peek({ source, domain, days, ttlDays });
    const usable = !force && p.hit && !p.stale;
    return {
      domain, label, tier,
      cached: !!p.hit,
      ageDays: p.hit ? Number(p.ageDays.toFixed(1)) : null,
      stale: p.hit ? !!p.stale : null,
      ttlDays: p.ttl,
      willFetch: !usable,
    };
  });
  return {
    source,
    total: rows.length,
    fromCache: rows.filter((r) => !r.willFetch).length,
    willFetch: rows.filter((r) => r.willFetch).length,
    // Split out because the national half is a shared cost the whole agency
    // amortises, and a strategist reading the cost line should see that the
    // two extra advertisers are usually free rather than two more credits.
    nationalWillFetch: rows.filter((r) => r.willFetch && r.tier === "national").length,
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
