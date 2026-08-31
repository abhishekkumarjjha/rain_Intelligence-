// =============================================================================
// lib/snapshot.js — IMMUTABLE EVIDENCE, and the history the deltas will need.
//
// Two things live here because they have the same deadline: both must be
// WRITTEN from the first production run even though neither is READ for months.
//
// 1. EVIDENCE BUNDLES.
//    Transparency Center ads disappear. If a benchmark run in September puts a
//    figure in a client report, and in November the client's competitor says
//    "we never advertised 4.50%, show me", the creative may be gone from
//    Google. A creativeId is a pointer, not an evidence record.
//    At capture time we already hold the image bytes, the raw provider JSON and
//    a timestamp. Persisting them costs almost nothing AT THAT MOMENT and is
//    impossible afterwards. That asymmetry is the whole argument.
//
// 2. BENCHMARK SNAPSHOTS.
//    Month-over-month change is the most diagnostically valuable finding this
//    tool can produce, and it cannot be reconstructed later. The UI can wait;
//    the storage cannot. What gets written is the SHAPE — stable
//    brand+product+source keys and the three distinct first-seen concepts —
//    so that when the delta UI lands it is a read, not a migration.
//
// THE THREE FIRST-SEEN CONCEPTS, which are routinely conflated and must not be:
//    creative_first_seen              provider's first_shown for one creative.
//                                     Changes every time artwork is refreshed.
//    offer_first_seen                 the first snapshot in which WE observed
//                                     this brand advertising this figure.
//    brand_product_source_first_seen  the first snapshot in which WE observed
//                                     this brand advertising this product here.
//
// Only the last two support "newly observed". Using the provider's first_shown
// for that makes a competitor who redesigned a banner look like a new entrant,
// and that sentence would go in a client report.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const SNAPS = path.join(ROOT, "_snapshots");
const EVIDENCE = path.join(ROOT, "_evidence");

for (const dir of [SNAPS, EVIDENCE]) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

const safe = (s) => String(s || "").replace(/[^a-zA-Z0-9_.-]/g, "_");

// ---------------------------------------------------------------------------
// EVIDENCE
// ---------------------------------------------------------------------------

/**
 * Persist everything needed to reproduce one creative exactly as RAIN saw it.
 *
 * Called at capture time, before the base64 is discarded. Failure is logged and
 * never propagates: a run that produced findings but failed to archive an image
 * is still a run, and taking the capture down to protect an archive would be
 * the wrong trade.
 */
export function putEvidence({ creativeId, source, capturedAt, brandDomain, providerRaw, mediaType, data, extraction }) {
  if (!creativeId) return null;
  const id = safe(creativeId);
  try {
    const bundle = {
      creativeId,
      source,
      brandDomain,
      capturedAt: capturedAt || new Date().toISOString(),
      // The provider's own record, untouched. Every derived field in the app can
      // be recomputed from this; none of it can be recovered without it.
      providerRaw: providerRaw || null,
      mediaType: mediaType || "image/png",
      hasImage: !!data,
      // Verbatim transcription plus the model and prompt version that produced
      // it. A dispute is often about what the ad SAID, not what it meant, and
      // that is answerable only if the transcription is dated and attributed.
      extraction: extraction ? {
        model: extraction.model || null,
        promptVersion: extraction.promptVersion || "search-v1",
        headlines: extraction.headlines || [],
        description: extraction.description || "",
        sitelinks: extraction.sitelinks || [],
        callouts: extraction.callouts || [],
        facts: extraction.facts || [],
        claims: extraction.claims || [],
        truncated: !!extraction.truncated,
      } : null,
    };
    writeFileSync(path.join(EVIDENCE, `${id}.json`), JSON.stringify(bundle, null, 2), "utf8");
    if (data) writeFileSync(path.join(EVIDENCE, `${id}.b64`), data, "utf8");
    return id;
  } catch (e) {
    console.error("[snapshot] evidence write failed:", e.message);
    return null;
  }
}

export function getEvidence(creativeId) {
  try {
    const p = path.join(EVIDENCE, `${safe(creativeId)}.json`);
    if (!existsSync(p)) return null;
    const bundle = JSON.parse(readFileSync(p, "utf8"));
    const img = path.join(EVIDENCE, `${safe(creativeId)}.b64`);
    if (existsSync(img)) bundle.data = readFileSync(img, "utf8");
    return bundle;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// BENCHMARK SNAPSHOTS
// ---------------------------------------------------------------------------

/**
 * The competitor set is part of the measurement, not a setting.
 *
 * "4 of 5" in July and "3 of 7" in August are not the same measurement, and
 * nothing else on the page will tell the reader that. Hashing the sorted domain
 * list gives every snapshot a version that a later run can compare against.
 */
export function competitorSetVersion(domains = []) {
  const sorted = [...new Set(domains.map((d) => String(d).toLowerCase()))].sort();
  return {
    hash: crypto.createHash("sha1").update(sorted.join("|")).digest("hex").slice(0, 12),
    domains: sorted,
  };
}

const snapKey = (clientDomain, product, source) =>
  `${safe(clientDomain)}__${safe(product)}__${safe(source)}`;

/**
 * Write one benchmark snapshot. Append-only: snapshots are never rewritten,
 * because a correction must produce a new report record rather than silently
 * changing what a previous month's report was based on.
 */
export function putSnapshot({ clientDomain, product, source, label, brands, competitorSet, windowStart, windowEnd, runId }) {
  try {
    const key = snapKey(clientDomain, product, source);
    const dir = path.join(SNAPS, key);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();

    const snapshot = {
      key, clientDomain, product, source, runId,
      label: label || monthLabel(stamp),
      takenAt: stamp,
      windowStart, windowEnd,
      competitorSet,
      // Brand state only — never the creatives. The evidence store holds those,
      // keyed by id, so a snapshot stays small enough to read on every run.
      brands: (brands || []).map((b) => ({
        domain: b.domain,
        label: b.label,
        isClient: !!b.isClient,
        adCount: b.adCount,
        hasCoverage: !!b.hasCoverage,
        leadEmphasis: b.leadEmphasis || null,
        positions: Object.fromEntries(Object.entries(b.positions || {}).map(([m, p]) => [m, {
          raw: p.raw, value: p.value, qualifiers: p.qualifiers, creativeId: p.creativeId,
        }])),
        claims: [...(b.claims?.keys?.() || [])],
      })),
    };

    writeFileSync(path.join(dir, `${stamp.replace(/[:.]/g, "-")}.json`), JSON.stringify(snapshot, null, 2), "utf8");
    return snapshot;
  } catch (e) {
    console.error("[snapshot] snapshot write failed:", e.message);
    return null;
  }
}

/** The most recent snapshot strictly before `before`, or the latest if omitted. */
export function previousSnapshot({ clientDomain, product, source, before = null, excludeRunId = null }) {
  try {
    const dir = path.join(SNAPS, snapKey(clientDomain, product, source));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) return null;
    const candidates = before
      ? files.filter((f) => f < before.replace(/[:.]/g, "-"))
      : files;
    // A run must never be its own previous. Its snapshot is written when it
    // completes, so every later read of that run — which is how the UI shows
    // it — would otherwise compare the run against itself: no set drift, and no
    // offer change can ever fire.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const snap = JSON.parse(readFileSync(path.join(dir, candidates[i]), "utf8"));
      if (excludeRunId && snap.runId === excludeRunId) continue;
      return snap;
    }
    return null;
  } catch { return null; }
}

export function snapshotHistory({ clientDomain, product, source, limit = 12 }) {
  try {
    const dir = path.join(SNAPS, snapKey(clientDomain, product, source));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-limit)
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  } catch { return []; }
}

/**
 * Derive first-seen state across the snapshot series.
 *
 * This is the function that makes "newly observed" defensible: it is computed
 * from OUR OWN observation history, never from the provider's first_shown.
 */
export function firstSeen({ clientDomain, product, source }) {
  const history = snapshotHistory({ clientDomain, product, source, limit: 24 });
  const brandFirst = new Map();
  const offerFirst = new Map();

  for (const snap of history) {
    for (const b of snap.brands || []) {
      if (!b.hasCoverage) continue;
      if (!brandFirst.has(b.domain)) brandFirst.set(b.domain, snap.takenAt);
      for (const [metric, pos] of Object.entries(b.positions || {})) {
        const k = `${b.domain}|${metric}|${pos.raw}`;
        if (!offerFirst.has(k)) offerFirst.set(k, snap.takenAt);
      }
    }
  }
  return {
    snapshots: history.length,
    brandProductSourceFirstSeen: Object.fromEntries(brandFirst),
    offerFirstSeen: Object.fromEntries(offerFirst),
  };
}

/**
 * Did the competitor set move between two snapshots?
 *
 * Rendered on the board whenever it did, because a changed denominator is a
 * changed measurement and the reader has no other way to know.
 */
export function setDrift(current, previous) {
  if (!previous?.competitorSet) return null;
  const now = new Set(current.domains || []);
  const was = new Set(previous.competitorSet.domains || []);
  const added = [...now].filter((d) => !was.has(d));
  const removed = [...was].filter((d) => !now.has(d));
  if (!added.length && !removed.length) return null;
  return {
    changed: true, added, removed,
    // Deltas run only over the intersection; anything else invents a change out
    // of a change to the set.
    stable: [...now].filter((d) => was.has(d)),
    note: `Competitor set changed since ${previous.label}: ${added.length ? `+${added.length}` : ""}${added.length && removed.length ? ", " : ""}${removed.length ? `−${removed.length}` : ""}. Comparisons to the previous benchmark cover only the ${[...now].filter((d) => was.has(d)).length} competitors present in both.`,
  };
}

function monthLabel(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// WATCHED SET — the default, not a restriction.
//
// Fulfillment may pick literally anyone. The stability problem is solved by the
// DEFAULT rather than by permission: prefill with last month's set, so drift is
// deliberate and stability is the path of least resistance.
// ---------------------------------------------------------------------------

const watchPath = (clientDomain, product) =>
  path.join(SNAPS, `_watched__${safe(clientDomain)}__${safe(product)}.json`);

export function putWatchedSet(clientDomain, product, competitors) {
  try {
    writeFileSync(watchPath(clientDomain, product), JSON.stringify({
      clientDomain, product, updatedAt: new Date().toISOString(),
      competitors: competitors.map((c) => ({ label: c.label, domain: c.domain, tier: c.tier || "local" })),
    }, null, 2), "utf8");
    return true;
  } catch { return false; }
}

export function getWatchedSet(clientDomain, product) {
  try {
    const p = watchPath(clientDomain, product);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}
