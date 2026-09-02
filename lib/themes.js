// =============================================================================
// lib/themes.js — WHAT THE DISPLAY CREATIVES ARE ABOUT.
//
// The Wall shows every banner a competitor is running. At forty creatives that
// is a lot of looking and no reading: the thing a strategist wants out of it is
// "there are three ideas in this category and here they are", which is a
// clustering problem over language and imagery. That is genuinely a model job —
// unlike counting, which lives in set-shape.js and must never come near one.
//
// THIS REPLACES THE RECOMMENDED-STRATEGY PASS, AND THE DIFFERENCE IS THE POINT.
//
// A theme DESCRIBES what exists: "rate-led typography, no imagery, figure in
// the headline". A recommendation PRESCRIBES what to do: "lead with your rate".
// The first is a summary of evidence on screen and is defensible in front of a
// client. The second is RAIN advising a bank on its product, which is the thing
// Han ruled out, and no amount of hedging in the prompt turns one into the
// other. So the constraints below are enforced in code, after the model has
// answered, and a bullet that breaks them is dropped rather than repaired:
//
//   · no second person, no modal advice — "you", "should", "consider",
//     "recommend", "try", "opportunity" all disqualify a theme
//   · no numbers the model invented; digits are stripped from theme prose
//     entirely, because every real figure on this screen is counted elsewhere
//     and a model-written one cannot be traced
//   · every theme must cite creativeIds that were actually sent, or it is
//     dropped — a theme with no ads behind it is a sentence about nothing
//   · the client is never named, and never identified as the client
//
// Fewer, well-evidenced themes beat a full set. If only one survives, one
// renders.
// =============================================================================

import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";

const SYSTEM = `You name the recurring ideas in a set of display advertising creatives.

You are a DESCRIBER. You summarise what these ads are, as a group. You never
advise, never suggest, never evaluate whether an approach is working, and never
address anyone. There is no client in this task and no reader to help — only a
pile of creatives to characterise.

WHAT A THEME IS
A theme is a recurring combination of message and treatment that several
creatives share. Name what the ads DO, not what anyone should do.

  good  "Rate-led typography — the figure set large, no photography, offer in
         the headline slot"
  good  "Community photography with local landmarks and member portraits"
  bad   "Rate-led creative is an opportunity to stand out"      (advice)
  bad   "These ads would perform better with stronger imagery"  (evaluation)
  bad   "You could lead with the rate"                          (addresses a reader)

RULES
- 2 to 3 themes. Fewer is correct when the set genuinely holds fewer.
- Each theme must be carried by at least two creatives, cited by id.
- NO DIGITS anywhere in your prose. The figures in these ads are counted
  elsewhere by code; a number written here cannot be traced and will be removed.
- Never name an advertiser, a bank, or a product brand.
- "name": 2 to 5 words. "description": one sentence, at most 25 words.

Return ONLY this JSON:
{
  "themes": [
    { "name": "", "description": "", "creativeIds": ["", ""] }
  ]
}`;

/** Words that turn a description into advice. Checked after the model answers. */
const PRESCRIPTIVE = /\b(you|your|should|shouldn't|must|consider|recommend|recommended|try|opportunity|opportunities|could|would|suggest|advise|better|best|improve|leverage|instead|need to|ought)\b/i;

/** Evaluation of outcomes. The capture has no performance data of any kind. */
const PERFORMANCE = /\b(wins?|winning|works?|working|performs?|performing|effective|successful|converts?|conversion|engaging|drives?)\b/i;

/**
 * Strip the client's identity before the model sees anything.
 *
 * Same argument as industry-context.js: a model that never learns whose ads
 * these are cannot slip into addressing them. Advertiser and domain are removed
 * outright; what is left is the creative itself, which is all the task needs.
 */
function anonymise(ad) {
  return {
    id: ad.creativeId,
    headline: ad.headline || "",
    subhead: ad.subhead || "",
    cta: ad.cta || "",
    visualStyle: ad.visualStyle || "",
    hasPeople: !!ad.hasPeople,
    tone: ad.tone || "",
    product: ad.product || "other",
    // The offer TYPE, never its value. "a rate is present" is a treatment fact;
    // "4.50% APY" is a figure, and figures are counted in code or not at all.
    offerType: ad.offer?.type || "none",
  };
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {Array} ads    the creatives on the wall (display)
 * @param {string} productLabel  for the framing line only — never sent
 * @returns {Promise<{themes: Array, framing: string}|null>}
 */
export async function readThemes(ads = [], productLabel = "") {
  // Below four creatives there is no recurring anything; naming a "theme" over
  // three ads is describing three ads with extra words.
  const usable = ads.filter((a) => a.legible !== false && (a.headline || a.subhead));
  if (usable.length < 4) return null;

  const known = new Set(usable.map((a) => a.creativeId));

  let raw;
  try {
    const msg = await createWithRetry({
      model: ANALYSIS_MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `${usable.length} display creatives:\n\n${
          JSON.stringify(usable.map(anonymise), null, 1)}\n\nName the recurring ideas in this set.`,
      }],
    });
    raw = extractJSON(msg);
  } catch (e) {
    // A themes pass that fails is a missing section, never a broken page.
    if (e?.code === "NO_API_KEY") throw e;
    return null;
  }

  if (!Array.isArray(raw?.themes)) return null;

  const themes = raw.themes
    .map((t) => {
      const name = clean(t?.name);
      // Digits are removed rather than the theme dropped: a model that writes
      // "three sizes" is describing correctly and only the numeral is unusable.
      const description = clean(t?.description).replace(/\b\d[\d,.]*%?\b/g, "").replace(/\s+/g, " ").trim();
      const creativeIds = [...new Set((Array.isArray(t?.creativeIds) ? t.creativeIds : [])
        .map(clean).filter((id) => known.has(id)))];
      return { name, description, creativeIds };
    })
    .filter((t) => t.name && t.description
      && t.name.split(/\s+/).length <= 5
      && t.description.split(/\s+/).length <= 25
      // A theme nothing carries is a sentence about nothing.
      && t.creativeIds.length >= 2
      && !PRESCRIPTIVE.test(t.name) && !PRESCRIPTIVE.test(t.description)
      && !PERFORMANCE.test(t.name) && !PERFORMANCE.test(t.description))
    .slice(0, 3);

  if (!themes.length) return null;

  return {
    themes,
    // Rendered verbatim above the themes. It states the register in the user's
    // own reading, not only in this file's comments.
    framing: `Recurring ideas across the ${usable.length} captured ${
      productLabel ? `${productLabel.toLowerCase()} ` : ""}display creatives. These describe what the ads are, not what anyone should do — and they cover what was captured, not the whole market.`,
    creativesRead: usable.length,
  };
}
