// =============================================================================
// lib/observations.js — the gate between what a model PROPOSED and what the
// findings engine is allowed to COUNT.
//
// extract-search.js lets a model propose structure: this figure is an apy, this
// phrase is early_direct_deposit. That is the right job for a model — it is
// semantics, not arithmetic. But nothing it proposes may be counted until it has
// been checked here against the metric registry and the product profile.
//
// Three things happen in this file, and all three are pure:
//
//   1. VALIDATION. A metric not in the registry, or not relevant to the
//      classified product, is dropped. A claim id outside the vocabulary is
//      dropped into `unclassified` rather than forced into the nearest match.
//   2. PARSING. The verbatim string stays the evidence forever; a numeric value
//      is derived beside it purely so the engine can sort. Unparseable means
//      displayable and not rankable — never discarded.
//   3. RANKABILITY. Set per pair, not per fact, by metrics.comparable(). Two
//      APYs at different terms are both real and cannot be ranked against each
//      other. Saying so is more useful than either ranking them or hiding them.
// =============================================================================

import { metricOf, isRankableMetric, comparable, better } from "./metrics.js";
import { profileFor } from "./profiles.js";

const num = (s) => {
  const t = String(s || "");
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return parseFloat(pct[1]);
  const usd = t.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (usd) return parseFloat(usd[1].replace(/,/g, ""));
  const mo = t.match(/(\d+)\s*(?:-|\s)?(?:month|mo\b|yr|year)/i);
  if (mo) return parseInt(mo[1], 10);
  const bare = t.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return bare ? parseFloat(bare[1]) : null;
};

/**
 * Is this verbatim figure COMPLETE enough to be counted and compared?
 *
 * The Transparency Center clips ad text with an ellipsis, and the reader
 * transcribes what it can see. Baton Rouge Telco's description arrived as
 * "…Open A Checking Account With BR Telco & Earn Up To 5.5…" and was proposed
 * as a cash_bonus of "Up To 5.5…". The same advertiser's uncut ad reads
 * "Earn Up To 5.55% APY*" — so that figure was neither a bonus nor 5.5 of
 * anything, and it produced the sentence "2 of 3 competitors advertise cash
 * bonus" about a competitor who advertises no bonus at all.
 *
 * A clipped figure cannot be repaired by a better prompt, because the digits
 * are genuinely not on screen. It can only be refused, and refusing it is
 * cheap and deterministic — which is why the gate lives here in code and not
 * in the prompt.
 *
 * Deliberately narrow. It rejects only text that LOOKS like a figure and is
 * demonstrably cut off or missing the unit that gives it meaning. Non-numeric
 * language like "high APY" or "No Annual Fee" is untouched: it is not a
 * clipped number, it is simply not a number, and it is already unrankable.
 */
export function isCompleteFigure(raw, unit) {
  const t = String(raw ?? "").trim();
  if (!t) return false;
  // The provider's own truncation marker. Whatever followed it is unknowable.
  if (/(?:…|\.\.\.)$/.test(t)) return false;
  // A figure carrying digits but not the symbol that says what they measure.
  // "5.5" is not a rate and not an amount; which one it was is exactly the
  // information the clip destroyed.
  if (/\d/.test(t)) {
    if (unit === "percent" && !t.includes("%")) return false;
    if (unit === "usd" && !/[$€£]/.test(t)) return false;
  }
  return true;
}

// Metrics that express a COST OF THE ACCOUNT. Only these can be misread as the
// account's price when the ad was actually pricing an optional add-on.
const COST_METRICS = new Set(["monthly_fee", "annual_fee"]);

const QUALIFIER_KEYS = [
  "term_months", "minimum_deposit", "balance_cap", "new_money_only", "new_money_required",
  "relationship_required", "credit_tier", "autopay_required", "loan_amount", "intro_months",
  "direct_deposit_required", "new_members_only", "waiver_condition", "first_year_waived",
  "category", "spend_cap", "applies_to",
];

function normalizeQualifiers(raw = {}) {
  const out = {};
  for (const k of QUALIFIER_KEYS) {
    const v = raw?.[k];
    if (v === undefined || v === null || v === "" || v === "null") continue;
    if (typeof v === "boolean") { out[k] = v; continue; }
    const n = num(v);
    // Months and dollar amounts normalize to numbers; conditions stay strings.
    out[k] = (n !== null && /months|deposit|cap|amount|spend/.test(k)) ? n : String(v).trim();
  }
  return out;
}

/**
 * One ad record -> the same record with a validated `facts[]` and `claims[]`.
 *
 * Idempotent and pure. Safe to re-run over cached extractions, which matters
 * because the extraction cache stores what the model said and this layer may
 * change as the registry grows.
 */
export function normalizeObservation(ad) {
  const profile = profileFor(ad.product);
  const relevant = new Set(profile.metrics);
  const vocabulary = new Set(Object.keys(profile.claims));

  const facts = [];
  const droppedFacts = [];
  for (const f of ad.rawEconomicFacts || []) {
    const m = metricOf(f.metric);
    if (!m) { droppedFacts.push({ ...f, why: "unknown metric" }); continue; }
    // A fact that is real but not part of this product's comparison profile is
    // kept as evidence and excluded from counting. A savings APY quoted inside
    // a checking ad is exactly this case, and silently counting it in the
    // checking rate position is how a wrong rank gets built from a correct read.
    if (!relevant.has(f.metric)) { droppedFacts.push({ ...f, why: "not a comparison metric for this product" }); continue; }

    const value = num(f.raw);
    const complete = isCompleteFigure(f.raw, m.unit);
    facts.push({
      metric: f.metric,
      raw: f.raw,
      value,
      unit: m.unit,
      qualifiers: normalizeQualifiers(f.qualifiers),
      sourceField: f.sourceField || "description",
      // A clipped figure is never the brand's advertised position and never
      // enters a count. It is KEPT, because it is still evidence that the
      // brand said something here — it simply cannot be read as a number.
      complete,
      // A COST attached to a named add-on is not the account's cost. "$5.99/month
      // with BaZing" is the price of a benefits bundle; ranked as a monthly fee
      // it says the client charges for an account their competitors give away.
      // The extractor is asked to tag these with applies_to — when it does, the
      // tag has to actually do something, or it is decoration. This is that.
      scopedToAddOn: COST_METRICS.has(f.metric) && !!normalizeQualifiers(f.qualifiers).applies_to,
      // Per-fact rankability is necessary but not sufficient: a pair can still
      // be refused by comparable() at comparison time.
      rankable: complete && Number.isFinite(value) && isRankableMetric(f.metric),
      displayable: complete,
    });
  }

  const claims = [];
  const unclassified = [...(ad.unclassified || [])];
  for (const c of ad.rawClaims || []) {
    if (!vocabulary.has(c.claim)) {
      // Not an error — the claim may be real and simply outside this product's
      // profile. It goes to the bucket, which is the only signal you get that a
      // profile needs a new entry.
      if (c.verbatim) unclassified.push(c.verbatim);
      continue;
    }
    if (claims.some((x) => x.claim === c.claim)) continue;   // one per ad, per claim
    claims.push({ claim: c.claim, verbatim: c.verbatim, sourceField: c.sourceField });
  }

  return { ...ad, facts, claims, unclassified, droppedFacts };
}

export function normalizeAll(ads = []) {
  return ads.map((a) => (a && a.rawEconomicFacts !== undefined ? normalizeObservation(a) : a));
}

// ---------------------------------------------------------------------------
// BRAND-LEVEL ROLLUP.
//
// THE UNIT OF ANALYSIS IS THE BRAND for every offer and claim finding.
//
// This is the fix for the denominator problem: a competitor with forty
// creatives and a competitor with two must each count once when the sentence is
// "4 of 5 competitors". Creative counts are their own separate finding with
// their own separate unit, and the two are never mixed inside one sentence.
// ---------------------------------------------------------------------------

/**
 * @param {{key,label,domain,isClient,ads}} column
 * @returns brand-level position: strongest advertised value per metric, set of
 *          claims advertised anywhere, lead emphasis distribution.
 */
export function rollUpBrand(column) {
  const ads = column.ads || [];
  const byMetric = new Map();

  for (const ad of ads) {
    for (const f of ad.facts || []) {
      const list = byMetric.get(f.metric) || [];
      list.push({ ...f, creativeId: ad.creativeId, ad });
      byMetric.set(f.metric, list);
    }
  }

  // The brand's advertised position on a metric is its STRONGEST advertised
  // value — the one a consumer comparing ads would notice and act on. Direction
  // comes from the registry, so this is correct for a monthly fee (lowest wins)
  // as well as an APY (highest wins). The full list stays attached as evidence,
  // so nobody has to trust the pick.
  const positions = {};
  // Metrics where the brand said SOMETHING but every reading of it was clipped.
  // Held separately so the snapshot can say "figure was cut off in the captured
  // ad" rather than "not observed" — those are different facts about the world,
  // and only one of them is a reason to go and look again.
  const partial = {};
  for (const [metric, list] of byMetric) {
    // An add-on price never becomes the brand's position on a cost metric. It
    // stays in `partial` as evidence, because the ad really did print it.
    const complete = list.filter((f) => f.complete && !f.scopedToAddOn);
    if (!complete.length) {
      partial[metric] = { all: list, adCount: list.length };
      continue;
    }
    const rankable = complete.filter((f) => f.rankable);
    const pool = rankable.length ? rankable : complete;
    const best = pool.slice().sort((a, b) => {
      if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return 0;
      return -better(metric, a.value, b.value);
    })[0];
    // `all` stays the COMPLETE readings only — it is the evidence list behind a
    // counted figure, and a clipped sibling is not evidence for that figure.
    positions[metric] = { ...best, all: complete, adCount: complete.length };
  }

  const claims = new Map();
  for (const ad of ads) {
    for (const c of ad.claims || []) {
      if (!claims.has(c.claim)) claims.set(c.claim, { claim: c.claim, verbatim: c.verbatim, evidence: [] });
      claims.get(c.claim).evidence.push(ad.creativeId);
    }
  }

  const leads = new Map();
  for (const ad of ads) {
    if (!ad.leadEmphasis) continue;
    leads.set(ad.leadEmphasis, (leads.get(ad.leadEmphasis) || 0) + 1);
  }
  const leadEmphasis = [...leads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    key: column.key,
    label: column.label,
    domain: column.domain,
    isClient: !!column.isClient,
    tier: column.tier || "local",
    adCount: ads.length,
    hasCoverage: ads.length > 0,
    positions,
    partial,
    claims,
    leadEmphasis,
    // How many economic facts the brand's ads carry at all. Used only for the
    // offer-combination finding, which counts facts WITHIN an ad — never across
    // ads, and never as a quality score.
    maxFactsInOneAd: ads.reduce((n, a) => Math.max(n, (a.facts || []).length), 0),
    urgency: ads.some((a) => a.urgency?.present),
    truncatedAds: ads.filter((a) => a.truncated).length,
  };
}

/**
 * Rank one brand's position against the others on a metric.
 *
 * Returns explicit buckets rather than an index, because the sentence the
 * product needs is "2 advertise higher, 3 advertise lower", not "you are 3rd".
 * Pairs refused by comparable() land in `notComparable` WITH THEIR REASON and
 * are reported alongside the rank rather than dropped — a fact you decline to
 * rank is still a fact the strategist should see.
 */
export function rankAgainst(metric, subject, others) {
  const stronger = [], weaker = [], equal = [], notComparable = [];
  if (!subject || !Number.isFinite(subject.value)) {
    return { stronger, weaker, equal, notComparable, comparableCount: 0, ranked: false };
  }

  for (const o of others) {
    if (!o.position) continue;
    const verdict = comparable(subject, o.position);
    if (!verdict.ok) {
      notComparable.push({ ...o, reason: verdict.reason });
      continue;
    }
    const cmp = better(metric, o.position.value, subject.value);
    if (cmp > 0) stronger.push(o);
    else if (cmp < 0) weaker.push(o);
    else equal.push(o);
  }

  return {
    stronger, weaker, equal, notComparable,
    comparableCount: stronger.length + weaker.length + equal.length,
    ranked: true,
  };
}
