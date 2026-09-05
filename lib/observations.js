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
    return true;
  }

  // NO DIGITS AT ALL, on a metric measured in percent or dollars.
  //
  // "Low APR", "high APY", "Great Rates", "competitive rates" are marketing
  // language, not figures — and La Capitol's credit-card board reported "ads
  // print apr of Low APR. No competitor's captured ads printed one", which
  // asserts a rate position out of an adjective.
  //
  // "No annual fee" and "free checking" are different: they state a value, and
  // that value is zero. Those stay.
  if (unit === "percent" || unit === "usd") {
    return /\b(no|free|zero|without|waived)\b/i.test(t);
  }
  return true;
}

// ---------------------------------------------------------------------------
// GROUNDING — a figure only counts if the ad actually printed it.
//
// This file's whole reason to exist is that a model PROPOSES and code DECIDES,
// and until now it decided about everything except the one thing most likely to
// be wrong: whether the string the model handed back was ever on screen.
//
// `{ metric: "apy", raw: "5.55% APY" }` passed every gate here — registry,
// profile, completeness, rankability — without anyone asking whether "5.55%
// APY" appears anywhere in the headline, description, sitelinks or callouts the
// same read transcribed. An invented figure is indistinguishable from a
// transcribed one once it is inside `facts[]`, and it then becomes a brand's
// advertised position, a rank against the client, and a sentence in a report.
//
// This is the same defect class as the citation bug fixed in themes.js: a
// model-supplied string that nothing checked against reality. There the model
// was echoing 22-character creative ids and one wrong digit dropped a finding.
// Here a wrong digit does the opposite and INVENTS one, which is worse.
//
// The check is deliberately lenient about FORM and strict about PRESENCE. The
// transcription and the extracted figure come out of the same model call and
// routinely differ in spacing, curly quotes, unicode ellipsis and the space
// around a % or $. None of those are grounds to refuse a figure. Being absent
// from the ad is.
// ---------------------------------------------------------------------------

/** Unicode punctuation the two halves of one model answer disagree about. */
function normalizeForGrounding(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    // The provider's clip marker is not text the advertiser wrote. Removing it
    // from BOTH sides means a clipped figure is still recognised as present —
    // it is refused later by isCompleteFigure(), for the right reason.
    .replace(/(?:…|\.\.\.)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const squeeze = (s) => s.replace(/\s+/g, "");

/**
 * Everything the reader said it could SEE on this creative, joined.
 *
 * Covers both record shapes on purpose. A search ad carries headlines[],
 * description, sitelinks[] and callouts[]; a display creative carries headline,
 * subhead, cta and allText. Note that shapeSearch()'s `allText` deliberately
 * omits the headlines, so grounding cannot read allText alone.
 */
export function sourceTextOf(ad) {
  const parts = [
    ad?.headline, ad?.subhead, ad?.cta, ad?.brand,
    ad?.description, ad?.displayUrl, ad?.allText,
    ...(Array.isArray(ad?.headlines) ? ad.headlines : []),
    ...(Array.isArray(ad?.sitelinks) ? ad.sitelinks : []),
    ...(Array.isArray(ad?.callouts) ? ad.callouts : []),
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Does `raw` appear in `sourceText`?
 *
 * Two passes. The first compares with whitespace collapsed, which is the honest
 * comparison. The second compares with whitespace removed entirely, which
 * forgives "$5.99/month" against "$5.99 / month" and "4.50%APY" against "4.50%
 * APY" — spacing differences inside one model's own answer, never a difference
 * about what the ad said.
 *
 * SCOPED TO ONE AD. A figure printed by a different creative of the same brand
 * is not evidence that THIS ad printed it, and the brand rollup counts ads.
 */
export function isGrounded(raw, sourceText) {
  const needle = normalizeForGrounding(raw);
  if (!needle) return false;
  const hay = normalizeForGrounding(sourceText);
  if (!hay) return false;
  if (hay.includes(needle)) return true;
  return squeeze(hay).includes(squeeze(needle));
}

// Metrics that express a COST OF THE ACCOUNT. Only these can be misread as the
// account's price when the ad was actually pricing an optional add-on.
const COST_METRICS = new Set(["monthly_fee", "annual_fee"]);

/**
 * A REDUCTION of a rate is not a rate.
 *
 * La Capitol's auto-loan ad reads "Rates as low as 4.59% APR* ... get 0.65% off
 * your rate". Both were filed as `apr`, and because a lower APR wins, 0.65
 * became the brand's advertised position — so the board told the client they
 * advertised a 0.65% auto loan and ranked it against a competitor's real 4.84%.
 * The conclusion happened to survive; the figure on screen did not, and against
 * a competitor at 3% it would have produced a flatly false claim.
 *
 * Same shape as the add-on fee: a number correctly READ and wrongly TYPED. The
 * grammar is the tell — a percentage bound to "off", "discount" or "save" is
 * what comes OFF a rate, never the rate itself.
 */
const RATE_REDUCTION = /\b(off|discount(ed|s)?|save|savings?|lower by|less)\b/i;

/**
 * Claim ALIASES — one offer mechanic, one claim id.
 *
 * A vocabulary that grew per product ended up with two names for the same
 * thing, and the extractor cheerfully returns both from one sentence. Collapsed
 * here rather than in the prompt, because the prompt cannot know which of two
 * legal ids the board already counted.
 */
const CANONICAL_CLAIM = {
  no_payment_days: "payment_deferral",
  deferred_first_payment: "payment_deferral",
  skip_payment: "payment_deferral",
};

/**
 * Is this verbatim just the advertiser saying what KIND of institution it is?
 *
 * "Federal credit union" and "Your Local Credit Union" are an institution's
 * type and tagline. They appear in the verified-advertiser line of essentially
 * every credit-union ad, so classifying them as member-owned or local-service
 * positioning turns identity into strategy and produces a message gap against a
 * competitor who never chose to say anything.
 *
 * Deliberately narrow: it rejects only strings that are NOTHING BUT the
 * institution type. "Where it pays to be a member" and "Built for members, by
 * members" are real selling claims and pass straight through.
 */
function isInstitutionIdentity(verbatim) {
  const t = String(verbatim || "").trim().toLowerCase().replace(/[.,!]+$/, "");
  if (!t) return false;
  return /^(your |our |a |the )?(local |community |federal |state )*(credit union|bank|savings bank|federal savings)$/.test(t);
}

/**
 * Move a figure to the mechanic it actually is.
 *
 * The extractor reads the number correctly and types it by the nearest familiar
 * label. These three corrections are grammar, not product knowledge:
 *
 *   "0.65% off your rate"        apr        -> rate_discount
 *   "up to 100% financing"       down_payment -> financing_percent
 *   "borrow up to $30,000"       cash_bonus -> loan_amount
 *
 * Each was previously either ranked as the wrong thing or dropped. A separate
 * metric id means it can be shown, and can never be compared against the rate,
 * bonus or down payment it was standing in for.
 */
function retype(f, ad) {
  const raw = String(f?.raw || "");
  const text = String(ad?.allText || "");
  const m = metricOf(f?.metric);

  // A percentage bound to "off"/"discount"/"save" is what comes OFF a rate.
  if (m?.unit === "percent" && RATE_REDUCTION.test(raw) && f.metric !== "rate_discount") {
    return { ...f, metric: "rate_discount", retypedFrom: f.metric };
  }
  // "Up to 100% financing" is how much of the purchase is lent, not a deposit.
  if (f?.metric === "down_payment" && /financ/i.test(raw)) {
    return { ...f, metric: "financing_percent", retypedFrom: f.metric };
  }
  // A dollar figure on a lending ad is the loan unless the copy says bonus.
  if (f?.metric === "cash_bonus" && LOAN_AMOUNT.test(text) && !BONUS_LANGUAGE.test(text)) {
    return { ...f, metric: "loan_amount", retypedFrom: f.metric };
  }
  return f;
}

/** "Borrow up to $30,000" — the size of the loan, not a payment to the customer. */
const LOAN_AMOUNT = /\b(borrow|loan amounts?|finance up to|credit limits?)\b/i;
/** Language that makes a dollar figure genuinely a bonus. */
const BONUS_LANGUAGE = /\b(bonus|cash back|reward|welcome offer|get \$|earn \$|receive \$)/i;

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

  // The transcription this same read produced. Every figure and every claim
  // verbatim is checked against it before it is allowed to count.
  const source = sourceTextOf(ad);

  const facts = [];
  const droppedFacts = [];
  for (const raw0 of ad.rawEconomicFacts || []) {
    // RETYPE BEFORE VALIDATING, never drop.
    //
    // A rate discount, a financing percentage and a loan size were being
    // recognised correctly and then either forced into the wrong metric or
    // thrown away. Retyping keeps the fact — the ad really does say it — and
    // puts it somewhere it can be shown without ever being ranked against a
    // figure that means something else.
    const f = retype(raw0, ad);
    const m = metricOf(f.metric);
    if (!m) { droppedFacts.push({ ...f, why: "unknown metric" }); continue; }
    // A fact that is real but not part of this product's comparison profile is
    // kept as evidence and excluded from counting. A savings APY quoted inside
    // a checking ad is exactly this case, and silently counting it in the
    // checking rate position is how a wrong rank gets built from a correct read.
    if (!relevant.has(f.metric)) { droppedFacts.push({ ...f, why: "not a comparison metric for this product" }); continue; }

    const value = num(f.raw);
    const complete = isCompleteFigure(f.raw, m.unit);
    // GROUNDED IN THIS AD, not in the brand and not in the run. A figure the
    // transcription does not contain was not observed, whatever the model
    // filed it as.
    const grounded = isGrounded(f.raw, source);
    const qualifiers = normalizeQualifiers(f.qualifiers);
    // A COST attached to a named add-on is not the account's cost. "$5.99/month
    // with BaZing" is the price of a benefits bundle; ranked as a monthly fee
    // it says the client charges for an account their competitors give away.
    // The extractor is asked to tag these with applies_to — when it does, the
    // tag has to actually do something, or it is decoration. This is that.
    // Computed before the record rather than inside it, so `rankable` below
    // can read it instead of being written without it.
    const scopedToAddOn = COST_METRICS.has(f.metric) && !!qualifiers.applies_to;
    facts.push({
      metric: f.metric,
      raw: f.raw,
      value,
      unit: m.unit,
      qualifiers,
      sourceField: f.sourceField || "description",
      // A clipped figure is never the brand's advertised position and never
      // enters a count. It is KEPT, because it is still evidence that the
      // brand said something here — it simply cannot be read as a number.
      complete,
      scopedToAddOn,
      // Set by retype() when the figure was moved to its true mechanic, so a
      // reader of the evidence can see the reclassification rather than
      // wondering why an ad's headline figure is in an unexpected column.
      retypedFrom: f.retypedFrom || null,
      // Did the ad text this read transcribed actually contain this string?
      // False means KEPT as evidence of what the model proposed, marked, and
      // excluded from every count, position, rank and denominator. Deleting it
      // would hide the fact that the reader is inventing figures, which is
      // information the next person debugging this needs.
      grounded,
      // Per-fact rankability is necessary but not sufficient: a pair can still
      // be refused by comparable() at comparison time.
      //
      // scopedToAddOn belongs HERE and not only in rollUpBrand. It is a
      // per-fact reason a figure can never be ranked — not a pairwise one —
      // and it was enforced in exactly one of the two places that decide
      // whether "$5.99/month with BaZing" can be compared to a competitor's
      // account fee. rollUpBrand filters it out of positions, so the board is
      // safe today; anything that reads f.rankable directly was not. Found by
      // the corpus, whose label says what the flag is supposed to mean.
      rankable: grounded && complete && !scopedToAddOn
        && Number.isFinite(value) && isRankableMetric(f.metric),
      displayable: complete,
    });
  }

  const claims = [];
  const unclassified = [...(ad.unclassified || [])];
  for (const c of ad.rawClaims || []) {
    // ONE OFFER MECHANIC, ONE CLAIM. "No Payments For 60 Days" was being
    // returned as both payment_deferral and no_payment_days, and the board then
    // rendered two MESSAGE ADVANTAGE cards quoting the same sentence — two
    // labels for one thing, presented as two advantages.
    const claim = CANONICAL_CLAIM[c.claim] || c.claim;
    if (!vocabulary.has(claim)) {
      // Not an error — the claim may be real and simply outside this product's
      // profile. It goes to the bucket, which is the only signal you get that a
      // profile needs a new entry.
      if (c.verbatim) unclassified.push(c.verbatim);
      continue;
    }
    // AN ADVERTISER'S NAME IS NOT A MESSAGE STRATEGY. "Federal credit union"
    // was being read as member-owned positioning, and it is the institution's
    // legal type — it appears in the verified-advertiser line of every credit
    // union's ad. A finding built on that says a competitor is messaging on
    // something they never chose to say.
    if (isInstitutionIdentity(c.verbatim)) {
      if (c.verbatim) unclassified.push(c.verbatim);
      continue;
    }
    if (claims.some((x) => x.claim === claim)) continue;   // one per ad, per claim
    // A claim is a QUOTE. "No monthly fee" counted against a brand has to be
    // something that brand printed, and the verbatim is the whole of the
    // evidence for it — a claim whose quote is not in the ad is a claim with no
    // evidence at all. Kept and marked, exactly like an ungrounded figure.
    claims.push({
      claim, verbatim: c.verbatim, sourceField: c.sourceField,
      grounded: isGrounded(c.verbatim, source),
    });
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
  // Figures the reader proposed that its own transcription does not contain.
  // Held apart from `partial` on purpose: "the ad text was clipped before it
  // could be read" is a statement about the CAPTURE, and it would be false
  // here. Nothing on the board reads this map — it exists so an ungrounded
  // figure is visible to whoever is debugging the reader instead of vanishing.
  const ungrounded = {};

  for (const ad of ads) {
    for (const f of ad.facts || []) {
      const entry = { ...f, creativeId: ad.creativeId, ad };
      if (f.grounded === false) {
        (ungrounded[f.metric] ||= []).push(entry);
        continue;
      }
      const list = byMetric.get(f.metric) || [];
      list.push(entry);
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
      // An unquotable claim is not a claim. The board prints the verbatim next
      // to the count, so counting one whose quote is not in the ad would put an
      // invented sentence in quotation marks in front of a client.
      if (c.grounded === false) continue;
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
    ungrounded,
    claims,
    leadEmphasis,
    // How many economic facts the brand's ads carry at all. Used only for the
    // offer-combination finding, which counts facts WITHIN an ad — never across
    // ads, and never as a quality score.
    maxFactsInOneAd: ads.reduce((n, a) => Math.max(n, (a.facts || []).filter((f) => f.grounded !== false).length), 0),
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
