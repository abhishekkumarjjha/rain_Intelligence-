// Pure-logic smoke test. No key, no network.
import assert from "node:assert";
import { buildListingParams, selectForReading, epochToDate } from "../lib/atc-provider.js";
import { clusterAds, buildBenchmark, samplingNote, countedFindings } from "../lib/analyze.js";
import { productFromUrl, normalizeProduct } from "../lib/products.js";

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
const ad = (inst, over, days=100) => ({
  creativeId: inst + (over?.value || "n") + days, institution: inst, product: "checking",
  headline: "h", offer: over ? { type: over.type, value: over.value, term: over.term || "",
    minimum: over.minimum || "", qualifier: "", numeric: { n: parseFloat(over.value.replace(/[^0-9.]/g,"")), kind: "usd" } } : null,
  totalDaysShown: days, firstShown: "2025-01-01", lastShown: "2026-08-10",
});

const bench = buildBenchmark({
  client: { label: "Lookout", domain: "lookout.com", ads: [ad("lookout.com", null)] },
  competitors: [
    { label: "Comp A", domain: "a.com", ads: [ad("a.com", { type: "bonus", value: "$400" })] },
    { label: "Comp B", domain: "b.com", ads: [ad("b.com", { type: "bonus", value: "$300" }, 900)] },
  ],
  product: "checking",
  runs: [{ complete: false, providerTotal: 2000, selectedForReading: 18 }],
});

t("benchmark shows the client column first and marks it", () => {
  assert.equal(bench.columns[0].isClient, true);
  assert.equal(bench.columns.length, 3);
});
t("bonus row exists with an absent client cell", () => {
  const row = bench.rows.find(r => r.id === "offer_bonus");
  assert.ok(row);
  assert.equal(row.cells[0].absent, true, "client did not advertise a bonus");
  assert.equal(row.cells[1].value, "$400");
});
t("missing terms downgrade comparability, and say so", () => {
  const row = bench.rows.find(r => r.id === "offer_bonus");
  assert.equal(row.comparability.level, "advertised-only");
  assert.match(row.comparability.note, /not full product terms/);
});
t("gap finding counts competitors, not ads", () => {
  const f = bench.findings.find(x => x.kind === "gap");
  assert.match(f.text, /2 of 2 competitors advertised a cash bonus/);
  assert.match(f.text, /Lookout did not/);
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

console.log(`\n${n} passed`);
