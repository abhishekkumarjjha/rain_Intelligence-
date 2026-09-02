// =============================================================================
// lib/primary-read.js — THE ONE SENTENCE AT THE TOP.
//
// The board answers every question except the one a strategist opens with:
// "so what is actually going on here?" Six cards, each true, each counted, and
// the reader is left to assemble the picture themselves — which is work, and
// which two readers will do differently.
//
// This assembles it once. It is the same facts in a different arrangement:
// fact -> relative weight -> overall read -> limitation.
//
// NO MODEL, AND THAT IS NOT AN ASCETIC CHOICE.
//
// Everything the sentence needs is already a number on the board:
//
//   ahead / level / under pressure   the primary-rate finding's outcome
//   what is creating the pressure    the metrics on the pressure findings
//   broad pattern or lone tactic     count over denominator, per finding
//   what cannot be established       the coverage gates
//
// So the only thing a model could add is phrasing, and it would charge for that
// in the one currency this screen cannot spend: a synthesis is the most
// quotable thing on the page, and the most likely to be read aloud to a client.
// A template says the same thing every time and cannot drift into advice.
//
// The specific failure a model makes here is not hypothetical. This capture has
// THREE readable competitors but only TWO with an APY to rank against, and the
// difference matters — "strongest of three" is a claim the evidence does not
// support. Prose smooths that over. Arithmetic does not.
//
// WHAT THIS MUST NEVER DO
//
// It never recommends, never names a cause of campaign performance, and never
// calls a product weak. It reports what was advertised and stops, because the
// capture contains no click, no conversion and no spend — and because RAIN
// asserting a client's product is inferior is the one thing that was ruled out.
// The reader draws the conclusion; that is the whole of quasi-analysis.
// =============================================================================

import { metricOf } from "./metrics.js";
import { claimLabel } from "./profiles.js";

const nOf = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Lower-case mid-sentence, but never an acronym: "apy" reads as a typo. */
const soften = (s) => (/[a-z]/.test(String(s)) ? String(s).toLowerCase() : String(s));

/** "a, b and c" */
const andList = (xs) => xs.join(", ").replace(/, ([^,]*)$/, xs.length > 2 ? " and $1" : " and $1");

/** What a finding is ABOUT, in two or three words. */
function subject(f) {
  if (f.claimId) return soften(claimLabel(f.claimId));
  if (f.metric) return soften(metricOf(f.metric)?.label || f.metric);
  // Last resort is the RULE label, which is an all-caps eyebrow ("OFFER
  // COMBINATION"). soften() protects acronyms and would leave it shouting
  // mid-sentence, so this one is lower-cased outright.
  return String(f.chip || f.label || "").toLowerCase();
}

/**
 * @param {object} args
 *   findings   the FULL finding list, significance already assigned
 *   client     the client brand rollup
 *   coverage   assessCoverage() output
 *   profile    the product profile
 * @returns {{framing, headline, differences, boundary, counts}|null}
 */
export function buildPrimaryRead({ findings = [], client, coverage, profile, setShape = null }) {
  // Below three readable competitors the board already refuses ratio language.
  // A synthesis over two brands is a sentence about two brands.
  if (!coverage?.allowRatioLanguage || !coverage.usableCount) return null;

  const rate = profile.primaryRate;
  const rateLabel = metricOf(rate)?.label || rate;
  const D = coverage.usableCount;

  const onRate = findings.find((f) => f.metric === rate && f.outcome !== "context");
  const pressure = findings.filter((f) => f.outcome === "pressure" && f.metric !== rate);
  const majority = pressure.filter((f) => f.significance === "primary" || f.significance === "supporting");
  const isolated = pressure.filter((f) => f.significance === "isolated");

  // ---- HEADLINE: where the client stands on the product's headline figure ---
  //
  // Every branch names the denominator it is speaking over, and it is the
  // COMPARABLE count, not the readable count. Those differ whenever a competitor
  // advertised no such figure, which is most captures.
  let headline;
  if (!onRate) {
    // The client printed no figure on the headline metric — a real position,
    // and not the same as being behind on one.
    headline = `${client.label}'s captured ads did not advertise ${soften(rateLabel)}. `
      + `Competitive differences in this capture sit in ${majority.length || isolated.length
        ? andList([...new Set([...majority, ...isolated].map(subject))]) : "message and offer framing"}.`;
  } else if (onRate.outcome === "lead") {
    const comparable = Number(onRate.denominator) || 0;
    headline = comparable >= 1
      ? `${client.label} holds the strongest advertised ${rateLabel} of the ${
          nOf(comparable, "comparable local competitor")} captured.`
      : `${client.label} advertised ${rateLabel}; no comparable competitor figure was captured to rank it against.`;
  } else {
    headline = `${onRate.count} of ${nOf(Number(onRate.denominator) || 0, "comparable local competitor")} `
      + `advertise a stronger ${rateLabel} than ${client.label}.`;
  }

  // ---- DIFFERENCES: what is creating pressure, weighted -------------------
  const parts = [];
  if (majority.length) {
    parts.push(andList(majority.map((f) => `${subject(f)} (${f.count} of ${f.denominator})`)));
  }
  if (isolated.length) {
    // The qualifier is attached ONCE to the group rather than repeated per item,
    // and it is the whole point of the sentence: a tactic belonging to a single
    // advertiser must not read as something the local set does.
    parts.push(`${andList(isolated.map(subject))}, ${
      isolated.length === 1 ? "from one advertiser only" : "each from one advertiser only"}`);
  }
  const differences = parts.length
    ? `Where competitors differ: ${parts.join("; ")}.`
    : `No competitor in the readable set advertised anything ${client.label}'s captured ads did not.`;

  // ---- LOCAL VERSUS NATIONAL ----------------------------------------------
  //
  // The two must never merge into one sentence. "The market is moving toward
  // bonuses" is the claim to avoid: we cannot tell from the Transparency Center
  // whether a national's ads served in this client's market at all, so their
  // behaviour is an example of how the product gets framed at scale and is not
  // evidence about Baton Rouge. Kept in its own clause, always attributed.
  const axis = setShape?.observations?.find((o) => o.kind === "contested_axis");
  const natAxis = setShape?.observations?.find((o) => o.kind === "national_axis");
  const localBits = [];
  if (axis) localBits.push(`${axis.label || axis.chip} is the figure most local advertisers print (${axis.count} of ${axis.denominator})`);
  const loneTactics = isolated.map(subject);
  if (loneTactics.length) localBits.push(`${andList(loneTactics)} appeared in one competitor's ads only`);
  const localVsNational = localBits.length || natAxis
    ? [
        localBits.length ? `Locally, ${localBits.join("; ")}.` : "",
        natAxis ? `In the national reference set, both captured advertisers led on ${soften(natAxis.chip)} alone — shown for context, not as evidence of this local market.` : "",
      ].filter(Boolean).join(" ")
    : "";

  // ---- BOUNDARY: what this cannot establish -------------------------------
  const gaps = [];
  const unread = (coverage.totalCompetitors || 0) - D;
  if (unread > 0) gaps.push(`${nOf(unread, "selected competitor")} contributed no ads on this product and ${unread === 1 ? "is" : "are"} in no denominator`);
  if (coverage.anyTruncated) gaps.push("some captured ad text was clipped before it could be read in full");
  // Semicolons, not "and": each gap is its own clause and several already
  // contain an "and" of their own.
  const boundary = `Counted across ${nOf(D, "readable local competitor")}${
    gaps.length ? `; ${gaps.join("; ")}` : ""}. This describes what was advertised — the capture carries no click, conversion or spend data, so it cannot show what any of it caused.`;

  return {
    // Printed above the read, verbatim. It says what the section is FOR, which
    // is the difference between a diagnostic aid and an accusation: this is
    // read AFTER delivery has been examined, never instead of it.
    framing: "Campaign delivery — placement, pacing, CPM — is not visible here. "
      + "This is the competitive picture in the captured advertising, to be read once execution factors have been examined.",
    headline,
    differences,
    localVsNational,
    // Verified month-over-month change, when a comparable earlier snapshot
    // exists. For a performance review this is often the most useful line on
    // the page — a static comparison says how things stand, a change says what
    // moved — so it is surfaced here rather than left to compete for a card.
    changes: findings
      .filter((f) => /^offer_(new|changed|withdrawn)$/.test(f.rule))
      .slice(0, 3)
      .map((f) => ({ id: f.id, text: f.headline })),
    boundary,
    counts: { comparableOnRate: Number(onRate?.denominator) || 0, readable: D, patterns: majority.length, tactics: isolated.length },
  };
}
