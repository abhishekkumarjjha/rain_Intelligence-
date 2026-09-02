// =============================================================================
// lib/extract.js — STAGE 1. Rendered creatives -> structured ad records.
//
// This model TRANSCRIBES AND CLASSIFIES. It does not write, suggest, adapt or
// improve anything. Splitting it from any later judgement is what makes a bad
// output diagnosable: if a benchmark row is wrong you can look at this stage's
// JSON and know immediately whether the creative was misread or the comparison
// was misjudged. When both jobs share one prompt, you can never tell.
//
// IMPORTANT — this is NOT the SEM tool's extractor with a new name.
// That one reads SCREENSHOTS OF A GRID: one image contains many search ads,
// each with a headline, description, display URL and sitelink rows.
// This one reads ONE BANNER CREATIVE PER IMAGE: text is baked into artwork,
// there is no description field, no sitelinks, and the offer is usually the
// single largest thing on the canvas. Feeding banners to the grid prompt
// produces confident nonsense.
// =============================================================================

import { VISION_MODEL, createWithRetry, extractJSON } from "./claude.js";
import { PRODUCT_CODES, coerceProductCode } from "./products.js";

const clean = (v) => String(v ?? "").trim();
const cleanList = (v) => (Array.isArray(v) ? v : []).map((x) => clean(x)).filter(Boolean).slice(0, 8);

const SYSTEM = `You read ONE rendered advertising creative from the Google Ads Transparency Center and transcribe what is legibly on it.

You are a TRANSCRIBER AND CLASSIFIER, not a writer. Report only what is visibly
present. Never complete, tidy, correct, improve or infer any text or number. You
are not asked for an opinion about the ad.

This is a single banner or display creative, not a screenshot of a search
results page. Expect artwork with text set into it: a brand logo, a headline,
sometimes a subhead, sometimes a call-to-action button, and often a prominent
offer (a rate, a bonus, a term).

=== THE OFFER IS THE MOST IMPORTANT THING ON THE CANVAS ===
If the creative advertises a rate, a bonus, a discount or a term, transcribe it
EXACTLY as written, character for character. Never round, never convert, never
restate 4.50% as 4.5%. If a figure carries an asterisk or a footnote marker,
keep the marker.

Transcribe the QUALIFYING DETAIL too, when it is visible: the term ("12-month"),
the minimum ("with $1,000 minimum deposit"), the condition ("for new members"),
and any small print you can actually read. Most banner creatives DO NOT show
these. When a qualifier is not visible, leave it empty. NEVER supply a plausible
one — an invented minimum deposit is the single most damaging thing you could
produce here, because these figures end up side by side in a comparison a client
reads.

=== LEGIBILITY IS A REPORTED FACT, NOT A JUDGEMENT CALL ===
If artwork is too small, too low-contrast or too blurry to read confidently, set
"legible": false and transcribe only what you are sure of. Do not sharpen a
guess into a fact. A half-read creative honestly flagged is useful; a
confidently misread one poisons every count downstream.

=== PRODUCT CLASSIFICATION ===
Classify the creative into exactly one of:
${PRODUCT_CODES.join(", ")}

Use the headline, the offer and any visible URL. Give "productConfidence" from 0
to 1 and be willing to be unsure: a creative that just says "Bank With Us" is
"other" at low confidence, and that is the correct answer. A confident wrong
label is worse than an unsure right one, because low-confidence creatives are
kept and shown to the strategist while confidently mislabelled ones are filed
away silently.

=== CREATIVE CRAFT FIELDS ===
The creative team uses this tool for inspiration, so also report what the ad
looks like: its dominant visual approach, whether people appear, and the tone.
These are descriptive, not evaluative. Do not say whether the ad is good.

Return ONLY this JSON, no prose:
{
  "brand": "the advertiser/brand name visible on the creative, or \\"\\"",
  "headline": "the main headline text, verbatim",
  "subhead": "secondary line if present, verbatim, else \\"\\"",
  "cta": "call-to-action button or link text, verbatim, else \\"\\"",
  "allText": "every other legible text fragment, joined with ' · '",
  "offer": {
    "present": false,
    "type": "rate | bonus | discount | fee_waiver | term | other | none",
    "value": "exactly as printed, e.g. \\"4.59% APR\\" or \\"$400\\"",
    "unit": "APY | APR | USD | percent | none",
    "term": "e.g. \\"12-month\\" if visible, else \\"\\"",
    "minimum": "e.g. \\"$1,000 minimum\\" if visible, else \\"\\"",
    "qualifier": "e.g. \\"new members only\\" if visible, else \\"\\"",
    "finePrintVisible": false
  },
  "product": "one code from the list above",
  "productConfidence": 0.0,
  "visualStyle": "photo | illustration | typographic | product-shot | mixed",
  "hasPeople": false,
  "tone": "two or three words describing the tone",
  "legible": true
}`;

/**
 * Read one batch of downloaded creatives. One model call per creative, run
 * concurrently: a single unreadable image cannot poison the batch, and every
 * record keeps a reliable link back to the creative it came from.
 *
 * @param {Array} images  output of atc-provider.capture()
 * @param {{concurrency?: number}} opts
 */
export async function extractCreatives(images = [], opts = {}) {
  const concurrency = Math.max(1, Math.min(12, opts.concurrency || 6));
  const out = [];
  let failed = 0;

  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (img) => {
      try {
        const msg = await createWithRetry({
          model: VISION_MODEL,
          max_tokens: 1200,
          system: SYSTEM,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType || "image/png", data: img.data } },
              { type: "text", text: "Transcribe and classify this creative. Return the JSON described in your instructions and nothing else." },
            ],
          }],
        });
        const a = extractJSON(msg);
        if (!a) return null;
        return shape(a, img);
      } catch (e) {
        if (e.code === "NO_API_KEY") throw e;
        return null;                    // one bad creative is not a failed run
      }
    }));
    for (const r of results) { if (r) out.push(r); else failed++; }
  }

  return { ads: out, extractionFailed: failed };
}

/**
 * Model output + provider metadata -> one normalized Ad record.
 *
 * The join is the whole point of this function: everything the model says lives
 * next to everything the provider said, and provenance never gets lost. Dates
 * and longevity come from the PROVIDER only — the model is never asked for a
 * date, so it can never invent one.
 */
function shape(a, img) {
  const o = a.offer && typeof a.offer === "object" ? a.offer : {};
  const offerPresent = !!o.present && !!clean(o.value);

  return {
    // ---- identity (provider) ----
    creativeId: img.creativeId,
    bytesHash: img.bytesHash,
    duplicateIds: img.duplicateIds || [],

    // ---- attribution (provider) ----
    // institution is the entered domain — the user-facing competitor.
    // advertiser is what Google verified, which is frequently an AGENCY.
    // These stay separate fields forever. Collapsing them is how MidFirst Bank
    // becomes "Fogarty and Klein, Inc." in front of a client.
    institution: img.domain,
    advertiser: img.advertiser || "",
    advertiserId: img.advertiserId || "",
    targetDomain: img.targetDomain || "",

    // ---- evidence (provider) ----
    imageUrl: img.imageUrl,
    detailsLink: img.detailsLink,
    format: img.format,
    width: img.width, height: img.height,
    firstShown: img.firstShown,
    lastShown: img.lastShown,
    totalDaysShown: img.totalDaysShown,

    // ---- content (model) ----
    brand: clean(a.brand),
    headline: clean(a.headline),
    subhead: clean(a.subhead),
    cta: clean(a.cta),
    allText: clean(a.allText),

    // ---- offer observation (model, transcribed) ----
    offer: offerPresent ? {
      type: ["rate", "bonus", "discount", "fee_waiver", "term", "other"].includes(o.type) ? o.type : "other",
      value: clean(o.value),
      unit: ["APY", "APR", "USD", "percent", "none"].includes(o.unit) ? o.unit : "none",
      // Empty means NOT VISIBLE ON THE CREATIVE. It does not mean "no minimum".
      // The comparison layer renders these as an em-dash and refuses to treat
      // two offers as like-for-like when either side is blank.
      term: clean(o.term),
      minimum: clean(o.minimum),
      qualifier: clean(o.qualifier),
      finePrintVisible: !!o.finePrintVisible,
      numeric: parseOfferNumber(clean(o.value)),
    } : null,

    // ---- classification (model) ----
    product: coerceProductCode(a.product),
    productConfidence: typeof a.productConfidence === "number"
      ? Math.max(0, Math.min(1, a.productConfidence)) : 0.5,

    // ---- craft (model) ----
    visualStyle: ["photo", "illustration", "typographic", "product-shot", "mixed"].includes(a.visualStyle)
      ? a.visualStyle : "mixed",
    hasPeople: !!a.hasPeople,
    tone: clean(a.tone),

    legible: a.legible !== false,
  };
}

/**
 * Pull a comparable number out of a transcribed offer string.
 *
 * The STRING remains the evidence and is what gets displayed. This number
 * exists only so the table can sort, and so "2 of 3 competitors advertised a
 * higher rate than the client" can be computed in code rather than asserted by
 * a model. Returns null whenever the string is not cleanly numeric — an
 * unparseable offer is shown as-is and excluded from arithmetic.
 */
export function parseOfferNumber(value) {
  const s = String(value || "");
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return { n: parseFloat(pct[1]), kind: "percent" };
  const usd = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (usd) return { n: parseFloat(usd[1].replace(/,/g, "")), kind: "usd" };
  return null;
}


// =============================================================================
// FORMAT DISPATCH.
//
// The single most consequential bug in the benchmark was that this file had ONE
// prompt, written for banners, and it was applied to Google SEARCH creatives —
// which is the only format Campaign Benchmark ever captures. The prompt tells
// the model there is no description and no sitelinks, so every fact living in
// those fields was discarded before anything downstream could count it.
//
// The dispatcher is deliberately the only new thing in this file. The banner
// reader above is unchanged and the Creative wall keeps running through exactly
// the code it ran through before.
// =============================================================================

import { extractSearchCreatives } from "./extract-search.js";

/**
 * Which reader a given run's creatives go through. Exported so the extraction
 * cache can be keyed on it: the two readers emit DIFFERENT SHAPES, so a record
 * written by one is not a substitute for the other, and a cache that cannot
 * tell them apart silently reintroduces the bug this dispatcher exists to fix.
 *
 * @param {{format?: "text"|"image"|"video"}} ctx  the run's creative_format
 * @param {Array} images  atc-provider.capture() output, as a fallback
 * @returns {"search"|"banner"}
 */
/**
 * READER VERSIONS — part of the extraction cache key.
 *
 * A creative's pixels never change, so its transcription is bought once. But
 * the transcription is only as good as the PROMPT that produced it, and when a
 * prompt changes the old readings are wrong in a way nothing downstream can
 * detect: they have the right shape, the right creative id, and the wrong
 * content.
 *
 * That already happened here. Tightening the add-on-fee rule in
 * extract-search.js left every cached reading in place, and the only remedy was
 * remembering to delete a directory by hand — which is not a remedy, it is a
 * trap for whoever copies this cache to another environment.
 *
 * BUMP THE VERSION WHENEVER THE PROMPT OR THE OUTPUT SHAPE CHANGES. Old entries
 * then miss rather than mislead, and a cache carried from an older build
 * invalidates itself on arrival instead of quietly serving stale facts.
 */
export const READER_VERSIONS = {
  // v2: the add-on-fee rule became a grammar test rather than a list of
  //     products, and applies_to is required on a bound price.
  search: "search-v2",
  // v1: unchanged since the banner reader was written.
  banner: "banner-v1",
};

/** The cache key component for a reader family. */
export const readerKey = (family) => READER_VERSIONS[family] || `${family}-v1`;

export function readerFor(ctx = {}, images = []) {
  const format = String(ctx.format || images[0]?.format || "image").toLowerCase();
  // Video renders as a frame and reads like a banner: text baked into artwork,
  // no description field. It belongs with the banner reader, flagged low
  // fidelity by the caller rather than given a third prompt it does not need.
  return format === "text" ? "search" : "banner";
}

/**
 * @param {Array}  images  atc-provider.capture() output
 * @param {{format?: "text"|"image"|"video"}} ctx  the run's creative_format
 */
export async function extractByFormat(images = [], ctx = {}, opts = {}) {
  if (readerFor(ctx, images) === "search") return extractSearchCreatives(images, opts);
  return extractCreatives(images, opts);
}
