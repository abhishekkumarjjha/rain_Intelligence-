// =============================================================================
// lib/national-tier.js — the two standing national benchmarks.
//
// RAIN's competitor analysis has always been six columns: the subject plus five
// competitors, where slots 4 and 5 never change. J.P. Morgan Chase is the
// national benchmark and Capital One is the national digital-first benchmark.
// They are not there because they compete locally with a Baton Rouge credit
// union — they almost never do. They are a fixed national ceiling, so every
// RAIN client sees how they stack up against the biggest and most digitally
// sophisticated players regardless of market.
//
//   slots 1-3  "who actually takes our customers"   picked per subject
//   slots 4-5  "how do we compare to the ceiling"   never change
//
// So the user never selects these. They are appended to every Creative capture,
// which is also what fixes the empty wall: a community bank might run four
// display creatives, while Chase runs hundreds.
//
// ---------------------------------------------------------------------------
// WHY THEY GET THEIR OWN CACHE RULES
// ---------------------------------------------------------------------------
// Chase's display advertising is IDENTICAL no matter which client is being
// analysed. It is not per-client evidence, so it should not be bought
// per-client. The capture cache is already keyed on (source, domain, window)
// rather than on the client, which means one Chase capture already serves every
// analysis — these two just get a longer TTL and a larger read allowance
// because the cost is amortised across every client who ever runs the tool.
//
// One capture a month, shared by all 37 clients, is roughly a rounding error
// per analysis. That is the whole argument for reading MORE of them, not less.
//
// ---------------------------------------------------------------------------
// WHY THEY ARE TIERED IN THE UI RATHER THAN MIXED IN
// ---------------------------------------------------------------------------
// Volume asymmetry is the trap. If a local credit union contributes four cards
// and Chase contributes forty, an undifferentiated wall IS a Chase wall, and
// the local evidence — the part that answers "who takes our customers" — is
// buried below the fold. Solving an empty wall by burying the local signal is
// not solving it.
//
// So national creatives are tagged `tier: "national"` and the wall groups them
// separately, exactly as the six-column analysis has always separated slots 1-3
// from slots 4-5.
// =============================================================================

import { normDomain } from "./atc-provider.js";

export const NATIONAL_BENCHMARKS = [
  {
    label: "J.P. Morgan Chase",
    domain: "chase.com",
    role: "National benchmark",
    why: "The largest US bank. Included in every analysis as a fixed national ceiling, not because it competes locally.",
  },
  {
    label: "Capital One",
    domain: "capitalone.com",
    role: "National digital-first benchmark",
    why: "The national digital-first standard. Included in every analysis to show what the most digitally sophisticated player is running.",
  },
];

const NATIONAL_DOMAINS = new Set(NATIONAL_BENCHMARKS.map((n) => n.domain));

export function isNational(domain) {
  return NATIONAL_DOMAINS.has(normDomain(domain));
}

/* Nationals are re-captured far less often than local competitors.
   Two reasons, and the second is the important one:
     · a national brand's display rotation moves on a quarterly cycle, so a
       month-old capture is not meaningfully stale
     · the entry is SHARED by every client, so each refresh is a cost paid once
       and amortised across every analysis anyone runs that month
   Local competitors keep the 7-day default: their creative is the part a
   strategist is actually being asked about, and staleness there is visible.

   90 rather than 30, because a quarter is the actual cadence: national brand
   creative turns over on a quarterly cycle, so a 30-day TTL was re-buying the
   same ads three times a quarter. Raising a TTL can only PREVENT fetches, never
   cause one, so this is free — but it is not free of consequence. A national
   capture is taken over a window, and at 90 days that window can be months
   away from the client's. benchmarkFor() therefore states the age on the
   reference note whenever it exceeds the window the client is being read over,
   so the board never presents last quarter's national ads as though they sat
   inside this month's comparison. */
export const NATIONAL_TTL_DAYS = Number(process.env.RI_NATIONAL_TTL_DAYS || 90);

/* Read allowance for a national: EVERYTHING one listing returns.
   
   This was 30, under a comment claiming it was higher than the local cap. It
   was half of it, and the arithmetic it produced was indefensible: the listing
   request returns 100 creatives whether we read them or not, so a cap of 30
   threw away seventy creatives already paid for. On the La Capitol auto-loan
   board that showed up as "J.P. Morgan Chase — 30 of about 4,000 listed ads
   were sampled and none were auto loan", which is a statement about our
   sampling wearing the costume of a finding about Chase.

   Two things make reading the full page the right call rather than a luxury:

     · a national's reads are bought once per TTL and shared by every client,
       so the marginal cost per analysis rounds to nothing, where the local cap
       is paid per client per run
     · nationals now FEED findings. The national_gap rule fires when every
       captured national advertises something the client does not, so a
       creative we declined to read is a finding we declined to make. The old
       comment in atc-provider.js — "reading deeper into them buys nothing a
       finding can use" — was true when nationals were wall decoration and
       stopped being true the moment that rule shipped.

   100 is not arbitrary: it is the same number as `num` in buildListingParams,
   so the cap and the fetch match and nothing retrieved goes unread. Reading
   DEEPER than one page needs pagination, which is separate work. */
export const NATIONAL_READ_CAP = Number(process.env.RI_NATIONAL_READ || 100);

/**
 * Append the standing nationals to a competitor list.
 *
 * Creative only. Benchmark is deliberately excluded — that mode is "our ads
 * against theirs" on one product over one window, and dropping Chase into the
 * comparison table would put a national ceiling in a column the client reads as
 * a peer. The national tier answers a different question and belongs on the
 * inspiration wall, not in the benchmark.
 *
 * Idempotent: a national already chosen by hand is not duplicated, it is just
 * marked as national so it lands in the right tier.
 */
export function withNationals(competitors = [], { enabled = true } = {}) {
  const chosen = competitors.map((c) => ({
    ...c,
    domain: normDomain(c.domain),
    tier: isNational(c.domain) ? "national" : "local",
  }));

  if (!enabled) return chosen;

  const present = new Set(chosen.map((c) => c.domain));
  const added = NATIONAL_BENCHMARKS
    .filter((n) => !present.has(n.domain))
    .map((n) => ({ label: n.label, domain: n.domain, tier: "national", role: n.role, why: n.why, auto: true }));

  return [...chosen, ...added];
}

/** Per-advertiser capture options, so the caller does not special-case tiers. */
export function captureOptionsFor(domain, defaults = {}) {
  if (!isNational(domain)) return defaults;
  return { ...defaults, max: NATIONAL_READ_CAP, ttlDays: NATIONAL_TTL_DAYS };
}
