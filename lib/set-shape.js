// =============================================================================
// lib/set-shape.js — WHAT THE CAPTURED SET IS COMPETING ON.
//
// The board answers "how does the client compare on each metric". It does not
// answer the question a strategist actually opens with, which is "what is this
// category fighting about at all". Those are different questions and the second
// one is not derivable by reading the first six cards in sequence — it is a
// property of the SET, not of any brand in it.
//
// THIS FILE CONTAINS NO MODEL CALL, AND IT MUST NOT ACQUIRE ONE.
//
// That is the whole argument for building it. "Cash bonus is the figure most of
// these brands advertise" is a count over positions already fixed by the
// findings engine — `filter().length`, nothing more. A model asked to produce
// the same sentence can get the count wrong, and would need a fence of
// constraints to do reliably what arithmetic does perfectly. Where a number is
// involved, the model is the strictly worse instrument.
//
// THE LINE THIS FILE DOES NOT CROSS.
//
// Every sentence here describes the captured ads and stops. It never says what
// wins, what works, what performs, or what anyone should do — the capture
// contains no click, no conversion and no spend, so any claim of that kind
// would be invented. "3 of 4 brands advertise a bonus" is an observation.
// "Bonus is what wins here" is market lore wearing an observation's clothes,
// and it belongs in industry-context.js where it is fenced, anonymised and
// labelled as general category patterns rather than as findings about anyone.
//
// The useful middle ground is real, and it is this: state the shape, name the
// denominator, and let the reader draw the conclusion. That is the same
// discipline the findings engine already runs on, applied one level up.
// =============================================================================

import { metricOf } from "./metrics.js";

/** Lower-case for mid-sentence use, but never an acronym. */
const soften = (s) => (/[a-z]/.test(String(s)) ? String(s).toLowerCase() : String(s));

const nOf = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "a, b or c" — the list form used when naming what was absent. */
const orList = (xs) => xs.join(", ").replace(/, ([^,]*)$/, " or $1");

/**
 * @param {object} args
 *   client      the client's brand rollup
 *   competitors LOCAL competitors only, already filtered to those with coverage
 *   reference   national brands — never counted, reported separately
 *   profile     the product profile
 *   coverage    assessCoverage() output, for the ratio-language gate
 * @returns {{observations: Array}|null}
 */
export function readSetShape({ client, competitors = [], reference = [], profile, coverage }) {
  const observations = [];
  const push = (o) => { if (o) observations.push(o); };

  // The population is the client plus every LOCAL competitor we could read.
  // Nationals are excluded here for the same reason they are excluded from
  // every denominator: we cannot tell whether their ads served in this market,
  // so counting them would describe a category the client does not compete in.
  const brands = [client, ...competitors].filter((b) => b && b.hasCoverage);

  // Below three readable brands there is no "shape" — there are two brands and
  // a coincidence. The same floor the findings engine uses for ratio language.
  if (brands.length < 3) return null;

  const metrics = profile.metrics.filter((m) => metricOf(m));

  // How many brands printed a figure on each metric, and which.
  const byMetric = metrics.map((metric) => {
    const has = brands.filter((b) => b.positions[metric]);
    return { metric, label: metricOf(metric).label, has };
  }).filter((x) => x.has.length > 0);

  if (!byMetric.length) return null;

  const ranked = [...byMetric].sort((a, b) => b.has.length - a.has.length);

  // ---- THE CONTESTED AXIS --------------------------------------------------
  // The figure the most brands chose to print. Only worth saying when it
  // actually separates from the next one — if every metric is advertised by the
  // same number of brands, there is no axis, and saying there is one would be
  // manufacturing a pattern out of a tie.
  const top = ranked[0];
  const runnerUp = ranked.find((x) => x.has.length < top.has.length);
  if (top.has.length >= 2 && runnerUp) {
    push({
      kind: "contested_axis",
      chip: top.label,
      metric: top.metric,
      text: `${top.label} is the figure most of these advertisers print — ${top.has.length} of ${nOf(brands.length, "captured brand")} advertise one${
        runnerUp ? `, against ${runnerUp.has.length} for ${soften(runnerUp.label)}` : ""}.`,
      detail: top.has.map((b) => `${b.label} ${b.positions[top.metric].raw}`).join(" · "),
      count: top.has.length,
      denominator: brands.length,
      evidence: dedupe(top.has.flatMap((b) => b.positions[top.metric].all.map((f) => f.creativeId))),
    });
  }

  // ---- AN AXIS ALMOST NOBODY IS ON -----------------------------------------
  // A figure exactly one brand prints. Reported about COMPETITORS only: the
  // client being the sole advertiser of something is already a finding, and
  // repeating it here would be the same sentence twice in different type.
  for (const x of ranked) {
    if (x.has.length !== 1) continue;
    const only = x.has[0];
    if (only.isClient) continue;
    push({
      kind: "uncontested_axis",
      chip: x.label,
      metric: x.metric,
      text: `${only.label} is the only captured advertiser printing ${soften(x.label)} — ${only.positions[x.metric].raw}. The other ${nOf(brands.length - 1, "brand")} printed none.`,
      count: 1,
      denominator: brands.length,
      evidence: dedupe(only.positions[x.metric].all.map((f) => f.creativeId)),
    });
  }

  // ---- ADVERTISING WITHOUT AN OFFER ----------------------------------------
  // A brand running on-product ads that carry no figure at all. This is a
  // genuine strategic posture and it is invisible on the board, because every
  // card is about a figure and this brand has none to compare.
  const noFigure = brands.filter((b) => !b.isClient && Object.keys(b.positions).length === 0);
  for (const b of noFigure) {
    push({
      kind: "brand_only",
      chip: "No figures",
      text: `${b.label} advertised ${soften(profile.label)} without printing any figure — ${nOf(b.adCount, "captured ad")}, no rate, bonus, fee or minimum.`,
      count: b.adCount,
      denominator: b.adCount,
      evidence: dedupe((b.ads || []).map((a) => a.creativeId)),
    });
  }

  // ---- WHAT THE NATIONALS ARE ON -------------------------------------------
  // Reported as its own observation, never merged with the local count. When
  // every national is on the same single axis, that is the clearest signal in
  // the capture about how the category is bought at scale — and it is still
  // only a statement about their ADVERTISING, not about what works.
  const refWithFigures = reference.filter((b) => b.hasCoverage && Object.keys(b.positions).length);
  if (refWithFigures.length >= 2) {
    const axes = refWithFigures.map((b) => Object.keys(b.positions));
    const single = axes.every((a) => a.length === 1) && new Set(axes.map((a) => a[0])).size === 1;
    if (single) {
      const metric = axes[0][0];
      const m = metricOf(metric);
      const absent = metrics.filter((x) => x !== metric).map((x) => soften(metricOf(x).label));
      push({
        kind: "national_axis",
        chip: m.label,
        metric,
        reference: true,
        text: `Both national advertisers compete on ${soften(m.label)} alone — ${
          refWithFigures.map((b) => `${b.label} ${b.positions[metric].raw}`).join(", ")}. No ${orList(absent)} appeared in any of their captured ads.`,
        count: refWithFigures.length,
        denominator: refWithFigures.length,
        evidence: dedupe(refWithFigures.flatMap((b) => b.positions[metric].all.map((f) => f.creativeId))),
      });
    }
  }

  if (!observations.length) return null;

  return {
    observations,
    // Rendered verbatim above the block. It is the register guarantee: this
    // section counts advertising and stops there. Anything a reader concludes
    // about what performs is the reader's conclusion, made knowingly.
    framing: `Counted across the ${nOf(brands.length, "brand")} captured for ${soften(profile.label)}. These describe what was advertised, not what performs — the capture carries no click, conversion or spend data.`,
    brandsCounted: brands.length,
  };
}

const dedupe = (ids) => [...new Set((ids || []).filter(Boolean))];
