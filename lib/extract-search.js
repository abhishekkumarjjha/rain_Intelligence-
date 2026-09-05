// =============================================================================
// lib/extract-search.js — STAGE 1 for GOOGLE SEARCH creatives.
//
// PRIORITY ZERO. This file exists because the benchmark was reading search ads
// with the banner prompt in extract.js, which tells the model:
//
//     "This is a single banner or display creative, not a screenshot of a
//      search results page. … there is no description field, no sitelinks"
//
// Campaign Benchmark is hard-pinned to google_search. So the most important
// source in the product was being interpreted with the wrong artifact ontology,
// and every fact that lives in a description — which for a credit union is most
// of them — was thrown away before anything downstream could see it. Campus
// Federal's 4.50% APY sits in a description. It was never read.
//
// THIS IS NOT THE SEM TOOL'S PROMPT EITHER. That one reads a SCREENSHOT OF A
// GRID: one image, many ad cards, taken by a human from a browser. This reads
// ONE RENDERED SEARCH AD returned by SerpApi as a single image — one card, no
// grid, no surrounding page. Reusing the grid prompt makes the model hunt for
// cards that are not there and invent boundaries between fields.
//
// TWO JOBS, DELIBERATELY IN ONE CALL:
//   1. TRANSCRIBE every field verbatim.
//   2. Propose a STRUCTURED read — metrics and claims — from a FIXED vocabulary.
//
// Job 2 is semantic ("Get paid up to 2 days early" -> early_direct_deposit) and
// a model is the right tool for it. What the model may NOT do is count, rank,
// or decide what is absent. It proposes; observations.js validates every
// proposal against the registry and the profile and drops anything outside the
// vocabulary. So the model widens what we can see and never touches arithmetic.
// =============================================================================

import { VISION_MODEL, createWithRetry, extractJSON } from "./claude.js";
import { PRODUCT_CODES, coerceProductCode } from "./products.js";
import { METRIC_IDS } from "./metrics.js";
import { ALL_CLAIM_IDS } from "./profiles.js";

const clean = (v) => String(v ?? "").trim();
const cleanList = (v, n = 12) =>
  (Array.isArray(v) ? v : []).map((x) => clean(x)).filter(Boolean).slice(0, n);

const SYSTEM = `You read ONE rendered Google Search ad from the Google Ads Transparency Center and report exactly what is on it.

This is a SINGLE search ad rendered as an image. It is not a banner, and it is
not a screenshot of a results page containing several ads. Expect:

  - one or more HEADLINE parts, the large coloured link text, often joined by a
    dash or a pipe
  - a DISPLAY URL
  - a DESCRIPTION paragraph — usually the longest text on the ad, and the place
    where rates, bonuses and terms most often appear
  - SITELINKS: linked rows beneath the ad, each a separate destination
    ("Open an Account", "Rates", "Locations"), often stacked with a chevron
  - CALLOUTS: short unlinked fragments, usually separated by interpuncts
  - sometimes a thumbnail image, and sometimes a review or rating block

You are a TRANSCRIBER AND CLASSIFIER, not a writer. Report only what is legibly
present. Never complete, tidy, correct, improve or infer any text or number.

=== READ EVERY FIELD. THE DESCRIPTION IS NOT DECORATION ===
The single most damaging failure here is reading the headline and stopping. A
financial ad routinely carries a bonus in the headline and a rate in the
description, or a rate in the description and a fee claim in a sitelink. All of
them count. Read the headline, the description, EVERY sitelink and EVERY callout
before you answer.

=== TRUNCATION IS A REPORTED FACT ===
The Transparency Center clips long text with an ellipsis. If any field ends in
"…" or "..." or simply stops mid-word, set "truncated": true. A clipped
description silently treated as complete is the worst failure in this file,
because the absence of a claim is something this tool counts.

If the render is too small or blurry to read confidently, set "legible": false
and transcribe only what you are sure of. Do not sharpen a guess into a fact.

=== SITELINKS AND CALLOUTS ARE DIFFERENT THINGS ===
A sitelink is a LINK to another page: evidence about where an advertiser sends
traffic. A callout is unlinked text: evidence about what they claim. If you
cannot tell, put it in callouts — the downstream use is narrower, so that is the
safer mistake.

=== ECONOMIC FACTS ===
For every number that describes the OFFER, emit one entry in "economicFacts".
An ad can and often does carry several. Never collapse them, never pick the
biggest one, never drop the second.

Allowed "metric" values, and nothing else:
${METRIC_IDS.join(", ")}

  "raw"         the figure EXACTLY as printed, character for character. Never
                round, never convert, never restate 4.50% as 4.5%. Keep
                asterisks and footnote markers.
  "metric"      which of the values above it is. If a percentage is labelled APY
                it is apy; labelled APR it is apr; an introductory or promotional
                rate on a card or HELOC is intro_apr. If you cannot tell which,
                omit the fact rather than guessing — a rate filed under the wrong
                metric is compared against the wrong column.
  "qualifiers"  ONLY what is visibly printed. term_months, minimum_deposit,
                balance_cap, intro_months, direct_deposit_required,
                new_money_required, waiver_condition, credit_tier, new_members_only,
                applies_to.
                Use null for anything not shown. AN INVENTED MINIMUM DEPOSIT IS
                THE MOST DAMAGING THING YOU CAN PRODUCE, because these figures
                end up side by side in a comparison a client reads.
  "sourceField" headline | description | sitelink | callout | display_url

A FEE FOR AN OPTIONAL ADD-ON IS NOT THE ACCOUNT'S MONTHLY FEE.

Apply this as a GRAMMAR TEST, not a list of products you recognise. A price is
the price OF whatever the sentence binds it to. If the figure is bound to a
named thing by "with", "for", "on", or a possessive — "$5.99/month with
<Name>", "$3/month for identity protection", "<Name> is $4/month" — then that
named thing is what costs the money, and this ad does NOT state the account's
own fee. Put the named thing in qualifiers.applies_to, verbatim.

Only when the price is bound to the ACCOUNT ITSELF — "$12 monthly service fee",
"a $5 monthly fee on this account" — is applies_to null.

The usual tell is a list of benefits immediately before the price: protection,
roadside assistance, identity monitoring, phone cover, discounts. Those are a
bundle, and the price that follows them is the bundle's.

If you cannot tell which it is, OMIT THE FEE ENTIRELY. A bundle price filed as
an account fee gets compared against competitors' account fees and produces a
sentence about the client's own product that is wrong in a way nobody
downstream can detect.

=== CLAIMS ===
For every non-numeric selling point, emit one entry in "claims" using ONLY these
ids:
${ALL_CLAIM_IDS.join(", ")}

Keep the exact wording in "verbatim". If a selling point is clearly present but
matches none of the ids, put it in "unclassified" as free text — do not force it
into the nearest id. That list is how the vocabulary gets improved; a forced fit
is invisible and permanent.

=== MESSAGE SIGNALS ===
  "leadEmphasis"  What the FIRST HEADLINE PART leads with, and only that.
                  One of: rate, bonus, fee, feature, brand, audience, other.
                  If the first headline part is missing or ambiguous, use "".
                  Do not judge which element is most prominent overall — that is
                  a subjective read and it is counted downstream, so it must be
                  defined by position, not by impression.
  "urgency"       true only if the ad prints urgency language ("limited time",
                  "ends soon", a deadline date). Report the phrase.
  "audience"      an addressed group if one is named (students, seniors,
                  business, first-time buyers, members), else "".

=== PRODUCT ===
Classify into exactly one of:
${PRODUCT_CODES.join(", ")}
Use the headline, the description and the display URL path — the path is often
the strongest signal. Give "productConfidence" 0 to 1 and be willing to be
unsure: an ad that just says "Bank With Us" is "other" at low confidence and
that is the correct answer.

Return ONLY this JSON, no prose:
{
  "advertiser": "verified advertiser name if shown, else \\"\\"",
  "displayUrl": "",
  "headlines": ["each headline part, verbatim, in order"],
  "description": "full visible description text, verbatim",
  "sitelinks": ["linked rows, verbatim"],
  "callouts": ["unlinked fragments, verbatim"],
  "otherText": "any other legible text, joined with ' · '",
  "economicFacts": [
    { "metric": "apy", "raw": "4.50% APY", "qualifiers": { "term_months": null, "minimum_deposit": null }, "sourceField": "description" }
  ],
  "claims": [
    { "claim": "early_direct_deposit", "verbatim": "Get paid up to 2 days early", "sourceField": "description" }
  ],
  "unclassified": ["selling points that matched no claim id, verbatim"],
  "leadEmphasis": "rate | bonus | fee | feature | brand | audience | other | \\"\\"",
  "urgency": { "present": false, "phrase": "" },
  "audience": "",
  "product": "one code from the list above",
  "productConfidence": 0.0,
  "truncated": false,
  "legible": true
}`;

/**
 * Read a batch of rendered SEARCH creatives. One model call per creative, run
 * concurrently — a single unreadable render cannot poison the batch, and every
 * record keeps a reliable link back to the creative it came from.
 *
 * The returned record is a SUPERSET of the shape extract.js produces, so
 * everything already reading `ad.headline`, `ad.product` or `ad.offer` keeps
 * working. `offer` is populated from the strongest economic fact purely for
 * backward compatibility with the legacy benchmark table; nothing new reads it.
 */
export async function extractSearchCreatives(images = [], opts = {}) {
  const concurrency = Math.max(1, Math.min(12, opts.concurrency || 6));
  const out = [];
  let failed = 0;

  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (img) => {
      try {
        const msg = await createWithRetry({
          model: VISION_MODEL,
          max_tokens: 2000,
          system: SYSTEM,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType || "image/png", data: img.data } },
              { type: "text", text: "Transcribe and classify this search ad. Read the headline, the description, every sitelink and every callout. Return the JSON described in your instructions and nothing else." },
            ],
          }],
        });
        const a = extractJSON(msg);
        if (!a) return null;
        return shapeSearch(a, img);
      } catch (e) {
        if (e.code === "NO_API_KEY") throw e;
        return null;
      }
    }));
    for (const r of results) { if (r) out.push(r); else failed++; }
  }

  return { ads: out, extractionFailed: failed };
}

/**
 * Model output + provider metadata -> one normalized search Ad record.
 *
 * Dates and longevity come from the PROVIDER only. The model is never asked for
 * a date, so it can never invent one.
 */
export function shapeSearch(a, img) {
  const headlines = cleanList(a.headlines, 4);
  const description = clean(a.description);
  const sitelinks = cleanList(a.sitelinks, 10);
  const callouts = cleanList(a.callouts, 10);

  const rawFacts = (Array.isArray(a.economicFacts) ? a.economicFacts : [])
    .slice(0, 10)
    .map((f) => ({
      metric: clean(f?.metric).toLowerCase(),
      raw: clean(f?.raw),
      qualifiers: (f && typeof f.qualifiers === "object" && f.qualifiers) || {},
      sourceField: clean(f?.sourceField) || "description",
    }))
    .filter((f) => f.metric && f.raw);

  const rawClaims = (Array.isArray(a.claims) ? a.claims : [])
    .slice(0, 12)
    .map((c) => ({
      claim: clean(c?.claim).toLowerCase(),
      verbatim: clean(c?.verbatim),
      sourceField: clean(c?.sourceField) || "description",
    }))
    .filter((c) => c.claim);

  return {
    // ---- identity (provider) ----
    creativeId: img.creativeId,
    bytesHash: img.bytesHash,
    duplicateIds: img.duplicateIds || [],

    // ---- attribution (provider) ----
    institution: img.domain,
    advertiser: img.advertiser || clean(a.advertiser),
    advertiserId: img.advertiserId || "",
    targetDomain: img.targetDomain || "",

    // ---- evidence (provider) ----
    imageUrl: img.imageUrl,
    detailsLink: img.detailsLink,
    format: img.format || "text",
    source: "google_search",
    width: img.width, height: img.height,
    firstShown: img.firstShown,
    lastShown: img.lastShown,
    totalDaysShown: img.totalDaysShown,

    // ---- content (model, verbatim) ----
    headlines,
    // `headline` singular is what the legacy table, the cluster key and the
    // creative wall all read. Kept as the joined form so nothing downstream
    // has to learn a new field to keep working.
    headline: headlines.join(" - "),
    description,
    displayUrl: clean(a.displayUrl),
    sitelinks,
    callouts,
    allText: [description, ...sitelinks, ...callouts, clean(a.otherText)].filter(Boolean).join(" · "),

    // ---- structured proposals (model, VALIDATED LATER in observations.js) ----
    // Deliberately named `raw*`: nothing may count these until they have been
    // checked against the metric registry and the product profile.
    rawEconomicFacts: rawFacts,
    rawClaims,
    unclassified: cleanList(a.unclassified, 8),

    leadEmphasis: ["rate", "bonus", "fee", "feature", "brand", "audience", "other"].includes(clean(a.leadEmphasis))
      ? clean(a.leadEmphasis) : "",
    urgency: {
      present: !!a.urgency?.present,
      phrase: clean(a.urgency?.phrase),
    },
    audience: clean(a.audience),

    // ---- classification (model) ----
    product: coerceProductCode(a.product),
    productConfidence: typeof a.productConfidence === "number"
      ? Math.max(0, Math.min(1, a.productConfidence)) : 0.5,

    truncated: !!a.truncated,
    legible: a.legible !== false,

    // ---- backward compatibility ------------------------------------------
    // The legacy benchmark table and clusterAds() read `ad.offer`. Populated
    // from the first economic fact so nothing breaks mid-migration. NOTHING NEW
    // READS THIS — the singular offer is the bug this whole file exists to fix,
    // and it is kept only so the old table can render while the new board is
    // being trusted.
    offer: legacyOffer(rawFacts),

    // The creative wall never sees search ads (benchmark is pinned to search,
    // creative to display), but these keep the shared record shape total so a
    // stray call into creativeSummary() cannot throw.
    visualStyle: "typographic",
    hasPeople: false,
    tone: "",
    subhead: "",
    cta: "",
  };
}

const LEGACY_TYPE = {
  apy: "rate", apr: "rate", intro_apr: "rate",
  cash_bonus: "bonus", monthly_fee: "fee_waiver", annual_fee: "fee_waiver",
};

function legacyOffer(facts) {
  const f = facts.find((x) => LEGACY_TYPE[x.metric]);
  if (!f) return null;
  const pct = f.raw.match(/(\d+(?:\.\d+)?)\s*%/);
  const usd = f.raw.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  return {
    type: LEGACY_TYPE[f.metric],
    value: f.raw,
    unit: pct ? (f.metric === "apr" || f.metric === "intro_apr" ? "APR" : "APY") : (usd ? "USD" : "none"),
    term: f.qualifiers?.term_months ? `${f.qualifiers.term_months}-month` : "",
    minimum: f.qualifiers?.minimum_deposit ? `$${f.qualifiers.minimum_deposit} minimum` : "",
    qualifier: "",
    finePrintVisible: false,
    numeric: pct ? { n: parseFloat(pct[1]), kind: "percent" }
      : usd ? { n: parseFloat(usd[1].replace(/,/g, "")), kind: "usd" } : null,
  };
}
