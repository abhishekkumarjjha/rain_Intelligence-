// =============================================================================
// lib/coverage.js — WHAT WE ACTUALLY SAW, and what that licenses us to say.
//
// "No search ads" is not one state. It is four, with four different remedies,
// and the old UI collapsed them into a single shrug:
//
//   not_advertising   the advertiser was not found on this source at all
//   outside_window    ads exist for the advertiser but none served in the window
//   off_product       ads served in the window, none classified to this product
//   partial           on-product ads exist but the capture was truncated
//
// THE HARD GATE, and the reason this file is separate from findings.js:
//
//   If the CLIENT has zero on-product ads, every client-gap finding is
//   suppressed. You cannot write "La Capitol's captured ads do not advertise a
//   bonus" when you captured zero La Capitol ads. That is the single most
//   dangerous false statement this tool can produce, it is trivially easy to
//   hit — LaCap's own run listed 45 and kept 9 — and it reads as authoritative
//   because every other number on the page is real.
//
// The second rule: a competitor with no coverage is EXCLUDED FROM EVERY
// DENOMINATOR and listed separately. Counting a competitor we could not read as
// a competitor who does not advertise a bonus is the same error wearing a
// different hat.
// =============================================================================

export const COVERAGE = {
  OK: "ok",
  PARTIAL: "partial",
  OFF_PRODUCT: "off_product",
  OUTSIDE_WINDOW: "outside_window",
  NOT_ADVERTISING: "not_advertising",
};

const MESSAGES = {
  [COVERAGE.NOT_ADVERTISING]: {
    short: "No ads found on this source",
    remedy: "This advertiser was not found in the Transparency Center for the window. They may not run search ads, or they may buy under an advertiser account not linked to this domain.",
  },
  [COVERAGE.OUTSIDE_WINDOW]: {
    short: "No ads served in this window",
    remedy: "Ads exist for this advertiser but none served in the selected dates. Widen the window.",
  },
  [COVERAGE.OFF_PRODUCT]: {
    short: "Ads found, none on this product",
    remedy: "Their captured ads were all for other products. Widen the scope to adjacent products, or check a different product.",
  },
  [COVERAGE.PARTIAL]: {
    short: "Partial coverage",
    remedy: "More creatives were listed than were read. Findings describe the ads captured, not everything this advertiser ran.",
  },
  [COVERAGE.OK]: { short: "", remedy: "" },
};

/**
 * @param {object} brand   rollUpBrand() output
 * @param {object} runInfo per-domain progress record from the capture
 */
export function coverageFor(brand, runInfo = {}) {
  const listed = Number(runInfo.listed ?? runInfo.providerTotal ?? 0);
  const read = Number(runInfo.read ?? 0);
  const onProduct = brand.adCount;

  let state;
  if (onProduct > 0) state = (listed > read && read > 0) ? COVERAGE.PARTIAL : COVERAGE.OK;
  else if (read > 0) state = COVERAGE.OFF_PRODUCT;
  else if (listed > 0) state = COVERAGE.OUTSIDE_WINDOW;
  else state = COVERAGE.NOT_ADVERTISING;

  return {
    state,
    usable: onProduct > 0,
    listed, read, onProduct,
    truncatedAds: brand.truncatedAds || 0,
    ...MESSAGES[state],
  };
}

/**
 * Assemble the coverage picture for the whole board, and decide what the
 * findings engine is permitted to assert.
 */
export function assessCoverage({ client, competitors, progress = {} }) {
  const clientCoverage = coverageFor(client, progress[client.domain] || {});
  const competitorCoverage = competitors.map((c) => ({
    key: c.key, label: c.label, domain: c.domain, tier: c.tier,
    ...coverageFor(c, progress[c.domain] || {}),
  }));

  const usable = competitorCoverage.filter((c) => c.usable);
  const unusable = competitorCoverage.filter((c) => !c.usable);

  // Named candidates, not a generic "add more competitors". Telling fulfillment
  // to widen coverage without naming who to add is how a report ends up padded
  // with whoever was handy, which dilutes every ratio on the page.
  const suggestions = [];
  if (!clientCoverage.usable) {
    suggestions.push({
      severity: "blocking",
      text: `No on-product ads were captured for ${client.label}. Comparisons against the client's own advertising are suppressed for this run.`,
      remedy: clientCoverage.remedy,
    });
  }
  if (usable.length < 3) {
    suggestions.push({
      severity: "warning",
      text: usable.length === 0
        ? "No competitor had on-product ads in this capture."
        : `Only ${usable.length} of ${competitors.length} competitors had on-product ads. Ratio findings need at least three.`,
      remedy: unusable.length
        ? `No coverage for ${unusable.map((c) => c.label).join(", ")}. Try a wider window, or add competitors known to run search ads for this product.`
        : "Add competitors known to run search ads for this product.",
    });
  }

  const tiers = new Set(usable.map((c) => c.tier || "local"));
  if (tiers.size > 1) {
    suggestions.push({
      severity: "warning",
      text: "This set mixes local and national advertisers. National ads are not necessarily served in the client's market, so a combined ratio is not a local comparison.",
      remedy: "Scope findings to local competitors, or read the tiers separately.",
    });
  }

  return {
    client: clientCoverage,
    competitors: competitorCoverage,
    usableDomains: usable.map((c) => c.domain),
    usableCount: usable.length,
    totalCompetitors: competitors.length,

    // ---- what the engine may assert ----------------------------------------
    // Read by findings.js on every rule. These are permissions, not hints.
    allowClientGapFindings: clientCoverage.usable,
    allowRatioLanguage: usable.length >= 3,
    allowNamedFindings: usable.length >= 1,
    // A ratio computed over a set where half the members could not be read is
    // arithmetic about the capture, not about the market.
    denominatorTrustworthy: usable.length >= 3 && usable.length >= Math.ceil(competitors.length * 0.6),

    suggestions,
    anyTruncated: competitorCoverage.some((c) => c.truncatedAds > 0) || clientCoverage.truncatedAds > 0,
  };
}
