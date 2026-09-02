// Pure-logic smoke test. No key, no network.
import assert from "node:assert";
import { buildListingParams, selectForReading, epochToDate } from "../lib/atc-provider.js";
import { clusterAds, buildBenchmark, samplingNote } from "../lib/analyze.js";
import { productFromUrl, normalizeProduct } from "../lib/products.js";
import { buildBoard } from "../lib/benchmark.js";

let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  " + name); };

// --- provider params -------------------------------------------------------
t("image capture omits platform (there is no DISPLAY value)", () => {
  const p = buildListingParams("lacapfcu.org", { format: "image" });
  assert.equal(p.creative_format, "image");
  assert.equal(p.platform, undefined);
  assert.equal(p.num, 100);
  assert.match(p.start_date, /^\d{8}$/);
});
t("text capture pins platform=SEARCH", () => {
  assert.equal(buildListingParams("x.com", { format: "text" }).platform, "SEARCH");
});
t("epoch converts", () => assert.equal(epochToDate(1685948400), "2023-06-05"));

// --- selection -------------------------------------------------------------
t("selection prefers fresh, breaks ties on longevity", () => {
  const today = new Date().toISOString().slice(0,10);
  const old = "2024-01-01";
  const picked = selectForReading([
    { creativeId: "a", lastShown: old,   totalDaysShown: 1169 },
    { creativeId: "b", lastShown: today, totalDaysShown: 30 },
    { creativeId: "c", lastShown: today, totalDaysShown: 900 },
  ], 3);
  assert.deepEqual(picked.map(x => x.creativeId), ["c", "b", "a"]);
});

// --- clustering ------------------------------------------------------------
t("same headline+offer collapses into one idea", () => {
  const mk = (id, hl, days) => ({ creativeId: id, headline: hl, product: "auto-loan",
    offer: { value: "4.59% APR" }, totalDaysShown: days, width: 300, height: 250 });
  const c = clusterAds([mk("1","Refinance Your Auto Loan",100), mk("2","refinance your auto loan!",900), mk("3","Different Idea",50)]);
  assert.equal(c.length, 2);
  assert.equal(c[0].variations, 2);
  assert.equal(c[0].creativeId, "2", "representative is the longest-running member");
});

// --- benchmark -------------------------------------------------------------
//
// The table is now a VIEW over the board's rollup rather than a second
// aggregation of its own, so these fixtures carry rawEconomicFacts and the
// board is built first. That is the point of the change: one canonical number,
// and no way to construct a table that disagrees with the findings above it.
const ad = (inst, over, days=100) => ({
  creativeId: inst + (over?.value || "n") + days, institution: inst, product: "checking",
  headline: "h",
  rawEconomicFacts: over ? [{ metric: "cash_bonus", raw: over.value, qualifiers: {}, sourceField: "headline" }] : [],
  rawClaims: [], allText: over ? `Earn a ${over.value} bonus` : "h",
  totalDaysShown: days, firstShown: "2025-01-01", lastShown: "2026-08-10",
});

const benchArgs = {
  client: { label: "Lookout", domain: "lookout.com", ads: [ad("lookout.com", null)] },
  competitors: [
    { label: "Comp A", domain: "a.com", ads: [ad("a.com", { type: "bonus", value: "$400" })] },
    { label: "Comp B", domain: "b.com", ads: [ad("b.com", { type: "bonus", value: "$300" }, 900)] },
  ],
  product: "checking",
};
const smokeBoard = buildBoard({ ...benchArgs, progress: {} });
const bench = buildBenchmark({
  ...benchArgs,
  runs: [{ complete: false, providerTotal: 2000, selectedForReading: 18 }],
  brands: smokeBoard.brands,
});

t("benchmark shows the client column first and marks it", () => {
  assert.equal(bench.columns[0].isClient, true);
  assert.equal(bench.columns.length, 3);
});
t("bonus row exists with an absent client cell", () => {
  const row = bench.rows.find(r => r.id === "offer_cash_bonus");
  assert.ok(row);
  assert.equal(row.cells[0].absent, true, "client did not advertise a bonus");
  assert.equal(row.cells[1].value, "$400");
});
t("missing terms downgrade comparability, and say so", () => {
  const row = bench.rows.find(r => r.id === "offer_cash_bonus");
  assert.equal(row.comparability.level, "advertised-only");
  assert.match(row.comparability.note, /not full product terms/);
});
t("the table carries no findings of its own", () => {
  // It used to compute a third set, over a DIFFERENT denominator: "1 of 6
  // competitors" counting nationals, beside a board saying "1 of 3" excluding
  // them. The board owns findings; this is the metric-by-metric audit trail.
  assert.equal(bench.findings, undefined);
});
t("longevity phrasing is days-shown, never 'continuously'", () => {
  const row = bench.rows.find(r => r.id === "longevity");
  assert.match(row.cells[2].detail, /shown on 900 days since/);
  assert.doesNotMatch(JSON.stringify(bench), /continuous|best.performing/i);
});
t("incomplete capture forbids market claims", () => {
  assert.equal(bench.sampling.complete, false);
  assert.match(bench.sampling.note, /not the whole market/);
});

// --- product ---------------------------------------------------------------
t("product from URL path", () => {
  assert.equal(productFromUrl("https://bank.com/personal/checking-accounts").product, "checking");
  assert.equal(productFromUrl("https://bank.com").from, "none");
});

// --- selection breadth -----------------------------------------------------
// The failure this guards, from a live capture: Chase's longest-running display
// work is evergreen card marketing, so a cap filled straight off the quality
// ranking returned only card creatives and reported that Chase runs no checking
// ads. Product is unknowable before the image is read, so launch cohort is the
// proxy — spread across campaigns, don't go deep into one.
t("the read cap spreads across campaigns instead of draining the longest-running one", () => {
  const evergreen = Array.from({ length: 20 }, (_, i) => ({
    creativeId: `ever_${i}`, firstShown: "2024-01-05", lastShown: "2026-08-26", totalDaysShown: 900 + i,
  }));
  const newer = Array.from({ length: 6 }, (_, i) => ({
    creativeId: `new_${i}`, firstShown: "2026-07-02", lastShown: "2026-08-26", totalDaysShown: 40 + i,
  }));

  const picked = selectForReading([...evergreen, ...newer], 8);
  assert.equal(picked.length, 8);
  const fromNewer = picked.filter((c) => c.creativeId.startsWith("new_")).length;
  // A straight top-N by longevity would take 8 evergreen and zero newer.
  assert.ok(fromNewer >= 3, `newer campaign should get slots, got ${fromNewer}`);
  assert.ok(picked.some((c) => c.creativeId.startsWith("ever_")), "the strongest campaign still gets slots");
});

t("a single-campaign advertiser is unaffected by the spread", () => {
  const one = Array.from({ length: 10 }, (_, i) => ({
    creativeId: `c_${i}`, firstShown: "2026-06-01", lastShown: "2026-08-26", totalDaysShown: 100 - i,
  }));
  const picked = selectForReading(one, 4);
  assert.equal(picked.length, 4);
  // One cohort means the quality ranking is the whole answer, as before.
  assert.deepEqual(picked.map((c) => c.creativeId), ["c_0", "c_1", "c_2", "c_3"]);
});

t("the cap still bites when there is more than it admits", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    creativeId: `c_${i}`, firstShown: `2026-0${(i % 6) + 1}-01`, lastShown: "2026-08-26", totalDaysShown: 100,
  }));
  assert.equal(selectForReading(many, 18).length, 18);
  // and never returns duplicates of the same creative
  const ids = selectForReading(many, 18).map((c) => c.creativeId);
  assert.equal(new Set(ids).size, 18);
});

console.log(`\n${n} passed`);
