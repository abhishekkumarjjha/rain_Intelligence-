// =============================================================================
// lib/atc-provider.js — Google Ads Transparency Center evidence adapter.
//
// Descended from the SEM tool's competitor-serpapi.js, generalised in exactly
// three ways and no more:
//
//   1. creative_format is a PARAMETER, not the constant "text". RAIN
//      Intelligence's Creative mode needs `image`; Benchmark needs `text`.
//   2. `platform` is OMITTED for image/video. There is no DISPLAY value in the
//      provider's platform enum (only PLAY/MAPS/SEARCH/SHOPPING/YOUTUBE), so
//      pinning platform=SEARCH while asking for image creatives asks for
//      something that barely exists. Format is what separates display-style
//      banner creatives from search text ads.
//   3. Every call returns a CAPTURE RUN record alongside the creatives — see
//      the sampling note below.
//
// It is still an EVIDENCE ADAPTER and nothing more. It does not parse ad text,
// classify products, judge relevance, or decide anything.
//
// ---------------------------------------------------------------------------
// THE SAMPLING PROBLEM, which this file exists to make impossible to ignore
// ---------------------------------------------------------------------------
// A live check on lacapfcu.org returned 21 TEXT creatives — and ~2,000 IMAGE
// creatives. `num` is capped at 100. So for image captures we are ALWAYS
// looking at a sample, never at the market.
//
// That is fine. What is not fine is a UI that says "their longest-running
// image ad" when the truthful sentence is "the longest-running ad IN WHAT WE
// RETRIEVED". Those are different claims and only one of them is supportable.
//
// So: every capture carries `providerTotal`, `returned` and `complete`, and the
// analysis layer refuses superlatives when complete === false.
// =============================================================================

import crypto from "node:crypto";

const ENDPOINT = "https://serpapi.com/search.json";

// SerpApi's Transparency Center region is its OWN numeric ID space — not
// Google's browser `region=US`. 2840 is the United States. Env-overridable so a
// wrong constant is a one-line fix, not a redeploy.
const REGION_US = process.env.SERPAPI_TC_REGION || "2840";

const LISTING_TIMEOUT_MS = Number(process.env.SERPAPI_TIMEOUT_MS || 20000);
const IMAGE_TIMEOUT_MS = Number(process.env.SERPAPI_IMAGE_TIMEOUT_MS || 12000);
const MAX_IMAGE_BYTES = 3_000_000;
const IMAGE_CONCURRENCY = 6;

export const DEFAULT_LOOKBACK_DAYS = 30;

/* How many creatives from ONE advertiser get read by the vision model.

   THE COST IS ONE VISION CALL PER CREATIVE, and that call is small: a banner is
   ~140 image tokens against a ~940-token prompt, read by a fast model, so a
   creative costs roughly a third of a cent. Eighteen was a conservative default
   from before that was measured — at these prices the cap buys latency, not
   money, and 30 is worth the seconds. The listing itself is one search credit
   for up to 100.

   The cap governs VISION CALLS, not downloads — see capture(), where the
   byte-dedupe now runs first so no slot is spent on artwork already in hand.

   Why a cap is needed at all: the listing carries NO ad text. Every creative
   gives an advertiser, dates and an image URL, and nothing else. A creative's
   product is unknowable until its image has been read, so we cannot ask the
   provider for "just the checking ads".

   THE KNOWN COST: we choose which ads to read before knowing what any of them
   are about. See selectForReading() for how that choice is made and why.

   THIS CAP IS FOR LOCAL ADVERTISERS, and 60 rather than 30 is an analytical
   choice, not a generous one. The local competitors are the entire payload of
   the board — every ratio, every gap, every "1 of 3" is counted over them — and
   their renderable counts are small. A live capture returned 20, 36, 16, 5 and
   2 renderable creatives across five local institutions; a cap of 30 truncated
   exactly one of them and silently dropped six of Baton Rouge Telco's ads, any
   of which could have carried a figure that changes a finding.

   Nationals are capped separately — see NATIONAL_READ_CAP in national-tier.js
   — and at the full page rather than lower. They are still excluded from every
   denominator, but they stopped being pure decoration when the national_gap
   rule shipped, and their reads are bought once per TTL and shared by every
   client rather than paid per run. */
export const MAX_READ_PER_ADVERTISER = Number(process.env.RI_MAX_READ || 60);

/* How many candidates to DOWNLOAD per vision slot, so identical artwork can be
   collapsed before the cap is spent. Downloads cost bandwidth and nothing else
   — banners are tens of kilobytes — while a vision call is the priced unit, so
   over-fetching here is how the cap buys distinct creatives instead of copies. */
const DEDUPE_POOL_FACTOR = Number(process.env.RI_DEDUPE_POOL_FACTOR || 3);

/* LONGEVITY_NOTE — read before writing any copy about totalDaysShown.
   It is a COUNT OF DAYS SERVED, not a contiguous run: an ad can show for 30
   days, pause for a year, and show again.
     x "Running continuously for 3 years"  — an overclaim we cannot support
     x "Their best-performing ad"          — we have no performance data at all
     v "Shown on 1,169 days since Jun 2023"
     v "Long-running · 1,169 days"
   State what the data says, never what it implies. */

export function hasKey() {
  return !!(process.env.SERPAPI_API_KEY && process.env.SERPAPI_API_KEY.trim());
}

function dateRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  return { start_date: fmt(start), end_date: fmt(end) };
}

/** Unix epoch seconds -> YYYY-MM-DD. "" for anything unusable. */
export function epochToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function normDomain(raw) {
  const d = String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//i, "").replace(/^www\./i, "")
    .replace(/[/?#].*$/, "").replace(/\s+/g, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : "";
}

/**
 * Request parameters, exposed separately so they are unit-testable with no key
 * and no network.
 *
 * @param {string} domain
 * @param {{format?: "text"|"image"|"video", days?: number, start?: string, end?: string}} opts
 */
export function buildListingParams(domain, opts = {}) {
  const format = ["text", "image", "video"].includes(opts.format) ? opts.format : "image";
  const { start_date, end_date } = (opts.start && opts.end)
    ? { start_date: opts.start, end_date: opts.end }
    : dateRange(opts.days || DEFAULT_LOOKBACK_DAYS);

  const params = {
    engine: "google_ads_transparency_center",
    // `text` searches advertisers/domains, which lets us skip resolving an
    // advertiser_id first. The entered domain is the term.
    text: domain,
    creative_format: format,
    region: REGION_US,
    start_date,
    end_date,
    num: 100,
  };

  // ONLY pin platform for text creatives. For image/video, leaving it unset
  // returns creatives across all surfaces — which is what "display" means here.
  // There is no DISPLAY option in the provider's platform enum.
  if (format === "text") params.platform = "SEARCH";

  return params;
}

function classifyHttp(status, body) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  const msg = String((body && (body.error || body.message)) || "").toLowerCase();
  if (msg.includes("api key")) return "auth";
  if (msg.includes("run out") || msg.includes("exceeded") || msg.includes("limit")) return "quota";
  return "provider_error";
}

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

/**
 * ONE listing request for ONE domain and ONE format.
 * Returns creatives PLUS the capture-run record that keeps later claims honest.
 */
export async function listCreatives(domain, opts = {}) {
  if (!hasKey()) return { ok: false, reason: "not_configured" };
  const d = normDomain(domain);
  if (!d) return { ok: false, reason: "bad_domain" };

  const params = buildListingParams(d, opts);
  const qs = new URLSearchParams({ ...params, api_key: process.env.SERPAPI_API_KEY });

  let res, body;
  try {
    res = await withTimeout(
      (signal) => fetch(`${ENDPOINT}?${qs}`, { signal, headers: { accept: "application/json" } }),
      LISTING_TIMEOUT_MS
    );
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : "provider_error" };
  }

  try { body = await res.json(); } catch { return { ok: false, reason: "provider_error" }; }
  if (!res.ok) return { ok: false, reason: classifyHttp(res.status, body) };
  if (body && body.error) return { ok: false, reason: classifyHttp(200, body) };

  const raw = [].concat(body.ad_creatives || [], body.ads || [], body.creatives || []).filter(Boolean);

  const seen = new Set();
  const mapped = raw.map((c, i) => ({
    creativeId: String(c.ad_creative_id || c.creative_id || c.id || `c_${i}`),
    imageUrl: String(c.image || c.image_url || c.thumbnail || "").trim(),
    // A creative with no `image` carries a JavaScript preview `link` instead
    // (displayads-formats.googleusercontent.com/ads/preview/content.js). A
    // vision model cannot read that. We keep it, flagged, rather than dropping
    // it silently — "1,900 found" then "40 read" has to be reconcilable.
    previewLink: String(c.link || "").trim(),
    advertiser: String(c.advertiser || c.advertiser_name || "").trim(),
    advertiserId: String(c.advertiser_id || "").trim(),
    // The cross-check for agency attribution: when `advertiser` is the agency
    // ("Fogarty and Klein, Inc."), targetDomain still holds the real domain.
    targetDomain: normDomain(c.target_domain || ""),
    format: String(c.format || c.creative_format || params.creative_format).toLowerCase(),
    width: Number(c.width) || null,
    height: Number(c.height) || null,
    firstShown: epochToDate(c.first_shown),
    lastShown: epochToDate(c.last_shown ?? c.last_seen),
    totalDaysShown: Number.isFinite(+c.total_days_shown) ? Math.max(0, Math.round(+c.total_days_shown)) : null,
    detailsLink: String(c.details_link || "").trim(),
  })).filter((c) => !seen.has(c.creativeId) && seen.add(c.creativeId));

  const renderable = mapped.filter((c) => c.imageUrl && /^https?:\/\//i.test(c.imageUrl));
  const previewOnly = mapped.filter((c) => !c.imageUrl && c.previewLink);

  const providerTotal = Number.isFinite(+(body.search_information || {}).total_results)
    ? +body.search_information.total_results : mapped.length;

  // ---- the capture-run record ----------------------------------------------
  // Everything a later sentence needs in order to be true. `complete` is the
  // single most important field in this object: when it is false, the analysis
  // layer must not emit superlatives or market-wide absence claims.
  const run = {
    domain: d,
    format: params.creative_format,
    platform: params.platform || "(all)",
    region: params.region,
    window: { start: params.start_date, end: params.end_date },
    providerTotal,
    returned: mapped.length,
    renderable: renderable.length,
    previewOnly: previewOnly.length,
    complete: providerTotal <= mapped.length,
    capturedAt: new Date().toISOString(),
  };

  // Multiple advertiser accounts pointing at one domain is normal and is the
  // agency-attribution case. Surfaced, never silently merged.
  const advertisers = [...new Set(mapped.map((c) => c.advertiser).filter(Boolean))];
  run.advertisers = advertisers;
  run.multipleAdvertisers = advertisers.length > 1;

  return { ok: true, creatives: renderable, previewOnly, run };
}

/**
 * Which creatives get read, when the cap bites.
 *
 * Ordered by EVIDENCE QUALITY, not array position:
 *   1. freshness first — an ad still being served is what Creative wants to see
 *   2. longevity as the tiebreak — an ad a competitor kept paying for across
 *      1,169 days is worth reading before one that ran 30
 *
 * This is the reverse of the SEM tool's pure-longevity sort, on purpose.
 * The SEM tool asks "what has proven itself?"; Creative asks "what is running
 * now?" — and a longevity-only sort floats old evergreen work above the fresh
 * campaign the creative team actually wants to see.
 */
export function rankByEvidenceQuality(creatives) {
  const today = Date.now();
  const daysSince = (d) => {
    if (!d) return 9999;
    const t = Date.parse(d + "T00:00:00Z");
    return Number.isFinite(t) ? Math.floor((today - t) / 86400000) : 9999;
  };
  return (creatives || []).slice().sort((a, b) => {
    const fa = daysSince(a.lastShown), fb = daysSince(b.lastShown);
    // Bucket freshness so that a 2-day gap doesn't outrank 800 days of longevity.
    const ba = fa <= 7 ? 0 : fa <= 30 ? 1 : fa <= 90 ? 2 : 3;
    const bb = fb <= 7 ? 0 : fb <= 30 ? 1 : fb <= 90 ? 2 : 3;
    if (ba !== bb) return ba - bb;
    return (b.totalDaysShown ?? -1) - (a.totalDaysShown ?? -1);
  });
}

/**
 * Which creatives get read, when the cap bites.
 *
 * Ranked by evidence quality — freshness first, longevity as the tiebreak —
 * and then spread ACROSS CAMPAIGNS rather than taken straight off the top.
 *
 * ---------------------------------------------------------------------------
 * WHY A STRAIGHT TOP-N IS THE WRONG PICK
 * ---------------------------------------------------------------------------
 * Ranking alone sorts by longevity within the freshest bucket, so the
 * longest-running campaign takes every slot. That is invisible for a community
 * bank running one campaign and severe for a national: Chase's longest-running
 * display work is evergreen card marketing, so a 30-slot cap filled top-down
 * returned 30 card creatives and the checking campaign — newer, therefore
 * shorter-running — never got read at all. The wall then reports that Chase
 * advertises no checking, which is a claim about Chase rather than about our
 * sampling.
 *
 * A creative's PRODUCT is unknowable before its image is read, so we cannot
 * select for product directly. `firstShown` is the usable proxy: creatives from
 * one campaign launch together, so round-robin across launch cohorts buys
 * breadth across campaigns with the same number of vision calls. Within a
 * cohort the quality ranking still decides.
 */
export function selectForReading(creatives, max = MAX_READ_PER_ADVERTISER) {
  const ranked = rankByEvidenceQuality(creatives);

  // Cohort = launch month. Insertion order follows the ranking, so the cohort
  // holding the single best creative is served first.
  const cohorts = new Map();
  for (const c of ranked) {
    const key = (c.firstShown || "unknown").slice(0, 7);
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(c);
  }

  const queues = [...cohorts.values()];
  const out = [];
  for (let i = 0; out.length < max && queues.some((q) => q.length); i++) {
    const q = queues[i % queues.length];
    if (q.length) out.push(q.shift());
  }
  return out;
}

async function downloadOne(creative, domain) {
  try {
    const res = await withTimeout((signal) => fetch(creative.imageUrl, { signal }), IMAGE_TIMEOUT_MS);
    if (!res.ok) return null;
    const ct = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(ct)) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_IMAGE_BYTES) return null;
    // The body read sits outside withTimeout's abort scope, so bound it again —
    // otherwise a slow trickle holds a capture open indefinitely.
    const buf = await Promise.race([
      res.arrayBuffer().then((a) => Buffer.from(a)),
      new Promise((_, rej) => setTimeout(() => rej(new Error("body_timeout")), IMAGE_TIMEOUT_MS)),
    ]);
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return {
      ...creative,
      data: buf.toString("base64"),
      mediaType: ct === "image/jpg" ? "image/jpeg" : ct,
      // Byte-identical creatives are common in ad libraries. Hashing before
      // extraction means we never pay a vision call twice for the same picture.
      bytesHash: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16),
      domain,
    };
  } catch {
    return null;                        // one broken image is not a failed run
  }
}

/**
 * Download creatives server-side, bounded concurrency, skip-on-failure.
 * 19 of 21 succeeding is a success with 19 images, never a failure.
 * Byte-identical duplicates collapse here, before any model sees them.
 */
export async function downloadCreatives(creatives, domain) {
  const out = [];
  for (let i = 0; i < creatives.length; i += IMAGE_CONCURRENCY) {
    const batch = await Promise.all(
      creatives.slice(i, i + IMAGE_CONCURRENCY).map((c) => downloadOne(c, domain))
    );
    for (const img of batch) if (img) out.push(img);
  }

  const byHash = new Map();
  let exactDupes = 0;
  for (const img of out) {
    const prev = byHash.get(img.bytesHash);
    if (prev) {
      prev.duplicateIds = prev.duplicateIds || [];
      prev.duplicateIds.push(img.creativeId);
      // Keep the longest-running instance as the representative.
      if ((img.totalDaysShown ?? -1) > (prev.totalDaysShown ?? -1)) {
        prev.totalDaysShown = img.totalDaysShown;
        prev.firstShown = img.firstShown;
      }
      exactDupes++;
    } else {
      byHash.set(img.bytesHash, img);
    }
  }

  return {
    images: [...byHash.values()],
    downloadFailed: creatives.length - out.length,
    exactDupes,
  };
}

/**
 * The whole capture path for ONE domain and ONE format: list -> select -> download.
 * Extraction happens in lib/extract.js so that provider concerns and model
 * concerns never share a file.
 */
export async function capture(domain, opts = {}) {
  const listing = await listCreatives(domain, opts);
  if (!listing.ok) return { ok: false, reason: listing.reason, domain: normDomain(domain) };

  if (!listing.creatives.length) {
    return {
      ok: true, images: [], run: listing.run,
      reason: listing.run.previewOnly > 0 ? "preview_only" : "no_ads",
    };
  }

  // THE CAP GOVERNS VISION CALLS, NOT DOWNLOADS.
  //
  // It used to govern downloads: the cap was applied first and the byte-dedupe
  // ran afterwards, so duplicate renders of one creative ate the budget before
  // anything was read. Measured on a live capture, Campus Federal spent all 18
  // of its slots to come back with 7 distinct creatives — 61% of the budget
  // bought copies of artwork already in hand, and the campaigns that never got
  // read were the ones carrying the offers.
  //
  // Downloading is free; only the vision call is priced. So we download a wider
  // pool, collapse identical artwork, and then spend the cap on what is left.
  // Same spend, distinct creatives.
  const max = opts.max || MAX_READ_PER_ADVERTISER;
  const pool = selectForReading(listing.creatives, max * DEDUPE_POOL_FACTOR);
  const { images: distinct, downloadFailed, exactDupes } = await downloadCreatives(pool, normDomain(domain));
  const images = distinct.slice(0, max);

  // NOTHING CAME BACK, AND WHY IS THE WHOLE ANSWER.
  //
  // The empty-listing path above already says which kind of nothing it found —
  // "preview_only" or "no_ads". This path did not. A capture that LISTED four
  // creatives and failed to download every one of them returned ok:true with an
  // empty array and no reason at all, so the target rendered as "empty" with a
  // blank explanation: on screen, indistinguishable from a competitor who is
  // simply not advertising.
  //
  // That is the line this product does not cross. "We could not fetch their
  // artwork" is a fact about our capture; "they are not advertising" is a claim
  // about them, and only one of them is true here.
  const emptyReason = images.length ? undefined
    : downloadFailed > 0 ? "download_failed"
      : listing.run.previewOnly > 0 ? "preview_only"
        : "no_ads";

  return {
    ok: true,
    images,
    // Present only when there is nothing to show. A caller that reads this
    // without checking images.length gets undefined, which is correct.
    reason: emptyReason,
    run: {
      ...listing.run,
      // What the cap actually admitted, post-dedupe — the number the funnel's
      // "selected to read" step reports.
      selectedForReading: images.length,
      // THE CAP THIS CAPTURE RAN UNDER, recorded so a later run can tell
      // whether the ceiling has since been raised. Without it the only
      // available comparison is read-count against renderable, and those
      // legitimately differ whenever dedupe collapses identical artwork — so a
      // cache entry would look permanently "short" and re-fetch on every run
      // while never being able to catch up.
      readCap: max,
      downloadPool: pool.length,
      distinctDownloaded: distinct.length,
      downloaded: distinct.length + exactDupes,
      downloadFailed,
      exactDupes,
      // The chain any status line must be able to reconcile:
      //   providerTotal -> returned -> renderable -> selected -> read
      capped: distinct.length > images.length || listing.creatives.length > pool.length,
    },
  };
}

/**
 * A Transparency Center link scoped to the BANK'S DOMAIN rather than to the
 * verified advertiser account.
 *
 * The provider's own `details_link` points at
 * `/advertiser/AR…/creative/CR…`, so the page it opens is titled with whoever
 * Google verified as the advertiser. For an institution whose media is bought
 * through an agency that is a third party's name — the reported case being a
 * competitor whose creatives open under an unrelated company, and MidFirst's
 * ads sitting under "Fogarty and Klein, Inc." — which reads, to anyone glancing
 * at a screen share, as though the tool pulled the wrong bank.
 *
 * The domain-scoped view has no such problem: it is titled with the domain that
 * was entered, and it shows every advertiser account pointing at that domain,
 * which is the honest picture anyway.
 *
 * So this becomes the PRIMARY link everywhere. The creative-specific
 * `details_link` stays available in the evidence drawer as a secondary link,
 * labelled with the advertiser name so the agency attribution is explained
 * rather than merely encountered.
 */
export function buildDomainLink(domain, { days = DEFAULT_LOOKBACK_DAYS, format = "image", platform = null } = {}) {
  const d = normDomain(domain);
  if (!d) return "";
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const iso = (x) => x.toISOString().slice(0, 10);
  const p = new URLSearchParams({
    region: "US",
    "start-date": iso(start),
    "end-date": iso(end),
    domain: d,
  });
  // The UI's format vocabulary, not ours: TEXT / IMAGE / VIDEO.
  if (format) p.set("format", String(format).toUpperCase());
  if (platform) p.set("platform", String(platform).toUpperCase());
  return `https://adstransparency.google.com/?${p}`;
}
