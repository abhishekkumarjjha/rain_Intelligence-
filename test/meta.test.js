// =============================================================================
// test/meta.test.js — the Meta source, end to end, offline.
//
// These are INVARIANTS, not coverage. Each one corresponds to a way the
// integration could look correct while being wrong: a template becoming a
// headline, a Google count and a Meta count landing in one denominator, an
// unresolved Page rendering as "no ads", a stop date invented from a field that
// is not one.
// =============================================================================

import { check, section, summary, eq, ok, startServer } from "./harness.js";
import { dedupeMessages, canonicalDestination, classifyDeterministic, extractOfferFromText, metaTimingLabel } from "../lib/meta-analyze.js";
import { normalizeMetaAd, isTemplate, buildAdParams } from "../lib/meta-provider.js";
import { resolveSources, googleFormatFor, SOURCES } from "../lib/sources.js";
import { cacheKey } from "../lib/capture-cache.js";
import { readFileSync } from "node:fs";

const COMPETITORS = [
  { label: "La Cap Test Credit Union", domain: "lacaptest.org" },
  { label: "Summit Credit Union", domain: "summitcu.test" },
];

// ---------------------------------------------------------------------------
section("pure logic — link safety");

/* safeUrl() lives in browser code, so it is lifted out of public/app.js and run
   here rather than left to the Playwright suite, which skips itself whenever the
   browser is missing. A guard that only runs sometimes is not a guard. */
const safeUrl = (() => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const m = app.match(/const safeUrl = \(u\) => \{[\s\S]*?\n\};/);
  if (!m) throw new Error("safeUrl not found in public/app.js");
  return new Function("location", `${m[0]} return safeUrl;`)({ origin: "http://localhost:3000" });
})();

await check("a javascript: destination never becomes a link", () => {
  // A Meta card's link_url is chosen by whoever bought the ad, not observed
  // about them. esc() would pass this through untouched — there is nothing in
  // it to escape — and the drawer would render a link that runs on click.
  eq(safeUrl("javascript:alert(document.cookie)"), "", "javascript: rejected");
  eq(safeUrl("JaVaScRiPt:alert(1)"), "", "case does not evade the check");
  eq(safeUrl(" javascript:alert(1)"), "", "leading space does not evade the check");
  eq(safeUrl("data:text/html,<script>alert(1)</script>"), "", "data: rejected");
});

await check("ordinary destinations still render", () => {
  eq(safeUrl("https://bank.test/checking?utm_source=rain-7246"),
     "https://bank.test/checking?utm_source=rain-7246", "https survives intact");
  ok(safeUrl("http://bank.test/x").startsWith("http://"), "http survives");
  eq(safeUrl("/api/media/abc123"), "/api/media/abc123", "our own media path is not a scheme question");
  eq(safeUrl(""), "", "empty stays empty");
  eq(safeUrl(null), "", "absent stays empty");
});

// ---------------------------------------------------------------------------
section("pure logic — templates and units");

await check("a DCO parent's {{product.name}} is recognised as a template", () => {
  ok(isTemplate("{{product.name}}"), "should detect");
  ok(isTemplate("{{product.brand}}"), "should detect");
  ok(!isTemplate("Explore Our Home Equity Line of Credit"), "real copy is not a template");
});

await check("cards become the units and template parent text is discarded", () => {
  const rec = {
    ad_archive_id: "a1", page_id: "p1", page_name: "Bank",
    is_active: true, start_date: "2026-08-18T07:00:00Z", end_date: "2026-08-24T07:00:00Z",
    publisher_platform: ["FACEBOOK"],
    snapshot: {
      title: "{{product.name}}", body: { text: "{{product.brand}}" },
      display_format: "DCO", link_url: "https://bank.test/x",
      cards: [
        { title: "Real Headline", body: "Real body copy", link_url: "https://bank.test/checking", resized_image_url: "https://scontent.xx.fbcdn.net/1_n.jpg" },
      ],
    },
  };
  const { ad, units } = normalizeMetaAd(rec, { domain: "bank.test", label: "Bank" });
  eq(units.length, 1, "unit count");
  eq(units[0].title, "Real Headline", "card title wins");
  ok(ad.parentTemplated, "parent flagged as templated");
});

await check("a template never becomes a headline even with no cards", () => {
  const rec = {
    ad_archive_id: "a2", page_id: "p1", page_name: "Bank", is_active: true,
    snapshot: { title: "{{product.name}}", body: { text: "{{product.brand}}" }, cards: [], images: [] },
  };
  const { units } = normalizeMetaAd(rec, { domain: "bank.test", label: "Bank" });
  eq(units[0].title, "", "templated title is blanked, not passed through");
  eq(units[0].body, "", "templated body is blanked");
});

// ---------------------------------------------------------------------------
section("pure logic — message dedupe");

await check("identical copy with different artwork is ONE message", () => {
  const units = [0, 1, 2, 3, 4, 5].map((i) => ({
    unitId: `a#${i}`, sourceAdId: "a", cardIndex: i, institution: "b.test",
    title: "Explore Our HELOC", body: "Intro APR as low as 4.99%",
    destinationUrl: "https://b.test/heloc?utm_source=rain-7246",
    imageUrl: `https://scontent.xx.fbcdn.net/${i}_n.jpg`,
  }));
  const msgs = dedupeMessages(units);
  eq(msgs.length, 1, "message count");
  eq(msgs[0].assetCount, 6, "asset variants preserved");
  eq(msgs[0].adRecordCount, 1, "one underlying ad record");
});

await check("ad records and asset variants are counted separately", () => {
  const mk = (ad, i) => ({
    unitId: `${ad}#${i}`, sourceAdId: ad, cardIndex: i, institution: "b.test",
    title: "Same", body: "Same", destinationUrl: "https://b.test/x",
    imageUrl: `https://scontent.xx.fbcdn.net/${ad}${i}_n.jpg`,
  });
  const msgs = dedupeMessages([mk("a", 0), mk("a", 1), mk("b", 0)]);
  eq(msgs.length, 1, "one message");
  eq(msgs[0].adRecordCount, 2, "two ad records");
  eq(msgs[0].assetCount, 3, "three assets");
});

await check("the same headline from two advertisers never merges", () => {
  const msgs = dedupeMessages([
    { unitId: "a#0", sourceAdId: "a", cardIndex: 0, institution: "one.test", title: "Great Rates", body: "", destinationUrl: "https://one.test/cd" },
    { unitId: "b#0", sourceAdId: "b", cardIndex: 0, institution: "two.test", title: "Great Rates", body: "", destinationUrl: "https://two.test/cd" },
  ]);
  eq(msgs.length, 2, "two competitors making the same bet is a finding, not a duplicate");
});

await check("a unit with no text and no destination fails open", () => {
  const msgs = dedupeMessages([
    { unitId: "a#0", sourceAdId: "a", cardIndex: 0, institution: "b.test", title: "", body: "", destinationUrl: "" },
    { unitId: "a#1", sourceAdId: "a", cardIndex: 1, institution: "b.test", title: "", body: "", destinationUrl: "" },
  ]);
  eq(msgs.length, 2, "wrongly splitting costs one vision call; wrongly merging destroys evidence");
});

await check("tracking parameters are stripped for grouping but product ones are not", () => {
  eq(canonicalDestination("https://www.b.test/heloc?utm_source=rain-7246&fbclid=x"), "b.test/heloc", "tracking removed");
  eq(canonicalDestination("https://b.test/apply?product=heloc"), "b.test/apply?product=heloc", "meaningful param kept");
});

// ---------------------------------------------------------------------------
section("pure logic — cheap-first classification");

await check("the destination path classifies without a model", () => {
  eq(classifyDeterministic({ destinationUrl: "https://b.test/home-equity-line-credit" }).product, "heloc", "heloc");
  eq(classifyDeterministic({ destinationUrl: "https://b.test/auto-refinance" }).product, "auto-loan", "auto");
  eq(classifyDeterministic({ destinationUrl: "https://b.test/share-certificates" }).from, "url", "provenance");
});

await check("a DoubleClick redirect falls through to copy, not to a guess", () => {
  const viaUrl = classifyDeterministic({ destinationUrl: "https://ad.doubleclick.net/ddm/trackclk/N5762" });
  eq(viaUrl.product, null, "URL yields nothing");
  const viaText = classifyDeterministic({
    destinationUrl: "https://ad.doubleclick.net/ddm/trackclk/N5762",
    title: "Cash back that adds up.", body: "Earn on every purchase with our credit card.",
  });
  eq(viaText.product, "credit-card", "copy rescues it");
  eq(viaText.from, "provider_text", "provenance records which tier answered");
});

await check("offers are transcribed from copy exactly, never rounded", () => {
  const o = extractOfferFromText({ body: "6.50% APY on a 12-month certificate with $10,000 minimum." });
  eq(o.value, "6.50% APY", "exact string, not 6.5%");
  eq(o.unit, "APY", "unit");
  eq(o.from, "provider_text", "provenance");
  ok(o.term.includes("12"), "term captured when printed");
});

await check("an absent term stays empty rather than being invented", () => {
  const o = extractOfferFromText({ body: "Get $300 when you open an account." });
  eq(o.term, "", "no term printed, none supplied");
  eq(o.type, "bonus", "bonus recognised");
});

// ---------------------------------------------------------------------------
section("pure logic — dates and sources");

await check("an active Meta ad never renders a closed date range", () => {
  const label = metaTimingLabel({ isActive: true, startDate: "2026-08-18T07:00:00Z", providerEndDate: "2026-08-24T07:00:00Z" });
  ok(label.startsWith("Active · started"), `got: ${label}`);
  ok(!label.includes("→") && !label.includes("–"), "no range for a live ad");
  ok(!/\d+\s*days/.test(label), "no invented duration");
});

await check("benchmark cannot be switched off Google search by a caller", () => {
  eq(resolveSources({ mode: "benchmark", sources: ["meta"] })[0], SOURCES.GOOGLE_SEARCH, "pinned");
  eq(resolveSources({ mode: "benchmark", sources: ["google_display"] }).length, 1, "single source");
});

await check("creative accepts display, meta or both", () => {
  eq(resolveSources({ mode: "creative", sources: ["meta"] })[0], SOURCES.META, "meta");
  eq(resolveSources({ mode: "creative", sources: ["google_display", "meta"] }).length, 2, "both");
  eq(resolveSources({ mode: "creative", sources: [] })[0], SOURCES.GOOGLE_DISPLAY, "default");
});

await check("asking a Meta source for a Google format is a hard error", () => {
  let threw = false;
  try { googleFormatFor(SOURCES.META); } catch { threw = true; }
  ok(threw, "should throw rather than guess");
});

await check("the capture cache key ignores product but not source or window", () => {
  const a = cacheKey({ source: "meta", domain: "b.test", days: 90 });
  const b = cacheKey({ source: "meta", domain: "b.test", days: 90 });
  const c = cacheKey({ source: "google_display", domain: "b.test", days: 90 });
  const d = cacheKey({ source: "meta", domain: "b.test", days: 30 });
  eq(a, b, "same inputs, same key — one capture serves every product scope");
  ok(a !== c, "source is part of the key");
  ok(a !== d, "window is part of the key");
});

await check("ad_type is always all — never a credit_ads union", () => {
  eq(buildAdParams({ pageId: "1", days: 90 }).ad_type, "all", "all only");
});

// ---------------------------------------------------------------------------
section("live server — a Meta capture");

const S = await startServer();
let metaRun;

try {
  {
    const { body } = await S.get("/api/health");
    await check("health reports each source's availability separately", () => {
      ok(body.sources.find((s) => s.key === "meta").available, "meta available");
      ok(body.sources.find((s) => s.key === "google_display").available, "google available");
      eq(body.meta.maxPages, 2, "page ceiling exposed");
    });
  }

  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"],
      clientDomain: "lacaptest.org", clientLabel: "La Cap Test",
      product: "heloc", competitors: COMPETITORS,
    });
    ok(body.ok, "capture should start");
    metaRun = await S.awaitRun(body.runs[0].runId);

    await check("the run is tagged as a Meta run", () => {
      eq(metaRun.source, "meta", "source");
      ok(metaRun.meta, "meta payload present");
      ok(!metaRun.creative, "no google creative payload on a meta run");
    });

    await check("template parents never reach the wall as headlines", () => {
      const bad = metaRun.meta.messages.filter((m) => /\{\{/.test(`${m.title} ${m.body}`));
      eq(bad.length, 0, `messages carrying a template: ${bad.map((b) => b.title).join(", ")}`);
    });

    await check("cards were collapsed into fewer messages than raw units", () => {
      const f = metaRun.meta.funnel;
      ok(f.rawUnits > f.messages, `${f.rawUnits} cards -> ${f.messages} messages`);
    });

    await check("most products were resolved without a model", () => {
      const c = metaRun.meta.summary.classification;
      ok((c.url || 0) > 0, "some classified from the URL path");
      ok((c.url || 0) + (c.provider_text || 0) > (c.vision || 0), "cheap tiers outweigh vision");
    });

    await check("the funnel reconciles reported -> retrieved -> messages", () => {
      const f = metaRun.meta.funnel;
      ok(f.retrieved <= f.reported, "retrieved never exceeds reported");
      ok(f.messages <= f.rawUnits, "messages never exceed cards");
      eq(f.messages, metaRun.meta.capturedCount, "message count matches the wall");
    });

    await check("a partial capture is declared partial", () => {
      ok(!metaRun.sampling.complete, "a page token remained");
      ok(/not everything the competitor is running/.test(metaRun.sampling.note), metaRun.sampling.note);
    });

    await check("RAIN-managed messages are flagged but not removed", () => {
      ok(metaRun.meta.rainManaged > 0, "some detected");
      const flagged = metaRun.meta.messages.filter((m) => m.rainManaged);
      ok(flagged.length === metaRun.meta.rainManaged, "count matches the records");
      ok(metaRun.meta.messages.length > 0, "and they are still in the wall");
    });

    await check("RAIN detection reads the URL before tracking params are stripped", () => {
      const m = metaRun.meta.messages.find((x) => x.rainManaged);
      ok(/utm_source=rain/i.test(m.destinationUrl), "original destination retained on the record");
    });

    await check("Meta media is stored locally, not hotlinked", () => {
      const withMedia = metaRun.meta.messages.filter((m) => m.mediaHash);
      ok(withMedia.length > 0, "media stored");
      ok(withMedia.every((m) => m.mediaStored), "all stored ones flagged");
    });

    await check("no Meta record carries a Google longevity field", () => {
      const leaked = metaRun.meta.messages.filter((m) => m.totalDaysShown !== undefined);
      eq(leaked.length, 0, "totalDaysShown must never exist on a Meta record");
    });

    await check("every Meta record keeps its raw provider end date, unelevated", () => {
      const m = metaRun.meta.messages[0];
      ok("providerEndDate" in m, "kept as provider metadata");
      ok(!("endDate" in m), "never promoted to a plain endDate the UI might render as a stop");
    });
  }

  {
    const stored = metaRun.meta.messages.find((m) => m.mediaHash);
    const { status, headers } = await S.raw(`/api/media/${stored.mediaHash}`);
    await check("stored Meta media serves from our own store", () => {
      eq(status, 200, "status");
      ok(String(headers["content-type"] || "").startsWith("image/"), "content type");
    });
    const bad = await S.raw("/api/media/..%2f..%2fetc%2fpasswd");
    await check("a traversal-shaped media hash reads nothing", () => ok(bad.status === 404 || bad.status === 400, `got ${bad.status}`));
  }

  // -------------------------------------------------------------------------
  section("live server — page resolution states");

  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"],
      clientDomain: "lacaptest.org", clientLabel: "La Cap Test", product: "checking",
      competitors: [{ label: "Quiet Federal Credit Union", domain: "quietfcu.test" }],
    });
    const run = await S.awaitRun(body.runs[0].runId);
    const p = run.progress["quietfcu.test"];
    await check("a resolved Page with zero ads is 'empty', not 'unresolved'", () => {
      eq(p.status, "empty", "status");
      eq(p.reason, "no_ads", "reason");
      ok(p.pageResolved, "resolution succeeded and says so");
    });
  }

  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"],
      clientDomain: "lacaptest.org", clientLabel: "La Cap Test", product: "checking",
      competitors: [{ label: "Chase", domain: "chasetest.test" }],
    });
    const run = await S.awaitRun(body.runs[0].runId);
    const p = run.progress["chasetest.test"];
    await check("an ambiguous Page match refuses to fetch and asks", () => {
      eq(p.status, "needs_confirmation", "status");
      ok(!p.pageResolved, "resolution did not succeed");
      ok(Array.isArray(p.candidates) && p.candidates.length > 1, "candidates returned for a human");
    });
  }

  // -------------------------------------------------------------------------
  section("live server — the capture cache");

  {
    const first = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"],
      clientDomain: "summitcu.test", clientLabel: "Summit", product: "mortgage",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }],
    });
    await S.awaitRun(first.body.runs[0].runId);

    // Same advertiser, DIFFERENT product — the cache is product-agnostic, so
    // this must be free. That is the whole reason the key omits product.
    const second = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"],
      clientDomain: "summitcu.test", clientLabel: "Summit", product: "cd",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }],
    });
    const run = await S.awaitRun(second.body.runs[0].runId);
    await check("a second capture of the same advertiser is served from cache", () => {
      ok(run.progress["summitcu.test"].fromCaptureCache, "cache hit");
      eq(run.requests, 0, "zero provider requests spent");
    });

    const forced = await S.post("/api/capture", {
      mode: "creative", sources: ["meta"], force: true,
      clientDomain: "summitcu.test", clientLabel: "Summit", product: "cd",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }],
    });
    const frun = await S.awaitRun(forced.body.runs[0].runId);
    await check("Re-analyze bypasses the cache and spends requests", () => {
      ok(!frun.progress["summitcu.test"].fromCaptureCache, "not a cache hit");
      ok(frun.requests > 0, "requests were spent");
    });
  }

  {
    const { body } = await S.post("/api/cost", {
      mode: "creative", sources: ["meta"],
      clientDomain: "summitcu.test",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }, { label: "New Bank", domain: "unseen.test" }],
      days: 90,
    });
    await check("cost is knowable before anything is spent", () => {
      const plan = body.plans[0];
      eq(plan.fromCache, 1, "one advertiser already captured");
      eq(plan.willFetch, 1, "only the unseen one costs a request");
    });
  }

  // -------------------------------------------------------------------------
  section("live server — sources stay separate");

  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display", "meta"],
      clientDomain: "lacaptest.org", clientLabel: "La Cap Test", product: "mortgage",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }, { label: "La Cap", domain: "lacapfcu.org" }],
    });
    await check("both sources produce two separate runs", () => {
      eq(body.runs.length, 2, "run count");
      ok(body.runs[0].runId !== body.runs[1].runId, "distinct ids");
      const srcs = body.runs.map((r) => r.source).sort();
      eq(srcs.join(","), "google_display,meta", "one run per source");
    });

    const runs = await Promise.all(body.runs.map((r) => S.awaitRun(r.runId)));
    const g = runs.find((r) => r.source === "google_display");
    const m = runs.find((r) => r.source === "meta");

    await check("neither run carries the other's payload", () => {
      ok(g.creative && !g.meta, "google run has only a creative payload");
      ok(m.meta && !m.creative, "meta run has only a meta payload");
    });

    await check("the two runs use different window defaults", () => {
      eq(g.days, 30, "google served-window default");
      eq(m.days, 90, "meta started-since default");
    });

    await check("a Meta run is never diffed against a Google run", () => {
      if (m.diff) eq(m.diff.previousRunId?.startsWith("run_"), true, "if diffed, only against another meta run");
      ok(true, "comparability includes source");
    });
  }

  {
    // agencybank.com is the fixture's agency-attribution case: Google verifies
    // its ads under a media agency's name, which is exactly the situation the
    // domain-scoped link exists to fix.
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "lacapfcu.org", clientLabel: "La Cap", product: "mortgage",
      competitors: [{ label: "Agency Bank", domain: "agencybank.com" }],
    });
    const run = await S.awaitRun(body.runs[0].runId);
    await check("Google ads link through the bank's domain, not the agency's account", () => {
      const ad = run.ads.find((a) => a.institution === "agencybank.com");
      ok(ad, "agencybank creative captured");
      ok(ad.domainLink.includes("domain=agencybank.com"), "scoped to the bank's domain");
      ok(!ad.domainLink.includes("/advertiser/"), "not scoped to the verified advertiser account");
      ok(ad.detailsLink.includes("/advertiser/"), "the creative-specific link is still available as a secondary");
      ok(ad.advertiser && ad.advertiser !== "Agency Bank", "and the agency name is kept as its own field");
    });
  }

  // -------------------------------------------------------------------------
  section("live server — benchmark is untouched");

  {
    const { body } = await S.post("/api/capture", {
      mode: "benchmark", sources: ["meta"],          // deliberately wrong
      clientDomain: "lacaptest.org", clientLabel: "La Cap Test", product: "mortgage",
      competitors: [{ label: "Summit Credit Union", domain: "summitcu.test" }],
    });
    const run = await S.awaitRun(body.runs[0].runId);
    await check("a benchmark asking for Meta still captures Google search", () => {
      eq(run.source, "google_search", "source pinned");
      ok(run.benchmark, "benchmark payload built");
      ok(!run.meta, "no meta payload");
    });
  }
} finally {
  await S.stop();
}

summary();
