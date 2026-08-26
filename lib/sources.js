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

/** Which sources a mode is allowed to capture. Benchmark is Google search, full stop. */
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
