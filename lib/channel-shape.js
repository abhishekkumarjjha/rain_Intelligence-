// =============================================================================
// lib/channel-shape.js — HOW THESE ADVERTISERS USE THIS CHANNEL.
//
// The observation that started this file could not have come from a model, and
// that is the whole argument for the file existing:
//
//   "Chase lists about four thousand search creatives and twenty-seven display
//    ones. Capital One lists three thousand and six hundred."
//
// Nothing in a display creative contains that fact. It is a comparison between
// two capture records, and the themes model is only ever shown the creatives —
// so asking it for a set-level takeaway means asking it to invent one. The
// number is available, it is exact, and a model paraphrasing it would be strictly
// worse than arithmetic.
//
// Same rule as set-shape.js: this is the most prominent sentence on the panel,
// so it is the one that must be counted rather than written. The model still
// names the recurring ideas underneath it, which IS a clustering-over-language
// job and genuinely belongs to a model.
//
// WHAT IT MAY AND MAY NOT SAY
// The provider tells us how many creatives it LISTED for an advertiser in a
// window. That is a fact about the Transparency Center's index, not about
// budget, impressions or intent — so the language stays on "lists", never
// "spends", "focuses on", "prioritises" or "has moved to". A bank running few
// display creatives may be running each of them everywhere.
// =============================================================================

import { SOURCES } from "./sources.js";

/** Google's index is approximate at the top end; say so the way it reads. */
function approx(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1000) return `about ${Math.round(n / 1000)},000`;
  if (n >= 100) return `about ${Math.round(n / 100) * 100}`;
  return String(n);
}

/* HOW LOPSIDED IS WORTH SAYING.
   Chase lists 4,000 search creatives against 27 display — 148 to one. Capital
   One lists 3,000 against 600, which is five to one. Both are real asymmetries
   and only one is dramatic, so the threshold admits both and the WORDING tracks
   the smaller ratio rather than the larger. Gating at ten would have refused the
   observation entirely because one advertiser was merely five times heavier on
   search, which is still a fact worth a sentence. */
const NOTABLE = 3;
const STARK = 20;

/**
 * @param {object} o
 * @param {Array}  o.advertisers  [{ domain, label, tier }]
 * @param {number} o.days         the capture window
 * @param {(q:{source:string,domain:string,days:number}) => ({hit:boolean,entry?:object})} o.peek
 *        capture-cache lookup, injected so this is testable without a cache
 * @returns {{headline:string, detail:string, rows:Array}|null}
 */
export function channelShape({ advertisers = [], days = 30, peek }) {
  if (typeof peek !== "function") return null;

  const listedFor = (domain, source) => {
    // TTL is deliberately ignored: a stale entry still tells us how many
    // creatives the provider listed, and that is all this reads.
    const r = peek({ source, domain, days });
    const n = r?.hit ? r.entry?.run?.providerTotal : null;
    return Number.isFinite(n) ? n : null;
  };

  const rows = advertisers.map((a) => ({
    label: a.label,
    domain: a.domain,
    tier: a.tier || "local",
    search: listedFor(a.domain, SOURCES.GOOGLE_SEARCH),
    display: listedFor(a.domain, SOURCES.GOOGLE_DISPLAY),
  })).filter((r) => Number.isFinite(r.search) && Number.isFinite(r.display));

  // Both channels have to have been captured for the same advertiser, or there
  // is no comparison — only two unrelated numbers.
  if (!rows.length) return null;

  const nationals = rows.filter((r) => r.tier === "national");
  if (!nationals.length) return null;

  // Every national, or it is one advertiser's habit rather than a shape. Same
  // threshold the national_gap finding uses, and for the same reason.
  const ratio = (r) => (r.display > 0 ? r.search / r.display : Infinity);
  const skewed = nationals.filter((r) => ratio(r) >= NOTABLE);
  if (skewed.length !== nationals.length) return null;

  // The weakest case sets the wording, so the sentence is true of every
  // advertiser it covers rather than of the most extreme one.
  const weakest = Math.min(...nationals.map(ratio));
  const degree = weakest >= STARK ? "far more" : "several times more";

  const named = nationals
    .map((r) => `${r.label} lists ${approx(r.search)} search creatives and ${approx(r.display)} display`)
    .join("; ");

  return {
    headline: nationals.length === 1
      ? `The captured national advertiser lists ${degree} search creatives than display ones.`
      : `Both captured national advertisers list ${degree} search creatives than display ones.`,
    detail: `${named} — in this ${days}-day window. This counts what the Transparency Center indexed, not what was spent or where it ran: an advertiser with few image creatives may still be running each of them widely.`,
    rows,
  };
}

// =============================================================================
// WHO IS ACTUALLY IN THIS SET — the second counted observation, and it lives
// here for the same reason as the first: it is arithmetic over the capture, so
// a model must never be asked for it.
//
// It exists because of a real panel that said "No insights available" over a
// checking wall where the honest reading was sitting in plain sight: every
// design captured on that product came from the two national advertisers, and
// not one regional competitor had a display creative on it. That is a fact, it
// is exact, and it does not depend on a model finding a recurring idea in the
// artwork. When the themes pass finds nothing, THIS still has something to say.
//
// WHAT IT MAY NOT SAY
// Nothing about the client. Creative-mode runs do not capture the client's own
// ads, so "the client is the only local advertiser doing X" is not available
// here at any price — it would be an assertion about ads nobody captured.
// And nothing about products: an advertiser with no captured design on this
// product may be running one that was not sampled, or not indexed, or not
// listed. The wording stays on "captured", every time.
// =============================================================================

/**
 * @param {object} o
 * @param {Array}  o.families      CLUSTERED, product-scoped designs: {tier, institution}
 * @param {Array}  o.advertisers   [{ domain, label, tier }] every advertiser captured
 * @param {string} o.productLabel  the scope these families were filtered to
 * @param {number} o.days          the capture window
 * @param {object} [o.client]      { label, designs } — the client's OWN captured
 *        designs on this product. A separate population, never added to either
 *        cohort and never entering a denominator: this counts what the client
 *        was captured running, which is the other half of "competitors lead
 *        with a bonus" and the only half the wall could previously see.
 * @returns {{headline:string, detail:string}|null}
 */
export function cohortShape({ families = [], advertisers = [], productLabel = "", days = 30, client = null }) {
  if (!families.length) return null;

  const product = productLabel ? productLabel.toLowerCase() : "";
  const of = (tier) => families.filter((f) => (f.tier === "national" ? "national" : "regional") === tier);
  const national = of("national");
  const regional = of("regional");

  const regionalCaptured = advertisers.filter((a) => (a.tier || "local") !== "national");

  // Stated as a count of what was captured, never as what the client does or
  // does not run. Zero captured designs means the Transparency Center listed
  // none in this window for this product — not that none exist.
  const clientLine = client && Number.isFinite(client.designs)
    ? ` ${client.designs
      ? `The client was captured running ${client.designs} distinct ${product} design${client.designs === 1 ? "" : "s"} of their own over the same window.`
      : `No ${product} display design was captured for the client over the same window, so nothing here is compared against their own creative.`}`
    : "";
  const brands = (rows) => new Set(rows.map((f) => f.institution || f.domain)).size;
  const window = `in this ${days}-day window`;

  // The case that started this. Say it plainly, then say what it is not.
  if (national.length && !regional.length && regionalCaptured.length) {
    return {
      headline: `Every ${product} design captured here is from a national advertiser.`,
      detail: `All ${national.length} distinct ${product} display design${national.length === 1 ? "" : "s"} came from the `
        + `${brands(national)} national advertiser${brands(national) === 1 ? "" : "s"}; none of the `
        + `${regionalCaptured.length} regional advertiser${regionalCaptured.length === 1 ? "" : "s"} captured had one `
        + `${window}. The national tier is a reference ceiling, not this client's market — so this set has no local `
        + `comparison in it, rather than a local set that lost. A regional advertiser may still be running ${product} `
        + `display that the Transparency Center did not list or this capture did not sample.${clientLine}`,
    };
  }

  if (regional.length && !national.length) {
    return {
      headline: `No national ${product} display design was captured in this set.`,
      detail: `All ${regional.length} distinct ${product} design${regional.length === 1 ? "" : "s"} came from regional `
        + `advertisers; neither national advertiser had a ${product} image creative listed ${window}.${clientLine}`,
    };
  }

  if (!regional.length || !national.length) return null;

  // Both cohorts present. The split is the fact; concentration is the caveat
  // that stops "nine designs" reading as nine independent advertisers.
  const total = families.length;
  const top = [...families.reduce((m, f) => {
    const k = f.institution || f.domain || "?";
    return m.set(k, (m.get(k) || 0) + 1);
  }, new Map()).values()].sort((a, b) => b - a)[0] || 0;

  return {
    headline: `${regional.length} of the ${total} ${product} designs captured are regional, ${national.length} national.`,
    detail: `Across ${brands(families)} advertiser${brands(families) === 1 ? "" : "s"} ${window}`
      + `${top > total / 2 ? `, though ${top} of the ${total} come from a single advertiser — the set is that advertiser's output more than the market's` : ""}. `
      + `Counted from the designs captured on this product, not from what anyone is spending.${clientLine}`,
  };
}
