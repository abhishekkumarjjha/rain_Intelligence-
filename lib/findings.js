// =============================================================================
// lib/findings.js — THE DETERMINISTIC FINDINGS ENGINE.
//
// This file is the product. Everything upstream exists to feed it and
// everything downstream exists to render it.
//
// NO MODEL RUNS HERE. Not for counting, not for ranking, not for phrasing. The
// sentences the user asked for — "5 of 6 competitors advertise a bonus and the
// client does not" — are template-shaped by nature, and a model on this path
// buys nothing while adding latency, cost, drift, and register risk on the one
// screen where the CEO's constraint is load-bearing.
//
// THREE RULES THAT GOVERN EVERY FINDING IN THIS FILE:
//
// 1. DECLARED UNIT OF ANALYSIS. Every finding says whether its denominator
//    counts BRANDS, CLUSTERS or CREATIVES, and never mixes two in one sentence.
//    A competitor with forty creatives and one with two each count once in
//    "4 of 5 competitors". Creative volume is its own finding with its own unit.
//
// 2. POSITIVE AND NEGATIVE EVIDENCE ARE ASYMMETRIC. Presence may be stated
//    plainly: they advertised it, we saw it. Absence is a claim about our
//    RECALL, not about their advertising, so it is always phrased as "not
//    observed in the captured ads" and gated on coverage.
//
// 3. STRENGTH COUNTS AS WELL AS GAPS. Han asked "why is our performance dipping
//    — or why is our performance doing well?" A board that can only report
//    deficits answers half the question and gets used twice.
//
// ON THE CEO CONSTRAINT: the findings are allowed to sting. What RAIN must not
// do is ASSERT that a client's product is inferior. So the register is neutral
// voice, not neutral effect — we report what each side visibly emphasised and
// let the reader draw the conclusion. That is the whole of "quasi-analysis".
// =============================================================================

import { metricOf, formatValue } from "./metrics.js";
import { profileFor, claimLabel } from "./profiles.js";
import { rankAgainst, isCompleteFigure } from "./observations.js";

export const UNITS = { BRAND: "brand", CLUSTER: "cluster", CREATIVE: "creative" };

/**
 * Evidence is a set of CREATIVES, never a list of facts. One ad printing
 * "6.50% APY" in both its headline and its description is two facts and one
 * piece of evidence; counting facts made the chip read 6 over a client with
 * five ads, a number the reader cannot reconcile with anything else on screen.
 */
const dedupe = (ids) => [...new Set((ids || []).filter(Boolean))];

/**
 * OUTCOME — which of the three boards a finding belongs on.
 *
 *   lead      the client is ahead, or is the only one saying something
 *   pressure  a competitor is ahead, or says something the client does not
 *   context   true, useful, and not a scoreboard entry
 *
 * Deliberately NOT "winning" and "losing". Sales reads this screen sitting
 * beside the client, and a header that says LOSING is RAIN asserting the
 * client's product is inferior — the one thing Han ruled out. "Where
 * competitors lead" describes the ADVERTISING, which is all we observed, and
 * lets the client draw the conclusion themselves.
 */
export const OUTCOMES = { LEAD: "lead", PRESSURE: "pressure", CONTEXT: "context" };

// Deterministic report ordering. Materiality to campaign performance is NOT
// something this tool can observe, so this is explicitly a display priority and
// is named that way — calling it "severity" would give card ordering a fake
// objectivity it has not earned.
const PRIORITY = {
  rate_position: 100, rate_advantage: 98,
  bonus_gap: 96, bonus_advantage: 94,
  offer_withdrawn: 92, offer_new: 92, offer_changed: 90,
  fee_position: 88,
  offer_combination: 80,
  claim_gap: 70, claim_advantage: 68,
  advertised_vs_current: 66,
  lead_emphasis: 50,
  mixed_message: 44,
  not_ranked: 40,
  recent_activity: 30,
  creative_volume: 20,
  longevity: 10,
};

const pct = (n, d) => (d ? n / d : 0);

/** The claim that contradicts a printed figure on the same metric. */
const NEGATION_CLAIMS = {
  monthly_fee: "no_monthly_fee",
  minimum_balance: "no_minimum_balance",
  annual_fee: "no_annual_fee",
};

/**
 * @param {object} args
 *   client        rollUpBrand() for the client
 *   competitors   rollUpBrand() for each competitor, ALREADY filtered to usable
 *   product       taxonomy code
 *   coverage      assessCoverage() output — read as permissions
 *   previous      previous snapshot for delta rules, or null
 *   ratePages     { [domain]: RatePageObservation } or null
 */
export function buildFindings({ client, competitors, product, coverage, previous = null, ratePages = null }) {
  const profile = profileFor(product);
  const out = [];
  // The card's eyebrow used to be the RULE ("OFFER GAP"), which names the shape
  // of the finding and not its subject — you had to read the sentence to learn
  // what was being compared. Lead with the metric instead, using the registry's
  // own label so the chip on a card and the column header in the snapshot are
  // always the same words for the same thing. The rule stays, de-emphasised.
  const chipFor = (f) => {
    const label = f.metric ? metricOf(f.metric)?.label : null;
    return label || f.label;
  };
  const push = (f) => {
    if (f) out.push({ ...f, chip: f.chip || chipFor(f), priority: PRIORITY[f.rule] ?? 0 });
  };

  const usable = competitors.filter((c) => c.hasCoverage);
  const D = usable.length;

  // A cost the client's OWN ads contradict cannot be asserted as their cost.
  // LaCap prints "$5.99/month* with BaZing" in one ad and "No Fee" in another;
  // the first is almost certainly an optional bundle. The MIXED MESSAGE rule
  // further down states that and ASKS, which is the honest treatment. Letting
  // COST VISIBILITY also fire would put the same tool on both sides of the
  // question on the same board — asserting a fee disadvantage in one card and
  // doubting it in the next.
  const contested = new Set();
  if (client.hasCoverage) {
    for (const metric of profile.metrics) {
      const neg = NEGATION_CLAIMS[metric];
      if (neg && client.positions[metric] && client.claims.has(neg)) contested.add(metric);
    }
  }

  // ---- OFFER POSITION ------------------------------------------------------
  // Han's worked example: 4.00% against three at 3.85% and two at 4.50%.
  for (const metric of profile.metrics) {
    const m = metricOf(metric);
    if (!m || m.direction === "none") continue;
    // Owned by MIXED MESSAGE. Only ever true when the client HAS a figure, so
    // a gap finding about a client who advertises nothing is unaffected.
    if (contested.has(metric)) continue;

    const subject = client.positions[metric];
    const others = usable.map((c) => ({ key: c.key, label: c.label, position: c.positions[metric] }))
      .filter((o) => o.position);

    if (!subject) {
      // Client has no figure on this metric. Only a gap finding, and only if we
      // actually read the client's ads.
      if (others.length && coverage.allowClientGapFindings) {
        push(gapFinding({ metric, m, others, D, client, coverage, profile }));
      }
      continue;
    }
    // ---- SOLE ADVERTISER --------------------------------------------------
    // The client printed a figure and no competitor's captured ads did. This
    // was previously dropped: the loop required competitor figures before it
    // would speak, so a thin capture produced no offer finding even when the
    // client was visibly advertising a rate AND a fee.
    //
    // The metric's direction decides how it reads, which is exactly why
    // direction lives on the metric. Sole APY is a position worth holding;
    // sole MONTHLY FEE is the client being the only one printing a cost.
    if (!others.length) {
      if (D >= 1) {
        const positive = m.direction === "higher";
        push({
          rule: positive ? "rate_advantage" : "fee_position",
          label: positive ? "SOLE ADVERTISER" : "COST VISIBILITY",
          unit: UNITS.BRAND, metric,
          direction: positive ? "positive" : "negative",
          outcome: positive ? OUTCOMES.LEAD : OUTCOMES.PRESSURE,
          headline: positive
            ? `Only ${client.label} shows ${m.label} in the captured set — ${subject.raw}.`
            : `${client.label}'s ads print ${m.label.toLowerCase()} of ${subject.raw}. No competitor's captured ads printed one.`,
          detail: positive
            ? `Not observed in ${nOf(D, "competitor")}' captured ads.`
            : `A figure absent from a competitor's ads is not a figure they do not charge — it was simply not printed in what we captured.`,
          count: 1, denominator: D + 1,
          evidence: dedupe(subject.all.map((f) => f.creativeId)),
          reportLine: positive
            ? `${client.label}'s captured ads advertised ${subject.raw}; ${m.label} was not observed in ${nOf(D, "selected competitor")}' captured ads.`
            : `${client.label}'s captured ads showed ${m.label.toLowerCase()} of ${subject.raw}; ${m.label.toLowerCase()} was not observed in ${nOf(D, "selected competitor")}' captured ads.`,
        });
      }
      continue;
    }

    const rank = rankAgainst(metric, subject, others);
    if (!rank.comparableCount) {
      push(notRankedFinding({ metric, m, subject, rank, client }));
      continue;
    }

    const isRate = metric === profile.primaryRate;
    const rule = rank.stronger.length === 0
      ? (isRate ? "rate_advantage" : "fee_position")
      : (isRate ? "rate_position" : "fee_position");

    const label = rank.stronger.length === 0 ? "OFFER STRENGTH"
      : rank.weaker.length === 0 ? "OFFER PRESSURE" : "OFFER POSITION";

    push({
      rule,
      label,
      unit: UNITS.BRAND,
      metric,
      direction: rank.stronger.length === 0 ? "positive" : rank.weaker.length ? "mixed" : "negative",
      // A mixed rank (some above, some below) is PRESSURE: the useful fact for
      // a strategist is that somebody is ahead, not that somebody is behind.
      outcome: rank.stronger.length === 0 ? OUTCOMES.LEAD : OUTCOMES.PRESSURE,
      headline: rank.stronger.length === 0
        // At n=1, "than all 1 comparable competitor" reads as a bug because it
        // is one. Name them instead — a single competitor is a name, not a set.
        ? (rank.comparableCount === 1
            ? `${client.label} advertises ${strongerWord(m)} ${m.label} than ${(rank.weaker[0] || rank.equal[0])?.label}, the only comparable competitor.`
            : `${client.label} advertises ${strongerWord(m)} ${m.label} than all ${nOf(rank.comparableCount, "comparable competitor")}.`)
        : rank.weaker.length === 0
          ? `${rank.stronger.length} of ${rank.comparableCount} comparable competitors advertise ${strongerWord(m)} ${m.label} than ${client.label}.`
          : `${rank.stronger.length} of ${rank.comparableCount} comparable competitors advertise ${strongerWord(m)} ${m.label} than ${client.label}; ${rank.weaker.length} advertise ${weakerWord(m)}.`,
      detail: [
        `${client.label} ${subject.raw}`,
        ...others.slice(0, 5).map((o) => `${o.label} ${o.position.raw}`),
      ].join(" · "),
      count: rank.stronger.length,
      denominator: rank.comparableCount,
      // Excluded pairs travel WITH the finding rather than in a footnote, so
      // the reader can see the rank is over a subset and why.
      excluded: rank.notComparable.map((n) => ({ label: n.label, raw: n.position.raw, reason: n.reason })),
      evidence: dedupe([
        subject.creativeId,
        ...others.flatMap((o) => o.position.all.map((f) => f.creativeId)),
      ]),
      reportLine: rank.stronger.length === 0
        ? `Among ${rank.comparableCount} comparable competitors' captured ${profile.label.toLowerCase()} ads, none advertised ${strongerWord(m)} ${m.label} than ${client.label}'s ${subject.raw}.`
        : `Among ${rank.comparableCount} comparable competitors' captured ${profile.label.toLowerCase()} ads, ${rank.stronger.length} advertised ${strongerWord(m)} ${m.label} than ${client.label}'s ${subject.raw}${rank.weaker.length ? ` and ${rank.weaker.length} advertised ${weakerWord(m)}` : ""}.`,
    });
  }

  // ---- OFFER COMBINATION ---------------------------------------------------
  // Counts economic facts WITHIN a single ad, never across ads. This is the
  // Campus Federal finding — a rate and a bonus in the same creative — and it
  // was structurally invisible while an ad could hold only one offer.
  if (coverage.allowClientGapFindings) {
    const stacked = usable.filter((c) => c.maxFactsInOneAd >= 2);
    if (stacked.length && client.maxFactsInOneAd < 2 && client.hasCoverage) {
      push({
        rule: "offer_combination",
        label: "OFFER COMBINATION",
        unit: UNITS.BRAND,
        direction: "negative",
        outcome: OUTCOMES.PRESSURE,
        headline: ratio(stacked.length, D, coverage,
          `${stacked.length} of ${D} competitors advertise two or more offer figures in a single ad. ${client.label}'s captured ads carry one.`,
          `${listNames(stacked)} advertise two or more offer figures in a single ad; ${client.label}'s captured ads carry one.`),
        detail: stacked.map((c) => `${c.label} ${Object.values(c.positions).map((p) => p.raw).slice(0, 3).join(" + ")}`).join(" · "),
        count: stacked.length, denominator: D,
        evidence: dedupe(stacked.flatMap((c) => Object.values(c.positions).flatMap((p) => p.all.map((f) => f.creativeId)))),
        reportLine: `${stacked.length} of ${D} selected competitors combined two or more advertised offer figures in a single captured ad; ${client.label}'s captured ads carried one.`,
      });
    }
  }

  // ---- CLAIMS --------------------------------------------------------------
  for (const claimId of Object.keys(profile.claims)) {
    const withClaim = usable.filter((c) => c.claims.has(claimId));
    const clientHas = client.claims.has(claimId);

    // Gap: a majority advertise it, the client's captured ads do not.
    // The threshold belongs on RATIO LANGUAGE, not on the finding. Requiring
    // two competitors made claims structurally invisible at n=1 and n=2 — one
    // competitor advertising "24/7 mobile banking" the client never mentions is
    // a real, nameable observation, and refusing to state it is silence, not
    // caution.
    const claimFloor = coverage.allowRatioLanguage ? 2 : 1;
    const claimShare = coverage.allowRatioLanguage ? 0.5 : 0;
    if (!clientHas && coverage.allowClientGapFindings && withClaim.length >= claimFloor && pct(withClaim.length, D) >= claimShare) {
      push({
        rule: "claim_gap",
        label: "MESSAGE GAP",
        unit: UNITS.BRAND,
        direction: "negative",
        outcome: OUTCOMES.PRESSURE,
        headline: ratio(withClaim.length, D, coverage,
          `${withClaim.length} of ${D} competitors mention ${claimLabel(claimId).toLowerCase()} in captured search ads. This message was not observed in ${client.label}'s captured ads.`,
          `${listNames(withClaim)} mention ${claimLabel(claimId).toLowerCase()}; this message was not observed in ${client.label}'s captured ads.`),
        detail: withClaim.slice(0, 4).map((c) => `${c.label}: "${trim(c.claims.get(claimId).verbatim)}"`).join(" · "),
        count: withClaim.length, denominator: D,
        evidence: dedupe(withClaim.flatMap((c) => c.claims.get(claimId).evidence)),
        reportLine: `${withClaim.length} of ${D} selected competitors' captured search ads mentioned ${claimLabel(claimId).toLowerCase()}; this message was not observed in ${client.label}'s captured ads.`,
      });
    }

    // Strength: the client advertises it and nobody else does. Half the
    // question Han asked, and the half the old board could not answer at all.
    if (clientHas && withClaim.length === 0 && D >= 1) {
      push({
        rule: "claim_advantage",
        label: "MESSAGE ADVANTAGE",
        unit: UNITS.BRAND,
        direction: "positive",
        outcome: OUTCOMES.LEAD,
        headline: `${client.label} is the only advertiser in the captured set mentioning ${claimLabel(claimId).toLowerCase()}.`,
        detail: `"${trim(client.claims.get(claimId).verbatim)}" — not observed in any of ${D} competitors' captured ads.`,
        count: 1, denominator: D + 1,
        evidence: dedupe(client.claims.get(claimId).evidence),
        reportLine: `${client.label}'s captured ads mentioned ${claimLabel(claimId).toLowerCase()}; this message was not observed in ${D} selected competitors' captured ads.`,
      });
    }
  }

  // ---- LEAD EMPHASIS -------------------------------------------------------
  // "Lead" is defined by POSITION — the first headline part — decided in the
  // extractor prompt and never by impression. If it were a judgement call,
  // extraction variance would become a counted fact, which is exactly the
  // defect that killed the old lever-density metric.
  if (client.leadEmphasis && D >= 3) {
    const byLead = new Map();
    for (const c of usable) if (c.leadEmphasis) byLead.set(c.leadEmphasis, (byLead.get(c.leadEmphasis) || 0) + 1);
    const [topLead, topN] = [...byLead.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (topLead && topLead !== client.leadEmphasis && topN >= Math.ceil(D / 2)) {
      push({
        rule: "lead_emphasis",
        label: "LEAD MESSAGE",
        unit: UNITS.CREATIVE,
        direction: "neutral",
        outcome: OUTCOMES.CONTEXT,
        headline: `${topN} of ${D} competitors lead with ${LEAD_WORDS[topLead] || topLead}. ${client.label}'s ads lead with ${LEAD_WORDS[client.leadEmphasis] || client.leadEmphasis}.`,
        detail: "Lead is the first headline slot, not overall prominence.",
        count: topN, denominator: D,
        evidence: dedupe(usable.filter((c) => c.leadEmphasis === topLead).flatMap((c) => c.ads?.map((a) => a.creativeId) || [])),
        reportLine: `${topN} of ${D} selected competitors' captured ads led with ${LEAD_WORDS[topLead] || topLead}; ${client.label}'s captured ads led with ${LEAD_WORDS[client.leadEmphasis] || client.leadEmphasis}.`,
      });
    }
  }

  // ---- CHANGE, versus the previous snapshot --------------------------------
  // Only over brands present in BOTH runs. A competitor added this month has no
  // prior state, so calling their offer "newly observed" would manufacture a
  // change out of a change to the competitor set — and that is the card most
  // likely to end up in front of a client.
  if (previous) push(...changeFindings({ client, usable, previous, profile }));

  // ---- ADVERTISED VERSUS CURRENT -------------------------------------------
  // The one finding with zero CEO-constraint risk: it is about the client's own
  // creative hygiene and names nobody's product as worse than anybody's.
  if (ratePages) push(...advertisedVsCurrent({ client, usable, ratePages, profile }));

  // ---- MIXED MESSAGE, inside the client's own ad set -----------------------
  //
  // The LaCap capture shows why this earns a rule. One ad prints "$5.99/month*
  // with BaZing"; another says "No Fee". Both are the client's own advertising,
  // both are true, and a consumer scanning search results sees a contradiction.
  //
  // BUT: those are almost certainly different things — an optional benefits
  // package versus the account itself. So this rule STATES THE OBSERVATION AND
  // ASKS. It never asserts a contradiction, because the tool cannot tell a
  // genuine inconsistency from two ads about two products, and asserting one
  // that turns out to be the latter is exactly the kind of confident wrong
  // answer that costs a strategist their trust in the whole board.
  //
  // Context bucket, not pressure. It is not a competitor beating anyone.
  if (client.hasCoverage) {
    for (const metric of profile.metrics) {
      const m = metricOf(metric);
      if (!m || m.direction !== "lower") continue;    // fees and minimums only

      const pos = client.positions[metric];
      const negatingClaim = NEGATION_CLAIMS[metric];
      if (!pos || !negatingClaim || !client.claims.has(negatingClaim)) continue;

      const feeAd = (client.ads || []).find((a) => (a.facts || []).some((f) => f.metric === metric));
      const freeAd = (client.ads || []).find((a) => (a.claims || []).some((c) => c.claim === negatingClaim));
      if (!feeAd || !freeAd || feeAd.creativeId === freeAd.creativeId) continue;

      push({
        rule: "mixed_message",
        label: "MIXED MESSAGE",
        unit: UNITS.CREATIVE,
        metric,
        direction: "neutral",
        outcome: OUTCOMES.CONTEXT,
        headline: `${client.label}'s captured ads show both ${pos.raw} and "${trim(client.claims.get(negatingClaim).verbatim, 40)}".`,
        // Neutral, and about the COPY rather than the product. The two figures
        // are almost certainly an account and an optional add-on, so there is
        // no contradiction to assert — but both ran in the same window and a
        // reader scanning search results does not separate them. Stating that
        // is an observation; telling the client to rewrite the ad is advice,
        // and advice is not this tool's job.
        detail: `Both ran in the same window. If they describe different things — an account and an optional add-on — the figures do not conflict, though someone scanning search results sees them together.`,
        count: 2, denominator: null,
        evidence: dedupe([feeAd.creativeId, freeAd.creativeId]),
        reportLine: "",
      });
    }
  }

  // ---- CONTEXT -------------------------------------------------------------
  const longest = [client, ...usable].map((b) => ({
    b, days: Math.max(0, ...(b.ads || []).map((a) => a.totalDaysShown || 0)),
  })).sort((a, b) => b.days - a.days)[0];
  if (longest?.b?.isClient && longest.days > 365 && client.urgency) {
    push({
      rule: "longevity",
      label: "CREATIVE AGE",
      unit: UNITS.CREATIVE,
      direction: "neutral",
      outcome: OUTCOMES.CONTEXT,
      headline: `${client.label}'s longest-running captured ad has served on ${longest.days.toLocaleString()} days and carries limited-time language.`,
      detail: "Days served is a count of days the ad was live, not a continuous run, and not a performance signal.",
      count: longest.days, denominator: null,
      evidence: dedupe((client.ads || []).filter((a) => a.totalDaysShown === longest.days).map((a) => a.creativeId)),
      reportLine: "",
    });
  }

  out.sort((a, b) => (b.priority - a.priority) || (b.count || 0) - (a.count || 0));
  return out;
}

/** The 3–6 the board shows. Never manufactured up to a target count. */
export function topFindings(findings, max = 6) {
  return findings.slice(0, max);
}

export function emptyStateFor(coverage) {
  if (!coverage.client.usable) {
    return { kind: "no_client_ads", text: `No on-product ads were captured for the client, so comparisons against their own advertising cannot be made.`, remedy: coverage.client.remedy };
  }
  if (coverage.usableCount === 0) {
    return { kind: "no_competitor_ads", text: "No competitor had on-product ads in this capture.", remedy: coverage.suggestions[0]?.remedy || "" };
  }
  // The honest clean version — only reachable when coverage was actually good.
  return { kind: "no_differences", text: "No material competitive differences were identified in the captured ads for this product.", remedy: "" };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const LEAD_WORDS = {
  rate: "a rate", bonus: "a cash bonus", fee: "a fee claim",
  feature: "a product feature", brand: "the brand", audience: "an audience",
  other: "something else",
};

function strongerWord(m) { return m.direction === "higher" ? "a higher" : "a lower"; }

/** "1 competitor" / "3 competitors" — kills "all 1 comparable competitor". */
function nOf(n, noun) { return `${n} ${noun}${n === 1 ? "" : "s"}`; }

/** Subject-verb agreement for named lists. "Campus Federal advertise" was a bug. */
function verb(n, singular, plural) { return n === 1 ? singular : plural; }
function weakerWord(m) { return m.direction === "higher" ? "a lower" : "a higher"; }
function trim(s, n = 60) { const t = String(s || ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }
function listNames(brands) {
  const names = brands.map((b) => b.label);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Ratio phrasing versus named phrasing.
 *
 * Below three readable competitors a ratio is not a market statement, it is an
 * anecdote wearing a denominator. "1 of 2 competitors advertised a bonus" reads
 * as a finding and is not one. Named phrasing is honest at small n, and the
 * board additionally marks these internal-only.
 */
function ratio(n, d, coverage, ratioText, namedText) {
  return coverage.allowRatioLanguage ? ratioText : namedText;
}

function gapFinding({ metric, m, others, D, client, coverage, profile }) {
  const isBonus = metric === "cash_bonus";
  return {
    rule: isBonus ? "bonus_gap" : "rate_position",
    label: isBonus ? "BONUS GAP" : "OFFER GAP",
    unit: UNITS.BRAND,
    metric,
    direction: "negative",
    outcome: OUTCOMES.PRESSURE,
    headline: ratio(others.length, D, coverage,
      `${others.length} of ${D} competitors advertise ${m.label.toLowerCase()}. ${client.label}'s captured ads do not.`,
      `${listNames(others)} ${verb(others.length, "advertises", "advertise")} ${m.label.toLowerCase()}; ${client.label}'s captured ads do not.`),
    detail: others.slice(0, 5).map((o) => `${o.label} ${o.position.raw}`).join(" · "),
    count: others.length, denominator: D,
    evidence: dedupe(others.flatMap((o) => o.position.all.map((f) => f.creativeId))),
    reportLine: `${m.label} appeared in ${others.length} of ${D} selected competitors' captured ${profile.label.toLowerCase()} ads; ${client.label}'s captured ads did not advertise ${m.label.toLowerCase()}.`,
  };
}

/**
 * A figure we can show but refuse to rank.
 *
 * "Campus advertises 5.00% and the client 4.50%, on different balance caps, so
 * these are not ranked as like-for-like" is a genuinely useful sentence. It is
 * more useful than either ranking them — technically true, commercially
 * misleading — or hiding the observation entirely.
 */
function notRankedFinding({ metric, m, subject, rank, client }) {
  if (!rank.notComparable.length) return null;
  return {
    rule: "not_ranked",
    label: "NOT LIKE-FOR-LIKE",
    unit: UNITS.BRAND,
    metric,
    direction: "neutral",
    outcome: OUTCOMES.CONTEXT,
    headline: `${m.label} figures were advertised by ${client.label} and ${rank.notComparable.length} competitor${rank.notComparable.length === 1 ? "" : "s"}, but the captured ads are not directly comparable.`,
    detail: [
      `${client.label} ${subject.raw}`,
      ...rank.notComparable.map((n) => `${n.label} ${n.position.raw} (${n.reason})`),
    ].join(" · "),
    count: rank.notComparable.length, denominator: rank.notComparable.length,
    evidence: dedupe([subject.creativeId, ...rank.notComparable.flatMap((n) => n.position.all.map((f) => f.creativeId))]),
    reportLine: `${client.label} and ${rank.notComparable.length} selected competitor${rank.notComparable.length === 1 ? "" : "s"} advertised ${m.label} figures; the captured ads showed different qualifying terms, so the figures are reported without ranking.`,
  };
}

/**
 * Deltas against the previous snapshot.
 *
 * `first_shown` from the provider is the first appearance of a CREATIVE, not a
 * competitor entering a product or a channel. A competitor refreshing artwork
 * looks identical to a new entrant through that field. So change detection runs
 * against OUR OWN snapshots and against nothing else.
 */
function changeFindings({ client, usable, previous, profile }) {
  const out = [];
  const prevBrands = new Map((previous.brands || []).map((b) => [b.domain, b]));

  for (const c of usable) {
    const before = prevBrands.get(c.domain);
    if (!before) continue;                       // no prior state: never a "change"

    for (const metric of profile.metrics) {
      const now = c.positions[metric];
      // A SNAPSHOT IS ONLY AS GOOD AS THE READER THAT WROTE IT.
      //
      // An older snapshot can hold a figure today's gate would refuse — the
      // August capture stored Baton Rouge Telco's clipped "Up To 5.5…" as a
      // cash bonus. Once the gate started refusing it, the delta engine saw a
      // bonus yesterday and none today and reported that the competitor had
      // WITHDRAWN AN OFFER. Nothing changed in the market; the tool got better
      // at reading. Re-gating the previous side makes an extractor improvement
      // silent, which is the only honest way for it to arrive.
      const wasRaw = before.positions?.[metric];
      const was = wasRaw && isCompleteFigure(wasRaw.raw, metricOf(metric)?.unit) ? wasRaw : null;

      if (now && !was) {
        out.push({
          rule: "offer_new",
          label: "RECENT CHANGE",
          unit: UNITS.BRAND,
          metric,
          direction: "negative",
          outcome: OUTCOMES.PRESSURE,
          headline: `${c.label}'s ${metricOf(metric).label.toLowerCase()} of ${now.raw} is newly observed since the ${previous.label} benchmark.`,
          detail: `Previously observed: ${describeBrand(before, profile)}`,
          count: 1, denominator: 1,
          evidence: dedupe(now.all.map((f) => f.creativeId)),
          reportLine: `${c.label}'s captured ads advertised ${now.raw}, which was not observed in the ${previous.label} capture.`,
        });
      } else if (!now && was) {
        // A competitor retreating is a real diagnostic signal and it sits on the
        // positive side of the ledger, which the board is short of.
        out.push({
          rule: "offer_withdrawn",
          label: "RECENT CHANGE",
          unit: UNITS.BRAND,
          metric,
          direction: "positive",
          outcome: OUTCOMES.LEAD,
          headline: `${c.label}'s ${metricOf(metric).label.toLowerCase()} of ${was.raw} was not observed in this capture.`,
          detail: `Observed in the ${previous.label} benchmark; not observed in the current window.`,
          count: 1, denominator: 1,
          evidence: [],
          reportLine: `${c.label}'s ${was.raw} was observed in the ${previous.label} capture and was not observed in the current window.`,
        });
      } else if (now && was && Number.isFinite(now.value) && Number.isFinite(was.value) && now.value !== was.value) {
        out.push({
          rule: "offer_changed",
          label: "RECENT CHANGE",
          unit: UNITS.BRAND,
          metric,
          direction: "neutral",
          outcome: OUTCOMES.CONTEXT,
          headline: `${c.label}'s advertised ${metricOf(metric).label.toLowerCase()} moved from ${was.raw} to ${now.raw} since the ${previous.label} benchmark.`,
          detail: "",
          count: 1, denominator: 1,
          evidence: now.all.map((f) => f.creativeId),
          reportLine: `${c.label}'s captured ads advertised ${now.raw}, compared with ${was.raw} in the ${previous.label} capture.`,
        });
      }
    }
  }
  return out;
}

function describeBrand(b, profile) {
  const bits = profile.metrics.map((m) => b.positions?.[m]?.raw).filter(Boolean);
  return bits.length ? bits.join(" · ") : "no offer figures captured";
}

/**
 * Ads are historical; the rate page is current.
 *
 * Rate-page figures are DISPLAY-ONLY and never enter a denominator: coverage of
 * rate pages is wildly inconsistent (JS-rendered tables, PDFs, "view all rates"
 * links), and inconsistent coverage produces biased counts. What it can do is
 * flag a client still advertising a figure their own page no longer shows.
 */
function advertisedVsCurrent({ client, usable, ratePages, profile }) {
  const out = [];
  for (const brand of [client, ...usable]) {
    const page = ratePages[brand.domain];
    if (!page || !page.ok) continue;
    for (const metric of profile.metrics) {
      const adv = brand.positions[metric];
      const cur = page.facts?.find((f) => f.metric === metric);
      if (!adv || !cur || !Number.isFinite(adv.value) || !Number.isFinite(cur.value)) continue;
      if (adv.value === cur.value) continue;
      out.push({
        rule: "advertised_vs_current",
        label: "ADVERTISED VS CURRENT",
        unit: UNITS.BRAND,
        metric,
        direction: "neutral",
        outcome: OUTCOMES.CONTEXT,
        headline: `${brand.label}'s captured ads advertise ${adv.raw}. Their current ${profile.label.toLowerCase()} rate page shows ${cur.raw}.`,
        detail: `Page fetched ${page.fetchedAt?.slice(0, 10)}. Rate-page figures are shown for context and are not ranked against advertising.`,
        count: 1, denominator: 1,
        evidence: dedupe(adv.all.map((f) => f.creativeId)),
        sourceNote: page.url,
        reportLine: `${brand.label}'s captured ads advertised ${adv.raw}; their ${profile.label.toLowerCase()} rate page showed ${cur.raw} when fetched on ${page.fetchedAt?.slice(0, 10)}.`,
      });
    }
  }
  return out;
}
