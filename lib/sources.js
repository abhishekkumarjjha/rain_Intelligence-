// =============================================================================
// lib/sources.js — the three evidence sources, named once.
//
// A "source" is a provider AND a surface AND a set of temporal semantics. It is
// not a filter. Two sources never share a wall, a denominator, a longevity
// column, a cache entry or a run diff — because the numbers underneath them do
// not mean the same thing.
//
// The single most important consequence: `[...googleAds, ...metaAds]` is a bug
// even when it typechecks. Google's `totalDaysShown` is days served; Meta has no
// equivalent and never will. Concatenating them produces a column that is
// sometimes one measurement and sometimes another, with no way for a reader to
// tell which.
// =============================================================================

export const SOURCES = {
  GOOGLE_DISPLAY: "google_display",
  GOOGLE_SEARCH: "google_search",
  META: "meta",
};

export const SOURCE_LABELS = {
  google_display: "Google display",
  google_search: "Google search",
  meta: "Meta",
};

/**
 * Which sources a mode is allowed to capture. Benchmark is Google search, full
 * stop — it compares ads against ads on one surface, and mixing a banner into
 * that table would rank a rate against a piece of artwork.
 *
 * THE WALL DOES NOT CAPTURE SEARCH, and that is a cost decision, not an
 * oversight.
 *
 * A rendered search ad is a creative and belongs on a wall — but making the
 * Wall capture it would double the Wall's bill for people who only ever want to
 * see artwork, and the expensive part is not the listing request (~$0.01) but
 * the ONE VISION CALL PER CREATIVE READ that follows it. At RI_MAX_READ=30 per
 * advertiser, a second format is a few hundred model calls.
 *
 * Competitive Intelligence already captures and reads every search ad, so the
 * search wall is rendered from THAT run at no additional cost. Free view over
 * paid data, rather than a second purchase of the same data.
 *
 * The formats also stay separate REQUESTS wherever both are wanted. One
 * unfiltered call would be cheaper and would destroy the board: a live check on
 * lacapfcu.org found ~20 text creatives against ~2,000 image, and `num` caps at
 * 100 — so the text ads, which are the entire benchmark input, would be crowded
 * out of the response by artwork. The format filter is what keeps a local
 * competitor's search capture COMPLETE, and completeness is what lets the board
 * say "1 of 3 competitors" rather than refusing to count at all.
 */
export const SOURCES_FOR_MODE = {
  creative: [SOURCES.GOOGLE_DISPLAY, SOURCES.META],
  benchmark: [SOURCES.GOOGLE_SEARCH],
};

export const PROVIDER_OF = {
  google_display: "serpapi",
  google_search: "serpapi",
  meta: "searchapi",
};

export function isGoogle(source) {
  return source === SOURCES.GOOGLE_DISPLAY || source === SOURCES.GOOGLE_SEARCH;
}

export function isMeta(source) {
  return source === SOURCES.META;
}

/**
 * Normalize whatever the client asked for into a legal source list for the mode.
 *
 * Benchmark ALWAYS returns google_search regardless of what was submitted — the
 * mode's meaning is "our search ads against theirs", and a caller that could
 * quietly switch its provider could quietly change what the table means.
 */
export function resolveSources({ mode, sources }) {
  const allowed = SOURCES_FOR_MODE[mode] || SOURCES_FOR_MODE.creative;
  if (mode === "benchmark") return [SOURCES.GOOGLE_SEARCH];

  const asked = Array.isArray(sources) ? sources : (sources ? [sources] : []);
  const legal = asked.map(String).filter((s) => allowed.includes(s));
  // Default to Google display: it is the proven path, and it costs SerpApi
  // credits that are already budgeted rather than SearchApi requests that are not.
  return legal.length ? [...new Set(legal)] : [SOURCES.GOOGLE_DISPLAY];
}

/**
 * Google's creative_format for a source. Meta has no such concept — asking for
 * one is a category error, so this throws rather than guessing.
 */
export function googleFormatFor(source) {
  if (source === SOURCES.GOOGLE_DISPLAY) return "image";
  if (source === SOURCES.GOOGLE_SEARCH) return "text";
  throw new Error(`googleFormatFor called with non-Google source: ${source}`);
}

/**
 * Window control copy. Deliberately different per source, because the underlying
 * filters are different questions:
 *
 *   Google — the Transparency Center is filtered on a SERVED window: was this
 *            creative shown between these dates?
 *   Meta   — SearchApi's start_date is an EARLIEST-START filter: did this ad
 *            begin on or after this date? An ad that started two years ago and
 *            is still running today is EXCLUDED by a 30-day Meta window and
 *            INCLUDED by a 30-day Google window.
 *
 * Same number, opposite behaviour at the boundary. Giving them one shared
 * control labelled "Last 30 days" would be a lie of symmetry.
 */
export const WINDOW_OPTIONS = {
  google_display: { label: "Served in the last", options: [30, 90], default: 30 },
  google_search: { label: "Served in the last", options: [30, 90], default: 30 },
  // Meta flights are short and 30 days comes back thin, so the default is wider.
  meta: { label: "Started in the last", options: [30, 90, 180], default: 90 },
};

export function defaultWindowFor(source) {
  return (WINDOW_OPTIONS[source] || WINDOW_OPTIONS.google_display).default;
}
