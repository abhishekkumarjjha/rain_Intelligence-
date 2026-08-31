// =============================================================================
// lib/benchmark.js — assembles the Campaign Benchmark board.
//
// Replaces buildBenchmark() in analyze.js as the deliverable. That function
// still runs and its table is still rendered, but BELOW the findings, as the
// audit trail rather than the answer.
//
// The board is three blocks, in this order:
//
//   1. FINDINGS      3–6 cards. One sentence, one line of detail, one evidence
//                    chip. Never padded to a target count; when there is
//                    nothing, the empty state says so plainly, and says which
//                    KIND of nothing it is.
//   2. OFFER SNAPSHOT  a compact matrix — brands down, profile metrics across.
//                    Everything the findings assert, visible at once.
//   3. REPORT LINES  selectable, neutral-voice sentences fulfillment ticks and
//                    pastes into the monthly report.
//
// The report block is bullets, not a paragraph, because a strategist picks two
// of six findings and needs those two. A prose paragraph has to be rewritten
// before it can be used, which means it will not be used.
// =============================================================================

import { normalizeAll, rollUpBrand } from "./observations.js";
import { assessCoverage } from "./coverage.js";
import { buildFindings, topFindings, emptyStateFor } from "./findings.js";
import { profileFor } from "./profiles.js";
import { metricOf } from "./metrics.js";
import { filterByProduct } from "./analyze.js";
import { competitorSetVersion, setDrift } from "./snapshot.js";
import { readSetShape } from "./set-shape.js";

/**
 * @param {object} args
 *   client        { label, domain, ads }
 *   competitors   [{ label, domain, tier, ads }]
 *   product       taxonomy code
 *   progress      run.progress — per-domain listed/read counts for coverage
 *   previous      previousSnapshot() or null
 *   ratePages     { [domain]: RatePageObservation } or null
 *   maxFindings   default 6
 */
export function buildBoard({
  client, competitors, product, progress = {},
  previous = null, ratePages = null, maxFindings = 6,
}) {
  const profile = profileFor(product);
  const scope = (ads) => normalizeAll(filterByProduct(ads || [], product));

  const clientBrand = withAds(rollUpBrand({
    key: "client", label: client.label, domain: client.domain, isClient: true, ads: scope(client.ads),
  }), scope(client.ads));

  // NATIONALS ARE REFERENCE ONLY.
  //
  // Chase and Capital One advertise nationally and we cannot tell from the
  // Transparency Center whether any of it served in this client's market. So
  // they get a row in the offer snapshot as a ceiling and are excluded from
  // every denominator — "4 of 5 competitors advertise a bonus" means something
  // different if two of the five are national banks whose ads may never have
  // reached Baton Rouge.
  const isReference = (c) => (c.tier || "local") === "national";

  const competitorBrands = competitors.map((c) => {
    const ads = scope(c.ads);
    return {
      ...withAds(rollUpBrand({
        key: c.domain, label: c.label, domain: c.domain, tier: c.tier, isClient: false, ads,
      }), ads),
      // Ads captured for this brand BEFORE the product scope was applied.
      // "We captured nothing from them" and "we captured plenty, none of it
      // about checking" are different competitive facts — the first is a
      // capture result, the second is how the competitor spends. Collapsing
      // both to "no ads captured" told the reader the wrong one.
      capturedTotal: (c.ads || []).length,
    };
  });

  // Coverage, findings and every ratio see LOCAL competitors only.
  const localBrands = competitorBrands.filter((b) => !isReference(b));
  const referenceBrands = competitorBrands.filter((b) => isReference(b));

  const coverage = assessCoverage({ client: clientBrand, competitors: localBrands, progress });

  // Only brands we could actually read enter any denominator. A competitor we
  // failed to capture is not a competitor who does not advertise a bonus.
  const usable = localBrands.filter((b) => b.hasCoverage);

  const setVersion = competitorSetVersion(competitors.filter((c) => !isReference(c)).map((c) => c.domain));
  const drift = previous ? setDrift(setVersion, previous) : null;

  // Deltas run only over brands present in BOTH runs, so a newly added
  // competitor can never manufacture a "newly observed" card.
  const previousForDelta = previous && drift
    ? { ...previous, brands: (previous.brands || []).filter((b) => drift.stable.includes(b.domain)) }
    : previous;

  const all = buildFindings({
    client: clientBrand,
    competitors: usable,
    product,
    coverage,
    previous: previousForDelta,
    ratePages,
  });

  const shown = topFindings(all, maxFindings);

  return {
    product,
    productLabel: profile.label,
    client: { label: client.label, domain: client.domain },
    competitorSet: setVersion,
    setDrift: drift,

    findings: shown,
    findingsTotal: all.length,

    // THREE BOARDS, not two. "Where you lead" and "Where competitors lead" are
    // the scoreboard; everything else is real but is not a scoreboard entry,
    // and mixing it in is what made the old board read as "so what?".
    boards: {
      lead: shown.filter((f) => f.outcome === "lead"),
      pressure: shown.filter((f) => f.outcome === "pressure"),
      context: shown.filter((f) => f.outcome === "context" || !f.outcome),
    },
    // Never padded. Two real findings render as two cards.
    empty: shown.length === 0 ? emptyStateFor(coverage) : null,

    // What the SET is competing on, as distinct from how the client compares on
    // each metric. Counted in code, never written by a model. See set-shape.js.
    setShape: readSetShape({
      client: clientBrand, competitors: usable, reference: referenceBrands, profile, coverage,
    }),

    snapshot: offerSnapshot({ profile, client: clientBrand, competitors: localBrands, reference: referenceBrands }),
    // No report SECTION any more — it repeated the findings verbatim on a
    // screen meant to be scanned in seconds. The capability survives as one
    // copy button in the header, which reads these.
    reportLines: reportLines(shown),

    coverage,
    // The brand rollups, for the snapshot writer and the evidence drawer.
    brands: [clientBrand, ...localBrands],
    referenceBrands,
    // Everything a profile could not classify, surfaced internally. This is the
    // only signal that a profile needs a new claim id — without it the
    // vocabulary rots silently and facts get dropped for years.
    unclassified: [...new Set([clientBrand, ...competitorBrands]
      .flatMap((b) => (b.ads || []).flatMap((a) => a.unclassified || [])))].slice(0, 30),
  };
}

/** rollUpBrand() intentionally does not retain the ad list; the board needs it. */
function withAds(brand, ads) {
  return { ...brand, ads };
}

/**
 * The compact offer matrix — brands down, profile metrics across.
 *
 * Deliberately small. It is not the old benchmark table with new columns: it
 * carries only what the profile says matters for this product, so a checking
 * board shows APY / bonus / monthly fee / minimum and nothing else. Every cell
 * is the brand's strongest advertised value with the verbatim string intact.
 */
/** Lower-case a metric label for use mid-sentence, but never an acronym: "apy"
 *  reads as a typo where "cash bonus" reads as English. */
const soften = (s) => (/[a-z]/.test(String(s)) ? String(s).toLowerCase() : String(s));

function offerSnapshot({ profile, client, competitors, reference = [] }) {
  const columns = profile.snapshot.map((id) => ({
    metric: id,
    label: metricOf(id)?.label || id,
    direction: metricOf(id)?.direction || "none",
  }));

  const scopeLabel = soften(profile.label);
  const row = (b) => ({
    key: b.key, label: b.label, domain: b.domain, isClient: b.isClient,
    tier: b.tier, adCount: b.adCount, hasCoverage: b.hasCoverage,
    capturedTotal: b.capturedTotal ?? b.adCount,
    // Why this brand contributes no figures, in the brand's own row rather
    // than repeated in four identical cells.
    absentReason: b.hasCoverage ? null
      : (b.capturedTotal > 0
          ? `${b.capturedTotal} ad${b.capturedTotal === 1 ? "" : "s"} captured, none about ${scopeLabel}`
          : "no ads captured in this window"),
    cells: columns.map((c) => {
      const p = b.positions[c.metric];
      if (!p) {
        // An em-dash was being read as "they don't charge one". It never meant
        // that — it meant NOT OBSERVED IN THE CAPTURED ADS. Saying so in words
        // costs two words and removes the misreading. What it must never say is
        // "no bonus" or "no minimum": this tool observes advertising and has no
        // basis at all for a claim about the institution's actual product.
        const clipped = b.partial?.[c.metric];
        return {
          metric: c.metric,
          value: !b.hasCoverage
            ? (b.capturedTotal > 0 ? `no ${scopeLabel} ads` : "no ads")
            : clipped ? "cut off" : "none captured",
          absent: true,
          clipped: !!clipped,
          note: !b.hasCoverage
            ? (b.capturedTotal > 0
                ? `${b.capturedTotal} ads were captured for this advertiser, none classified as ${profile.label}. They are advertising — just not this product, in what we captured.`
                : "No ads at all were captured for this advertiser in this window.")
            : clipped
              ? "A figure was advertised here, but the ad text was clipped before it could be read in full."
              : "Not observed in the captured ads. This is not a statement about the product.",
          evidence: clipped ? [...new Set(clipped.all.map((f) => f.creativeId).filter(Boolean))] : [],
        };
      }
      return {
        metric: c.metric,
        value: p.raw,
        absent: false,
        note: qualifierNote(p),
        rankable: p.rankable,
        evidence: p.all.map((f) => f.creativeId),
      };
    }),
    claims: [...b.claims.keys()],
  });

  // A national's row is usually one figure and a line of blanks, which reads as
  // a broken row rather than as the finding it actually is: Chase is buying this
  // product's search results on bonus alone. Collapse it into that sentence.
  const withSummary = (r) => {
    const shown = r.cells.filter((c) => !c.absent);
    const missing = r.cells.filter((c) => c.absent && !c.clipped);
    if (!r.hasCoverage || shown.length !== 1 || missing.length < 2) return r;
    const only = columns.find((c) => c.metric === shown[0].metric);
    return {
      ...r,
      summary: {
        // Said as a STRATEGY, not as a list of blanks. Chase printing a bonus
        // and nothing else across every captured ad is not missing data — it is
        // the whole of what they chose to compete on in this product's results.
        text: `${r.label} leads on ${soften(only.label)} alone — ${shown[0].value}. No ${
          missing.map((c) => soften(columns.find((k) => k.metric === c.metric)?.label || c.metric))
            .join(", ").replace(/, ([^,]*)$/, " or $1")} appeared in any captured ad.`,
        evidence: shown[0].evidence || [],
      },
    };
  };

  return {
    columns,
    rows: [row(client), ...competitors.map(row)],
    // Rendered under their own heading, below a rule, visually separated from
    // the rows that produced the findings.
    reference: reference.map((b) => withSummary({ ...row(b), reference: true })),
    referenceNote: reference.length
      ? "National advertisers, shown for reference only. Their ads are not counted in any finding — we cannot tell from the Transparency Center whether they served in this market."
      : "",
  };
}

function qualifierNote(p) {
  const bits = Object.entries(p.qualifiers || {}).map(([k, v]) => {
    if (v === true) return k.replace(/_/g, " ");
    if (k === "term_months") return `${v}-month`;
    if (k === "minimum_deposit") return `$${Number(v).toLocaleString()} minimum`;
    if (k === "balance_cap") return `up to $${Number(v).toLocaleString()}`;
    if (k === "intro_months") return `${v}-month intro`;
    return `${k.replace(/_/g, " ")}: ${v}`;
  });
  return bits.join(" · ");
}

/**
 * Selectable report lines.
 *
 * Neutral VOICE, not neutral effect. RAIN never asserts that a client's product
 * is worse; the counted facts are allowed to land. Every line is scoped to what
 * was captured, and every line names the denominator it was computed over.
 */
function reportLines(findings) {
  return findings
    .filter((f) => f.reportLine)
    .map((f) => ({
      id: f.rule + (f.metric ? `_${f.metric}` : ""),
      label: f.label,
      text: f.reportLine,
      direction: f.direction,
      evidence: f.evidence || [],
    }));
}
