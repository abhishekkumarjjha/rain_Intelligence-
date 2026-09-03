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
    detail: `${named} — in this ${days}-day window. This counts what the Transparency Center indexed, not what was spent or where it ran: an advertiser with few display creatives may still be running each of them widely.`,
    rows,
  };
}
