// =============================================================================
// lib/meta-analyze.js — pure logic for the Meta source.
//
// Same rule as analyze.js: EVERY NUMBER IS COMPUTED HERE, never by a model.
// Separate file because Meta's grain and semantics are different, and a shared
// module invites the exact merge this architecture forbids. Nothing here ever
// touches a Google record and nothing in analyze.js ever touches a Meta one.
//
// The two things this file exists to do:
//
//   1. MESSAGE DEDUPE. 420 cards behind 111 probed ads, and most cards are the
//      same message rendered at different sizes — one La Capitol HELOC ad
//      carried six cards with byte-identical copy and six different video
//      renders. The wall's unit is the MESSAGE, and vision is paid for once per
//      message rather than once per asset.
//
//   2. CHEAP-FIRST CLASSIFICATION. Unlike a Google banner, where copy exists
//      only in pixels, a Meta card ships machine-readable text and a
//      destination URL. Roughly half the probed ads classify from the URL path
//      alone, at no cost and with no chance of a misread digit. Vision is the
//      fallback, not the default.
//
// The dedupe ALGORITHM is the contract. No count from the probe is hard-coded
// anywhere: run it on different data and a different number is the correct
// answer.
// =============================================================================

import { PRODUCT_LABELS, coerceProductCode, bucketFor } from "./products.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/* Tracking parameters that never change what a destination MEANS. Stripped for
   grouping only — the original URL is kept intact on every unit, because the
   RAIN-managed signal lives in exactly these parameters. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|_ga|mc_cid|mc_eid|ref$|referrer$)/i;

/**
 * Canonical destination for grouping.
 *
 * Deliberately conservative: strips known tracking parameters and nothing else.
 * A blanket "drop the query string" would merge `/apply?product=heloc` with
 * `/apply?product=auto`, which are different offers at the same path.
 */
export function canonicalDestination(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (!TRACKING_PARAMS.test(k)) keep.append(k, v);
    const q = keep.toString();
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${q ? `?${q}` : ""}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Group units into distinct creative messages.
 *
 * Identity is what the ad SAYS plus where it SENDS. Two cards with the same
 * headline, body and destination are one message with two renders.
 *
 * FAIL OPEN: a unit with no text and no destination gets a unique key rather
 * than joining an "empty" bucket. Wrongly splitting costs one extra vision call;
 * wrongly merging destroys evidence and produces a count nobody can reproduce.
 *
 * Never groups across advertisers. Two banks running the same headline are not
 * variations of one idea — they are two competitors making the same bet, which
 * is a finding rather than a duplicate.
 */
export function dedupeMessages(units = []) {
  const groups = new Map();

  for (const u of units) {
    const title = norm(u.title);
    const body = norm(u.body).slice(0, 220);
    const dest = canonicalDestination(u.destinationUrl);
    const hasSignal = title || body || dest;

    const key = hasSignal
      ? [u.institution, title, body, dest].join("|")
      : `${u.institution}|__unique__|${u.unitId}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }

  return [...groups.values()].map((members) => {
    // Prefer a member with real artwork as the representative — a video-only
    // card still has a preview frame, but an image card reads better.
    const rep = members.find((m) => m.imageUrl) || members[0];

    const assets = [...new Set(members.map((m) => m.imageUrl || m.videoPreviewUrl).filter(Boolean))];
    const adIds = [...new Set(members.map((m) => m.sourceAdId))];

    return {
      ...rep,
      messageId: `${rep.institution}:${rep.sourceAdId}:${rep.cardIndex}`,
      // These two counts are DIFFERENT and are labelled differently in the UI.
      // "3 ad records" means Meta served this message under three ad objects;
      // "6 assets" means one message rendered six ways. Calling both
      // "variations" would make the wall unreadable.
      adRecordCount: adIds.length,
      assetCount: assets.length,
      sourceAdIds: adIds,
      unitIds: members.map((m) => m.unitId),
      assetUrls: assets.slice(0, 8),
      // A message is RAIN-managed if any member carries the tracking signal.
      rainManaged: members.some((m) => m.rainManaged),
      isVideo: members.some((m) => m.isVideo),
    };
  }).sort((a, b) => {
    if (b.adRecordCount !== a.adRecordCount) return b.adRecordCount - a.adRecordCount;
    return String(b.startDate).localeCompare(String(a.startDate));
  });
}

// ---------------------------------------------------------------------------
// TIER 1 + 2 — deterministic classification, before any model call
// ---------------------------------------------------------------------------

const URL_PATTERNS = [
  ["heloc", /heloc|home-?equity|equity-?line/],
  ["mortgage", /mortgage|home-?loan|home-?refinance|first-?time-?home/],
  ["auto-loan", /auto-?(loan|refinance)|vehicle-?loan|car-?loan/],
  ["credit-card", /credit-?card|cash-?back-?card|rewards-?card/],
  ["personal-loan", /personal-?loan|signature-?loan/],
  ["cd", /certificate|share-?cert|\bcds?\b|term-?deposit/],
  ["money-market", /money-?market/],
  ["savings", /savings|high-?yield/],
  ["checking", /checking/],
  ["business", /business|commercial|\bsba\b|merchant/],
  ["wealth", /wealth|invest|retirement|\bira\b/],
];

const TEXT_PATTERNS = [
  ["heloc", /\bheloc\b|home equity line|home equity loan/i],
  ["mortgage", /\bmortgage\b|home loan|first-time homebuyer|refinance your home/i],
  ["auto-loan", /auto loan|auto refinance|car loan|vehicle loan/i],
  ["credit-card", /credit card|cash back card|rewards card/i],
  ["personal-loan", /personal loan|signature loan/i],
  ["cd", /certificate of deposit|share certificate|\bcd rate/i],
  ["money-market", /money market/i],
  ["savings", /savings account|high-yield savings/i],
  ["checking", /checking account|\bchecking\b/i],
  ["business", /business (checking|savings|loan|account)|commercial lending/i],
];

/**
 * Classify from the destination path, then from provider text.
 *
 * On the probe corpus the URL alone resolved 59 of 106 ads with a link — a
 * genuinely useful slice, and NOT the "everything" it is tempting to assume.
 * The rest are DoubleClick redirects, Instagram profile links, shorteners and
 * campaign vanity paths, none of which carry a product. Which is exactly why
 * this returns a PROVENANCE alongside the answer: a strategist auditing a count
 * needs to know whether it came from a URL, from copy, or from a model.
 */
export function classifyDeterministic(message) {
  const dest = String(message.destinationUrl || "");
  let pathPart = "";
  try { pathPart = new URL(dest).pathname.toLowerCase(); } catch { pathPart = dest.toLowerCase(); }

  for (const [code, re] of URL_PATTERNS) {
    if (re.test(pathPart)) return { product: code, confidence: 0.92, from: "url" };
  }

  const text = `${message.title || ""} ${message.body || ""} ${message.description || ""}`;
  if (text.trim()) {
    for (const [code, re] of TEXT_PATTERNS) {
      if (re.test(text)) return { product: code, confidence: 0.8, from: "provider_text" };
    }
  }

  return { product: null, confidence: 0, from: "unresolved" };
}

/**
 * Offers literally present in provider text.
 *
 * TRANSCRIPTION, not interpretation. The string is preserved exactly as
 * written; nothing is rounded, converted or completed. A term or minimum is
 * captured only when it appears next to the figure — otherwise those fields
 * stay empty, which means NOT STATED, never "no minimum".
 */
export function extractOfferFromText(message) {
  const text = `${message.title || ""} ${message.body || ""} ${message.description || ""}`;
  if (!text.trim()) return null;

  const rate = text.match(/(\d+(?:\.\d+)?)\s*%\s*(APY|APR)/i);
  if (rate) {
    const value = rate[0].replace(/\s+/g, " ").trim();
    return {
      type: "rate", value,
      unit: rate[2].toUpperCase(),
      term: (text.match(/\b(\d+)[-\s]?(month|year|mo|yr)s?\b/i) || [])[0] || "",
      minimum: (text.match(/\$[\d,]+\s*(minimum|min\.?)|(minimum|min\.?)\s*(deposit\s*)?of\s*\$[\d,]+/i) || [])[0] || "",
      qualifier: /new (member|customer|account)/i.test(text) ? (text.match(/new (member|customer|account)s?/i) || [])[0] : "",
      numeric: { n: parseFloat(rate[1]), kind: "percent" },
      from: "provider_text",
    };
  }

  const dollar = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  if (dollar) {
    const isBonus = /bonus|get \$|earn \$|cash back|reward/i.test(text);
    return {
      type: isBonus ? "bonus" : "other",
      value: dollar[0].replace(/\s+/g, ""),
      unit: "USD",
      term: "", 
      minimum: (text.match(/\$[\d,]+\s*(minimum|min\.?)/i) || [])[0] || "",
      qualifier: /new (member|customer|account)/i.test(text) ? (text.match(/new (member|customer|account)s?/i) || [])[0] : "",
      numeric: { n: parseFloat(dollar[1].replace(/,/g, "")), kind: "usd" },
      from: "provider_text",
    };
  }

  return null;
}

/**
 * Apply deterministic enrichment across all messages and report what remains
 * for vision. `needsVision` is what the read cap gets applied to — after dedupe
 * and after the free tiers, never before.
 */
export function enrichDeterministic(messages = []) {
  let fromUrl = 0, fromText = 0, unresolved = 0, offersFromText = 0;

  for (const m of messages) {
    const c = classifyDeterministic(m);
    if (c.product) {
      m.product = coerceProductCode(c.product);
      m.productConfidence = c.confidence;
      m.productFrom = c.from;
      if (c.from === "url") fromUrl++; else fromText++;
    } else {
      m.product = null;
      m.productFrom = "unresolved";
      unresolved++;
    }

    const offer = extractOfferFromText(m);
    if (offer) { m.offer = offer; m.offerFrom = "provider_text"; offersFromText++; }
  }

  return {
    messages,
    fromUrl, fromText, unresolved, offersFromText,
    needsVision: messages.filter((m) => !m.product || !m.offer),
  };
}

// ---------------------------------------------------------------------------
// AGGREGATION
// ---------------------------------------------------------------------------

export function metaProductBreakdown(messages = []) {
  const counts = new Map();
  for (const m of messages) {
    const code = m.product || "other";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, n]) => ({ code, label: PRODUCT_LABELS[code] || code, count: n }))
    .sort((a, b) => b.count - a.count);
}

export function filterMetaByProduct(messages, product, { includeAdjacent = false } = {}) {
  if (!product || product === "all" || product === "other") return messages;
  return messages.filter((m) => {
    const b = bucketFor(m.product || "other", product);
    return b === "on" || (includeAdjacent && b === "adjacent");
  });
}

export function metaCreativeSummary(messages = []) {
  const byProvenance = { url: 0, provider_text: 0, vision: 0, unresolved: 0 };
  for (const m of messages) byProvenance[m.productFrom || "unresolved"] = (byProvenance[m.productFrom || "unresolved"] || 0) + 1;

  return {
    messages: messages.length,
    adRecords: new Set(messages.flatMap((m) => m.sourceAdIds || [])).size,
    assets: messages.reduce((n, m) => n + (m.assetCount || 1), 0),
    withOffer: messages.filter((m) => m.offer).length,
    video: messages.filter((m) => m.isVideo).length,
    rainManaged: messages.filter((m) => m.rainManaged).length,
    active: messages.filter((m) => m.isActive).length,
    classification: byProvenance,
    platforms: [...new Set(messages.flatMap((m) => m.platforms || []))],
  };
}

/**
 * The Meta funnel. Its own steps, its own vocabulary — Google's funnel talks
 * about preview-only links and a 100-per-request ceiling, neither of which
 * exists here.
 *
 * Every number is arithmetic over captured records. Nothing is estimated and
 * nothing is model-produced.
 */
export function metaFunnel(runs = [], messages = [], onProduct = null, visionRead = 0) {
  const sum = (k) => runs.reduce((n, r) => n + (Number(r?.[k]) || 0), 0);

  const reported = sum("providerTotal");
  const retrieved = sum("retrieved");
  const rawUnits = sum("rawUnits");
  const deduped = messages.length;
  const pages = sum("pagesFetched");
  const moreAvailable = runs.some((r) => r?.moreAvailable);

  const steps = [
    { key: "reported", label: "reported by Meta", value: reported },
    {
      key: "retrieved", label: "ads retrieved", value: retrieved,
      lost: Math.max(0, reported - retrieved),
      why: `beyond the ${pages}-page capture ceiling`,
    },
    { key: "units", label: "creative cards inside them", value: rawUnits },
    {
      key: "messages", label: "distinct messages", value: deduped,
      lost: Math.max(0, rawUnits - deduped),
      why: "the same copy and destination rendered at different sizes",
    },
    { key: "read", label: "read by vision", value: visionRead,
      why: "only messages the URL and copy could not resolve" },
  ];

  if (onProduct != null) {
    steps.push({
      key: "onProduct", label: "on the product in scope", value: onProduct,
      lost: Math.max(0, deduped - onProduct), why: "classified as a different product",
    });
  }

  return {
    reported, retrieved, rawUnits, messages: deduped, visionRead, onProduct,
    pagesFetched: pages, moreAvailable,
    steps: steps.filter((s) => s.value > 0 || s.lost > 0),
  };
}

/**
 * Sampling note for Meta. Separate from the Google one because the reason a
 * capture is partial is different: Google truncates at a per-request ceiling,
 * Meta at a page ceiling we chose in order not to spend twenty requests on one
 * advertiser.
 */
export function metaSamplingNote(runs = []) {
  // Keyed on `complete`, NOT on whether a page token happened to remain.
  // Retrieving 4 of a reported 44 is a sample even when pagination ran out —
  // the ceiling that stopped us is irrelevant to the reader, and only the
  // relationship between what was reported and what we hold is.
  const partial = runs.filter((r) => r && r.complete === false);
  const reported = runs.reduce((n, r) => n + (Number(r?.providerTotal) || 0), 0);
  const retrieved = runs.reduce((n, r) => n + (Number(r?.retrieved) || 0), 0);

  return {
    complete: partial.length === 0,
    reported, retrieved,
    note: partial.length === 0
      ? `All ${retrieved} Meta ads matching this window were retrieved.`
      : `${retrieved} of about ${reported.toLocaleString()} Meta ads were retrieved. Findings describe the ads captured, not everything the competitor is running.`,
  };
}

/**
 * Display copy for a Meta ad's timing. Fixed HERE, in code, so no caller can
 * shorten it into something the data does not support.
 *
 * The probe found all 111 ads `is_active: true` while all 111 carried an
 * `end_date` in the past — 78 of them dated the day before the run. So
 * `end_date` behaves like a rolling last-observed stamp, not a stop date, and
 * rendering "Aug 18 → Aug 24" for a live ad would tell a strategist it had
 * finished when it had not.
 *
 * Also absent on purpose: any day count. Google's "shown on 1,169 days" is a
 * provider-supplied days-served field. Meta has no equivalent, and
 * end minus start is not one.
 */
export function metaTimingLabel(message) {
  const started = message.startDate ? fmtDate(message.startDate) : "";
  if (message.isActive) return started ? `Active · started ${started}` : "Active";
  return started ? `Started ${started}` : "";
}

function fmtDate(iso) {
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
