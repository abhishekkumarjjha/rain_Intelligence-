// =============================================================================
// test/benchmark.test.js — THE ACCEPTANCE TEST FOR CAMPAIGN BENCHMARK.
//
// "Does the benchmark table render?" is not the bar. The bar is whether the
// engine can DISCOVER a fixed set of statements from a known set of ads,
// without any model-written prose, and point at the evidence for each one.
//
// Every model call is stubbed. These tests run with no API key and no network,
// which is the point: if the arithmetic ever needs a key, the arithmetic has
// moved somewhere it does not belong.
// =============================================================================

import assert from "node:assert/strict";
import { shapeSearch } from "../lib/extract-search.js";
import { normalizeObservation, rollUpBrand, rankAgainst } from "../lib/observations.js";
import { productFromUrl } from "../lib/products.js";
import { comparable, better } from "../lib/metrics.js";
import { buildBoard } from "../lib/benchmark.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

// ---------------------------------------------------------------------------
// Fixture helper — model JSON in, provider metadata attached, normalized out.
// ---------------------------------------------------------------------------
let n = 0;
function ad(modelJson, provider = {}) {
  const img = {
    creativeId: provider.creativeId || `CR_${++n}`,
    domain: provider.domain || "campusfederal.org",
    advertiser: provider.advertiser || "Campus Federal Credit Union",
    imageUrl: "https://example.test/x.png",
    format: "text",
    firstShown: provider.firstShown || "2026-06-03",
    lastShown: provider.lastShown || "2026-08-30",
    totalDaysShown: provider.totalDaysShown ?? 88,
  };
  return normalizeObservation(shapeSearch(modelJson, img));
}

// ===========================================================================
console.log("\nSTAGE 1 — the bug that started this: one ad, three facts");
// ===========================================================================

// This is the exact ad from the evidence panel that the old extractor read as
// "$600 bonus, no rate". It carries a bonus in the headline, an APY in the
// description and a fee claim in a sitelink. All three must survive.
const CAMPUS_STACKED = {
  advertiser: "Campus Federal Credit Union",
  displayUrl: "www.campusfederal.org/",
  headlines: ["Campus Federal Checking", "Earn $600 Reward Card"],
  description: "Upgrade your money with Lagniappe Checking at Campus Federal. Earn 4.50% APY with Lagniappe Checking by Campus Federal, where it pays to be a member.",
  sitelinks: ["Become a Member", "Savings", "No Monthly Fee"],
  callouts: ["Great Rates", "Excellent Experiences"],
  economicFacts: [
    { metric: "cash_bonus", raw: "$600", qualifiers: {}, sourceField: "headline" },
    { metric: "apy", raw: "4.50% APY", qualifiers: {}, sourceField: "description" },
  ],
  claims: [
    { claim: "no_monthly_fee", verbatim: "No Monthly Fee", sourceField: "sitelink" },
    { claim: "member_owned", verbatim: "where it pays to be a member", sourceField: "description" },
  ],
  unclassified: [],
  leadEmphasis: "brand",
  urgency: { present: false, phrase: "" },
  product: "checking",
  productConfidence: 0.95,
  truncated: false,
  legible: true,
};

const campus1 = ad(CAMPUS_STACKED);

test("the APY in the description survives extraction", () => {
  const apy = campus1.facts.find((f) => f.metric === "apy");
  assert.ok(apy, "APY was dropped — this is the original Campus Federal bug");
  assert.equal(apy.raw, "4.50% APY");
  assert.equal(apy.value, 4.5);
});

test("the bonus in the headline survives alongside it", () => {
  const bonus = campus1.facts.find((f) => f.metric === "cash_bonus");
  assert.ok(bonus, "cash bonus was dropped");
  assert.equal(bonus.value, 600);
});

test("one ad holds BOTH figures — the singular-offer bug is gone", () => {
  assert.equal(campus1.facts.length, 2, `expected 2 economic facts, got ${campus1.facts.length}`);
});

test("a claim read from a sitelink survives", () => {
  assert.ok(campus1.claims.some((c) => c.claim === "no_monthly_fee"));
});

test("verbatim strings are never normalized away", () => {
  assert.equal(campus1.facts.find((f) => f.metric === "apy").raw, "4.50% APY",
    "4.50 must not become 4.5 — the printed string is the evidence");
});

test("a fact outside the product profile is kept as evidence, not counted", () => {
  const mixed = ad({
    ...CAMPUS_STACKED,
    economicFacts: [
      { metric: "apy", raw: "4.50% APY", qualifiers: {}, sourceField: "description" },
      // A mortgage APR quoted inside a checking ad. Real, and not a checking
      // comparison metric — counting it would build a wrong rank from a
      // correct read.
      { metric: "points", raw: "0.5 points", qualifiers: {}, sourceField: "callout" },
    ],
  });
  assert.equal(mixed.facts.length, 1);
  assert.equal(mixed.droppedFacts.length, 1);
  assert.match(mixed.droppedFacts[0].why, /not a comparison metric/);
});

test("a claim outside the vocabulary lands in unclassified, not the nearest match", () => {
  const odd = ad({
    ...CAMPUS_STACKED,
    claims: [{ claim: "free_toaster", verbatim: "Free toaster with every account", sourceField: "callout" }],
  });
  assert.equal(odd.claims.length, 0);
  assert.ok(odd.unclassified.includes("Free toaster with every account"));
});

// ===========================================================================
console.log("\nSTAGE 2 — direction and comparability");
// ===========================================================================

test("direction comes from the metric, not the product", () => {
  assert.equal(better("apy", 4.5, 4.0), 1, "higher APY is stronger");
  assert.equal(better("apr", 4.5, 4.0), -1, "higher APR is weaker");
  assert.equal(better("monthly_fee", 0, 5), 1, "lower fee is stronger");
  assert.equal(better("term_months", 12, 60), 0, "CD term has no direction");
});

test("a credit card has metrics pointing opposite ways at once", () => {
  assert.equal(better("intro_apr", 0, 4.9), 1);
  assert.equal(better("rewards_rate", 3, 1.5), 1);
  assert.equal(better("annual_fee", 0, 95), 1);
});

test("same qualifiers -> comparable", () => {
  const a = { metric: "apy", value: 4.5, qualifiers: { term_months: 12 } };
  const b = { metric: "apy", value: 4.0, qualifiers: { term_months: 12 } };
  assert.equal(comparable(a, b).ok, true);
});

test("different CD terms -> refused, with a stated reason", () => {
  const a = { metric: "apy", value: 4.5, qualifiers: { term_months: 7 } };
  const b = { metric: "apy", value: 4.5, qualifiers: { term_months: 12 } };
  const v = comparable(a, b);
  assert.equal(v.ok, false);
  assert.match(v.reason, /term/);
});

test("the balance-cap trap is refused, not ranked", () => {
  // 5.00% capped at $5,000 versus 4.50% uncapped. Ranking these is technically
  // true and commercially misleading, which is the whole reason for this gate.
  const capped = { metric: "apy", value: 5.0, qualifiers: { balance_cap: 5000 } };
  const uncapped = { metric: "apy", value: 4.5, qualifiers: {} };
  const v = comparable(capped, uncapped);
  assert.equal(v.ok, false);
  assert.match(v.reason, /balance cap/);
});

test("neither side printing a qualifier still compares", () => {
  const a = { metric: "apy", value: 4.5, qualifiers: {} };
  const b = { metric: "apy", value: 4.0, qualifiers: {} };
  assert.equal(comparable(a, b).ok, true,
    "most search ads print a figure and no terms; refusing all of them refuses everything");
});

// ===========================================================================
console.log("\nSTAGE 3 — Han's worked example, end to end");
// ===========================================================================

const cdAd = (domain, label, apy, term = 12) => ad({
  advertiser: label,
  displayUrl: `www.${domain}/certificates`,
  headlines: [`${label} CD Rates`],
  description: `Earn ${apy}% APY on a ${term}-month certificate.`,
  sitelinks: ["Open an Account"],
  callouts: [],
  economicFacts: [{ metric: "apy", raw: `${apy}% APY`, qualifiers: { term_months: term }, sourceField: "description" }],
  claims: [],
  unclassified: [],
  leadEmphasis: "rate",
  urgency: { present: false, phrase: "" },
  product: "cd",
  productConfidence: 0.95,
  truncated: false,
  legible: true,
}, { domain, advertiser: label });

const CD_BOARD = buildBoard({
  client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [cdAd("lacapfcu.org", "La Capitol FCU", "4.00")] },
  competitors: [
    { label: "Comp A", domain: "a.org", ads: [cdAd("a.org", "Comp A", "3.85")] },
    { label: "Comp B", domain: "b.org", ads: [cdAd("b.org", "Comp B", "3.85")] },
    { label: "Comp C", domain: "c.org", ads: [cdAd("c.org", "Comp C", "3.85")] },
    { label: "Comp D", domain: "d.org", ads: [cdAd("d.org", "Comp D", "4.50")] },
    { label: "Comp E", domain: "e.org", ads: [cdAd("e.org", "Comp E", "4.50")] },
  ],
  product: "cd",
  progress: Object.fromEntries(["lacapfcu.org", "a.org", "b.org", "c.org", "d.org", "e.org"]
    .map((d) => [d, { listed: 1, read: 1 }])),
});

test("the CEO's example produces the CEO's sentence", () => {
  const f = CD_BOARD.findings.find((x) => x.rule === "rate_position");
  assert.ok(f, "no rate position finding");
  assert.equal(f.count, 2, "two competitors advertise a higher APY");
  assert.equal(f.denominator, 5);
  assert.match(f.headline, /2 of 5 comparable competitors advertise a higher APY/);
  assert.match(f.headline, /3 advertise a lower/);
});

test("the report line is scoped, neutral in voice, and names its denominator", () => {
  const line = CD_BOARD.reportLines.find((l) => l.id === "rate_position_apy");
  assert.ok(line);
  assert.match(line.text, /captured/, "must be scoped to what was captured");
  assert.doesNotMatch(line.text, /inferior|worse|behind|should/i,
    "RAIN never asserts the client's product is worse");
});

test("every finding declares its unit of analysis", () => {
  for (const f of CD_BOARD.findings) {
    assert.ok(["brand", "cluster", "creative"].includes(f.unit), `${f.rule} has no unit`);
  }
});

// ===========================================================================
console.log("\nSTAGE 4 — the five findings that define done");
// ===========================================================================

const chk = (domain, label, json, provider = {}) => ad({
  advertiser: label, displayUrl: `www.${domain}/checking`,
  sitelinks: [], callouts: [], unclassified: [],
  urgency: { present: false, phrase: "" },
  product: "checking", productConfidence: 0.95, truncated: false, legible: true,
  ...json,
}, { domain, advertiser: label, ...provider });

const BOARD = buildBoard({
  client: {
    label: "La Capitol FCU", domain: "lacapfcu.org",
    ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["La Capitol Checking", "6.50% APY"],
      description: "Earn 6.50% APY on Choice Checking. Limited-time offer.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY", qualifiers: {}, sourceField: "headline" }],
      claims: [{ claim: "early_direct_deposit", verbatim: "Get paid up to 2 days early", sourceField: "description" }],
      leadEmphasis: "rate",
    })],
  },
  competitors: [
    { label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] },
    { label: "Comp B", domain: "b.org", ads: [chk("b.org", "Comp B", {
      headlines: ["Get $400 When You Switch"],
      description: "Open a checking account and earn $400. No monthly fee.",
      economicFacts: [{ metric: "cash_bonus", raw: "$400", qualifiers: {}, sourceField: "headline" },
                      { metric: "apy", raw: "3.75% APY", qualifiers: {}, sourceField: "description" }],
      claims: [{ claim: "no_monthly_fee", verbatim: "No monthly fee", sourceField: "description" }],
      leadEmphasis: "bonus",
    })] },
    { label: "Comp C", domain: "c.org", ads: [chk("c.org", "Comp C", {
      headlines: ["$300 Checking Bonus"],
      description: "Earn $300. No monthly fee, no minimum balance.",
      economicFacts: [{ metric: "cash_bonus", raw: "$300", qualifiers: {}, sourceField: "headline" }],
      claims: [{ claim: "no_monthly_fee", verbatim: "No monthly fee", sourceField: "description" }],
      leadEmphasis: "bonus",
    })] },
    { label: "Comp D", domain: "d.org", ads: [chk("d.org", "Comp D", {
      headlines: ["$250 Bonus Checking"],
      description: "Switch and earn $250 with no monthly fee.",
      economicFacts: [{ metric: "cash_bonus", raw: "$250", qualifiers: {}, sourceField: "headline" }],
      claims: [{ claim: "no_monthly_fee", verbatim: "No monthly fee", sourceField: "description" }],
      leadEmphasis: "bonus",
    })] },
    { label: "Comp E", domain: "e.org", ads: [chk("e.org", "Comp E", {
      headlines: ["Neighbors Checking"],
      description: "Checking and savings with 24/7 online and mobile banking.",
      economicFacts: [],
      claims: [{ claim: "mobile_banking", verbatim: "24/7 Online & Mobile Banking", sourceField: "description" }],
      leadEmphasis: "brand",
    })] },
  ],
  product: "checking",
  progress: Object.fromEntries(["lacapfcu.org", "campusfederal.org", "b.org", "c.org", "d.org", "e.org"]
    .map((d) => [d, { listed: 1, read: 1 }])),
});

const has = (rule) => BOARD.findings.find((f) => f.rule === rule)
  || (() => { throw new Error(`missing finding: ${rule}\n       got: ${BOARD.findings.map((f) => f.rule).join(", ")}`); })();

test("1. bonus gap — 4 of 5 competitors advertise a bonus, the client does not", () => {
  const f = has("bonus_gap");
  assert.equal(f.count, 4);
  assert.equal(f.denominator, 5);
  assert.equal(f.unit, "brand", "a brand with 40 creatives counts once");
});

test("2. rate position — the client leads on APY", () => {
  const f = BOARD.findings.find((x) => x.rule === "rate_advantage" || x.rule === "rate_position");
  assert.ok(f);
  assert.equal(f.direction, "positive", "6.50% beats 4.50% and 3.75%");
});

test("3. offer combination — competitors stack rate and bonus, the client does not", () => {
  const f = has("offer_combination");
  assert.equal(f.count, 2, "Campus and Comp B carry two figures in one ad");
});

test("4. message gap — a majority mention no monthly fee, the client does not", () => {
  const f = BOARD.findings.find((x) => x.rule === "claim_gap" && /monthly fee/i.test(x.headline));
  assert.ok(f, "no monthly-fee claim gap");
  assert.equal(f.count, 4);
  assert.match(f.headline, /not observed in/i, "absence is a recall claim, never a fact about them");
});

test("5. message advantage — only the client mentions early direct deposit", () => {
  const f = has("claim_advantage");
  assert.match(f.headline, /early direct deposit/i);
  assert.equal(f.direction, "positive", "Han asked why performance is GOOD as well as bad");
});

test("every finding can point at the ads that created it", () => {
  for (const f of BOARD.findings) {
    if (f.rule === "offer_withdrawn") continue;   // absence has no creative
    assert.ok(f.evidence.length > 0, `${f.rule} has no evidence`);
  }
});

test("the board never pads to a target count", () => {
  assert.ok(BOARD.findings.length <= 6);
  assert.equal(BOARD.findings.length, Math.min(6, BOARD.findingsTotal));
});

test("the offer snapshot carries only this product's metrics", () => {
  assert.deepEqual(BOARD.snapshot.columns.map((c) => c.metric),
    ["apy", "cash_bonus", "monthly_fee", "minimum_opening_deposit"]);
});

// ===========================================================================
console.log("\nSTAGE 5 — the guards");
// ===========================================================================

test("zero client ads suppresses every client-gap finding", () => {
  const board = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [] },
    competitors: [
      { label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] },
      { label: "Comp B", domain: "b.org", ads: [chk("b.org", "Comp B", {
        headlines: ["$400"], description: "Earn $400.",
        economicFacts: [{ metric: "cash_bonus", raw: "$400", qualifiers: {}, sourceField: "headline" }],
        claims: [], leadEmphasis: "bonus",
      })] },
    ],
    product: "checking",
    progress: { "lacapfcu.org": { listed: 0, read: 0 }, "campusfederal.org": { listed: 1, read: 1 }, "b.org": { listed: 1, read: 1 } },
  });
  assert.equal(board.coverage.allowClientGapFindings, false);
  for (const f of board.findings) {
    assert.doesNotMatch(f.headline, /La Capitol FCU'?s captured ads do not/,
      "cannot state what the client did not advertise when zero client ads were captured");
  }
  assert.equal(board.empty?.kind, "no_client_ads");
});

test("an unreadable competitor is excluded from the denominator, not counted as a 'no'", () => {
  const board = buildBoard({
    client: { label: "Client", domain: "client.org", ads: [chk("client.org", "Client", {
      headlines: ["Checking"], description: "Open today.", economicFacts: [], claims: [], leadEmphasis: "brand",
    })] },
    competitors: [
      { label: "A", domain: "a.org", ads: [chk("a.org", "A", {
        headlines: ["$500"], description: "Earn $500.",
        economicFacts: [{ metric: "cash_bonus", raw: "$500", qualifiers: {}, sourceField: "headline" }],
        claims: [], leadEmphasis: "bonus",
      })] },
      { label: "B", domain: "b.org", ads: [chk("b.org", "B", {
        headlines: ["$500"], description: "Earn $500.",
        economicFacts: [{ metric: "cash_bonus", raw: "$500", qualifiers: {}, sourceField: "headline" }],
        claims: [], leadEmphasis: "bonus",
      })] },
      { label: "Dark", domain: "dark.org", ads: [] },
    ],
    product: "checking",
    progress: { "client.org": { listed: 1, read: 1 }, "a.org": { listed: 1, read: 1 }, "b.org": { listed: 1, read: 1 }, "dark.org": { listed: 0, read: 0 } },
  });
  const f = board.findings.find((x) => x.rule === "bonus_gap");
  assert.ok(f);
  assert.equal(f.denominator, 2, "the competitor we could not read is not a competitor without a bonus");
});

test("below three readable competitors, ratio language is replaced by names", () => {
  const board = buildBoard({
    client: { label: "Client", domain: "client.org", ads: [chk("client.org", "Client", {
      headlines: ["Checking"], description: "Open today.", economicFacts: [], claims: [], leadEmphasis: "brand",
    })] },
    competitors: [{ label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] }],
    product: "checking",
    progress: { "client.org": { listed: 1, read: 1 }, "campusfederal.org": { listed: 1, read: 1 } },
  });
  assert.equal(board.coverage.allowRatioLanguage, false);
  const f = board.findings.find((x) => x.rule === "bonus_gap");
  if (f) {
    assert.doesNotMatch(f.headline, /1 of 1/, "'1 of 1 competitors' is an anecdote wearing a denominator");
    assert.match(f.headline, /Campus Federal/);
  }
});

test("a newly added competitor cannot manufacture a 'newly observed' card", () => {
  const previous = {
    label: "July 2026",
    competitorSet: { hash: "old", domains: ["campusfederal.org"] },
    brands: [{ domain: "campusfederal.org", label: "Campus Federal", positions: {}, claims: [], hasCoverage: true }],
  };
  const board = buildBoard({
    client: { label: "Client", domain: "client.org", ads: [chk("client.org", "Client", {
      headlines: ["Checking"], description: "Open today.", economicFacts: [], claims: [], leadEmphasis: "brand",
    })] },
    competitors: [
      { label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] },
      // Present this month only. Their $700 bonus is new to US, not new.
      { label: "Newcomer", domain: "new.org", ads: [chk("new.org", "Newcomer", {
        headlines: ["$700 Bonus"], description: "Earn $700.",
        economicFacts: [{ metric: "cash_bonus", raw: "$700", qualifiers: {}, sourceField: "headline" }],
        claims: [], leadEmphasis: "bonus",
      })] },
    ],
    product: "checking",
    progress: { "client.org": { listed: 1, read: 1 }, "campusfederal.org": { listed: 1, read: 1 }, "new.org": { listed: 1, read: 1 } },
    previous,
  });
  const bogus = board.findings.find((f) => f.rule === "offer_new" && /Newcomer/.test(f.headline));
  assert.equal(bogus, undefined, "a competitor with no prior state has no change to report");
  assert.ok(board.setDrift?.changed, "the board must disclose that the set moved");
  assert.match(board.setDrift.note, /Competitor set changed/);
});

test("a real change against a stable competitor IS reported", () => {
  const previous = {
    label: "July 2026",
    competitorSet: { hash: "old", domains: ["campusfederal.org"] },
    brands: [{
      domain: "campusfederal.org", label: "Campus Federal", hasCoverage: true, claims: [],
      positions: { apy: { raw: "4.50% APY", value: 4.5, qualifiers: {} } },
    }],
  };
  const board = buildBoard({
    client: { label: "Client", domain: "client.org", ads: [chk("client.org", "Client", {
      headlines: ["Checking"], description: "Open today.", economicFacts: [], claims: [], leadEmphasis: "brand",
    })] },
    competitors: [{ label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] }],
    product: "checking",
    progress: { "client.org": { listed: 1, read: 1 }, "campusfederal.org": { listed: 1, read: 1 } },
    previous,
  });
  const f = board.findings.find((x) => x.rule === "offer_new" && /600/.test(x.headline));
  assert.ok(f, "the $600 bonus is genuinely new against a competitor present in both runs");
});

test("unclassified selling points are surfaced so profiles can be improved", () => {
  const board = buildBoard({
    client: { label: "Client", domain: "client.org", ads: [chk("client.org", "Client", {
      headlines: ["Checking"], description: "Free toaster.", economicFacts: [], claims: [],
      unclassified: ["Free toaster with every account"], leadEmphasis: "brand",
    })] },
    competitors: [{ label: "A", domain: "a.org", ads: [] }],
    product: "checking",
    progress: { "client.org": { listed: 1, read: 1 }, "a.org": { listed: 0, read: 0 } },
  });
  assert.ok(board.unclassified.includes("Free toaster with every account"));
});

// ===========================================================================
console.log("\nSTAGE 6 — the scoreboard, the reference tier, the BaZing case");
// ===========================================================================

const nat = (domain, label, json) => ({ ...chk(domain, label, json), tier: "national" });

const SB = buildBoard({
  client: {
    label: "La Capitol", domain: "lacapfcu.org",
    ads: [
      // The real ad: an add-on package price AND a rate in the same creative.
      chk("lacapfcu.org", "La Capitol", {
        headlines: ["Personal Checking Account", "Personal Banking In Louisiana"],
        description: "Enjoy mobile protection, roadside help, ID theft aid & more for $5.99/month* with BaZing. Celebrate La Cap's 65th anniversary with 6.50% APY* on Checking. Limited-time offer!",
        economicFacts: [
          { metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "description" },
          // Correctly tagged: this is BaZing's price, not the account's fee.
          { metric: "monthly_fee", raw: "$5.99/month*", qualifiers: { applies_to: "BaZing" }, sourceField: "description" },
        ],
        claims: [], leadEmphasis: "feature",
      }, { creativeId: "CR_BAZING" }),
      chk("lacapfcu.org", "La Capitol", {
        headlines: ["No Deposit Checking Account"],
        description: "No Fee checking with no minimum balance.",
        economicFacts: [],
        claims: [
          { claim: "no_monthly_fee", verbatim: "No Fee", sourceField: "description" },
          { claim: "no_minimum_balance", verbatim: "no minimum balance", sourceField: "description" },
        ],
        leadEmphasis: "feature",
      }, { creativeId: "CR_NOFEE" }),
    ],
  },
  competitors: [
    { label: "Campus Federal", domain: "campusfederal.org", ads: [ad(CAMPUS_STACKED, { domain: "campusfederal.org" })] },
    { label: "Baton Rouge Telco", domain: "brtelco.org", ads: [chk("brtelco.org", "Baton Rouge Telco", {
      headlines: ["$300 Checking Bonus"], description: "Earn $300. No monthly fee.",
      economicFacts: [{ metric: "cash_bonus", raw: "$300", qualifiers: {}, sourceField: "headline" }],
      claims: [{ claim: "no_monthly_fee", verbatim: "No monthly fee", sourceField: "description" }],
      leadEmphasis: "bonus",
    })] },
    { label: "Neighbors FCU", domain: "neighborsfcu.org", ads: [chk("neighborsfcu.org", "Neighbors FCU", {
      headlines: ["Neighbors FCU"], description: "Checking & Savings w/ 24/7 Online & Mobile Banking.",
      economicFacts: [], claims: [{ claim: "mobile_banking", verbatim: "24/7 Online & Mobile Banking", sourceField: "description" }],
      leadEmphasis: "brand",
    })] },
    // Reference tier. Must never touch a denominator.
    { label: "J.P. Morgan Chase", domain: "chase.com", tier: "national", ads: [nat("chase.com", "J.P. Morgan Chase", {
      headlines: ["Chase Total Checking", "$900 Bonus"], description: "Earn $900 with qualifying activities. 5.00% APY.",
      economicFacts: [
        { metric: "cash_bonus", raw: "$900", qualifiers: {}, sourceField: "headline" },
        { metric: "apy", raw: "5.00% APY", qualifiers: {}, sourceField: "description" },
      ],
      claims: [{ claim: "no_monthly_fee", verbatim: "No monthly service fee", sourceField: "description" }],
      leadEmphasis: "bonus",
    })] },
  ],
  product: "checking",
  progress: Object.fromEntries(
    ["lacapfcu.org", "campusfederal.org", "brtelco.org", "neighborsfcu.org", "chase.com"]
      .map((d) => [d, { listed: 2, read: 2 }])),
});

test("every shown finding lands in exactly one of the three boards", () => {
  const t = SB.boards.lead.length + SB.boards.pressure.length + SB.boards.context.length;
  assert.equal(t, SB.findings.length);
  for (const f of SB.findings) {
    assert.ok(["lead", "pressure", "context"].includes(f.outcome), `${f.rule} has no outcome`);
  }
});

test("the client's wins and losses are both present", () => {
  assert.ok(SB.boards.lead.length >= 1, "no lead findings");
  assert.ok(SB.boards.pressure.length >= 1, "no pressure findings");
});

test("a national never enters a denominator", () => {
  assert.ok(!SB.brands.some((b) => b.domain === "chase.com"));
  assert.ok(SB.referenceBrands.some((b) => b.domain === "chase.com"));
  const bonus = SB.findings.find((f) => f.rule === "bonus_gap");
  assert.ok(bonus);
  assert.equal(bonus.denominator, 3, "3 local competitors, not 4 — Chase is reference only");
});

test("a national never appears inside a finding headline", () => {
  for (const f of SB.findings) assert.doesNotMatch(f.headline, /Chase|Capital One/);
});

test("the national is still visible, in its own labelled block", () => {
  assert.ok(SB.snapshot.reference.length >= 1);
  assert.match(SB.snapshot.referenceNote, /never counted among the selected local competitors/);
});

test("a BaZing add-on price is never ranked against an account fee", () => {
  const bazing = { metric: "monthly_fee", value: 5.99, qualifiers: { applies_to: "BaZing" } };
  const accountFee = { metric: "monthly_fee", value: 5.00, qualifiers: {} };
  const v = comparable(bazing, accountFee);
  assert.equal(v.ok, false, "a benefits-bundle price is not the account's monthly fee");
  assert.match(v.reason, /what the fee covers/);
});

test("the $5.99 / 'No Fee' pair is raised as a question, never as a contradiction", () => {
  const f = SB.findings.find((x) => x.rule === "mixed_message");
  if (f) {
    assert.equal(f.outcome, "context", "not a scoreboard entry — no competitor is beating anyone");
    assert.match(f.detail, /different products or an optional add-on/,
      "the tool cannot tell a real inconsistency from two ads about two things");
    assert.doesNotMatch(f.headline, /contradict|inconsistent/i);
  }
});

test("no headline says 'all 1 comparable competitor'", () => {
  for (const f of SB.findings) assert.doesNotMatch(f.headline, /all 1 comparable/);
});

test("named gap findings agree with their verb", () => {
  for (const f of SB.findings) assert.doesNotMatch(f.headline, /^\S[^.]*\b[A-Z]\w+ Federal advertise\b/);
});

test("evidence counts creatives, not facts", () => {
  const f = SB.findings.find((x) => x.evidence?.length);
  assert.ok(f);
  assert.equal(f.evidence.length, new Set(f.evidence).size);
});

// ===========================================================================
console.log("\nSTAGE 6 — figures the tool must refuse to read");
// ===========================================================================
//
// Both fixtures are verbatim from the 2026-08-31 La Capitol capture, and each
// put a false sentence on the board before these guards existed.
// ===========================================================================

// Google clipped this description mid-number. The reader proposed it as a cash
// bonus of "Up To 5.5…". The same advertiser's uncut ad reads "Earn Up To 5.55%
// APY*" — so it was not a bonus, and it was not 5.5 of anything.
const CLIPPED = buildBoard({
  client: {
    label: "La Capitol FCU", domain: "lacapfcu.org",
    ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["La Capitol Checking"],
      description: "Earn 6.50% APY on Choice Checking.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })],
  },
  competitors: [
    { label: "BR Telco", domain: "brtelco.org", ads: [chk("brtelco.org", "BR Telco", {
      headlines: ["Baton Rouge Telco Federal Credit Union"],
      description: "Open A Checking Account With BR Telco & Earn Up To 5.5…",
      truncated: true,
      economicFacts: [{ metric: "cash_bonus", raw: "Up To 5.5…", qualifiers: {}, sourceField: "description" }],
    })] },
    { label: "Campus Federal", domain: "campusfederal.org", ads: [chk("campusfederal.org", "Campus Federal", {
      headlines: ["Earn $600 Reward Card"],
      description: "Earn $600 with Lagniappe Checking.",
      economicFacts: [{ metric: "cash_bonus", raw: "$600", qualifiers: {}, sourceField: "headline" }],
    })] },
  ],
  product: "checking",
  progress: Object.fromEntries(["lacapfcu.org", "brtelco.org", "campusfederal.org"]
    .map((d) => [d, { listed: 1, read: 1 }])),
});

test("a clipped figure never becomes a brand's advertised position", () => {
  const br = CLIPPED.brands.find((b) => b.domain === "brtelco.org");
  assert.equal(br.positions.cash_bonus, undefined, "a cut-off figure was counted as an offer");
});

test("a clipped figure is not counted in a gap denominator", () => {
  const gap = CLIPPED.findings.find((f) => f.rule === "bonus_gap");
  assert.ok(gap, "expected a bonus gap finding");
  assert.equal(gap.count, 1, `expected 1 competitor advertising a bonus, got: ${gap.headline}`);
});

test("the clipped reading survives as evidence, flagged as cut off", () => {
  const row = CLIPPED.snapshot.rows.find((r) => r.domain === "brtelco.org");
  const cell = row.cells.find((c) => c.metric === "cash_bonus");
  assert.equal(cell.clipped, true, "the cell must say the figure was cut off");
  assert.ok(cell.evidence.length, "the clipped ad must still be reachable");
});

test("an unclipped figure carrying its unit is unaffected", () => {
  const cf = CLIPPED.brands.find((b) => b.domain === "campusfederal.org");
  assert.equal(cf.positions.cash_bonus.raw, "$600");
});

// "$5.99/month* with BaZing" is the price of an optional benefits bundle. Read
// as the account's monthly fee it says the client charges for an account their
// competitors give away — about the client's own product, in the client's own
// report.
const BUNDLE = buildBoard({
  client: {
    label: "La Capitol FCU", domain: "lacapfcu.org",
    ads: [
      chk("lacapfcu.org", "La Capitol FCU", {
        headlines: ["Personal Checking Account"],
        description: "Enjoy mobile protection, roadside help & more for $5.99/month* with BaZing.",
        economicFacts: [{ metric: "monthly_fee", raw: "$5.99/month*", qualifiers: { applies_to: "BaZing" }, sourceField: "description" }],
      }, { creativeId: "FEE_AD" }),
      chk("lacapfcu.org", "La Capitol FCU", {
        headlines: ["Free Checking"],
        description: "No Fee Choice Checking.",
        claims: [{ claim: "no_monthly_fee", verbatim: "No Fee Choice Checking", sourceField: "description" }],
      }, { creativeId: "FREE_AD" }),
    ],
  },
  competitors: [
    { label: "Campus Federal", domain: "campusfederal.org", ads: [chk("campusfederal.org", "Campus Federal", {
      headlines: ["Lagniappe Checking"], description: "Earn 4.50% APY.",
      economicFacts: [{ metric: "apy", raw: "4.50% APY", qualifiers: {}, sourceField: "description" }],
    })] },
  ],
  product: "checking",
  progress: Object.fromEntries(["lacapfcu.org", "campusfederal.org"].map((d) => [d, { listed: 1, read: 1 }])),
});

test("an add-on price is never the brand's monthly fee", () => {
  const c = BUNDLE.brands.find((b) => b.isClient);
  assert.equal(c.positions.monthly_fee, undefined, "a bundle price was read as the account's fee");
});

test("no card asserts a cost the client's own ads contradict", () => {
  const asserted = BUNDLE.findings.filter((f) => f.rule === "fee_position");
  assert.equal(asserted.length, 0,
    `a cost was asserted on a contested fee: ${asserted.map((f) => f.headline).join(" | ")}`);
});

test("a national never enters the competitor set version", () => {
  // The snapshot writer used to recompute this from run.competitors, which
  // includes the reference tier. Stored 6, compared 4, and every run reported
  // "competitor set changed: −2" that no user action could clear.
  const withNationals = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: [
      { label: "Campus Federal", domain: "campusfederal.org", tier: "local", ads: [] },
      { label: "J.P. Morgan Chase", domain: "chase.com", tier: "national", ads: [] },
      { label: "Capital One", domain: "capitalone.com", tier: "national", ads: [] },
    ],
    product: "checking",
    progress: { "lacapfcu.org": { listed: 1, read: 1 } },
  });
  assert.deepEqual(withNationals.competitorSet.domains, ["campusfederal.org"],
    "the national tier leaked into set identity");
});

test("an extractor improvement is not reported as a market change", () => {
  // A snapshot written before the clipped-figure gate holds "Up To 5.5…" as a
  // cash bonus. Refusing it today must read as silence, not as a competitor
  // withdrawing an offer they never advertised.
  const board = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: [{ label: "BR Telco", domain: "brtelco.org", tier: "local", ads: [chk("brtelco.org", "BR Telco", {
      headlines: ["Free Checking"], description: "Earn Up To 5.55% APY*.",
      economicFacts: [{ metric: "apy", raw: "5.55% APY*", qualifiers: {}, sourceField: "description" }],
    })] }],
    product: "checking",
    progress: { "lacapfcu.org": { listed: 1, read: 1 }, "brtelco.org": { listed: 1, read: 1 } },
    previous: {
      label: "August 2026",
      competitorSet: { hash: "x", domains: ["brtelco.org"] },
      brands: [{ domain: "brtelco.org", label: "BR Telco", positions: {
        cash_bonus: { raw: "Up To 5.5…", value: null, qualifiers: {}, creativeId: "OLD" },
        apy: { raw: "5.55% APY*", value: 5.55, qualifiers: {}, creativeId: "OLD2" },
      } }],
    },
  });
  const withdrawn = board.findings.filter((f) => f.rule === "offer_withdrawn");
  assert.equal(withdrawn.length, 0,
    `a refused figure was reported as a withdrawn offer: ${withdrawn.map((f) => f.headline).join(" | ")}`);
});

// ===========================================================================
console.log("\nSTAGE 8 — what the set is competing on");
// ===========================================================================

test("the set read names the contested axis with its denominator", () => {
  const s = BOARD.setShape;
  assert.ok(s, "no set shape produced");
  const axis = s.observations.find((o) => o.kind === "contested_axis");
  assert.ok(axis, "expected a contested axis");
  assert.ok(axis.denominator >= 3, "an axis needs a stated population");
  assert.match(axis.text, new RegExp(`\\b${axis.count} of ${axis.denominator}\\b`),
    `the count must be visible in the sentence: ${axis.text}`);
});

test("no observation claims performance, only advertising", () => {
  // The capture holds no click, conversion or spend. Any verb about outcomes
  // would be invented, and it would read as RAIN asserting what works.
  const BANNED = /\b(wins?|winning|works?|performs?|effective|best|should|recommend|you should|drives?|converts?)\b/i;
  for (const o of BOARD.setShape.observations) {
    assert.doesNotMatch(o.text, BANNED, `outcome language in a counted observation: "${o.text}"`);
  }
  assert.doesNotMatch(BOARD.setShape.framing, /\b(wins?|works?|recommend)\b/i);
});

test("every observation points at the ads that produced it", () => {
  for (const o of BOARD.setShape.observations) {
    assert.ok(o.evidence?.length, `${o.kind} carries no evidence`);
    assert.equal(o.evidence.length, new Set(o.evidence).size, "evidence must be deduped");
  }
});

test("a national never enters the counted population", () => {
  // Same rule as every denominator on the board: we cannot tell whether a
  // national's ads served in this market, so they cannot describe it.
  const s = BOARD.setShape;
  const local = BOARD.brands.filter((b) => (b.tier || "local") !== "national" && b.hasCoverage);
  assert.equal(s.brandsCounted, local.length, "the population must be local brands only");
  for (const o of s.observations.filter((x) => !x.reference)) {
    assert.ok(o.denominator <= local.length, `${o.kind} counted beyond the local set`);
  }
});

test("below three readable brands the set has no shape", () => {
  const thin = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: [{ label: "Campus Federal", domain: "campusfederal.org", ads: [chk("campusfederal.org", "Campus Federal", {
      headlines: ["Lagniappe"], description: "Earn 4.50% APY.",
      economicFacts: [{ metric: "apy", raw: "4.50% APY", qualifiers: {}, sourceField: "description" }],
    })] }],
    product: "checking",
    progress: { "lacapfcu.org": { listed: 1, read: 1 }, "campusfederal.org": { listed: 1, read: 1 } },
  });
  assert.equal(thin.setShape, null, "two brands is a coincidence, not a shape");
});

// ===========================================================================
console.log("\nSTAGE 9 — weight, and the one sentence at the top");
// ===========================================================================

test("a lone advertiser's tactic is not weighted like a shared pattern", () => {
  // The complaint this fixes: "1 of 3 competitors advertise a $5 minimum" was
  // rendering identically to "2 of 3 mention member-owned", telling the reader
  // they carried the same diagnostic weight.
  const byRule = Object.fromEntries(BOARD.findings.map((f) => [f.rule, f]));
  for (const f of BOARD.findings) {
    assert.ok(f.significance, `${f.rule} has no significance`);
    const n = Number(f.count), d = Number(f.denominator);
    if (Number.isFinite(n) && Number.isFinite(d) && d >= 3 && n === 1 && f.outcome !== "context") {
      assert.equal(f.significance, "isolated", `${f.rule} at ${n}/${d} should be isolated`);
    }
    if (Number.isFinite(n) && Number.isFinite(d) && d > 0 && n / d >= 0.5 && f.outcome !== "context") {
      assert.equal(f.significance, "primary", `${f.rule} at ${n}/${d} should be primary`);
    }
  }
  assert.ok(Object.values(byRule).some((f) => f.significance === "primary"), "expected a primary finding");
});

test("the client's stance on the headline rate is always primary", () => {
  const rate = BOARD.findings.find((f) => f.metric === "apy" && f.outcome !== "context");
  assert.ok(rate, "expected a finding on the primary rate");
  assert.equal(rate.significance, "primary");
});

test("the client's own inconsistency is internal, never a competitor win", () => {
  for (const f of BOARD.findings.filter((f) => f.outcome === "context")) {
    assert.equal(f.significance, "internal", `${f.rule} should be internal`);
  }
});

test("the primary read states where the client stands, with its denominator", () => {
  const pr = BOARD.primaryRead;
  assert.ok(pr, "no primary read produced");
  assert.match(pr.headline, /\d+ comparable local competitor/,
    `the headline must name the comparable count: ${pr.headline}`);
});

test("the read separates a shared pattern from a single advertiser's tactic", () => {
  const pr = BOARD.primaryRead;
  // Only PRESSURE findings reach the differences line — a lone thing the client
  // LEADS on is not a competitor difference.
  const isolated = BOARD.findings.filter((f) => f.significance === "isolated" && f.outcome === "pressure");
  if (isolated.length) {
    assert.match(pr.differences, /one advertiser only/,
      `a lone tactic must be marked as one: ${pr.differences}`);
  }
  for (const f of BOARD.findings.filter((x) => x.significance === "primary" && x.outcome === "pressure")) {
    assert.match(pr.differences, new RegExp(`${f.count} of ${f.denominator}`),
      `a shared pattern must carry its share: ${pr.differences}`);
  }
});

test("the read never recommends anything", () => {
  const ADVICE = /\b(should|recommend|consider|adopt|improve|increase|ought|need to|try)\b/i;
  for (const k of ["framing", "headline", "differences", "boundary"]) {
    assert.doesNotMatch(BOARD.primaryRead[k], ADVICE, `advice in ${k}`);
  }
});

test("the read never claims a difference caused performance", () => {
  // Scoped to the ASSERTIVE lines. The boundary is where causation is denied —
  // "it cannot show what any of it caused" — so a blanket ban would fail the one
  // sentence doing the guarding.
  const CAUSATION = /\b(because of|caused by|driving|drove|due to|resulted in|led to)\b/i;
  for (const k of ["headline", "differences"]) {
    assert.doesNotMatch(BOARD.primaryRead[k], CAUSATION, `causation asserted in ${k}`);
  }
  assert.match(BOARD.primaryRead.boundary, /cannot show what any of it caused/i,
    "the boundary must deny causation explicitly");
});

test("the read never calls the product weak — only the advertising", () => {
  const BANNED = /\b(inferior|weak|uncompetitive|worse|poor|behind the market)\b/i;
  const all = Object.values(BOARD.primaryRead).filter((v) => typeof v === "string").join(" ");
  assert.doesNotMatch(all, BANNED);
});

test("the read states what the capture cannot establish", () => {
  assert.match(BOARD.primaryRead.boundary, /no click, conversion or spend/i);
});

test("the framing says this is read after delivery, not instead of it", () => {
  assert.match(BOARD.primaryRead.framing, /delivery|execution/i);
});

test("a discount off a rate is never read as the rate", () => {
  // Verbatim from La Capitol's auto-loan ad: "Rates as low as 4.59% APR* ...
  // get 0.65% off your rate". Both were filed as apr, and because a LOWER apr
  // wins, 0.65 became the advertised position — so the board told the client
  // they advertised a 0.65% auto loan.
  const board = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["4.59% APR* For 67 - 75 Months"],
      description: "Refinance your auto loan. Rates as low as 4.59% APR* and get 0.65% off your rate.",
      product: "auto-loan",
      economicFacts: [
        { metric: "apr", raw: "4.59% APR*", qualifiers: {}, sourceField: "headline" },
        { metric: "apr", raw: "0.65% off", qualifiers: {}, sourceField: "description" },
      ],
    })] },
    competitors: ["a", "b", "c"].map((k) => ({
      label: `Comp ${k.toUpperCase()}`, domain: `${k}.org`, ads: [chk(`${k}.org`, `Comp ${k.toUpperCase()}`, {
        headlines: ["Auto Loans"], description: "Rates from 4.84% APR*.", product: "auto-loan",
        economicFacts: [{ metric: "apr", raw: "4.84% APR*", qualifiers: {}, sourceField: "description" }],
      })],
    })),
    product: "auto-loan",
    progress: Object.fromEntries(["lacapfcu.org", "a.org", "b.org", "c.org"].map((d) => [d, { listed: 1, read: 1 }])),
  });
  const c = board.brands.find((b) => b.isClient);
  assert.equal(c.positions.apr.raw, "4.59% APR*",
    `a discount became the advertised rate: ${c.positions.apr.raw}`);
  // RETYPED, not dropped. The ad really does offer 0.65% off — it is simply a
  // different mechanic, and a separate metric id makes ranking it against a
  // rate impossible by construction rather than by a filter someone can remove.
  assert.equal(c.positions.rate_discount?.raw, "0.65% off", "the discount was lost entirely");
  assert.equal(c.positions.rate_discount.retypedFrom, "apr", "the reclassification is not recorded");
});

test("a product page URL is detected, plural or singular", () => {
  // "/credit-cards" resolved to `other`, which matches every ad ever captured —
  // so every finding and every piece of evidence on that board was about the
  // wrong product, while looking exactly as confident as a correct one.
  for (const [path, want] of [
    ["/credit-cards", "credit-card"], ["/credit-card", "credit-card"],
    ["/personal-loans", "personal-loan"], ["/home-loans", "mortgage"],
    ["/money-markets", "money-market"], ["/equity-lines", "heloc"],
    ["/checking-accounts", "checking"], ["/auto-loan", "auto-loan"],
  ]) {
    assert.equal(productFromUrl(`https://lacapfcu.org${path}`).product, want, `${path} misread`);
  }
  assert.equal(productFromUrl("https://lacapfcu.org/").from, "none", "a homepage must not guess");
});

test("an advertiser's own name is never a message strategy", () => {
  // "Federal credit union" is the institution's legal type and appears in the
  // verified-advertiser line of essentially every credit-union ad. Counted as
  // member-owned positioning it produces a message gap against a competitor who
  // never chose to say anything.
  for (const v of ["Federal credit union", "Your Local Credit Union", "Credit Union"]) {
    const ad = normalizeObservation({ product: "checking", rawEconomicFacts: [], allText: v,
      rawClaims: [{ claim: "member_owned", verbatim: v }] });
    assert.equal(ad.claims.length, 0, `identity counted as a claim: ${v}`);
  }
  // A real selling claim still passes.
  const real = normalizeObservation({ product: "checking", rawEconomicFacts: [], allText: "x",
    rawClaims: [{ claim: "member_owned", verbatim: "where it pays to be a member" }] });
  assert.equal(real.claims.length, 1, "a genuine member claim was rejected");
});

test("one offer mechanic produces one claim, not two", () => {
  // "No Payments For 60 Days" was returned as both payment_deferral and
  // no_payment_days, and rendered as two advantages quoting one sentence.
  const ad = normalizeObservation({ product: "auto-loan", rawEconomicFacts: [], allText: "x",
    rawClaims: [
      { claim: "payment_deferral", verbatim: "No Payments For 60 Days" },
      { claim: "no_payment_days", verbatim: "No Payments For 60 Days" },
    ] });
  assert.deepEqual(ad.claims.map((c) => c.claim), ["payment_deferral"]);
});

test("an amount you can borrow is never a cash bonus", () => {
  // "Borrow Funds Up To $30,000*" was filed as a bonus and ranked against
  // Chase's $3,000 welcome offer. Both are dollars; only one is a payment.
  const ad = normalizeObservation({ product: "personal-loan", rawClaims: [],
    allText: "Apply For A Personal Loan - Borrow Funds Up To $30,000*",
    rawEconomicFacts: [{ metric: "cash_bonus", raw: "$30,000*", qualifiers: {} }] });
  assert.deepEqual(ad.facts.map((f) => f.metric), ["loan_amount"],
    "a loan size was left countable as a bonus");
  assert.equal(ad.facts[0].retypedFrom, "cash_bonus", "the reclassification is not recorded");
  // A genuine bonus on the same product is untouched.
  const bonus = normalizeObservation({ product: "personal-loan", rawClaims: [],
    allText: "Earn a $300 bonus when you open a personal loan",
    rawEconomicFacts: [{ metric: "cash_bonus", raw: "$300", qualifiers: {} }] });
  assert.deepEqual(bonus.facts.map((f) => f.metric), ["cash_bonus"], "a real bonus was refused");
});

test("financing availability is its own mechanic, not a down payment", () => {
  // "Up to 100% Financing" is how a lender competes when it is not competing on
  // rate. Read as a down payment it says the opposite of what the ad says.
  const ad = normalizeObservation({ product: "auto-loan", rawClaims: [],
    allText: "Great Rates with Extended Loan Terms and Up to 100% Financing",
    rawEconomicFacts: [{ metric: "down_payment", raw: "Up to 100% Financing", qualifiers: {} }] });
  assert.deepEqual(ad.facts.map((f) => f.metric), ["financing_percent"]);
});

test("no two offer mechanics are ever ranked against each other", () => {
  // The structural guarantee: different metric ids cannot meet in a comparison,
  // whatever a later stage decides to do. A rate, a discount off that rate and
  // a financing percentage are three promises, not three values of one.
  const ids = ["apr", "rate_discount", "financing_percent", "loan_amount", "cash_bonus"];
  assert.equal(new Set(ids).size, ids.length, "mechanics must not share an id");
});

test("participation is stated before any ratio is read", () => {
  // A competitor absent from the product and one present but silent on price
  // are different facts, and a ratio alone cannot tell them apart.
  const pr = BOARD.primaryRead;
  assert.ok(pr.participation, "no participation line");
  assert.match(pr.participation, /of \d+ selected competitors? advertised/,
    `participation must name the selected set: ${pr.participation}`);
});

test("an advertiser with nothing on this product is named once, not tabled", () => {
  const snap = BOARD.snapshot;
  assert.ok(Array.isArray(snap.summaries), "expected per-advertiser summaries");
  for (const x of snap.summaries) {
    assert.ok(x.adCount > 0, `${x.label} has no ads and should not be summarised`);
    assert.ok(x.text, `${x.label} has no summary sentence`);
  }
  for (const a of snap.absent || []) {
    // Never "they don't advertise this" — always what OUR capture saw.
    assert.doesNotMatch(a.text, /does not advertise|no longer/i,
      `absence stated as a product fact: ${a.text}`);
  }
});

test("local and national conclusions never merge into one claim", () => {
  const t = BOARD.primaryRead.localVsNational;
  if (!t) return;
  // "The market is moving toward bonuses" is the sentence to prevent: a
  // national's ads may never have served in this client's market.
  assert.doesNotMatch(t, /\bthe market is\b|\bthe industry is\b|\bmoving toward\b|\btrend\b/i,
    `a market-wide claim was made from reference data: ${t}`);
  if (/national/i.test(t)) {
    assert.match(t, /not as evidence of this local market|shown for context/i,
      "national behaviour must be attributed as reference, not local evidence");
  }
});

test("every finding carries a stable id its evidence can be cited by", () => {
  const ids = BOARD.findings.map((f) => f.id);
  for (const id of ids) assert.match(id, /^[a-z_]+$/, `unusable finding id: ${id}`);
  assert.equal(ids.length, new Set(ids).size, "finding ids must be unique on a board");
  assert.ok(ids.includes("rate_advantage_apy") || ids.includes("rate_position_apy"),
    `expected a stable id on the primary-rate finding, got: ${ids.join(", ")}`);
});

test("month-over-month change is surfaced in the read when it exists", () => {
  const board = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: ["a", "b", "c"].map((k) => ({
      label: `Comp ${k.toUpperCase()}`, domain: `${k}.org`, ads: [chk(`${k}.org`, `Comp ${k.toUpperCase()}`, {
        headlines: ["Checking"], description: "Earn $600 with checking.",
        economicFacts: [{ metric: "cash_bonus", raw: "$600", qualifiers: {}, sourceField: "description" }],
      })],
    })),
    product: "checking",
    progress: Object.fromEntries(["lacapfcu.org", "a.org", "b.org", "c.org"].map((d) => [d, { listed: 1, read: 1 }])),
    previous: {
      label: "July 2026",
      competitorSet: { hash: "x", domains: ["a.org", "b.org", "c.org"] },
      brands: [{ domain: "a.org", label: "Comp A", positions: {} },
               { domain: "b.org", label: "Comp B", positions: {} },
               { domain: "c.org", label: "Comp C", positions: {} }],
    },
  });
  assert.ok(board.primaryRead.changes.length, "a newly observed offer must reach the read");
  for (const c of board.primaryRead.changes) {
    assert.ok(c.id, "a change must cite the finding it came from");
    assert.doesNotMatch(c.text, /newly launched|started offering/i,
      "newly OBSERVED is not newly launched");
  }
});

test("below three readable competitors there is no read at all", () => {
  const thin = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: [{ label: "Campus Federal", domain: "campusfederal.org", ads: [chk("campusfederal.org", "Campus Federal", {
      headlines: ["Lagniappe"], description: "Earn 4.50% APY.",
      economicFacts: [{ metric: "apy", raw: "4.50% APY", qualifiers: {}, sourceField: "description" }],
    })] }],
    product: "checking",
    progress: { "lacapfcu.org": { listed: 1, read: 1 }, "campusfederal.org": { listed: 1, read: 1 } },
  });
  assert.equal(thin.primaryRead, null, "two brands is a comparison, not a read");
});

// ===========================================================================
console.log("\nSTAGE 7 — the board reads at a glance");
// ===========================================================================

test("every finding declares the population it was counted over", () => {
  for (const f of BOARD.findings) {
    assert.ok(["regional", "national"].includes(f.scope), `${f.rule} has no scope`);
  }
});

test("a regional denominator never grows past the local set", () => {
  const local = BOARD.brands.filter((b) => !b.isClient && (b.tier || "local") !== "national" && b.hasCoverage).length;
  for (const f of BOARD.findings.filter((x) => x.scope === "regional")) {
    if (Number.isFinite(Number(f.denominator))) {
      assert.ok(Number(f.denominator) <= local + 1, `${f.rule} counted beyond the local set`);
    }
  }
});

test("a national finding names its population and carries its caveat", () => {
  // Excluding nationals from the COUNT was never a reason to hide them from the
  // PAGE. Both nationals leading on a bonus the client does not advertise is
  // real, and a scoreboard reading zero while that is true is its own wrong
  // answer. But a reader who misses that it is national reads it as a local
  // competitor, so the sentence says so and the caveat travels with the card.
  const board = buildBoard({
    client: { label: "La Capitol FCU", domain: "lacapfcu.org", ads: [chk("lacapfcu.org", "La Capitol FCU", {
      headlines: ["Checking"], description: "Earn 6.50% APY.",
      economicFacts: [{ metric: "apy", raw: "6.50% APY*", qualifiers: {}, sourceField: "headline" }],
    })] },
    competitors: [
      { label: "Comp A", domain: "a.org", tier: "local", ads: [chk("a.org", "Comp A", {
        headlines: ["Checking"], description: "Earn 4.00% APY.",
        economicFacts: [{ metric: "apy", raw: "4.00% APY", qualifiers: {}, sourceField: "description" }],
      })] },
      { label: "Chase", domain: "chase.com", tier: "national", ads: [chk("chase.com", "Chase", {
        headlines: ["Checking"], description: "Earn a $3,000 bonus.",
        economicFacts: [{ metric: "cash_bonus", raw: "$3,000", qualifiers: {}, sourceField: "description" }],
      })] },
      { label: "Capital One", domain: "capitalone.com", tier: "national", ads: [chk("capitalone.com", "Capital One", {
        headlines: ["Checking"], description: "Earn a $500 bonus.",
        economicFacts: [{ metric: "cash_bonus", raw: "$500", qualifiers: {}, sourceField: "description" }],
      })] },
    ],
    product: "checking",
    progress: Object.fromEntries(["lacapfcu.org", "a.org", "chase.com", "capitalone.com"]
      .map((d) => [d, { listed: 1, read: 1 }])),
  });
  const nat = board.findings.find((f) => f.scope === "national");
  assert.ok(nat, "both nationals advertise a bonus the client does not — that must reach the page");
  assert.match(nat.headline, /national reference advertiser/i, "the sentence must name the population");
  assert.match(nat.detail, /whether it served in this market/i, "the caveat must travel with the card");
  assert.equal(nat.denominator, 2, "a national finding counts nationals, never locals");
  // And the local counts are untouched by it.
  for (const f of board.findings.filter((x) => x.scope === "regional")) {
    assert.ok(Number(f.denominator) <= 2, `${f.rule} absorbed a national into its denominator`);
  }
});

test("every advertiser in the summary is clickable, figures or not", () => {
  // "Baton Rouge Telco — 1 credit card ad, no figure printed" is exactly the row
  // a strategist wants to open: "no figure" is a claim about their advertising,
  // and the ad is the only thing that settles it.
  for (const sum of BOARD.snapshot.summaries) {
    assert.ok(sum.evidence?.length, `${sum.label} has no way to see its ads`);
  }
});

test("every finding carries a short subject chip", () => {
  for (const f of BOARD.findings) {
    assert.ok(f.chip, `${f.rule} has no chip`);
    assert.ok(f.chip.split(/\s+/).length <= 3, `chip too long to scan: "${f.chip}"`);
  }
});

test("a metric finding's chip matches its snapshot column header", () => {
  const withMetric = BOARD.findings.filter((f) => f.metric);
  assert.ok(withMetric.length, "expected at least one metric finding");
  for (const f of withMetric) {
    const col = BOARD.snapshot.columns.find((c) => c.metric === f.metric);
    if (col) assert.equal(f.chip, col.label, `card says "${f.chip}", table says "${col.label}"`);
  }
});

test("an absent cell states an observation, never a product fact", () => {
  for (const row of BOARD.snapshot.rows) {
    for (const cell of row.cells.filter((c) => c.absent)) {
      assert.doesNotMatch(cell.value, /^no (bonus|fee|minimum|apy)/i,
        `"${cell.value}" claims a product fact the capture cannot support`);
      assert.notEqual(cell.value, "—", "an em-dash reads as nothing rather than as an observation");
    }
  }
});

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
