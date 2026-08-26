// =============================================================================
// test/meta-fixture.js — a fake SearchApi Meta Ad Library, offline and
// deterministic.
//
// Every shape here was observed in the live probe of 111 real ads. The fixture
// exists so the awkward cases are exercised on every run rather than discovered
// in production:
//
//   · a DCO ad whose PARENT text is {{product.name}} / {{product.brand}} while
//     the real copy sits in the cards — 58% of probed ads looked like this
//   · several cards carrying identical copy and different video renders — the
//     reason message dedupe has to happen before vision
//   · a direct bank product URL, a DoubleClick redirect, an Instagram profile
//     link and a RAIN utm_source, because product classification succeeds on
//     the first and fails on the next two
//   · an active ad whose end_date is already in the past — all 111 probed ads
//     were like this, which is why end_date is never rendered as a stop date
//   · a high-confidence Page match, an ambiguous one, and a resolved Page with
//     zero ads
//   · pagination with a token still outstanding
// =============================================================================

import zlib from "node:zlib";

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Distinct bytes per seed — the media store is content-addressed. */
export function jpegish(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19) + "Z";
const cdn = (n) => `https://scontent-phl2-1.xx.fbcdn.net/v/t39.35426-6/${n}_n.jpg?_nc_cat=105&oe=6A92B76F&_nc_gid=abc`;

// ---------------------------------------------------------------------------
// PAGE SEARCH
// ---------------------------------------------------------------------------
export const PAGES = {
  "La Cap Test Credit Union": [
    { page_id: "174192912618532", name: "La Cap Test Credit Union", category: "Credit Union", likes: 41000 },
  ],
  // Clean: one candidate, exact name.
  "Summit Credit Union": [
    { page_id: "111000111", name: "Summit Credit Union", category: "Credit Union", likes: 20100 },
  ],
  // The Chase case: identical top score, hairline margin, many candidates. The
  // resolver must refuse rather than pick the first.
  "Chase": [
    { page_id: "603730309652930", name: "Chase", category: "Financial Service", likes: 6000000 },
    { page_id: "603730309652931", name: "Chase", category: "Bank", likes: 4000 },
    { page_id: "603730309652932", name: "Chase", category: "Financial Service", likes: 900 },
  ],
  // Resolves cleanly, returns nothing. "Not advertising" is a real answer and
  // must stay distinguishable from "we could not find them".
  "Quiet Federal Credit Union": [
    { page_id: "222000222", name: "Quiet Federal Credit Union", category: "Credit Union", likes: 39508 },
  ],
};

export const PAGE_BY_DOMAIN = {
  "summitcu.test": "111000111",
  "chase.test": "603730309652930",
  "quietfcu.test": "222000222",
  "lacaptest.org": "174192912618532",
};

// ---------------------------------------------------------------------------
// ADS
// ---------------------------------------------------------------------------

/** The DCO shape: template parent, real copy in cards, several renders each. */
function dcoAd(id, { title, body, url, cards = 3, seedBase, startedDaysAgo = 6 }) {
  return {
    ad_archive_id: id,
    page_id: "174192912618532",
    page_name: "La Cap Test Credit Union",
    is_active: true,
    start_date: iso(startedDaysAgo),
    // In the past, while is_active is true. All 111 probed ads behaved this way.
    end_date: iso(1),
    publisher_platform: ["FACEBOOK", "INSTAGRAM"],
    categories: ["CREDIT"],
    collation_id: `coll_${id}`,
    collation_count: 1,
    snapshot: {
      page_name: "La Cap Test Credit Union",
      // The trap: reading these classifies the ad as gibberish.
      title: "{{product.name}}",
      body: { text: "{{product.brand}}" },
      display_format: "DCO",
      link_url: url,
      cta_text: "Learn More",
      cards: Array.from({ length: cards }, (_, i) => ({
        title, body, link_url: url,
        cta_text: "Learn More", cta_type: "LEARN_MORE",
        link_description: "Get the financing you need",
        // Identical copy, different artwork — one message, N renders.
        original_image_url: cdn(seedBase + i),
        resized_image_url: cdn(seedBase + i),
        image_crops: [],
      })),
    },
  };
}

/** A plain single-image ad with no cards. */
function simpleAd(id, { title, body, url, seed, pageId = "111000111", pageName = "Summit Credit Union", active = true }) {
  return {
    ad_archive_id: id,
    page_id: pageId, page_name: pageName,
    is_active: active,
    start_date: iso(12), end_date: iso(1),
    publisher_platform: ["FACEBOOK"],
    categories: ["NONE"],
    collation_id: `coll_${id}`,
    snapshot: {
      page_name: pageName, title, body: { text: body },
      display_format: "IMAGE", link_url: url, cta_text: "Apply Now",
      images: [{ original_image_url: cdn(seed), resized_image_url: cdn(seed), image_crops: [] }],
      cards: [],
    },
  };
}

/** A video ad — preview frame only; full video is never downloaded. */
function videoAd(id, { title, body, url, seed }) {
  return {
    ad_archive_id: id,
    page_id: "111000111", page_name: "Summit Credit Union",
    is_active: true, start_date: iso(3), end_date: iso(1),
    publisher_platform: ["INSTAGRAM"], categories: ["NONE"],
    collation_id: `coll_${id}`,
    snapshot: {
      page_name: "Summit Credit Union", title, body: { text: body },
      display_format: "VIDEO", link_url: url, cta_text: "Learn More",
      cards: [],
      videos: [{
        video_hd_url: "https://video-phl2-1.xx.fbcdn.net/o1/v/x.mp4",
        video_sd_url: "https://video-phl2-1.xx.fbcdn.net/o1/v/y.mp4",
        video_preview_image_url: cdn(seed),
      }],
    },
  };
}

export const META_ADS = {
  // Page 1 for lacaptest — DCO with RAIN tracking on the destination.
  "174192912618532": {
    page1: [
      dcoAd("meta_dco_heloc", {
        title: "Explore Our Home Equity Line of Credit",
        body: "Finance home improvements with a HELOC. Enjoy an introductory APR as low as 4.99% for 6 months.",
        url: "https://www.lacaptest.org/home-equity-line-credit?utm_source=rain-7246&utm_medium=digital-video&utm_campaign=heloc-{{campaign.id}}",
        cards: 3, seedBase: 900,
      }),
      dcoAd("meta_dco_checking", {
        title: "Get more with Choice Checking",
        body: "Open Choice Checking and get $300 when you set up direct deposit.",
        url: "https://www.lacaptest.org/choice-checking?utm_source=rain-7246&utm_medium=social",
        cards: 6, seedBase: 950,
      }),
      // Generic destination: no product in the path, no product in the copy.
      // Must fall through to vision, and must remain reachable as Unresolved.
      dcoAd("meta_dco_brand", {
        title: "Built by the community",
        body: "Wherever your story leads next, we are here.",
        url: "https://instagram.com/lacaptest",
        cards: 2, seedBase: 980, startedDaysAgo: 2,
      }),
    ],
    // A token remains after page 1 -> the capture is a sample, not an inventory.
    hasMore: true,
    page2: [
      dcoAd("meta_dco_auto", {
        title: "Refinance your auto loan",
        body: "Rates as low as 4.59% APR when you refinance with us.",
        url: "https://www.lacaptest.org/auto-refinance?utm_source=rain-7246",
        cards: 3, seedBase: 1010,
      }),
    ],
  },

  // Summit — no RAIN tracking, so this is genuine external competitor evidence.
  "111000111": {
    page1: [
      simpleAd("meta_summit_mortgage", {
        title: "Mortgage Loans Made Simple",
        body: "Put down 3% with no PMI on a first mortgage.",
        url: "https://summitcu.test/mortgage", seed: 700,
      }),
      simpleAd("meta_summit_cd", {
        title: "Earn more on your savings",
        body: "6.50% APY on a 12-month certificate with $10,000 minimum.",
        url: "https://summitcu.test/share-certificates", seed: 710,
      }),
      videoAd("meta_summit_video", {
        title: "Banking that moves with you",
        body: "See what membership gets you.",
        url: "https://summitcu.test/membership", seed: 720,
      }),
      // DoubleClick redirect — the Chase failure mode. URL classification must
      // fail here and the copy must be allowed to rescue it.
      simpleAd("meta_summit_redirect", {
        title: "Cash back that adds up.",
        body: "Earn on every purchase with our credit card.",
        url: "https://ad.doubleclick.net/ddm/trackclk/N5762.152606.962", seed: 730,
      }),
    ],
    hasMore: false,
  },

  // Resolved Page, zero ads. NOT the same as an unresolved Page.
  "222000222": { page1: [], hasMore: false },
};

export function pageSearchResponse(q) {
  const key = Object.keys(PAGES).find((k) => k.toLowerCase() === String(q || "").toLowerCase())
    || Object.keys(PAGES).find((k) => String(q || "").toLowerCase().includes(k.toLowerCase()));
  return { pages: key ? PAGES[key] : [] };
}

export function adsResponse(pageId, token) {
  const set = META_ADS[pageId];
  if (!set) return { ads: [], search_information: { total_results: 0 } };
  const onPage2 = token === "page2token";
  const ads = onPage2 ? (set.page2 || []) : set.page1;
  const total = set.page1.length + (set.page2 || []).length + (set.hasMore ? 40 : 0);
  return {
    ads,
    search_information: { total_results: total },
    ...(set.hasMore && !onPage2 ? { next_page_token: "page2token" } : {}),
  };
}
