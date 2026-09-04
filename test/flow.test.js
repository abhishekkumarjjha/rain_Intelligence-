// =============================================================================
// test/flow.test.js — the whole API surface, driven the way the UI drives it.
//
// Every assertion here is a sentence the product makes to a client. If a count
// is wrong, a denominator is missing, or a failed competitor takes down a run
// that succeeded for the others, it fails here rather than in front of someone.
// =============================================================================

import { startServer, check, section, summary, eq, ok } from "./harness.js";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

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
    // Banks brand every product, and there is no finite list of the names they
    // invent. The regex cannot read "platinum-card"; a model can.
    const { body } = await S.post("/api/resolve", { url: "https://lacapfcu.org/platinum-card" });
    await check("a branded product name is read when the pattern cannot", () => {
      eq(body.product, "credit-card", "product");
      eq(body.productFrom, "model", "productFrom");
      eq(body.looksLikeHomepage, false, "a confident read must not block the capture");
    });
  }
  {
    const { body } = await S.post("/api/resolve", { url: "https://lacapfcu.org/about-us" });
    await check("a page that names no product still goes to the user", () => {
      eq(body.product, "other", "product");
      eq(body.looksLikeHomepage, true, "the user must be asked rather than guessed at");
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
    // THE WALL CAPTURES THE CLIENT TOO, and this reverses an earlier rule.
    // The Wall was "what competitors made", so the client was left out — but
    // "competitors lead with a bonus" is not a finding until you know whether
    // the client does, and nothing on that screen could answer it.
    await check("creative mode captures the client as its own population", () => {
      const domains = started.targets.map((t) => t.domain);
      ok(domains.includes("lacapfcu.org"), "the client must be a capture target on the Wall");
      const self = started.targets.filter((t) => t.isClient);
      eq(self.length, 1, "exactly one target is the client");
      eq(self[0].domain, "lacapfcu.org", "and it is the client's domain");
    });
    await check("the standing nationals are appended without being selected", () => {
      const domains = started.targets.map((t) => t.domain);
      ok(domains.includes("chase.com"), "Chase is always present");
      ok(domains.includes("capitalone.com"), "Capital One is always present");
      eq(started.targets.length, 5, "the client + 2 chosen + 2 standing nationals");
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

    // THE CLIENT IS A SEPARATE POPULATION. It is captured so the wall can be
    // read against something, and it is kept out of every figure the wall
    // prints — the funnel, the sampling note, the tiers, the chips. Merging it
    // in would inflate the local set with the client's own creative and turn
    // "no local creatives were read" into a false negative.
    await check("the client's own creative comes back as its own block", () => {
      ok(creativeRun.client, "payload.client missing");
      ok(Number.isFinite(creativeRun.client.captured), "captured count missing");
      ok(Array.isArray(creativeRun.client.ads), "the client's ads must be reachable");
      for (const a of creativeRun.client.ads) ok(a.isClient, "a competitor ad leaked into the client block");
    });

    await check("no client creative is counted anywhere on the wall", () => {
      const c = creativeRun.creative;
      ok(!c.clusters.some((x) => x.institution === "lacapfcu.org"), "a client card reached the wall");
      ok(!c.byCompetitor.some((x) => x.domain === "lacapfcu.org"), "the client became a competitor chip");
      ok(!c.tiers.local.domains.includes("lacapfcu.org"), "the client entered the local tier");
      ok(!c.tiers.national.domains.includes("lacapfcu.org"), "the client entered the national tier");
      // The funnel reconciles against the wall, so the client's listings must
      // not appear in "listed by Google" while its ads are absent from "read".
      const read = c.funnel.steps.find((x) => x.key === "read");
      eq(read.value, c.capturedCount + (c.unreadable || 0), "the funnel must count the wall, not the client");
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
      // Rows are keyed on the METRIC now, not a legacy offer type — the table
      // reads the board's rollup rather than computing a second one.
      const row = b.rows.find((r) => r.id === "offer_cash_bonus");
      ok(row, "bonus row missing");
      const clientCell = row.cells.find((c) => c.column === "client");
      eq(clientCell.absent, true, "client bonus cell should be absent");
    });

    await check("the table agrees with the board, cell for cell", () => {
      // The defect this replaces: the table sorted on the LARGEST printed
      // figure while the board ranked by the metric's direction, so one
      // auto-loan screen showed 4.84% APR in a finding and 6.74% below it.
      for (const row of b.rows.filter((r) => r.kind === "offer")) {
        for (const cell of row.cells) {
          const brand = benchRun.board.brands.find((x) =>
            (cell.column === "client" ? x.isClient : x.domain === cell.column));
          const pos = brand?.positions?.[row.metric];
          if (cell.absent) { ok(!pos, `${row.metric}/${cell.column}: table blank, board has ${pos?.raw}`); continue; }
          eq(cell.value, pos?.raw, `${row.metric}/${cell.column} disagrees with the board`);
        }
      }
    });

    await check("the strongest advertised bonus is shown, with its evidence", () => {
      const row = b.rows.find((r) => r.id === "offer_cash_bonus");
      const camp = row.cells.find((c) => c.column === "campusfederal.org");
      eq(camp.value, "$400", "campusfederal headline bonus");
      ok(camp.evidence.length >= 2, "expected multiple bonus ads as evidence");
    });

    await check("the table carries no findings of its own", () => {
      // It used to compute a third set over a DIFFERENT denominator — "1 of 6
      // competitors" counting nationals, rendered directly above a board saying
      // "1 of 3" excluding them. The board owns findings.
      eq(b.findings, undefined, "the table is the audit trail, not a second opinion");
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
      const row = b.rows.find((r) => r.id === "offer_cash_bonus");
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

  // ------------------------------------------- how sure the reader actually was
  //
  // Both extractors compute productConfidence and clamp it. Nothing read it, so
  // a creative the reader placed on auto loans at 0.15 — the reader correctly
  // saying it could not tell — sat in the auto-loan denominator beside one at
  // 0.9. PEL2 is that creative: headline "Bank With Us", offer "1.99% APR".
  section("a creative the reader could not place is captured, shown, and not counted");
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "auto-loan", days: 30,
      competitors: [{ label: "Pelican State CU", domain: "pelicanstatecu.com" }],
    });
    const run = await S.awaitRun(started.runId);
    const low = run.ads.find((a) => a.creativeId === "PEL2");

    await check("it was captured, and it is still in the run", () => {
      ok(low, "PEL2 is not in run.ads — it must be reachable, it really ran");
      ok(low.productConfidence < 0.5, `confidence ${low.productConfidence}`);
    });

    await check("the product chips still count it — it WAS captured", () => {
      const auto = run.breakdown.find((b) => b.code === "auto-loan");
      ok(auto, "auto loan is missing from the breakdown entirely");
      ok(auto.count >= 2, `chips show ${auto.count}; the capture holds 2 auto-loan creatives`);
    });

    await check("no finding on the board is built on it", () => {
      for (const f of run.board.findings) {
        ok(!(f.evidence || []).includes("PEL2"), `${f.rule} cites a creative the reader could not place`);
      }
    });

    await check("no snapshot cell quotes its figure", () => {
      const cells = run.board.snapshot.rows.flatMap((r) => r.cells);
      ok(!cells.some((c) => String(c.value).includes("1.99")),
        "1.99% APR reached the snapshot from a creative classified at 0.15 confidence");
      for (const row of run.board.snapshot.rows) {
        for (const cell of row.cells) ok(!(cell.evidence || []).includes("PEL2"), "a cell cites it as evidence");
      }
    });

    await check("the audit table agrees with the board rather than counting it separately", () => {
      // Two aggregations over two different ad sets is the 4.84%-vs-6.74% bug.
      const col = run.benchmark.columns.find((c) => c.domain === "pelicanstatecu.com");
      eq(col.adCount, 1, "the audit table's column count");
    });

    await check("the funnel still reconciles, and says where it went in its own words", () => {
      const f = run.funnel;
      const onProduct = f.steps.find((s) => s.key === "onProduct");
      const counted = f.steps.find((s) => s.key === "counted");
      ok(onProduct, "the funnel lost its on-product step");
      ok(counted, "a creative dropped from the counts with no step to say so");
      eq(counted.value, onProduct.value - counted.lost, "counted + lost must equal on-product");
      ok(/confidence/i.test(counted.why), `the reason must name what happened: "${counted.why}"`);
      ok(!/different product/i.test(counted.why),
        "it was classified as THIS product, unsurely — saying otherwise reconciles by lying");
    });
  }

  // ------------------------------------------------- the removed strategy gate
  //
  // The UI stopped offering this months ago; the route stayed mounted, kept
  // generating and kept billing. Anything that still POSTs to it — an old tab,
  // a bookmark, a script — must now find nothing there rather than a model call.
  section("the strategy gate is gone, not merely hidden");
  {
    const r = await fetch(`${S.base}/api/run/${benchRun.id}/strategies`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    await check("POSTing the old strategy route is not routed at all", () => {
      eq(r.status, 404, "status");
    });
    await check("a finished benchmark payload carries no generated strategies", async () => {
      const { body } = await S.get(`/api/run/${benchRun.id}`);
      eq(body.strategies, null, "strategies");
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

// ---------------------------------------------------------------------------
// ONE TOOL, TWO HALVES. The Wall shows what competitors MADE; Competitive
// Intelligence shows how the client COMPARES.
//
// The Wall is DISPLAY ONLY, and that is a cost decision. Capturing search there
// too would double its bill — not in listing requests (~$0.01) but in the one
// vision call per creative that follows each one. Competitive Intelligence
// already reads every search ad, so the search wall is a free view over that
// run rather than a second purchase of the same data.
// ---------------------------------------------------------------------------
section("the Wall is display only — search is never bought twice");
{
  const comps = [{ label: "Campus Federal", domain: "campusfederal.org" }];
  const { body } = await S.post("/api/capture", {
    mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
    product: "checking", days: 30,
    // Asking for search on the Wall must be refused, not honoured: this is the
    // request shape a UI regression would send.
    sources: ["google_display", "google_search"], competitors: comps,
  });

  await check("a Wall run never captures Google search", () => {
    const sources = body.runs.map((r) => r.source);
    ok(!sources.includes("google_search"),
      `the Wall bought a search capture it does not need: ${sources.join(",")}`);
  });

  await check("the Wall still captures display", () => {
    eq(body.runs.map((r) => r.source).join(","), "google_display", "sources");
  });

  const wall = await S.awaitRun(body.runs[0].runId);
  await check("the display wall still fills", () => {
    eq(wall.status, "done", "status");
    ok(wall.creative?.clusters?.length > 0, "wall is empty");
  });
}

// ---------------------------------------------------------------------------
// KEY INSIGHTS — descriptive themes over the Wall's creatives.
//
// This replaces the recommended-strategy pass for the Wall, and the difference
// is the whole point: a theme says what the ads ARE, a recommendation says what
// someone should DO. The model is asked for the first and will sometimes return
// the second, so the rules are enforced here, after it answers.
// ---------------------------------------------------------------------------
section("key insights — themes describe, they never advise");
{
  const { body: started } = await S.post("/api/capture", {
    mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
    product: "checking", days: 30,
    competitors: [
      { label: "Campus Federal", domain: "campusfederal.org" },
      { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
    ],
  });
  const wall = await S.awaitRun(started.runId);

  const { body: t } = await S.post(`/api/run/${wall.id}/themes`);
  await check("themes generate for a finished Wall run", () => {
    ok(t.ok, `generation failed: ${t.reason}`);
    ok(t.themes.themes.length > 0, "expected at least one theme");
  });

  await check("a theme that advises is DROPPED, not softened", () => {
    const all = JSON.stringify(t.themes.themes);
    ok(!/\byou should\b/i.test(all), `advice survived: ${all}`);
    ok(!t.themes.themes.some((x) => x.name === "Switching moment"), "the prescriptive theme rendered");
  });

  await check("a theme claiming performance is dropped", () => {
    ok(!t.themes.themes.some((x) => x.name === "Bonus-forward creative"),
      "a performance claim survived a capture with no performance data");
  });

  await check("a theme citing no real creative is dropped", () => {
    ok(!t.themes.themes.some((x) => x.name === "Trust signals"), "a theme with invented evidence rendered");
  });

  await check("every surviving theme points at creatives from this run", () => {
    const known = new Set(wall.ads.map((a) => a.creativeId));
    for (const x of t.themes.themes) {
      ok(x.creativeIds.length >= 2, `${x.name} has too little evidence`);
      for (const id of x.creativeIds) ok(known.has(id), `${x.name} cites unknown ${id}`);
    }
  });

  await check("the framing states the register in the user's own reading", () => {
    ok(/not what anyone should do/i.test(t.themes.framing), `weak framing: ${t.themes.framing}`);
  });

  await check("a number written in WORDS is dropped like a digit", async () => {
    // The old rule stripped digits and said "no digits", so "several of the
    // designs" sailed through. A model-written figure with no digit in it is
    // still a model-written figure and still traces back to nothing counted.
    ok(!t.themes.messageThemes.some((x) => x.name === "Spelled-out counting"),
      "a spelled-out quantity survived");
  });

  await check("a theme that infers intent is dropped", () => {
    // "Strategy" claims to know why an advertiser did something. The capture
    // shows what ran, never why.
    ok(!t.themes.messageThemes.some((x) => x.name === "Acquisition strategy"),
      "an intent claim survived");
  });

  await check("a contrast whose two sides are the same cohort is not a contrast", () => {
    // The model labelled it a regional-vs-national contrast and cited the same
    // ids on both sides. Labels are verified against the real cohorts, never
    // taken on trust.
    ok(!(t.themes.cohortContrasts || []).some((x) => x.name === "False contrast"),
      "a contrast with one cohort on both sides rendered");
  });

  await check("support is derived from the evidence, not asked for", () => {
    // Four designs from ONE advertiser and four from four are completely
    // different findings, and used to render identically because advertiser
    // identity was stripped before the model ever saw it.
    for (const x of [...t.themes.messageThemes, ...(t.themes.executionPatterns || [])]) {
      ok(["cross_advertiser", "within_advertiser"].includes(x.supportType),
        `${x.name} has no support type`);
      eq(x.supportType === "within_advertiser", x.advertiserCount === 1,
        `${x.name}: support type disagrees with its own advertiser count`);
      ok(["regional", "national", "mixed", "unknown"].includes(x.scope), `${x.name} has no scope`);
      // The client is a THIRD population, never a cohort of the market: a theme
      // carried by the client and one national must not read as "mixed", which
      // on this panel means regional-and-national.
      eq(typeof x.clientToo, "boolean", `${x.name} does not say whether the client advertises it too`);
      ok(!x.clientOnly || x.scope === "unknown", `${x.name}: a client-only theme cannot carry a market scope`);
    }
  });

  await check("one design cut into many sizes is one piece of evidence", () => {
    // The defect this whole pass exists to fix: handed raw ads, the model read
    // one design resized five ways as five confirmations of a theme.
    for (const x of t.themes.messageThemes) {
      ok(x.familyCount >= 2, `${x.name} rests on fewer than two designs`);
      ok(x.familyCount <= x.creativeIds.length,
        `${x.name}: more designs than creatives, which cannot happen`);
    }
  });

  // THE PANEL IS NEVER AN ERROR, and it always says which scope it got.
  //
  // A product too thin to generalise over is an ordinary outcome of reading a
  // small wall — it used to arrive as ok:false and render as a red bar across
  // the results, the same treatment as a failed capture. It now widens to a
  // general read of the wall and LABELS ITSELF as one; the label is the whole
  // safety property, because a mixed-product read under a product heading is a
  // false claim about that product.
  await check("a thin product widens to a general read, and says so", async () => {
    const { body: thin } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "heloc", days: 30,
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
    });
    const thinRun = await S.awaitRun(thin.runId);
    const { body } = await S.post(`/api/run/${thinRun.id}/themes`);

    eq(body.ok, true, "a thin product must not be reported as a failure");
    if (body.themes) {
      eq(body.readScope, "all_products", "readScope");
      eq(body.themes.readScope, "all_products", "the scope must travel ON the saved themes");
      ok(body.productDesigns < body.needed, `fell back with ${body.productDesigns} on-product designs`);
      // The framing must not name a product the read did not confine itself to.
      ok(!new RegExp(thinRun.productLabel, "i").test(body.themes.framing),
        `general read framed as a product read: ${body.themes.framing}`);
    } else {
      // Too little on every product is also not an error — just nothing to show.
      eq(body.reason, "too_little_captured", "reason");
      ok(typeof body.allDesigns === "number", "the empty state must carry the count it was decided on");
    }
  });

  await check("a wall with nothing to say is an empty answer, never an error", async () => {
    const { body: empty } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "checking", days: 30, includeNationals: false,
      competitors: [{ label: "Silent Bank", domain: "silent-bank.test" }],
    });
    const emptyRun = await S.awaitRun(empty.runId);
    const { status, body } = await S.post(`/api/run/${emptyRun.id}/themes`);
    eq(status, 200, "status");
    eq(body.ok, true, "an unreadable wall is a result, not a failure");
    eq(body.themes, null, "themes");
    eq(body.reason, "too_little_captured", "reason");
  });

  // THE COUNTED OBSERVATIONS OUTLIVE THE MODEL. A themes pass that finds
  // nothing must not take the arithmetic down with it — "every design captured
  // on this product is from a national advertiser" needs no model at all, and
  // throwing it away is how a wall with a real reading in it rendered as
  // "No insights available".
  await check("the counted observations come back whatever the model does", async () => {
    const { body } = await S.post(`/api/run/${wall.id}/themes`, { force: true });
    ok(body.ok, `themes failed: ${body.reason}`);
    ok("counted" in body, "the counted block must be present in every answer");
    // And they are carried ON the themes, so a re-open renders them too.
    if (body.themes) {
      ok("cohort" in body.themes && "channel" in body.themes,
        "the counted lines must be saved with the themes, not recomputed on open");
    }
  });

  await check("citations are short labels, never the provider's raw ids", async () => {
    // A model asked to echo "CR01145745112471437313" back as evidence will
    // eventually mistype one, and a mistyped citation is dropped as invented —
    // silently, and if it happens across the answer the whole panel goes empty.
    // Every surviving finding here resolves to a real creative, which is only
    // possible if the label mapping is done in code.
    const { body } = await S.post(`/api/run/${wall.id}/themes`, { force: true });
    const ids = new Set((wall.ads || []).map((a) => a.creativeId));
    for (const x of [...body.themes.messageThemes, ...(body.themes.executionPatterns || [])]) {
      for (const id of x.creativeIds) ok(ids.has(id), `${x.name} cited ${id}, which is not in this run`);
    }
  });

  // TWO SCOPES, ASKED FOR BY NAME. The panel shows the general read of the wall
  // and the read for the product chosen on the landing page, side by side —
  // which is only possible if a scope can be requested rather than inferred.
  await check("a scope can be asked for by name, and says which it answered", async () => {
    const { body: all } = await S.post(`/api/run/${wall.id}/themes`, { scope: "all" });
    eq(all.ok, true, "ok");
    eq(all.scope, "all", "scope");
    eq(all.scopeLabel, "Every product captured", "scopeLabel");
    if (all.themes) {
      eq(all.themes.readScope, "all_products", "readScope");
      // A general read must never be framed as a product read.
      ok(!/checking/i.test(all.themes.framing), `general read framed as a product: ${all.themes.framing}`);
    }

    const { body: one } = await S.post(`/api/run/${wall.id}/themes`, { scope: "checking" });
    eq(one.scope, "checking", "scope");
    eq(one.scopeLabel, "Checking", "scopeLabel");
    if (one.themes) ok(/checking/i.test(one.themes.framing), "a product read must name its product");
  });

  await check("each scope is cached separately, so a re-open is never re-read", async () => {
    const { body } = await S.post(`/api/run/${wall.id}/themes`, { scope: "all" });
    eq(body.cached, true, "the second ask for a scope must come from the run");
    const { body: fresh } = await S.post(`/api/run/${wall.id}/themes`, { scope: "credit-card" });
    ok(!fresh.cached, "a scope never read is not cached");
    eq(fresh.scope, "credit-card", "scope");
  });

  await check("an unknown scope falls back to the run's product, never to everything", async () => {
    const { body } = await S.post(`/api/run/${wall.id}/themes`, { scope: "not-a-product" });
    eq(body.scope, "checking", "an unrecognised scope must not silently widen the read");
  });

  await check("themes are refused for Competitive Intelligence", async () => {
    const { body } = await S.post(`/api/run/${benchRun.id}/themes`);
    eq(body.reason, "wrong_mode", "reason");
  });

  await check("themes on an unknown run 404 rather than throwing", async () => {
    const { status } = await S.post("/api/run/run_nope/themes");
    eq(status, 404, "status");
  });
}

// ---------------------------------------------------------------------------
// FAIL CLOSED. The system used to be fail-OPEN: when one stage was wrong or
// uncertain, every later stage carried on producing confident analysis over a
// population nobody had validated. These are the gates that stop that.
// ---------------------------------------------------------------------------
section("an invalid scope produces no analysis at all");
{
  const comps = [{ label: "Campus Federal", domain: "campusfederal.org" }];

  await check("Competitive Intelligence refuses to start without a product", async () => {
    const { status, body } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "other", days: 30, competitors: comps,
    });
    eq(status, 400, "status");
    eq(body.reason, "product_required", "reason");
  });

  await check("...and refuses an absent product the same way", async () => {
    const { status, body } = await S.post("/api/capture", {
      mode: "benchmark", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      days: 30, competitors: comps,
    });
    eq(status, 400, "status");
    eq(body.reason, "product_required", "reason");
  });

  // The Wall is a browse. "Other" is a legitimate scope there — most display
  // banners carry no product signal at all, and the product chips are a filter
  // over everything captured rather than a gate on the analysis.
  await check("the Wall still accepts a scope of Other", async () => {
    const { body } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "other", days: 30, competitors: comps,
    });
    ok(body.ok, `the Wall should not be gated: ${body.reason}`);
  });
}

section("no finding cites evidence from another product");
{
  const { body: started } = await S.post("/api/capture", {
    mode: "benchmark", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
    product: "checking", days: 30,
    competitors: [
      { label: "Campus Federal", domain: "campusfederal.org" },
      { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
    ],
  });
  const run = await S.awaitRun(started.runId);

  // The credit-card run cited Google Maps listings and auto-loan ads as
  // credit-card message-gap evidence, because the scope filter was off. Every
  // id a finding points at must be an ad classified as the scoped product.
  await check("every finding's evidence is on the scoped product", () => {
    const onProduct = new Set(run.ads.filter((a) => a.product === run.product).map((a) => a.creativeId));
    for (const f of run.board.findings) {
      for (const id of f.evidence || []) {
        ok(onProduct.has(id), `${f.rule} cites ${id}, which is not a ${run.product} ad`);
      }
    }
  });

  await check("the funnel's on-product count is a real subset, not everything read", () => {
    const scoped = run.ads.filter((a) => a.product === run.product).length;
    ok(scoped < run.ads.length,
      `every captured ad counted as on-product — the scope filter is off (${scoped}/${run.ads.length})`);
  });

  await check("no client-facing line contains a null or undefined", () => {
    const text = JSON.stringify(run.board.primaryRead || {}) + JSON.stringify(run.board.findings || []);
    ok(!/\b(null|undefined)\b/.test(text.replace(/"[a-zA-Z]+":null/g, "")),
      "a missing value reached client-facing text");
  });
}

// ---------------------------------------------------- two writers, one file
//
// Opening Key insights fires two POSTs at once. When the run is not in ACTIVE —
// which is every run after a restart, and every evicted run — each handler
// loads its own copy of the record, writes its own scope, and saves the whole
// object back. The second save used to overwrite the first.
section("regression — two scopes read at once, both survive on disk");
{
  const A = await startServer({}, { keepData: true });
  let dataDir = A.dataDir;
  let runId = null;
  try {
    const { body: started } = await A.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
      ],
    });
    const wall = await A.awaitRun(started.runId);
    runId = wall.id;
  } finally {
    A.stop();   // keepData: the run file stays behind
  }

  // A FRESH PROCESS over the same directory. ACTIVE is empty, so both handlers
  // below take the loadRun() path — the one that used to lose a scope.
  const B = await startServer({}, { dataDir, keepData: true });
  let onDisk = null;
  try {
    const [all, checking] = await Promise.all([
      B.post(`/api/run/${runId}/themes`, { scope: "all" }),
      B.post(`/api/run/${runId}/themes`, { scope: "checking" }),
    ]);
    await check("both concurrent scope reads succeed", () => {
      ok(all.body.ok, `all: ${all.body.reason}`);
      ok(checking.body.ok, `checking: ${checking.body.reason}`);
    });
    onDisk = JSON.parse(readFileSync(path.join(dataDir, `${runId}.json`), "utf8"));
  } finally {
    B.stop();
  }

  await check("both scopes are on disk — neither write clobbered the other", () => {
    const scopes = Object.keys(onDisk.themesByScope || {}).sort();
    ok(scopes.includes("all"), `"all" was lost from disk; found ${JSON.stringify(scopes)}`);
    ok(scopes.includes("checking"), `"checking" was lost from disk; found ${JSON.stringify(scopes)}`);
  });

  await check("a lost scope is a re-billed scope — the saved read is what a reopen serves", () => {
    // The user-visible cost of the race: whichever scope was clobbered came
    // back uncached on the next open and paid for another model call.
    for (const s of ["all", "checking"]) {
      ok(onDisk.themesByScope[s], `${s} would be re-read, and re-billed, on the next open`);
    }
  });

  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ------------------------------------------------- completed runs leave memory
//
// The ACTIVE map had three .set calls and no .delete, so every run ever captured
// stayed in memory for the life of the process, holding its full ad records.
// Eviction is only safe because of the disk copy, so the thing to prove is that
// an evicted run comes back through loadRun() IDENTICAL, not merely present.
section("regression — an evicted run reads back off disk unchanged");
{
  const S = await startServer({ RI_ACTIVE_RUNS: "4" });
  try {
    const ids = [];
    const before = new Map();
    for (let i = 0; i < 6; i++) {
      const { body: started } = await S.post("/api/capture", {
        mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
        product: "checking", days: 30,
        competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
      });
      const run = await S.awaitRun(started.runId);
      ids.push(started.runId);
      before.set(started.runId, JSON.stringify(run));
    }

    await check("the oldest runs are still reachable after the cap is exceeded", async () => {
      for (const id of ids.slice(0, 2)) {
        const { status, body } = await S.get(`/api/run/${id}`);
        eq(status, 200, `status for ${id}`);
        eq(body.status, "done", `status field for ${id}`);
      }
    });

    await check("an evicted run's payload is byte-identical to the one it had in memory", async () => {
      for (const id of ids.slice(0, 2)) {
        const { body } = await S.get(`/api/run/${id}`);
        eq(JSON.stringify(body), before.get(id), `payload for ${id} changed after eviction`);
      }
    });

    await check("the most recent run is still the one held in memory", async () => {
      const { body } = await S.get(`/api/run/${ids[ids.length - 1]}`);
      eq(JSON.stringify(body), before.get(ids[ids.length - 1]), "the newest run changed");
    });

    await check("health reports how many runs are being held", async () => {
      const { body } = await S.get("/api/health");
      ok(typeof body.runsInMemory === "number", "runsInMemory is not reported");
      ok(body.runsInMemory <= 4, `${body.runsInMemory} runs held against a cap of 4 — nothing is being evicted`);
    });
  } finally { S.stop(); }
}

// ------------------------------------------------ the quote covers both bills
//
// The cost line read the capture cache and stopped there, so a run about to buy
// up to thirty Haiku vision reads was quoted as "1 request, 3 from cache".
// SerpApi credits were quoted; the larger line item was not mentioned.
//
// The rule for every case below: THE QUOTE MUST NEVER UNDER-COUNT what the
// capture then actually spends.
section("the cost quote states model spend, and never under-counts it");
{
  const S = await startServer();
  const COMPS = [
    { label: "Campus Federal", domain: "campusfederal.org" },
    { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
  ];
  const quote = (over) => S.post("/api/cost", {
    mode: "creative", sources: ["google_display"], competitors: COMPS,
    clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
    includeNationals: false, days: { google_display: 30 }, ...over,
  });
  const capture = (over) => S.post("/api/capture", {
    mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
    product: "checking", days: 30, competitors: COMPS, includeNationals: false, ...over,
  });

  try {
    const first = await quote();
    const plan = first.body.plans[0];

    await check("the quote states the model half at all", () => {
      ok(plan.model, "the quote says nothing about model calls");
      ok(typeof plan.model.freshVisionReadsAtMost === "number", "no vision-read figure");
      ok(typeof plan.model.extractionsReused === "number", "no reused-extraction figure");
    });

    await check("it names which reader version the figure is about", () =>
      ok(plan.model.reader, "a vision quote with no reader version cannot be checked against the cache"));

    await check("it says exactly which cache force bypasses", async () => {
      // Force re-fetches the LISTING and does not re-buy transcriptions. A
      // button labelled "force fresh capture" implies otherwise.
      eq(plan.model.force.bypassesCaptureCache, false, "unforced");
      eq(plan.model.force.bypassesExtractionCache, false, "extraction cache");
      const forced = await quote({ force: true });
      const fm = forced.body.plans[0].model;
      eq(fm.force.bypassesCaptureCache, true, "forced");
      eq(fm.force.bypassesExtractionCache, false, "force must not claim to re-buy transcriptions");
    });

    await check("Key insights is named as a separate call, not folded in or omitted", () =>
      eq(plan.model.analysisCallsInThisCapture, 0,
        "the capture quote must not silently include, or silently drop, the panel's call"));

    // --------------------------------------------------- quote versus actual
    const quotedReads = plan.model.freshVisionReadsAtMost;
    const { body: started } = await capture();
    const run = await S.awaitRun(started.runId);
    const actuallyRead = run.ads.length;

    await check("the first run reads no more creatives than the quote allowed", () =>
      ok(actuallyRead <= quotedReads,
        `quoted at most ${quotedReads} fresh reads, the capture read ${actuallyRead}`));

    // ------------------------------------ second time round, everything cached
    const second = await quote();
    const p2 = second.body.plans[0];

    await check("with every advertiser cached the quote spends nothing", () => {
      eq(p2.willFetch, 0, "SerpApi requests");
      eq(p2.model.freshVisionReadsAtMost, 0, "a fully cached capture must quote zero model calls");
      ok(p2.model.extractionsReused > 0, "nothing was reported as reused");
    });

    // ------------------------------ forced: the listing is re-bought, the reads are not
    const forced = await quote({ force: true });
    const p3 = forced.body.plans[0];

    await check("forcing re-buys the listing but not the transcriptions", () => {
      ok(p3.willFetch > 0, "force must quote the SerpApi requests it is about to make");
      ok(p3.model.extractionsReused > 0,
        "force quoted zero reused transcriptions — it would be claiming to re-buy reads it will not re-buy");
    });

    const { body: forcedRun } = await capture({ force: true });
    const run3 = await S.awaitRun(forcedRun.runId);

    await check("and the forced run really does not re-read what it already had", () =>
      ok(run3.ads.length <= p3.model.freshVisionReadsAtMost + p3.model.extractionsReused,
        `read ${run3.ads.length} against a quote of ${p3.model.freshVisionReadsAtMost} fresh + ${p3.model.extractionsReused} reused`));

    await check("every advertiser in the quote is accounted for individually", () => {
      const domains = p3.model.perAdvertiser.map((r) => r.domain).sort();
      ok(domains.includes("lacapfcu.org"), "the client is captured too and must be quoted");
      ok(domains.includes("campusfederal.org") && domains.includes("neighborsfcu.org"),
        `advertisers quoted: ${JSON.stringify(domains)}`);
    });
  } finally { S.stop(); }
}
{
  // Nationals are captured on the display half and must be in the quote — the
  // whole point of this endpoint is that no advertiser it is about to fetch is
  // missing from the bill.
  const S = await startServer();
  try {
    const withNat = await S.post("/api/cost", {
      mode: "creative", sources: ["google_display"],
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
      clientDomain: "lacapfcu.org", includeNationals: true, days: { google_display: 30 },
    });
    const withoutNat = await S.post("/api/cost", {
      mode: "creative", sources: ["google_display"],
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
      clientDomain: "lacapfcu.org", includeNationals: false, days: { google_display: 30 },
    });
    await check("turning the national tier on raises the quoted model spend", () => {
      const a = withNat.body.plans[0].model.freshVisionReadsAtMost;
      const b = withoutNat.body.plans[0].model.freshVisionReadsAtMost;
      ok(a > b, `nationals added no quoted reads (${a} vs ${b}) — two advertisers would be fetched unquoted`);
    });
  } finally { S.stop(); }
}

// ===========================================================================
// CROSS-CUTTING INVARIANT SWEEPS
//
// Not per feature. These walk EVERY string in a whole payload, because the
// failures they catch are the ones that arrive through a panel nobody thought
// to write a test for — a chip that rendered "undefined advertisers" got
// through a suite that already checked the board for exactly that.
// ===========================================================================
section("sweep — every string in every payload");
{
  // Both halves, and a run with a national tier, because the tiering code
  // paths render their own sentences.
  const runs = [];
  for (const [mode, product, includeNationals] of [
    ["creative", "checking", true],
    ["benchmark", "checking", false],
    ["creative", "auto-loan", false],
  ]) {
    const { body: started } = await S.post("/api/capture", {
      mode, product, includeNationals, clientDomain: "lacapfcu.org", clientLabel: "La Capitol", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
        { label: "EFCU Financial", domain: "efcufinancial.org" },
      ],
    });
    runs.push(await S.awaitRun(started.runId));
  }

  /** Every string in the payload, with the path it came from. */
  const strings = (obj, at = "", out = []) => {
    if (typeof obj === "string") { out.push([at, obj]); return out; }
    if (Array.isArray(obj)) { obj.forEach((v, i) => strings(v, `${at}[${i}]`, out)); return out; }
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) strings(v, at ? `${at}.${k}` : k, out);
    }
    return out;
  };

  // Verbatim ad copy is a transcription of somebody else's artwork: it is
  // quoted, not written, and it is not this product's sentence to police.
  const VERBATIM = /(^|\.)(ads|clusters|creative\.clusters|benchmark|board)\b.*\.(headline|headlines|description|subhead|cta|allText|sitelinks|callouts|verbatim|raw|unclassified|tone|displayUrl|advertiser|brand|imageUrl|detailsLink|domainLink)(\[|$|\.)/;
  const isVerbatim = (p) => VERBATIM.test(p) || /\.(imageUrl|detailsLink|domainLink|url|textSnapshot)$/.test(p);

  await check("no user-facing string contains undefined, NaN or [object Object]", () => {
    const bad = [];
    for (const r of runs) {
      for (const [at, v] of strings(r)) {
        if (/\bundefined\b|\bNaN\b|\[object [A-Z]/.test(v)) bad.push(`${r.mode}: ${at} = ${JSON.stringify(v.slice(0, 120))}`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("no user-facing string renders a bare null", () => {
    const bad = [];
    for (const r of runs) {
      for (const [at, v] of strings(r)) {
        if (isVerbatim(at)) continue;
        if (/(^|\s)null(\s|$|\.|,)/.test(v)) bad.push(`${r.mode}: ${at} = ${JSON.stringify(v.slice(0, 120))}`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("NO SENTENCE ASSERTS A PRODUCT FACT, anywhere in any payload", () => {
    // The rule the whole product rests on. "Not observed in 3 competitors'
    // captured ads" is true; "they don't offer it" is false, and it is a bank's
    // agency telling a client something untrue in front of that client's own
    // competitors. Swept over everything rather than over the board, because
    // the board is the only place anyone has ever checked.
    const CLAIM = /\b(do(es)?n'?t (offer|have|do|run)|do(es)? not (offer|have|provide)|no longer (offers?|runs?|has)|has no (bonus|fee|rate|minimum)\b|there is no \w+ (bonus|fee|rate))\b/i;
    const bad = [];
    for (const r of runs) {
      for (const [at, v] of strings(r)) {
        if (isVerbatim(at)) continue;          // an advertiser's own copy may say anything
        const m = v.match(CLAIM);
        if (m) bad.push(`${r.mode}: ${at} — "${m[0]}" in ${JSON.stringify(v.slice(0, 140))}`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("every evidence id resolves to an ad in the same run", () => {
    const bad = [];
    for (const r of runs) {
      const known = new Set();
      for (const a of r.ads || []) {
        known.add(a.creativeId);
        for (const d of a.duplicateIds || []) known.add(d);
        for (const v of a.variationIds || []) known.add(v);
      }
      for (const [at, v] of strings(r)) {
        // Evidence lives under keys called `evidence`, `creativeIds`,
        // `variationIds` and `data-ev` — all arrays of provider ids.
        if (!/\.(evidence|creativeIds|variationIds)\[\d+\]$/.test(at)) continue;
        if (!known.has(v)) bad.push(`${r.mode}: ${at} cites ${v}, which is in no ad of this run`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("every finding names the population it was counted over", () => {
    const bad = [];
    for (const r of runs.filter((x) => x.board)) {
      for (const f of r.board.findings || []) {
        const text = [f.headline, f.detail, f.population, f.scope].filter(Boolean).join(" ");
        const named = /\d+ of \d+|captured|competitors|advertisers|in this set|observed/i.test(text);
        ok(f.unit, `${f.rule} carries no unit`);
        if (!named) bad.push(`${f.rule}: "${f.headline}"`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("every counted figure on the board carries a denominator or a unit", () => {
    const bad = [];
    for (const r of runs.filter((x) => x.board)) {
      for (const f of r.board.findings || []) {
        if (typeof f.count !== "number") continue;
        // A count with no denominator is "4 competitors advertise a bonus",
        // which is a number the reader cannot place. The engine carries the
        // out-of as `denominator`; some cards state it in the sentence instead
        // (the sole-advertiser card reads "Not observed in 3 competitors'
        // captured ads"), and either is a population the reader can see.
        const stated = [f.headline, f.detail, f.reportLine].filter(Boolean).join(" ");
        if (typeof f.denominator !== "number" && !/\bof \d+\b|\b\d+ competitors?\b/i.test(stated)) {
          bad.push(`${r.mode}: ${f.rule} counts ${f.count} against nothing — "${f.headline}"`);
        }
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("no finding cites a creative the reader could not place (F-002 holds across the sweep)", () => {
    const bad = [];
    for (const r of runs.filter((x) => x.board)) {
      const unsure = new Set((r.ads || []).filter((a) => a.productConfidence < 0.5).map((a) => a.creativeId));
      for (const f of r.board.findings || []) {
        for (const id of f.evidence || []) if (unsure.has(id)) bad.push(`${f.rule} cites ${id}`);
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });

  await check("no finding cites a figure that is not in the ad it cites (F-001 holds across the sweep)", () => {
    const bad = [];
    for (const r of runs) {
      for (const a of r.ads || []) {
        for (const f of a.facts || []) {
          if (f.grounded === false && f.rankable) bad.push(`${a.creativeId}: ungrounded ${f.metric} is rankable`);
        }
      }
    }
    ok(bad.length === 0, `\n       ${bad.join("\n       ")}`);
  });
}

  // -------------------------------------- whose designs are in that number
  //
  // H15. The client's own designs are handed to the themes model on purpose —
  // the cohort contrast is not readable without them — but the framing line
  // counted them into "the N distinct designs captured" while the panel's own
  // readOver.designs counted competitors only. One panel, two Ns for the same
  // noun, and the larger one presented as a competitor figure.
  section("key insights — the framing counts competitors, and says the client was read too");
  {
    const { body: started } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "checking", days: 30,
      competitors: [
        { label: "Campus Federal", domain: "campusfederal.org" },
        { label: "Neighbors Federal Credit Union", domain: "neighborsfcu.org" },
        { label: "EFCU Financial", domain: "efcufinancial.org" },
      ],
    });
    const wall = await S.awaitRun(started.runId);
    const { body: t } = await S.post(`/api/run/${wall.id}/themes`, { scope: "all" });

    if (!t.themes) {
      await check("themes were read for the wall", () => ok(t.themes, `no themes: ${t.reason}`));
    } else {
      await check("the framing's design count is the panel's own competitor count", () => {
        const m = String(t.themes.framing).match(/across the (\d+) distinct/);
        ok(m, `the framing states no count: "${t.themes.framing}"`);
        eq(Number(m[1]), t.designs,
          `the framing says ${m[1]} designs, the panel's readOver says ${t.designs}`);
      });

      await check("and it says so — the number is named as a competitor figure", () =>
        ok(/competitor/i.test(t.themes.framing), `the framing does not say whose designs: "${t.themes.framing}"`));

      await check("creativesRead is the competitor count, not the total handed to the model", () => {
        eq(t.themes.creativesRead, t.designs, "creativesRead");
        ok(t.themes.designsHandedToTheModel >= t.themes.creativesRead,
          "the model was handed fewer designs than the panel counted");
      });

      await check("the client's designs are reported separately, never folded in", () => {
        eq(typeof t.themes.clientDesignsRead, "number", "clientDesignsRead");
        eq(t.themes.designsHandedToTheModel, t.themes.creativesRead + t.themes.clientDesignsRead,
          "the two populations do not add up to what was read");
      });

      await check("no count on this panel names a network the capture cannot establish", () =>
        ok(!/display design|display ad/i.test(JSON.stringify(t.themes)),
          "F-014: a 'display' claim survived in the themes panel"));
    }
  }

summary();
} finally {
  S.stop();
}
