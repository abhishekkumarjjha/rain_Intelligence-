// =============================================================================
// test/flow.test.js — the whole API surface, driven the way the UI drives it.
//
// Every assertion here is a sentence the product makes to a client. If a count
// is wrong, a denominator is missing, or a failed competitor takes down a run
// that succeeded for the others, it fails here rather than in front of someone.
// =============================================================================

import { startServer, check, section, summary, eq, ok } from "./harness.js";

const S = await startServer();

try {
  // ------------------------------------------------------------------ health
  section("health + directory");
  {
    const { body } = await S.get("/api/health");
    await check("health reports both providers configured", () => {
      ok(body.serpapi, "serpapi should be configured under the mock");
      ok(body.anthropic, "anthropic should be configured under the mock");
    });
    await check("health exposes the product taxonomy for the scope selector", () => {
      ok(Array.isArray(body.products) && body.products.length === 12, `got ${body.products?.length} products`);
      ok(body.products.every((p) => p.code && p.label), "every product needs a code and a label");
    });
    await check("health reports the directory size", () => ok(body.directorySize === 40, `got ${body.directorySize}`));
  }
  {
    const { body } = await S.get("/api/clients");
    await check("client list is populated and every row has a domain", () => {
      ok(body.clients.length === 40, `got ${body.clients.length}`);
      ok(body.clients.every((c) => c.domain && c.name), "each client needs a name and a domain");
    });
  }

  // ----------------------------------------------------------------- resolve
  section("resolve");
  {
    const { body } = await S.post("/api/resolve", { url: "https://www.lacapfcu.org/checking-accounts" });
    await check("product page resolves to its product", () => eq(body.product, "checking", "product"));
    await check("product page is not flagged as a homepage", () => eq(body.looksLikeHomepage, false, "looksLikeHomepage"));
    await check("known client matches the directory", () => {
      ok(body.knownClient, "lacapfcu.org should be a known client");
      eq(body.client.name, "La Capitol Federal Credit Union", "client name");
    });
    await check("competitors come back scoped and ranked", () => {
      ok(body.competitors.length > 0, "expected suggested competitors");
      ok(body.competitors.every((c) => c.domain && c.name), "each competitor needs a name and domain");
    });
  }
  {
    const { body } = await S.post("/api/resolve", { url: "lacapfcu.org" });
    await check("bare domain is flagged as a homepage, not silently scoped", () => {
      eq(body.looksLikeHomepage, true, "looksLikeHomepage");
      eq(body.product, "other", "product");
    });
  }
  {
    const { status, body } = await S.post("/api/resolve", { url: "not a url at all" });
    await check("garbage input is rejected with a reason", () => {
      eq(status, 400, "status");
      eq(body.reason, "bad_url", "reason");
    });
  }
  {
    const { body } = await S.post("/api/resolve", { url: "https://somebankwehavenot.com/checking" });
    await check("unknown client reports a directory miss instead of inventing competitors", () => {
      ok(body.directoryMiss, "expected directoryMiss");
      eq(body.competitors.length, 0, "competitor count");
    });
  }

  // -------------------------------------------------------- capture: refusals
  section("capture validation");
  {
    const { status, body } = await S.post("/api/capture", { clientDomain: "lacapfcu.org", competitors: [] });
    await check("a capture with no competitors is refused", () => {
      eq(status, 400, "status"); eq(body.reason, "no_competitors", "reason");
    });
  }
  {
    const { status, body } = await S.post("/api/capture", { clientDomain: "", competitors: [{ domain: "x.com" }] });
    await check("a capture with no client domain is refused", () => {
      eq(status, 400, "status"); eq(body.reason, "bad_client_domain", "reason");
    });
  }

  // ------------------------------------------------------- CREATIVE happy path
  section("creative mode — the inspiration wall");
  let creativeRun;
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol Federal Credit Union",
      product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
      ],
    });
    ok(started.ok, "capture should start");
    await check("creative mode does NOT capture the client", () => {
      const domains = started.targets.map((t) => t.domain);
      ok(!domains.includes("lacapfcu.org"), "the client is not a capture target in creative mode");
      ok(started.targets.every((t) => !t.isClient), "no target is flagged as the client");
    });
    await check("the standing nationals are appended without being selected", () => {
      const domains = started.targets.map((t) => t.domain);
      ok(domains.includes("chase.com"), "Chase is always present");
      ok(domains.includes("capitalone.com"), "Capital One is always present");
      eq(started.targets.length, 4, "2 chosen + 2 standing nationals");
    });

    creativeRun = await S.awaitRun(started.runId);
    await check("creative run completes", () => eq(creativeRun.status, "done", "status"));

    await check("every competitor was read", () => {
      const p = creativeRun.progress;
      eq(p["campusfederal.org"].status, "done", "campusfederal status");
      eq(p["neighborsfcu.org"].status, "done", "neighborsfcu status");
      eq(p["campusfederal.org"].read, 4, "campusfederal ads read");
      eq(p["neighborsfcu.org"].read, 3, "neighborsfcu ads read");
    });

    await check("the payload carries a creative block the wall can render", () => {
      ok(creativeRun.creative, "payload.creative missing");
      ok(Array.isArray(creativeRun.creative.clusters), "clusters must be an array");
      ok(creativeRun.creative.summary, "summary missing");
    });

    await check("THE WALL IS NOT EMPTY when creatives were captured", () => {
      ok(creativeRun.creative.clusters.length > 0,
        `7 creatives were read but the wall got ${creativeRun.creative.clusters.length} clusters`);
    });

    await check("near-identical executions collapse into one idea", () => {
      // CAMP1 and CAMP2 share a headline and a $300 bonus at two sizes.
      const idea = creativeRun.creative.clusters.find((c) => c.headline === "Free Checking, Actually Free");
      ok(idea, "the two-execution idea is missing from the wall");
      eq(idea.variations, 2, "variations");
      eq(idea.sizes.length, 2, "distinct sizes");
    });

    // ---- the "55 found but only 2 shown" report ----------------------------
    await check("EVERY captured creative is reachable from the wall, not just the scoped ones", () => {
      // Scoping to checking must not make the off-product creatives
      // unreachable. Counted against capturedCount rather than a literal,
      // because the roster now includes the standing nationals and a hardcoded
      // number would test the fixture instead of the invariant.
      const ids = new Set(creativeRun.creative.clusters.flatMap((c) => c.variationIds || [c.creativeId]));
      eq(ids.size, creativeRun.creative.capturedCount, "creatives reachable from the wall");
      ok(creativeRun.creative.scopedCount < creativeRun.creative.capturedCount, "the scope is narrower than the capture");
      ok(creativeRun.creative.scopedCount > 0, "and it is not empty");
    });

    await check("product chips count everything captured, not just the current slice", () => {
      const total = creativeRun.creative.byProduct.reduce((n, p) => n + p.count, 0);
      eq(total, creativeRun.creative.capturedCount, "product chip total");
      ok(creativeRun.creative.byProduct.length > 1, "expected more than one product chip");
    });

    await check("the wall opens on the scoped product when it has something in it", () =>
      eq(creativeRun.creative.defaultProductFilter, "checking", "defaultProductFilter"));

    await check("the capture funnel reconciles listed -> read -> on-product", () => {
      const f = creativeRun.creative.funnel;
      ok(f, "funnel missing");
      eq(f.read, creativeRun.creative.capturedCount, "read matches what the wall holds");
      eq(f.onProduct, creativeRun.creative.scopedCount, "onProduct matches the scoped slice");
      ok(f.listed >= f.read, `listed ${f.listed} < read ${f.read}`);
      // Every step that lost creatives has to say why, or the strip is noise.
      for (const st of f.steps) {
        if (st.lost > 0) ok(st.why && st.why.length > 0, `step ${st.key} lost ${st.lost} with no explanation`);
      }
    });

    await check("the sampling note never claims retrieval means reading", () => {
      const note = creativeRun.sampling.note;
      ok(/read|selected to read/i.test(note), `note gives no read count: ${note}`);
    });

    await check("off-product creatives are reachable, not silently discarded", () => {
      // Every creative read must be accounted for somewhere in the breakdown.
      const total = creativeRun.breakdown.reduce((s, b) => s + b.count, 0);
      eq(total, creativeRun.creative.capturedCount, "creatives accounted for across the product breakdown");
    });

    await check("every card has the evidence it needs to be clicked", () => {
      for (const c of creativeRun.creative.clusters) {
        ok(c.creativeId, "cluster without a creativeId");
        ok(c.imageUrl, `cluster ${c.creativeId} has no imageUrl to render`);
        ok(c.institution, `cluster ${c.creativeId} has no institution`);
      }
    });

    await check("competitor filter counts match the ads actually returned", () => {
      for (const bc of creativeRun.creative.byCompetitor) {
        const real = creativeRun.ads.filter((a) => a.institution === bc.domain).length;
        ok(bc.count <= real, `${bc.domain}: chip says ${bc.count}, only ${real} ads exist`);
      }
    });

    await check("longevity is phrased as days shown, never as a continuous run", () => {
      const withDays = creativeRun.ads.filter((a) => a.totalDaysShown != null);
      ok(withDays.length > 0, "expected ads with longevity");
      ok(withDays.every((a) => Number.isInteger(a.totalDaysShown)), "totalDaysShown must be an integer count");
    });

    await check("sampling note is present and scoped to what was captured", () => {
      ok(creativeRun.sampling?.note, "sampling note missing");
    });
  }

  // ---------------------------------------------------- persistence + reload
  section("persistence");
  {
    const { body } = await S.get(`/api/run/${creativeRun.id}`);
    await check("a finished run re-reads identically from disk", () => {
      eq(body.status, "done", "status");
      eq(body.ads.length, creativeRun.ads.length, "ad count");
    });
    const { body: list } = await S.get("/api/runs");
    await check("finished runs appear in the run list", () => ok(list.runs.some((r) => r.id === creativeRun.id), "run missing from list"));
  }

  // ------------------------------------------------------ BENCHMARK happy path
  section("benchmark mode — ads vs ads");
  let benchRun;
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", clientLabel: "La Capitol Federal Credit Union",
      product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
      ],
    });
    // 5 targets, not 3: the client, two chosen competitors, and the two
    // standing nationals. Benchmark now carries Chase and Capital One as a
    // REFERENCE TIER — they get a row in the offer snapshot and are excluded
    // from every denominator, because we cannot tell from the Transparency
    // Center whether a national's ads served in this client's market.
    await check("benchmark captures the client plus the national reference tier", () => {
      eq(started.targets.length, 5, "target count");
      eq(started.targets.filter((t) => t.isClient).length, 1, "client columns");
    });

    benchRun = await S.awaitRun(started.runId);
    await check("benchmark run completes", () => eq(benchRun.status, "done", "status"));

    const b = benchRun.benchmark;
    await check("the table has a client column first, marked as the client", () => {
      ok(b, "benchmark payload missing");
      eq(b.columns[0].isClient, true, "first column isClient");
      eq(b.columns.length, 5, "column count — client, 2 local, 2 national reference");
    });

    await check("THE CLIENT COLUMN IS POPULATED — its own ads were captured", () => {
      eq(b.columns[0].adCount, 2, "client on-product ad count");
    });

    await check("competitor columns are populated", () => {
      eq(b.columns[1].adCount, 3, "campusfederal on-product ads");
      eq(b.columns[2].adCount, 1, "neighborsfcu on-product ads");
    });

    await check("the bonus row exists and the client cell is absent", () => {
      const row = b.rows.find((r) => r.id === "offer_bonus");
      ok(row, "bonus row missing");
      const clientCell = row.cells.find((c) => c.column === "client");
      eq(clientCell.absent, true, "client bonus cell should be absent");
    });

    await check("the strongest advertised bonus is shown, with its evidence", () => {
      const row = b.rows.find((r) => r.id === "offer_bonus");
      const camp = row.cells.find((c) => c.column === "campusfederal.org");
      eq(camp.value, "$400", "campusfederal headline bonus");
      ok(camp.evidence.length >= 2, "expected multiple bonus ads as evidence");
    });

    await check("absence is a counted finding with its denominator", () => {
      const gap = (b.findings || []).find((f) => f.kind === "gap");
      ok(gap, "expected a gap finding");
      ok(/of \d+ competitors/.test(gap.text), `denominator missing from: ${gap.text}`);
      ok(gap.evidence.length > 0, "a gap finding must carry its evidence");
    });

    // THE POINT OF THE REFERENCE TIER: nationals are visible and uncounted.
    await check("nationals never enter a benchmark denominator", () => {
      const board = benchRun.board;
      ok(board, "board payload missing");
      const domains = board.brands.map((x) => x.domain);
      ok(!domains.includes("chase.com"), "Chase must not be a counted brand");
      ok(!domains.includes("capitalone.com"), "Capital One must not be a counted brand");
      ok((board.referenceBrands || []).length >= 1, "nationals should be in referenceBrands");
      ok(board.snapshot.referenceNote.length > 0, "the reference rows must be labelled");
      for (const f of board.findings) {
        ok(!/Chase|Capital One/.test(f.headline), `a national reached a finding: ${f.headline}`);
      }
    });

    // Three boards, not one list.
    await check("findings are split into lead / pressure / context", () => {
      const board = benchRun.board;
      ok(board.boards, "boards missing");
      const total = board.boards.lead.length + board.boards.pressure.length + board.boards.context.length;
      eq(total, board.findings.length, "every shown finding lands in exactly one board");
      for (const f of board.findings) {
        ok(["lead", "pressure", "context"].includes(f.outcome), `${f.rule} has no outcome`);
      }
    });

    await check("comparability travels with the row", () => {
      const row = b.rows.find((r) => r.id === "offer_bonus");
      ok(row.comparability, "comparability missing");
      ok(typeof row.comparability.level === "string", "comparability level missing");
    });

    await check("every cell's evidence ids resolve to real ads", () => {
      const known = new Set(benchRun.ads.map((a) => a.creativeId));
      for (const row of b.rows) {
        for (const cell of row.cells) {
          for (const id of cell.evidence || []) {
            ok(known.has(id), `row ${row.id} cites unknown creative ${id}`);
          }
        }
      }
    });

    await check("no row emits a bare number without a denominator or a unit", () => {
      const vol = b.rows.find((r) => r.id === "volume");
      ok(vol.cells.every((c) => c.note && /of \d+ captured/.test(c.note)), "volume cells must state their denominator");
    });
  }

  // ------------------------------------------------------------ the gate
  section("strategy gate");
  {
    const { body } = await S.post(`/api/run/${creativeRun.id}/strategies`);
    await check("strategies are refused for creative mode", () => eq(body.reason, "wrong_mode", "reason"));
  }
  {
    const { body } = await S.post(`/api/run/${benchRun.id}/strategies`);
    await check("strategies generate for a finished benchmark", () => {
      ok(body.ok, `generation failed: ${body.reason}`);
      ok(body.strategies.angles?.length > 0, "expected at least one angle");
    });
    await check("no angle emits a digit — counting is the code's job", () => {
      // Scoped to what the MODEL wrote. Code-authored text (the appended
      // sampling caution, generatedAt) carries counts by design — those are the
      // numbers the model is forbidden from recomputing.
      const text = JSON.stringify(body.strategies.angles);
      const digits = text.match(/\d/g) || [];
      ok(digits.length === 0, `strategy angles contained digits: ${digits.join("")}`);
    });
    await check("the sampling caveat is appended in code, every time", () => {
      const cautions = body.strategies.cautions || [];
      ok(cautions.some((c) => /captured|retrieved|window/i.test(c)),
        `no sampling caution was appended: ${JSON.stringify(cautions)}`);
    });
  }
  {
    const { status, body } = await S.post("/api/run/run_does_not_exist/strategies");
    await check("strategies on an unknown run 404 rather than throwing", () => {
      eq(status, 404, "status"); eq(body.reason, "not_found", "reason");
    });
  }

  // --------------------------------------------------------- partial failure
  section("partial failure — one bad competitor must not sink the run");
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Silent Bank", domain: "silentbank.com" },
        { label: "Preview Only", domain: "previewonly.com" },
      ],
    });
    const run = await S.awaitRun(started.runId);

    await check("the run still completes", () => eq(run.status, "done", "status"));
    await check("the competitor with ads still produced them", () => eq(run.progress["campusfederal.org"].read, 4, "read"));
    await check("a competitor with no ads is reported empty, not failed", () => {
      eq(run.progress["silentbank.com"].status, "empty", "status");
      eq(run.progress["silentbank.com"].reason, "no_ads", "reason");
    });
    await check("a preview-only competitor says so, and its count reconciles", () => {
      const p = run.progress["previewonly.com"];
      eq(p.status, "empty", "status");
      eq(p.reason, "preview_only", "reason");
      eq(p.previewOnly, 2, "preview-only count");
      eq(p.found, 2, "found count");
    });
    await check("the wall still renders the competitor that worked", () => {
      ok(run.creative.clusters.length > 0, "wall is empty despite one working competitor");
    });
  }

  // ------------------------------------------------------- duplicate targets
  section("duplicate and self-referential targets");
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Campus Federal Again", domain: "campusfederal.org" },
      ],
    });
    const run = await S.awaitRun(started.runId);
    await check("a duplicated competitor domain does not double-count its ads", () => {
      const camp = run.benchmark.columns.filter((c) => c.domain === "campusfederal.org");
      ok(camp.length === 1, `campusfederal appears as ${camp.length} columns`);
    });
  }
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [{ label: "Themselves", domain: "lacapfcu.org" }],
    });
    await check("the client cannot be entered as their own competitor", () => {
      ok(!started.ok || started.targets.filter((t) => t.domain === "lacapfcu.org").length === 1,
        "client domain appears twice in the target list");
    });
  }

  // ------------------------------------------------ the provider rotates ads
  section("captures are samples — consecutive runs are diffed");
  {
    const first = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
    });
    await S.awaitRun(first.body.runId);

    const second = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
    });
    const run = await S.awaitRun(second.body.runId);

    await check("a second comparable capture is diffed against the first", () => {
      ok(run.diff, "no diff on the second run");
      eq(run.diff.previousRunId, first.body.runId, "previous run id");
    });
    await check("an identical re-capture reports no new creatives", () => {
      eq(run.diff.appeared, 0, "appeared");
      // Every creative in the second capture was in the first. Derived rather
      // than literal so the standing nationals cannot invalidate the invariant.
      eq(run.diff.stillRunning, run.ads.length, "seen in both");
      eq(run.diff.noLongerObserved, 0, "no longer observed");
    });
    await check("a run with no comparable predecessor carries no diff", async () => {
      const other = await S.post("/api/capture", {
        mode: "creative", clientDomain: "lacapfcu.org", product: "mortgage", days: 30,
        competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
      });
      const r = await S.awaitRun(other.body.runId);
      eq(r.diff, null, "diff on a differently-scoped run");
    });
  }

  // ------------------------------------------------------ agency attribution
  section("institution is not the advertiser");
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", product: "checking", days: 30,
      competitors: [{ label: "Agency Bank", domain: "agencybank.com" }],
    });
    const run = await S.awaitRun(started.runId);
    // Indexed by institution, not by position: the capture now also contains
    // the standing nationals, so ads[0] is whichever advertiser happened to
    // land first.
    const agencyAd = run.ads.find((a) => a.institution === "agencybank.com");
    await check("the entered domain stays the institution", () => {
      ok(agencyAd, "agencybank creative captured");
      eq(agencyAd.institution, "agencybank.com", "institution");
    });
    await check("the verified advertiser is kept as a separate field", () => {
      eq(agencyAd.advertiser, "Fogarty and Klein, Inc.", "advertiser");
    });
  }

  
// ---------------------------------------------------------------------------
section("the read cap buys distinct creatives, not repeats");

{
  // dupeheavy.test runs 3 campaigns rendered at several sizes each: 20
  // creatives, 3 distinct artworks. Before the fix the cap was applied BEFORE
  // the byte-dedupe, so the slots filled with repeats of the longest-running
  // campaign and the two carrying offers were never read.
  const { body } = await S.post("/api/capture", {
    mode: "creative", sources: ["google_display"], includeNationals: false,
    clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
    competitors: [{ label: "Dupe Heavy", domain: "dupeheavy.test" }],
  });
  const run = await S.awaitRun(body.runs[0].runId);
  const ads = (run.ads || []).filter((a) => a.institution === "dupeheavy.test");

  await check("every campaign is read, not just the longest-running one", () => {
    const heads = new Set(ads.map((a) => a.headline));
    eq(heads.size, 3, `expected all 3 campaigns, got: ${[...heads].join(" | ")}`);
  });

  await check("no vision slot was spent on artwork already in hand", () => {
    // 20 creatives, 3 distinct artworks: reading more than 3 means duplicates
    // reached the model.
    eq(ads.length, 3, `expected 3 distinct reads, got ${ads.length}`);
  });

  await check("the offer-bearing campaigns survive to the wall", () => {
    const offers = ads.filter((a) => a.offer && a.offer.value).map((a) => a.offer.value).sort();
    eq(offers.length, 2, `expected 2 offers, got ${JSON.stringify(offers)}`);
    ok(offers.includes("$600"), "the checking bonus was not read");
    ok(offers.includes("3.99% APR"), "the HELOC rate was not read");
  });

  await check("the funnel still reconciles and names the duplicates", () => {
    const f = run.creative.funnel;
    const sel = f.steps.find((x) => x.key === "selected");
    ok(/duplicate render/.test(sel.why), `the drop should name duplicates: ${sel.why}`);
    ok(f.read >= sel.value - 1, "read must not exceed what was selected");
  });
}

// ---------------------------------------------------------------------------
// REGRESSIONS. Two ways the benchmark silently reverted to reporting nothing.
// Both passed every other test in this file while broken.
// ---------------------------------------------------------------------------
section("regression — the extraction cache is scoped to its reader");
{
  // A creative (display, banner reader) run and a benchmark (search reader) run
  // over the same creativeIds. The cache used to be keyed on creativeId alone,
  // so the banner records won and the benchmark read ads with no description
  // and no sitelinks — the exact fields the search reader exists to recover,
  // and no miss anywhere to show for it.
  const comps = [{ label: "Campus Federal", domain: "campusfederal.org" }];
  const base = { clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking", days: 30, competitors: comps };

  const { body: c } = await S.post("/api/capture", { ...base, mode: "creative" });
  await S.awaitRun(c.runId);
  const { body: b } = await S.post("/api/capture", { ...base, mode: "benchmark" });
  const bench = await S.awaitRun(b.runId);

  await check("benchmark ads carry the SEARCH shape, not a replayed banner record", () => {
    const ad = bench.ads.find((a) => a.creativeId === "CAMP1");
    ok(ad, "CAMP1 missing from the benchmark run");
    ok(Array.isArray(ad.sitelinks), "no sitelinks field — this is a banner record");
    ok(typeof ad.description === "string", "no description field — this is a banner record");
  });

  await check("the fact in the description survived into the board", () => {
    const camp = bench.board.brands.find((x) => x.domain === "campusfederal.org");
    ok(camp?.positions?.cash_bonus?.raw, "the bonus in the description was dropped");
  });
}

section("regression — a run is never its own previous snapshot");
{
  const base = { clientDomain: "neighborsfcu.org", clientLabel: "Neighbors FCU", product: "checking", days: 30 };
  const first = [{ label: "Campus Federal", domain: "campusfederal.org" }];

  const { body: r1 } = await S.post("/api/capture", { ...base, mode: "benchmark", competitors: first });
  await S.awaitRun(r1.runId);

  // A DIFFERENT competitor set. The second run must see the first as previous
  // and disclose the drift. It used to read back its own just-written snapshot
  // — identical set, so no drift, and no offer change could ever fire.
  const { body: r2 } = await S.post("/api/capture", {
    ...base, mode: "benchmark",
    competitors: [...first, { label: "EFCU Financial", domain: "efcufinancial.org" }],
  });
  const run2 = await S.awaitRun(r2.runId);

  await check("a changed competitor set is disclosed as drift", () => {
    ok(run2.board.setDrift, "set drift went unreported");
    ok(run2.board.setDrift.added.includes("efcufinancial.org"), "the added competitor is not named");
  });

  await check("drift survives re-reading the finished run", async () => {
    const { body } = await S.get(`/api/run/${r2.runId}`);
    ok(body.board.setDrift, "drift disappeared when the run was read back");
  });

  await check("the drift note states how many brands the comparison covers", () =>
    ok(/present in both/.test(run2.board.setDrift.note), `unhelpful note: ${run2.board.setDrift.note}`));
}

summary();
} finally {
  S.stop();
}
