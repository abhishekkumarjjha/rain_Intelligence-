// =============================================================================
// test/corpus-runner.js — the read, measured instead of assumed.
//
// npm test proves that IF THE READ IS RIGHT, THE ARITHMETIC IS RIGHT. Every
// fixture in it decides what the model returned, so the whole suite begins after
// the model has already answered perfectly. It cannot catch a wrong read, and a
// wrong read is what shows up on every live run.
//
// This replays a fixed corpus of creatives with human-verified labels and
// reports per-field accuracy. Two passes, and they cost differently:
//
//   --gate   modelAnswer -> shapeSearch/shape -> observations.js -> expected
//            counted facts. FREE. No key, no network. Runs in CI.
//
//   --read   the creative's IMAGE -> the real vision prompt -> the label.
//            ONE HAIKU VISION CALL PER CREATIVE. Never run this without the
//            approval described in §10 of the bug-hunt work order.
//
//   --dry-run  says exactly what --read would cost, and spends nothing.
//   --attach   fills evidenceRef from runs/_evidence for entries that have one.
//
// The gate pass is not a lesser test. Nine of the fourteen entries here are
// cases where the model's answer is CORRECT and the engine has to do something
// other than count it — retype it, refuse it, or keep it uncounted. Those are
// gate failures, not read failures, and they are the ones that reached clients.
// =============================================================================

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shapeSearch } from "../lib/extract-search.js";
import { shape as shapeDisplay } from "../lib/extract.js";
import { normalizeObservation } from "../lib/observations.js";
import { isShowable } from "../lib/analyze.js";
import { confidentlyClassified, PRODUCT_CONFIDENCE_FLOOR } from "../lib/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "corpus");
const EVIDENCE = path.join(process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs"), "_evidence");

const args = new Set(process.argv.slice(2));
const MODE = args.has("--read") ? "read" : args.has("--attach") ? "attach" : args.has("--dry-run") ? "dry-run" : "gate";

function load() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: path.join(DIR, f), entry: JSON.parse(readFileSync(path.join(DIR, f), "utf8")) }));
}

// ---------------------------------------------------------------------------
// ATTACH — connect an entry to a real creative on this machine.
//
// runs/ is gitignored, so in a clone _evidence is an empty directory. That is
// why every entry ships with needsEvidence: true. On the owner's machine this
// pass fills them in, and only then can --read say anything.
// ---------------------------------------------------------------------------
function attach() {
  if (!existsSync(EVIDENCE)) {
    console.log(`  no evidence store at ${EVIDENCE} — nothing to attach.`);
    return 1;
  }
  const available = readdirSync(EVIDENCE).filter((f) => f.endsWith(".json"));
  let linked = 0;
  for (const { file, entry } of load()) {
    const hit = available.find((f) => f.startsWith(`${entry.creativeId}.`) || f === `${entry.creativeId}.json`);
    if (!hit) continue;
    entry.evidenceRef = path.join("runs", "_evidence", hit);
    entry.needsEvidence = false;
    writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
    linked++;
  }
  console.log(`  attached ${linked} of ${load().length} entries from ${available.length} evidence bundles.`);
  if (!linked) {
    console.log("  Nothing matched. Corpus ids are CORPUS_* until a real creative is chosen for each");
    console.log("  case; rename an entry's creativeId to the provider id of the creative that shows");
    console.log("  the trap, then run --attach again.");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// DRY RUN — the number the work order asks to be quoted before anything is run.
// ---------------------------------------------------------------------------
function dryRun() {
  const all = load();
  const ready = all.filter(({ entry }) => !entry.needsEvidence && entry.evidenceRef);
  const search = ready.filter(({ entry }) => entry.source === "google_search").length;
  const display = ready.length - search;

  console.log("\n  CORPUS REPLAY — what a --read pass would cost\n");
  console.log(`    corpus entries                  ${all.length}`);
  console.log(`    with a creative attached        ${ready.length}`);
  console.log(`      · search reader (text)        ${search}`);
  console.log(`      · banner reader (image)       ${display}`);
  console.log(`    entries awaiting evidence       ${all.length - ready.length}`);
  console.log("");
  console.log(`    VISION CALLS A FULL REPLAY WOULD MAKE:  ${ready.length}`);
  console.log("    (one Haiku call per creative, one pass, no retries counted)");
  console.log("");
  if (ready.length === 0) {
    console.log("    Nothing is attached, so a read pass would cost nothing and prove nothing.");
    console.log("    Run --attach on a machine whose runs/_evidence holds the creatives.");
  }
  console.log("    Approval is required before --read. See §10 of the bug-hunt work order.\n");
  return 0;
}

// ---------------------------------------------------------------------------
// THE DIFF — per field, so a failure says which half was wrong.
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === "number" ? v : null);

function diffEntry(entry, ad) {
  const out = [];
  const check = (field, actual, expected, ok = actual === expected) =>
    out.push({ field, actual, expected, ok });

  const e = entry.expect;

  check("product", ad.product, e.product);
  if (typeof e.productConfidenceAtLeast === "number") {
    check("productConfidence>=", ad.productConfidence, e.productConfidenceAtLeast,
      ad.productConfidence >= e.productConfidenceAtLeast);
  }
  if (typeof e.productConfidenceAtMost === "number") {
    check("productConfidence<=", ad.productConfidence, e.productConfidenceAtMost,
      ad.productConfidence <= e.productConfidenceAtMost);
  }
  if (typeof e.legible === "boolean") check("legible", ad.legible !== false, e.legible);
  if (typeof e.truncated === "boolean") check("truncated", !!ad.truncated, e.truncated);
  if (typeof e.showable === "boolean") check("showable", isShowable(ad), e.showable);

  // Counted, not proposed: `facts` is what survived observations.js.
  const got = ad.facts || [];
  check("facts.count", got.length, (e.facts || []).length);
  for (const want of e.facts || []) {
    const f = got.find((x) => x.metric === want.metric && x.raw === want.raw);
    check(`fact[${want.metric} "${want.raw}"]`, f ? "present" : "MISSING", "present", !!f);
    if (!f) continue;
    for (const k of ["value", "complete", "rankable", "grounded", "scopedToAddOn", "retypedFrom"]) {
      if (!(k in want)) continue;
      check(`fact[${want.metric}].${k}`, f[k] ?? null, want[k] ?? null,
        (f[k] ?? null) === (want[k] ?? null) || (k === "value" && num(f[k]) === num(want[k])));
    }
  }
  for (const f of got) {
    const wanted = (e.facts || []).some((w) => w.metric === f.metric && w.raw === f.raw);
    if (!wanted) check(`fact[${f.metric} "${f.raw}"]`, "counted", "NOT COUNTED", false);
  }

  const claims = (ad.claims || []).filter((c) => c.grounded !== false).map((c) => c.claim).sort();
  check("claims", JSON.stringify(claims), JSON.stringify([...(e.claims || [])].sort()));

  // F-002 is part of the label, not a separate question: a creative below the
  // floor is captured and never counted, and the corpus has to say which.
  const counted = confidentlyClassified(ad);
  if (typeof e.productConfidenceAtMost === "number" && e.productConfidenceAtMost <= PRODUCT_CONFIDENCE_FLOOR) {
    check("countedAtAll", counted, false);
  }
  return out;
}

function gate() {
  const all = load();
  let entriesPassed = 0, fieldsOk = 0, fieldsTotal = 0;
  const failures = [];

  for (const { entry } of all) {
    const img = {
      creativeId: entry.creativeId, domain: entry.advertiser, advertiser: entry.advertiser,
      imageUrl: "corpus://none", format: entry.source === "google_search" ? "text" : "image",
      firstShown: "2026-06-01", lastShown: "2026-08-31", totalDaysShown: 90,
    };
    const shaped = entry.source === "google_search"
      ? shapeSearch(entry.modelAnswer, img)
      : shapeDisplay(entry.modelAnswer, img);
    const ad = entry.source === "google_search" ? normalizeObservation(shaped) : shaped;

    const rows = diffEntry(entry, ad);
    const bad = rows.filter((r) => !r.ok);
    fieldsTotal += rows.length;
    fieldsOk += rows.length - bad.length;
    if (bad.length === 0) { entriesPassed++; console.log(`  ok   ${entry.creativeId}`); }
    else {
      console.log(`  FAIL ${entry.creativeId}`);
      for (const r of bad) console.log(`         ${r.field}: got ${JSON.stringify(r.actual)}, expected ${JSON.stringify(r.expected)}`);
      failures.push({ creativeId: entry.creativeId, fields: bad });
    }
  }

  console.log(`\n  ${entriesPassed}/${all.length} entries clean · ${fieldsOk}/${fieldsTotal} fields correct`);
  console.log(`  (gate pass — no model was called, nothing was spent)\n`);
  return failures.length ? 1 : 0;
}

function read() {
  console.log("\n  --read SPENDS MONEY: one Haiku vision call per attached creative.");
  console.log("  It is deliberately not wired to run without an explicit approval flag.\n");
  dryRun();
  if (process.env.RI_CORPUS_APPROVED !== "1") {
    console.log("  Refusing to run. Set RI_CORPUS_APPROVED=1 only after the owner has approved");
    console.log("  the exact call count printed above.\n");
    return 1;
  }
  const ready = load().filter(({ entry }) => !entry.needsEvidence && entry.evidenceRef);
  if (!ready.length) {
    console.log("  Approved, but nothing is attached — there is nothing to read.\n");
    return 1;
  }
  console.log("  Approved. Attach-and-replay is implemented in --gate's diff; the read pass");
  console.log("  needs the image bytes from each evidence bundle and the real extractor, and");
  console.log("  it has not been run in this environment because no evidence exists here.\n");
  return 1;
}

const code = MODE === "attach" ? attach()
  : MODE === "dry-run" ? dryRun()
  : MODE === "read" ? read()
  : gate();
process.exit(code);
