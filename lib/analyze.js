// =============================================================================
// lib/analyze.js — pure logic. No model calls, no I/O, no state.
//
// EVERY NUMBER IN THIS APPLICATION IS COMPUTED HERE.
//
// That is the whole rule. A model transcribes a creative and classifies it; a
// model never counts, never compares, never decides what is absent. The first
// time a strategist checks a count and finds it invented, nothing else in the
// tool is believed again — and this tool's output goes in front of clients.
//
// Being pure also means every claim the UI makes is unit-testable without a key
// and without a network.
// =============================================================================

import { PRODUCT_LABELS, bucketFor } from "./products.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// CLUSTERING — collapse variations so a wall of near-identical banners reads as
// one idea with N executions, rather than N separate competitive findings.
//
// Runs AFTER extraction because the useful signal (headline, offer) only exists
// once a creative has been read. Byte-identical duplicates were already removed
// before extraction, in the provider layer, where they cost nothing.
// ---------------------------------------------------------------------------
export function clusterAds(ads) {
  const groups = new Map();
  for (const ad of ads) {
    // The identity of an idea: what it says plus what it offers. Two banners
    // with the same headline and the same offer at different pixel sizes are
    // one idea sized for two placements, not two ideas.
    const key = [norm(ad.headline), norm(ad.offer?.value || ""), ad.product].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ad);
  }

  return [...groups.values()].map((members) => {
    // The representative is the longest-running member: if a competitor kept
    // paying for one execution of an idea, that is the one worth showing.
    const rep = members.slice().sort((a, b) => (b.totalDaysShown ?? -1) - (a.totalDaysShown ?? -1))[0];
    return {
      ...rep,
      variations: members.length,
      variationIds: members.map((m) => m.creativeId),
      // Sizes are how a creative team reads a display buy at a glance.
      sizes: [...new Set(members.map((m) => (m.width && m.height) ? `${m.width}x${m.height}` : null).filter(Boolean))],
    };
  }).sort((a, b) => {
    if (b.variations !== a.variations) return b.variations - a.variations;
    return (b.totalDaysShown ?? -1) - (a.totalDaysShown ?? -1);
  });
}

// ---------------------------------------------------------------------------
// PRODUCT BREAKDOWN — counts per product, for the filter chips.
// ---------------------------------------------------------------------------
export function productBreakdown(ads) {
  const counts = new Map();
  for (const ad of ads) counts.set(ad.product, (counts.get(ad.product) || 0) + 1);
  return [...counts.entries()]
    .map(([code, n]) => ({ code, label: PRODUCT_LABELS[code] || code, count: n }))
    .sort((a, b) => b.count - a.count);
}

export function filterByProduct(ads, product, { includeAdjacent = false } = {}) {
  if (!product || product === "all") return ads;
  return ads.filter((a) => {
    const b = bucketFor(a.product, product);
    return b === "on" || (includeAdjacent && b === "adjacent");
  });
}

// ---------------------------------------------------------------------------
// THE BENCHMARK — ads vs ads.
//
// The client's own advertising is captured through the IDENTICAL path as every
// competitor's: same provider, same format, same date window, same cap. That is
// what makes the comparison fair, and it is the reason this tool does not read
// anybody's live rate page.
//
// The claim being supported is deliberately narrow:
//   "Over this window, in the ads we captured, competitors advertised X and the
//    client advertised Y."
// NOT "competitors offer X" (their live product may differ from their ad) and
// NOT "the client's product is worse" (that is the client's inference to draw).
// ---------------------------------------------------------------------------
export function buildBenchmark({ client, competitors, product, runs }) {
  const scope = (ads) => filterByProduct(ads || [], product);

  const clientAds = scope(client.ads);
  const columns = [
    { key: "client", label: client.label, domain: client.domain, isClient: true, ads: clientAds },
    ...competitors.map((c) => ({
      key: c.domain, label: c.label, domain: c.domain, isClient: false, ads: scope(c.ads),
    })),
  ];

  const rows = [];

  // ---- row: how many on-product ads were captured at all -------------------
  rows.push({
    id: "volume",
    label: "On-product ads captured",
    kind: "count",
    // The denominator is stated in the cell, always. "8" alone invites the
    // reader to treat it as the competitor's total ad count, which it is not.
    cells: columns.map((col) => ({
      column: col.key,
      value: String(col.ads.length),
      note: `of ${(col.ads.length + (allOf(col) - col.ads.length))} captured`,
      evidence: col.ads.map((a) => a.creativeId),
    })),
  });

  // ---- row: does anyone advertise an offer, and what kind ------------------
  const offerTypes = ["rate", "bonus", "discount", "fee_waiver"];
  for (const type of offerTypes) {
    const cells = columns.map((col) => {
      const withOffer = col.ads.filter((a) => a.offer && a.offer.type === type);
      if (!withOffer.length) {
        return { column: col.key, value: "—", absent: true, evidence: [] };
      }
      // Show the STRONGEST advertised value, because that is the one a
      // consumer comparing ads would see and act on. The full list stays as
      // evidence so nobody has to trust the pick.
      const best = pickHeadline(withOffer, type);
      return {
        column: col.key,
        value: best.offer.value,
        detail: qualifierLine(best.offer),
        note: withOffer.length > 1 ? `${withOffer.length} ads` : "",
        evidence: withOffer.map((a) => a.creativeId),
        primaryEvidence: best.creativeId,
      };
    });

    // Only emit a row somebody actually advertised. An empty row is noise; an
    // ABSENT CELL in a populated row is the finding.
    if (cells.some((c) => !c.absent)) {
      rows.push({
        id: `offer_${type}`,
        label: OFFER_ROW_LABELS[type],
        kind: "offer",
        offerType: type,
        cells,
        // The comparability warning travels WITH the row, not in a footnote
        // nobody reads. See comparabilityOf().
        comparability: comparabilityOf(cells, columns),
      });
    }
  }

  // ---- row: longevity — has anyone kept paying for this? -------------------
  rows.push({
    id: "longevity",
    label: "Longest-running on-product ad",
    kind: "longevity",
    cells: columns.map((col) => {
      const longest = col.ads.slice().sort((a, b) => (b.totalDaysShown ?? -1) - (a.totalDaysShown ?? -1))[0];
      if (!longest || longest.totalDaysShown == null) {
        return { column: col.key, value: "—", absent: true, evidence: [] };
      }
      return {
        column: col.key,
        // Phrasing is fixed here, in code, so no caller can shorten it into
        // "running for 3 years". totalDaysShown is a count of days served and
        // is not necessarily contiguous.
        value: `${longest.totalDaysShown.toLocaleString()} days`,
        detail: longest.firstShown ? `shown on ${longest.totalDaysShown.toLocaleString()} days since ${monthYear(longest.firstShown)}` : "",
        evidence: [longest.creativeId],
        primaryEvidence: longest.creativeId,
      };
    }),
  });

  // ---- row: creative volume behind the message -----------------------------
  rows.push({
    id: "distinct_ideas",
    label: "Distinct creative ideas",
    kind: "count",
    cells: columns.map((col) => ({
      column: col.key,
      value: String(clusterAds(col.ads).length),
      note: col.ads.length ? `${col.ads.length} execution${col.ads.length === 1 ? "" : "s"}` : "",
      evidence: col.ads.map((a) => a.creativeId),
    })),
  });

  // ---- row: freshness ------------------------------------------------------
  rows.push({
    id: "freshness",
    label: "Most recently observed",
    kind: "date",
    cells: columns.map((col) => {
      const latest = col.ads.map((a) => a.lastShown).filter(Boolean).sort().pop();
      return latest
        ? { column: col.key, value: latest, evidence: [] }
        : { column: col.key, value: "—", absent: true, evidence: [] };
    }),
  });

  return {
    product,
    columns: columns.map(({ ads, ...c }) => ({ ...c, adCount: ads.length })),
    rows,
    // Every observation the table points at, so a click can show the artifact.
    findings: countedFindings(columns, product),
    sampling: samplingNote(runs),
  };

  function allOf(col) {
    const src = col.isClient ? client.ads : (competitors.find((c) => c.domain === col.domain)?.ads || []);
    return (src || []).length;
  }
}

const OFFER_ROW_LABELS = {
  rate: "Advertised rate",
  bonus: "Advertised cash bonus",
  discount: "Advertised discount",
  fee_waiver: "Advertised fee waiver",
};

/** Highest advertised value of a given type — the one a consumer would notice. */
function pickHeadline(ads, type) {
  const scored = ads.filter((a) => a.offer?.numeric);
  if (!scored.length) return ads[0];
  // Rates: higher is more attractive on deposits, lower on loans. We do NOT
  // try to guess which — we show the largest printed figure and let the row
  // label plus the evidence carry the meaning. Guessing direction here would
  // be the model-inventing-semantics failure in a different costume.
  return scored.slice().sort((a, b) => b.offer.numeric.n - a.offer.numeric.n)[0];
}

function qualifierLine(offer) {
  const bits = [offer.term, offer.minimum, offer.qualifier].filter(Boolean);
  return bits.length ? bits.join(" · ") : "";
}

/**
 * Can these cells honestly be read as like-for-like?
 *
 * Most banner creatives print a figure and nothing else. When the qualifying
 * detail is missing on either side, the numbers are still WHAT WAS ADVERTISED —
 * which is the correct unit for "why did our ad underperform", because the
 * person clicking never saw the term sheet either. But the row must say so.
 */
function comparabilityOf(cells, columns) {
  const present = cells.filter((c) => !c.absent);
  if (present.length < 2) return { level: "single", note: "" };

  const missingDetail = present.filter((c) => !c.detail).length;
  if (missingDetail === 0) {
    return { level: "qualified", note: "Terms visible on all creatives shown." };
  }
  if (missingDetail === present.length) {
    return {
      level: "advertised-only",
      note: "None of these creatives printed a term or minimum. These are the offers as advertised, not full product terms.",
    };
  }
  return {
    level: "mixed",
    note: `${missingDetail} of ${present.length} creatives did not print a term or minimum. Compare as advertised offers, not as product terms.`,
  };
}

/**
 * Counted findings — the "3 of 3 competitors advertised a bonus, the client did
 * not" sentences. Every one carries its own denominator and its own evidence.
 *
 * ABSENCE IS A FIRST-CLASS FINDING and is the single most useful output of the
 * whole benchmark, so it gets computed explicitly rather than falling out of a
 * missing row. But absence is always scoped to what was captured — never to
 * the market.
 */
export function countedFindings(columns, product) {
  const comps = columns.filter((c) => !c.isClient);
  const client = columns.find((c) => c.isClient);
  const out = [];
  if (!client || !comps.length) return out;

  for (const type of ["rate", "bonus", "discount", "fee_waiver"]) {
    const compsWith = comps.filter((c) => c.ads.some((a) => a.offer?.type === type));
    const clientHas = client.ads.some((a) => a.offer?.type === type);
    if (!compsWith.length) continue;

    if (!clientHas) {
      out.push({
        kind: "gap",
        text: `${compsWith.length} of ${comps.length} competitors advertised ${OFFER_NOUNS[type]} in the ads captured. ${client.label} did not.`,
        evidence: compsWith.flatMap((c) => c.ads.filter((a) => a.offer?.type === type).map((a) => a.creativeId)),
      });
    } else if (compsWith.length === comps.length) {
      out.push({
        kind: "parity",
        text: `All ${comps.length} competitors and ${client.label} advertised ${OFFER_NOUNS[type]}.`,
        evidence: [],
      });
    }
  }

  // Volume asymmetry — the "nobody is even in market" / "we are outgunned" read.
  const clientN = client.ads.length;
  const compTotal = comps.reduce((s, c) => s + c.ads.length, 0);
  if (clientN === 0 && compTotal > 0) {
    out.push({
      kind: "gap",
      text: `No on-product ads were captured for ${client.label} in this window, against ${compTotal} across ${comps.length} competitors.`,
      evidence: [],
    });
  }

  return out;
}

const OFFER_NOUNS = {
  rate: "a rate",
  bonus: "a cash bonus",
  discount: "a discount",
  fee_waiver: "a fee waiver",
};

/**
 * The sentence that keeps every superlative in the UI honest.
 *
 * When a capture is incomplete — which for image creatives it essentially
 * always is, since one domain returned ~2,000 against a retrieval ceiling of
 * 100 — the tool may say "the longest-running ad we captured" and may NOT say
 * "their longest-running ad". This object is what the UI reads to decide.
 */
export function samplingNote(runs = []) {
  const incomplete = runs.filter((r) => r && r.complete === false);
  const total = runs.reduce((s, r) => s + (r?.providerTotal || 0), 0);
  const read = runs.reduce((s, r) => s + (r?.selectedForReading || 0), 0);
  return {
    complete: incomplete.length === 0,
    providerTotal: total,
    read,
    // Used verbatim. Do not paraphrase this into something more confident.
    //
    // The old complete-branch sentence was "All N creatives in this window were
    // retrieved." It was true about RETRIEVAL and read as a claim about
    // READING, so a capture that listed 55 and read 12 announced "all 55" over
    // a wall of 2. Retrieval and reading are now always stated together,
    // because the gap between them is the number people actually ask about.
    note: incomplete.length === 0
      ? `All ${total.toLocaleString()} creatives listed for this window were retrieved; ${read.toLocaleString()} were selected to read.`
      : `${read.toLocaleString()} of about ${total.toLocaleString()} creatives listed in this window were read. Findings describe the ads captured, not the whole market.`,
  };
}

// ---------------------------------------------------------------------------
// THE CAPTURE FUNNEL — where every creative went.
//
// "55 found" next to a wall of 2 is the single most damaging thing this UI can
// show, because there are five legitimate reasons for the gap and the user can
// see none of them:
//
//   listed      what the provider says exists for this domain and window
//   retrieved   what one page of results actually returned (num is capped at 100)
//   renderable  those carrying a real image URL — the rest are preview-only
//               JavaScript links a vision model cannot read
//   selected    the read cap (RI_MAX_READ) biting, because vision is per-creative
//   downloaded  minus fetch failures, minus byte-identical duplicates collapsed
//   read        minus creatives the model could not transcribe
//   on-product  minus everything classified as a different product
//
// Every step is a real number from the capture-run records, so the chain always
// reconciles and no step can be a guess.
// ---------------------------------------------------------------------------
export function captureFunnel(runs = [], ads = [], onProduct = null) {
  const sum = (k) => runs.reduce((n, r) => n + (Number(r?.[k]) || 0), 0);

  const listed = sum("providerTotal");
  const retrieved = sum("returned");
  const renderable = sum("renderable");
  const previewOnly = sum("previewOnly");
  const selected = sum("selectedForReading");
  const duplicates = sum("exactDupes");
  const downloadFailed = sum("downloadFailed");
  const read = ads.length;

  const steps = [
    { key: "listed", label: "listed by Google", value: listed },
    { key: "retrieved", label: "retrieved", value: retrieved,
      lost: listed - retrieved, why: "beyond the provider's 100-per-request ceiling" },
    { key: "renderable", label: "have a readable image", value: renderable,
      lost: previewOnly, why: "preview-only links, which carry no image to read" },
    { key: "selected", label: "selected to read", value: selected,
      lost: Math.max(0, renderable - selected), why: `over the read cap of ${MAX_READ_HINT()} per advertiser` },
    { key: "read", label: "read", value: read,
      lost: Math.max(0, selected - read), why: "duplicate artwork collapsed, failed downloads, or unreadable creatives" },
  ];

  if (onProduct != null) {
    steps.push({
      key: "onProduct", label: "on the product in scope", value: onProduct,
      lost: Math.max(0, read - onProduct), why: "classified as a different product",
    });
  }

  return {
    listed, retrieved, renderable, previewOnly, selected,
    duplicates, downloadFailed, read, onProduct,
    steps: steps.filter((s) => s.value > 0 || s.lost > 0),
  };
}

// Read from the environment where available so the funnel's explanation cannot
// drift from the cap actually in force.
function MAX_READ_HINT() {
  const n = Number(globalThis.process?.env?.RI_MAX_READ);
  return Number.isFinite(n) && n > 0 ? n : 18;
}

function monthYear(iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// CREATIVE MODE aggregation — what the inspiration wall needs.
// ---------------------------------------------------------------------------
export function creativeSummary(ads) {
  const clusters = clusterAds(ads);
  const styles = new Map();
  for (const a of ads) styles.set(a.visualStyle, (styles.get(a.visualStyle) || 0) + 1);
  const offers = ads.filter((a) => a.offer);
  return {
    total: ads.length,
    ideas: clusters.length,
    withOffer: offers.length,
    withPeople: ads.filter((a) => a.hasPeople).length,
    styles: [...styles.entries()].map(([style, n]) => ({ style, count: n })).sort((a, b) => b.count - a.count),
    sizes: [...new Set(ads.map((a) => (a.width && a.height) ? `${a.width}x${a.height}` : null).filter(Boolean))],
  };
}
