// =============================================================================
// lib/meta-provider.js — SearchApi.io -> Meta Ad Library.
//
// The Meta sibling of atc-provider.js. Same contract, same discipline: fetch,
// normalize, report an honest capture record, decide nothing.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT "ANOTHER FILE IN THE PROVIDER LAYER"
// ---------------------------------------------------------------------------
// The README used to claim adding Meta would be a new provider file and nothing
// else. A live probe of 111 unique Meta ads disproved that. Meta changes the
// CARDINALITY of the evidence:
//
//   Google:  1 ad = 1 creative = 1 image = 1 analysis record
//   Meta:    1 ad = up to 7 cards = up to 8 media assets
//
// 95 of 111 probed ads carried cards. 420 cards sat behind them. So a Meta ad is
// a CONTAINER, and the thing worth classifying and showing is the card. This
// file's job is to turn a container into units without losing the container.
//
// Three more things the probe settled, all encoded below:
//
//   1. 64 of 111 ads had `{{product.name}}` / `{{product.brand}}` as their
//      TOP-LEVEL text — 58% — while ZERO cards did. Dynamic-creative ads keep
//      their real copy in the cards and leave a template at the parent. Reading
//      `snapshot.body` classifies the majority of the corpus as gibberish.
//   2. `end_date` is not a stop date. All 111 ads were `is_active: true` and all
//      111 had an `end_date` in the past — 78 of them dated the day before the
//      probe ran. It behaves like a rolling last-observed stamp.
//   3. Media URLs are signed `fbcdn.net` links carrying `oe=` expiry tokens.
//      They are fetch-now values, not durable identifiers.
// =============================================================================

import crypto from "node:crypto";
import { normDomain } from "./atc-provider.js";
import { getIdentity, getMetaPageId, gradeResolution, isAutoPersistable, saveIdentity } from "./platform-identity.js";

const ENDPOINT = "https://www.searchapi.io/api/v1/search";
const TIMEOUT_MS = Number(process.env.SEARCHAPI_TIMEOUT_MS || 25000);

/* Pages fetched per advertiser, per capture.
   The probe reported 600 ads for Chase at ~30 rows a page — exhausting one
   advertiser would be ~20 requests. Five competitors would be a hundred.
   SearchApi bills per request, so exhaustive capture is not a default anyone
   can afford; it is a thing a strategist asks for explicitly. */
export const MAX_META_PAGES = Number(process.env.RI_META_MAX_PAGES || 2);

/* Distinct MESSAGES read by the vision model per advertiser. Applied after
   message dedupe, never before — reading 420 cards when they carry 153 distinct
   messages is paying four times for one answer. */
export const MAX_META_READ = Number(process.env.RI_META_MAX_READ || 18);

export const DEFAULT_META_LOOKBACK_DAYS = 90;

/* RAIN's own campaign tracking. 59 of 60 La Capitol Meta ads carried
   utm_source=rain-7246, so this is the common case for a managed client, not an
   edge case.

   Called RAIN-MANAGED, never "RAIN-authored": a tracking parameter proves the
   campaign runs through RAIN's tracking, not who designed the creative.

   Detected from the ORIGINAL destination URL, before any tracking parameters
   are stripped for message grouping — strip first and the signal is gone. */
const RAIN_UTM = new RegExp(process.env.RI_RAIN_UTM_PATTERN || "utm_source=rain[-_a-z0-9]*", "i");

const TEMPLATE_RE = /\{\{[^}]+\}\}/;

export function hasSearchApiKey() {
  return !!(process.env.SEARCHAPI_API_KEY && process.env.SEARCHAPI_API_KEY.trim());
}

const clean = (v) => String(v ?? "").trim();

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

function classifyHttp(status, body) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  const msg = String((body && (body.error || body.message)) || "").toLowerCase();
  if (msg.includes("api key") || msg.includes("unauthorized")) return "auth";
  if (msg.includes("limit") || msg.includes("quota") || msg.includes("exceeded")) return "quota";
  return "provider_error";
}

async function call(params) {
  const qs = new URLSearchParams({ ...params, api_key: process.env.SEARCHAPI_API_KEY });
  let res, body;
  try {
    res = await withTimeout(
      (signal) => fetch(`${ENDPOINT}?${qs}`, { signal, headers: { accept: "application/json" } }),
      TIMEOUT_MS
    );
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : "provider_error" };
  }
  try { body = await res.json(); } catch { return { ok: false, reason: "provider_error" }; }
  if (!res.ok) return { ok: false, reason: classifyHttp(res.status, body) };
  if (body && body.error) return { ok: false, reason: classifyHttp(200, body) };
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// PAGE RESOLUTION
// ---------------------------------------------------------------------------

function nameScore(query, candidate) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(query), c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = new Set(q.split(" ")), ct = new Set(c.split(" "));
  const hits = [...qt].filter((t) => ct.has(t)).length;
  return hits / Math.max(qt.size, 1);
}

/**
 * Resolve an institution to a Meta Page.
 *
 * Order matters and is a cost decision as much as a correctness one:
 *   1. the registry — free, human-verified, and the answer for known clients
 *   2. page search  — one SearchApi request, only for unknowns
 *
 * An ambiguous result does NOT fetch ads from a guess. It returns
 * `needs_confirmation` with the candidates, because a wrong Page silently
 * becomes permanent ground truth the moment anyone saves it.
 */
export async function resolvePage({ domain, name }) {
  const d = normDomain(domain);
  const known = getIdentity(d);
  if (known?.metaPageId) {
    return {
      ok: true, pageId: String(known.metaPageId), pageName: known.metaPageName || name || d,
      grade: known.confidence || "high", source: "registry", requests: 0,
    };
  }

  if (!hasSearchApiKey()) return { ok: false, reason: "not_configured", requests: 0 };

  const r = await call({ engine: "meta_ad_library_page_search", q: name || d });
  if (!r.ok) return { ok: false, reason: r.reason, requests: 1 };

  const raw = [].concat(r.body.pages || r.body.data || r.body.results || []).filter(Boolean);
  const candidates = raw.map((p) => ({
    pageId: String(p.page_id || p.id || ""),
    pageName: clean(p.name || p.page_name),
    category: clean(p.category),
    likes: Number(p.likes) || null,
    verified: !!p.verification || !!p.is_verified,
    imageUri: clean(p.image_uri || p.picture),
    score: nameScore(name || d, p.name || p.page_name),
  })).filter((c) => c.pageId);

  if (!candidates.length) return { ok: false, reason: "no_page_match", requests: 1 };

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const margin = candidates.length > 1 ? top.score - candidates[1].score : 1;
  const grade = gradeResolution({ score: top.score, margin, candidateCount: candidates.length });

  // Low confidence stops here. This is the Chase case: score 1.0, margin 0.0033,
  // fifteen Pages with the same name. Fetching ads from the first one would put
  // an unrelated advertiser's creatives under a competitor's name.
  if (grade === "low") {
    return {
      ok: false, reason: "needs_confirmation", requests: 1,
      candidates: candidates.slice(0, 6), grade, margin: Number(margin.toFixed(4)),
    };
  }

  if (isAutoPersistable(grade)) {
    saveIdentity(d, {
      metaPageId: top.pageId, metaPageName: top.pageName,
      resolvedBy: "page_search", confidence: grade,
      note: `auto-resolved: score ${top.score.toFixed(2)}, margin ${margin.toFixed(3)}, ${candidates.length} candidates`,
    });
  }

  return {
    ok: true, pageId: top.pageId, pageName: top.pageName, grade,
    margin: Number(margin.toFixed(4)), source: "page_search",
    candidates: candidates.slice(0, 6), requests: 1,
  };
}

// ---------------------------------------------------------------------------
// AD LISTING
// ---------------------------------------------------------------------------

function startDateFor(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function buildAdParams({ pageId, days, pageToken }) {
  const p = {
    engine: "meta_ad_library",
    page_id: String(pageId),
    country: "US",
    // ad_type=all ONLY. The probe settled the union question: La Capitol's 30
    // `credit_ads` IDs were all inside the 60 `all` IDs retrieved, so `all` is a
    // superset and a second category call is a doubled bill for no new records.
    ad_type: "all",
    active_status: "all",
    // NOTE: SearchApi documents this as an EARLIEST-START filter, not a served-
    // within-window filter. It excludes an ad that started before the date and
    // is still running today — the opposite of Google's behaviour at the
    // boundary. See lib/sources.js WINDOW_OPTIONS for the user-facing wording.
    start_date: startDateFor(days),
    sort_by: "most_recent",
  };
  if (pageToken) p.next_page_token = pageToken;
  return p;
}

// ---------------------------------------------------------------------------
// NORMALIZATION — container to units
// ---------------------------------------------------------------------------

/**
 * Is this string real ad copy, or a dynamic-creative placeholder?
 *
 * 58% of probed ads had `{{product.name}}` at the parent level. This is the
 * guard that stops a template becoming a headline, a product signal or an offer.
 */
export function isTemplate(text) {
  return TEMPLATE_RE.test(String(text || ""));
}

function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  return clean(body.text);
}

function mediaFromCard(c) {
  return {
    imageUrl: clean(c.resized_image_url || c.original_image_url),
    imageOriginalUrl: clean(c.original_image_url),
    videoPreviewUrl: clean(c.video_preview_image_url),
    videoUrl: clean(c.video_hd_url || c.video_sd_url),
    isVideo: !!(c.video_hd_url || c.video_sd_url),
  };
}

/**
 * One provider ad -> { ad, units[] }.
 *
 * If cards exist, THE CARDS ARE THE UNITS and parent text is metadata only.
 * If not, the parent snapshot becomes a single unit.
 *
 * The parent is never discarded: every unit carries `sourceAdId` back to it, so
 * a strategist can always get from a wall card to the Meta ad it came from.
 */
export function normalizeMetaAd(rec, { domain, label }) {
  const s = rec.snapshot || {};
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const images = Array.isArray(s.images) ? s.images : [];
  const videos = Array.isArray(s.videos) ? s.videos : [];

  const parentTemplated = isTemplate(s.title) || isTemplate(bodyText(s.body));

  const ad = {
    source: "meta",
    provider: "searchapi",
    sourceAdId: String(rec.ad_archive_id || rec.id || ""),
    institution: domain,
    institutionLabel: label,
    pageId: String(rec.page_id || s.page_id || ""),
    pageName: clean(rec.page_name || s.page_name),

    // Status and dates stay RAW and stay separate. No totalDaysShown is
    // computed here or anywhere: Meta has no days-served field, and deriving one
    // from end_date - start_date would invent a measurement Google's column
    // already means something else by.
    isActive: rec.is_active !== false,
    startDate: clean(rec.start_date),
    providerEndDate: clean(rec.end_date),   // provider metadata; NOT a stop date

    platforms: [].concat(rec.publisher_platform || s.publisher_platform || []).map(clean).filter(Boolean),
    displayFormat: clean(s.display_format),
    providerCategories: [].concat(rec.categories || []).map(clean).filter(Boolean),
    collationId: clean(rec.collation_id),
    collationCount: Number.isFinite(+rec.collation_count) ? +rec.collation_count : null,
    parentTemplated,
    cardCount: cards.length,
  };

  const units = [];
  const push = (u, idx, media) => {
    const destination = clean(u.destination);
    units.push({
      unitId: `${ad.sourceAdId}#${idx}`,
      sourceAdId: ad.sourceAdId,
      cardIndex: idx,
      institution: domain,
      institutionLabel: label,
      pageId: ad.pageId,
      pageName: ad.pageName,

      title: isTemplate(u.title) ? "" : clean(u.title),
      body: isTemplate(u.body) ? "" : clean(u.body),
      description: isTemplate(u.description) ? "" : clean(u.description),
      cta: clean(u.cta),
      // Original, untouched — RAIN detection reads this BEFORE canonicalization
      // strips the utm parameters that carry the signal.
      destinationUrl: destination,
      rainManaged: RAIN_UTM.test(destination),

      ...media,

      isActive: ad.isActive,
      startDate: ad.startDate,
      providerEndDate: ad.providerEndDate,
      platforms: ad.platforms,
      displayFormat: ad.displayFormat,
      collationId: ad.collationId,
      fromTemplateParent: parentTemplated && idx === -1,
    });
  };

  if (cards.length) {
    cards.forEach((c, i) => push({
      title: c.title, body: c.body, description: c.link_description,
      cta: c.cta_text || c.cta_type, destination: c.link_url,
    }, i, mediaFromCard(c)));
  } else {
    const media = images.length
      ? {
        imageUrl: clean(images[0].resized_image_url || images[0].original_image_url),
        imageOriginalUrl: clean(images[0].original_image_url),
        videoPreviewUrl: "", videoUrl: "", isVideo: false,
      }
      : videos.length
        ? {
          imageUrl: clean(videos[0].video_preview_image_url),
          imageOriginalUrl: "", videoPreviewUrl: clean(videos[0].video_preview_image_url),
          videoUrl: clean(videos[0].video_hd_url || videos[0].video_sd_url), isVideo: true,
        }
        : { imageUrl: "", imageOriginalUrl: "", videoPreviewUrl: "", videoUrl: "", isVideo: false };

    push({
      title: s.title, body: bodyText(s.body), description: s.link_description,
      cta: s.cta_text || s.cta_type, destination: s.link_url,
    }, -1, media);
  }

  return { ad, units };
}

/**
 * Capture one advertiser's Meta ads.
 *
 * Returns provider ads, their units, and a capture record whose numbers must
 * reconcile: providerTotal -> retrieved -> units -> (dedupe happens later).
 */
export async function captureMeta({ domain, label, days = DEFAULT_META_LOOKBACK_DAYS, maxPages = MAX_META_PAGES }) {
  if (!hasSearchApiKey()) return { ok: false, reason: "not_configured", requests: 0 };
  const d = normDomain(domain);
  if (!d) return { ok: false, reason: "bad_domain", requests: 0 };

  let requests = 0;
  const resolved = await resolvePage({ domain: d, name: label });
  requests += resolved.requests || 0;

  if (!resolved.ok) {
    return {
      ok: false, reason: resolved.reason, requests,
      candidates: resolved.candidates || null, grade: resolved.grade || null,
      // A Page we could not resolve and a Page with no ads are DIFFERENT facts.
      // Collapsing them into "no Meta ads" turns a lookup failure into a claim
      // about the competitor's advertising.
      pageResolved: false,
    };
  }

  const ads = [], units = [];
  const seen = new Set();
  let providerTotal = null, pages = 0, token = null;

  for (let i = 0; i < Math.max(1, maxPages); i++) {
    const r = await call(buildAdParams({ pageId: resolved.pageId, days, pageToken: token }));
    requests++;
    if (!r.ok) {
      if (pages === 0) {
        return { ok: false, reason: r.reason, requests, pageResolved: true, pageId: resolved.pageId };
      }
      break;                                  // partial capture, honestly reported
    }
    pages++;

    const batch = [].concat(r.body.ads || r.body.data || r.body.results || []).filter(Boolean);
    if (providerTotal === null) {
      const info = r.body.search_information || r.body.search_metadata || {};
      providerTotal = Number(info.total_results ?? info.total ?? r.body.total_count);
      if (!Number.isFinite(providerTotal)) providerTotal = null;
    }

    for (const rec of batch) {
      const id = String(rec.ad_archive_id || rec.id || "");
      // The same ad recurs across pages. Dedupe on the provider's own ID at
      // ingest so nothing downstream ever counts it twice.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const n = normalizeMetaAd(rec, { domain: d, label });
      ads.push(n.ad);
      units.push(...n.units);
    }

    token = clean(r.body.next_page_token || (r.body.pagination || {}).next_page_token);
    if (!token) break;
  }

  // If a token remains after the ceiling, the capture is a SAMPLE. That is fine
  // and is the normal case for a large advertiser — it just must never be
  // described with a superlative or a market-wide absence claim.
  const complete = !token && (providerTotal === null || ads.length >= providerTotal);

  return {
    ok: true,
    ads,
    units,
    requests,
    run: {
      source: "meta",
      provider: "searchapi",
      domain: d,
      pageId: resolved.pageId,
      pageName: resolved.pageName,
      pageResolvedBy: resolved.source,
      pageGrade: resolved.grade,
      window: { startedSince: startDateFor(days), days },
      providerTotal: providerTotal ?? ads.length,
      retrieved: ads.length,
      rawUnits: units.length,
      templatedParents: ads.filter((a) => a.parentTemplated).length,
      pagesFetched: pages,
      // True only when we stopped at the page ceiling with more still offered.
      // Distinct from `complete`, which also fails when the provider reports
      // more ads than the pages we fetched contained.
      moreAvailable: !!token,
      complete,
      requests,
      capturedAt: new Date().toISOString(),
    },
    pageResolved: true,
    reason: ads.length ? undefined : "no_ads",
  };
}

/** Stable identity for a downloaded asset, so identical media is stored once. */
export function mediaHash(url) {
  return crypto.createHash("sha256").update(String(url || "")).digest("hex").slice(0, 20);
}
