// =============================================================================
// test/fixture-lab.js — a fake Google Ads Transparency Center and a fake vision
// model, deterministic and offline.
//
// The recorded fixture (serpapi-lacapfcu.json) is one domain, one format, and
// every image in it is the SAME 1x1 png — which is exactly what you want for
// testing dedupe and exactly what you cannot use for testing anything
// downstream, because 21 creatives collapse to 1 and every ad carries identical
// content. This module builds a small synthetic market instead: several
// advertisers, distinct creatives, distinct pixels, known products and known
// offers — so a count that comes out wrong is a bug and not a fixture artifact.
// =============================================================================

import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// A real, valid 1x1 PNG whose pixel colour varies with `seed`. Distinct bytes
// are the point: the provider layer dedupes on a sha256 of the body, so
// identical pixels would collapse every creative into one before extraction.
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function pngFor(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGB
  const raw = Buffer.from([0, seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const day = 86400;
const now = Math.floor(Date.now() / 1000);
const ago = (d) => now - d * day;

// ---------------------------------------------------------------------------
// THE SYNTHETIC MARKET
//
// Shaped to exercise the cases that actually break things:
//   - campusfederal    on-product checking ads, one with a bonus, one dupe pair
//   - neighborsfcu     checking ads AND off-product ads (mortgage/other), which
//                      is what a real image capture looks like
//   - lacapfcu         the CLIENT — has ads, but NO bonus, so the absence
//                      finding has something to find
//   - silentbank       returns zero creatives (a competitor with no ads is not
//                      a failed run)
//   - previewonly      returns creatives that are all preview-only, so
//                      "found 4 / read 0" has to stay reconcilable
//   - agencybank       ads verified under an AGENCY name, not the bank's
// ---------------------------------------------------------------------------
export const MARKET = {
  /* The shape that exposed the cap-before-dedupe bug on a live capture: three
     real campaigns, each rendered at several sizes off the same artwork. A cap
     applied before the dedupe spends every slot on repeats of campaign A and
     never reaches B or C — which is exactly how an advertiser's offer ads go
     missing while the funnel still reconciles. */
  "dupeheavy.test": [
    /* Isolates the cap-before-dedupe bug, with the launch-cohort spread
       deliberately neutralised: every campaign launched in the SAME month, so
       diversification cannot rescue this and only the dedupe order can.

       Campaign A is 25 renders of ONE artwork and outranks the others on
       longevity. With the cap applied before the byte-dedupe, all 18 slots go
       to A and the read comes back with a single creative — the two campaigns
       carrying offers never reach the model. */
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `DUPE_A${i}`, headline: "Become a Member", product: "other",
      offer: { present: false }, art: 1,
      daysShown: 400 - i, first: ago(500), last: ago(1), w: 300, h: 250,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `DUPE_B${i}`, headline: "Earn $600 With Lagniappe Checking", product: "checking",
      offer: { present: true, type: "bonus", value: "$600", unit: "USD", term: "", minimum: "", qualifier: "" },
      art: 2,
      daysShown: 90 - i, first: ago(500), last: ago(1), w: 728, h: 90,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `DUPE_C${i}`, headline: "Unlock Your HELOC", product: "heloc",
      offer: { present: true, type: "rate", value: "3.99% APR", unit: "APR", term: "", minimum: "", qualifier: "" },
      art: 3,
      daysShown: 60 - i, first: ago(500), last: ago(1), w: 970, h: 250,
    })),
  ],
  "campusfederal.org": [
    { id: "CAMP1", headline: "Free Checking, Actually Free", product: "checking",
      offer: { present: true, type: "bonus", value: "$300", unit: "USD", term: "", minimum: "", qualifier: "new members only" },
      daysShown: 412, first: ago(500), last: ago(1), w: 728, h: 90 },
    { id: "CAMP2", headline: "Free Checking, Actually Free", product: "checking",
      offer: { present: true, type: "bonus", value: "$300", unit: "USD", term: "", minimum: "", qualifier: "new members only" },
      daysShown: 120, first: ago(200), last: ago(3), w: 300, h: 250 },
    { id: "CAMP3", headline: "Switch And Get Paid", product: "checking",
      offer: { present: true, type: "bonus", value: "$400", unit: "USD", term: "", minimum: "$500 direct deposit", qualifier: "" },
      daysShown: 61, first: ago(70), last: ago(0), w: 970, h: 250 },
    { id: "CAMP4", headline: "Rates That Move With You", product: "savings",
      offer: { present: true, type: "rate", value: "4.25% APY", unit: "APY", term: "", minimum: "", qualifier: "" },
      daysShown: 200, first: ago(260), last: ago(9), w: 300, h: 600 },
  ],
  "neighborsfcu.org": [
    { id: "NBR1", headline: "Checking That Pays You Back", product: "checking",
      offer: { present: true, type: "bonus", value: "$250", unit: "USD", term: "", minimum: "", qualifier: "" },
      daysShown: 88, first: ago(120), last: ago(2), w: 728, h: 90 },
    { id: "NBR2", headline: "Your Home, Your Rate", product: "mortgage",
      offer: { present: true, type: "rate", value: "6.125% APR", unit: "APR", term: "30-year fixed", minimum: "", qualifier: "" },
      daysShown: 340, first: ago(400), last: ago(4), w: 300, h: 250 },
    { id: "NBR3", headline: "Bank With Neighbors", product: "other",
      offer: { present: false }, daysShown: 900, first: ago(1000), last: ago(11), w: 160, h: 600 },
  ],
  "lacapfcu.org": [
    { id: "LAC1", headline: "Checking Built For Louisiana", product: "checking",
      offer: { present: false }, daysShown: 1169, first: ago(1300), last: ago(2), w: 728, h: 90 },
    { id: "LAC2", headline: "Open An Account Today", product: "checking",
      offer: { present: true, type: "rate", value: "0.10% APY", unit: "APY", term: "", minimum: "", qualifier: "" },
      daysShown: 45, first: ago(60), last: ago(6), w: 300, h: 250 },
  ],
  "efcufinancial.org": [
    { id: "EFC1", headline: "Checking, Simplified", product: "checking",
      offer: { present: true, type: "bonus", value: "$150", unit: "USD", term: "", minimum: "", qualifier: "" },
      daysShown: 55, first: ago(80), last: ago(3), w: 728, h: 90 },
  ],
  "pelicanstatecu.com": [
    { id: "PEL1", headline: "Drive Away Happy", product: "auto-loan",
      offer: { present: true, type: "rate", value: "5.49% APR", unit: "APR", term: "60-month", minimum: "", qualifier: "" },
      daysShown: 150, first: ago(180), last: ago(5), w: 300, h: 250 },
  ],
  // ---- THE STANDING NATIONALS ---------------------------------------------
  // Deep inventory, because that is the point of the tier: a community bank
  // contributes four creatives and a national contributes dozens. The wall's
  // tiering exists so this volume fills the screen without burying the local
  // evidence underneath it.
  //
  // "Open An Account Today" is here deliberately: lacapfcu.org runs a creative
  // with the SAME headline and product. Before clustering was scoped to the
  // advertiser, those two collapsed into one card and La Capitol's evidence
  // vanished from the wall — the exact failure that gets worse the more
  // competitors are added, since generic national copy overlaps with everyone.
  "chase.com": [
    { id: "CHS1", headline: "Open An Account Today", product: "checking",
      offer: { present: true, type: "bonus", value: "$300", unit: "USD", term: "", minimum: "", qualifier: "new accounts" },
      daysShown: 640, first: ago(700), last: ago(1), w: 728, h: 90 },
    { id: "CHS2", headline: "Mortgages Made Straightforward", product: "mortgage",
      offer: { present: true, type: "rate", value: "6.375% APR", unit: "APR", term: "30-year fixed", minimum: "", qualifier: "" },
      daysShown: 410, first: ago(500), last: ago(1), w: 300, h: 250 },
    { id: "CHS3", headline: "Cash Back On Everything", product: "credit-card",
      offer: { present: true, type: "bonus", value: "$200", unit: "USD", term: "", minimum: "", qualifier: "" },
      daysShown: 880, first: ago(900), last: ago(2), w: 300, h: 600 },
    { id: "CHS4", headline: "Banking That Travels With You", product: "other",
      offer: { present: false }, daysShown: 1200, first: ago(1300), last: ago(1), w: 970, h: 250 },
    { id: "CHS5", headline: "Save Automatically", product: "savings",
      offer: { present: true, type: "rate", value: "4.10% APY", unit: "APY", term: "", minimum: "", qualifier: "" },
      daysShown: 200, first: ago(240), last: ago(3), w: 160, h: 600 },
  ],
  "capitalone.com": [
    { id: "CAP1", headline: "No Fees. No Minimums.", product: "checking",
      offer: { present: false }, daysShown: 990, first: ago(1100), last: ago(1), w: 728, h: 90 },
    { id: "CAP2", headline: "Earn More On Your Savings", product: "savings",
      offer: { present: true, type: "rate", value: "4.25% APY", unit: "APY", term: "", minimum: "", qualifier: "" },
      daysShown: 520, first: ago(600), last: ago(1), w: 300, h: 250 },
    { id: "CAP3", headline: "Auto Financing, Pre-Qualified", product: "auto-loan",
      offer: { present: true, type: "rate", value: "5.99% APR", unit: "APR", term: "", minimum: "", qualifier: "" },
      daysShown: 330, first: ago(380), last: ago(2), w: 300, h: 600 },
    { id: "CAP4", headline: "What's In Your Wallet", product: "credit-card",
      offer: { present: false }, daysShown: 1400, first: ago(1500), last: ago(1), w: 970, h: 250 },
  ],

  "silentbank.com": [],
  "previewonly.com": [
    { id: "PRV1", headline: "", product: "other", offer: { present: false }, previewOnly: true, daysShown: 30, first: ago(40), last: ago(5) },
    { id: "PRV2", headline: "", product: "other", offer: { present: false }, previewOnly: true, daysShown: 12, first: ago(20), last: ago(7) },
  ],
  "agencybank.com": [
    { id: "AGY1", headline: "Checking Without The Games", product: "checking",
      offer: { present: true, type: "fee_waiver", value: "$0 monthly fee", unit: "none", term: "", minimum: "", qualifier: "" },
      daysShown: 77, first: ago(90), last: ago(1), w: 728, h: 90, advertiser: "Fogarty and Klein, Inc." },
  ],
};

/** Provider-shaped listing response for one domain. */
export function listingFor(domain, { format = "image", totalOverride = null } = {}) {
  const rows = MARKET[domain] || [];
  const ad_creatives = rows.map((r) => {
    const base = {
      advertiser_id: `AR_${domain}`,
      advertiser: r.advertiser || domain,
      format,
      target_domain: domain,
      ad_creative_id: r.id,
      total_days_shown: r.daysShown,
      first_shown: r.first,
      last_shown: r.last,
      details_link: `https://adstransparency.google.com/advertiser/AR_${domain}/creative/${r.id}`,
    };
    if (r.previewOnly) {
      base.link = "https://displayads-formats.googleusercontent.com/ads/preview/content.js?client=x";
    } else {
      base.image = `https://tpc.googlesyndication.com/archive/simgad/${r.id}`;
      base.width = r.w; base.height = r.h;
    }
    return base;
  });
  return {
    search_information: { total_results: totalOverride ?? ad_creatives.length },
    search_parameters: { engine: "google_ads_transparency_center" },
    ad_creatives,
  };
}

/** The extraction a perfect vision model would return for creative `id`. */
export function extractionFor(id) {
  for (const rows of Object.values(MARKET)) {
    const r = rows.find((x) => x.id === id);
    if (!r) continue;
    return {
      brand: r.advertiser || "",
      headline: r.headline,
      subhead: "",
      cta: "Learn more",
      allText: r.headline,
      offer: r.offer?.present
        ? { ...r.offer, finePrintVisible: !!r.offer.minimum }
        : { present: false, type: "none", value: "", unit: "none", term: "", minimum: "", qualifier: "", finePrintVisible: false },
      product: r.product,
      productConfidence: 0.9,
      visualStyle: "typographic",
      hasPeople: false,
      tone: "direct confident",
      legible: true,
    };
  }
  return null;
}

/** creativeId <-> png bytes, so the vision mock can identify what it was shown. */
export const PNG_BY_ID = new Map();
export const ID_BY_B64 = new Map();
let seed = 1;
for (const rows of Object.values(MARKET)) {
  for (const r of rows) {
    if (r.previewOnly) continue;
    // `art` makes rows share BYTES — one creative rendered at several sizes,
    // which is what a real display campaign looks like and what the byte-dedupe
    // is there to collapse. Offset so a shared id can never collide with an
    // auto-assigned seed.
    const png = pngFor(r.art != null ? 90000 + r.art : seed++);
    PNG_BY_ID.set(r.id, png);
    ID_BY_B64.set(png.toString("base64"), r.id);
  }
}
