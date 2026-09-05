// Paths are resolved from this file, not from the container that wrote it.
// The handover offers these as runnable evidence; hardcoded absolute paths
// made them runnable in exactly one place, which is the opposite of evidence.
const ROOT = new URL("../../", import.meta.url).href;
const load = (m) => import(ROOT + "lib/" + m);
const { shapeSearch } = await load("extract-search.js");
const { normalizeObservation } = await load("observations.js");
const { buildBoard } = await load("benchmark.js");
let n = 0;
const chk = (domain, label, json) => normalizeObservation(shapeSearch({
  advertiser: label, displayUrl: `${domain}/`, callouts: [], unclassified: [],
  urgency: { present: false, phrase: "" }, product: "checking", productConfidence: 0.9,
  truncated: false, legible: true, ...json,
}, { creativeId: `CR_${++n}`, domain, advertiser: label, imageUrl: "x", format: "text",
     firstShown: "2026-06-03", lastShown: "2026-08-30", totalDaysShown: 88 }));
const bonusAd = (d, l, a) => chk(d, l, {
  headlines: [`Earn ${a}`], description: `Open checking and earn ${a}. No monthly fee.`,
  economicFacts: [{ metric: "cash_bonus", raw: a, qualifiers: {}, sourceField: "headline" }],
  claims: [{ claim: "no_monthly_fee", verbatim: "No monthly fee", sourceField: "description" }],
  leadEmphasis: "bonus",
});
const board = buildBoard({
  client: { label: "Client CU", domain: "client.org", ads: [chk("client.org", "Client CU", {
    headlines: ["Client Checking", "3.00% APY"], description: "Earn 3.00% APY on Choice Checking.",
    economicFacts: [{ metric: "apy", raw: "3.00% APY", qualifiers: {}, sourceField: "headline" }],
    claims: [], leadEmphasis: "rate" })] },
  competitors: [
    { label: "Readable A", domain: "a.org", ads: [bonusAd("a.org", "Readable A", "$500")] },
    { label: "Readable B", domain: "b.org", ads: [bonusAd("b.org", "Readable B", "$400")] },
    { label: "Readable C", domain: "c.org", ads: [bonusAd("c.org", "Readable C", "$300")] },
    { label: "Dark One", domain: "dark1.org", ads: [] },
    { label: "Dark Two", domain: "dark2.org", ads: [] },
    { label: "J.P. Morgan Chase", domain: "chase.com", tier: "national", ads: [bonusAd("chase.com", "J.P. Morgan Chase", "$900")] },
    { label: "Capital One", domain: "capitalone.com", tier: "national", ads: [bonusAd("capitalone.com", "Capital One", "$800")] },
  ],
  product: "checking",
  progress: { "client.org": {listed:1,read:1}, "a.org": {listed:1,read:1}, "b.org": {listed:1,read:1},
    "c.org": {listed:1,read:1}, "dark1.org": {listed:0,read:0}, "dark2.org": {listed:0,read:0},
    "chase.com": {listed:400,read:1}, "capitalone.com": {listed:300,read:1} },
});
console.log(JSON.stringify(board.primaryRead, null, 2));
