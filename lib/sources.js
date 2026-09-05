// =============================================================================
// lib/sources.js — the evidence sources, named once.
//
// A "source" is a provider AND a surface AND a set of temporal semantics. It is
// not a filter. Two sources never share a wall, a denominator, a longevity
// column, a cache entry or a run diff — because the numbers underneath them do
// not mean the same thing.
//
// Both remaining sources are the Google Ads Transparency Center through SerpApi,
// separated by creative_format: display banners and rendered search ads. Meta
// was removed from the product; the separation rule stays because it is what
// stops `[...displayAds, ...searchAds]` becoming a column that is sometimes one
// measurement and sometimes another.
// =============================================================================

export const SOURCES = {
  GOOGLE_DISPLAY: "google_display",
  GOOGLE_SEARCH: "google_search",
};

// ---------------------------------------------------------------------------
// "IMAGE", NOT "DISPLAY", AND THE KEY STAYS AS IT IS.
//
// The provider filters on creative_format, and its own documentation describes
// text/image/video as what the creative IS, not where it ran. There is no
// DISPLAY value anywhere in its platform enum — only PLAY, MAPS, SEARCH,
// SHOPPING and YOUTUBE — so nothing in the response says an image creative
// served on the Google Display Network. Google's Transparency Center carries
// image creatives that ran on Discover, in Gmail, as YouTube companions and on
// Display, and the API does not distinguish them.
//
// So "display ads" was a claim about a delivery network built out of a filter
// on artwork type: exactly the rule this product is built on, crossed by a
// label. "Image creatives" is what was captured, and it is what the capture can
// support.
//
// THE KEY DOES NOT CHANGE. `google_display` is written into every
// capture-cache filename, every run.source and every snapshot, and comparability
// across runs is decided by matching it. Renaming it would invalidate the cache
// and re-buy the captures behind it — a spend decision, not a wording one.
// ---------------------------------------------------------------------------
export const SOURCE_LABELS = {
  google_display: "Google image ads",
  google_search: "Google search ads",
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
  creative: [SOURCES.GOOGLE_DISPLAY],
  benchmark: [SOURCES.GOOGLE_SEARCH],
};

export const PROVIDER_OF = {
  google_display: "serpapi",
  google_search: "serpapi",
};

export function isGoogle(source) {
  return source === SOURCES.GOOGLE_DISPLAY || source === SOURCES.GOOGLE_SEARCH;
}

/**
 * Meta was removed from the product. This survives as a permanent `false` rather
 * than disappearing, so that any caller still asking "is this a Meta source?"
 * gets a definite no instead of a ReferenceError — and so the answer is stated
 * in one place if the surface ever returns.
 */
export function isMeta() {
  return false;
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
  return legal.length ? [...new Set(legal)] : [SOURCES.GOOGLE_DISPLAY];
}

/**
 * Google's creative_format for a source. Throws on anything else rather than
 * guessing a default — a wrong format silently captures the wrong surface.
 */
export function googleFormatFor(source) {
  if (source === SOURCES.GOOGLE_DISPLAY) return "image";
  if (source === SOURCES.GOOGLE_SEARCH) return "text";
  throw new Error(`googleFormatFor called with non-Google source: ${source}`);
}

/**
 * Window control copy.
 *
 * The Transparency Center filters on a SERVED window: was this creative shown
 * between these dates? Both formats share that meaning, so they share a control.
 */
export const WINDOW_OPTIONS = {
  google_display: { label: "Served in the last", options: [30, 90], default: 30 },
  google_search: { label: "Served in the last", options: [30, 90], default: 30 },
};

export function defaultWindowFor(source) {
  return (WINDOW_OPTIONS[source] || WINDOW_OPTIONS.google_display).default;
}
