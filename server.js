// =============================================================================
// server.js — RAIN Intelligence
//
// Two modes over ONE capture pipeline:
//   CREATIVE   — what are competitors making? (image creatives, inspiration wall)
//   BENCHMARK  — how do our ads compare to theirs? (ads vs ads, counted facts)
//
// They are not two products. They are two readings of the same evidence store,
// which is why the capture path below branches on exactly one thing — the
// creative format requested — and nothing else.
//
// Capture is asynchronous with polling rather than a blocking POST, for one
// reason: a run touches N+1 advertisers concurrently and the user needs to see
// which ones have landed. A spinner that says nothing for 40 seconds is how a
// salesperson decides a tool is broken.
// =============================================================================

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capture, hasKey, normDomain, MAX_READ_PER_ADVERTISER, DEFAULT_LOOKBACK_DAYS } from "./lib/atc-provider.js";
import { extractCreatives } from "./lib/extract.js";
import { clusterAds, productBreakdown, filterByProduct, buildBenchmark, creativeSummary, samplingNote } from "./lib/analyze.js";
import { suggestCompetitors, findClient, listClients, DIRECTORY_SIZE } from "./lib/directory.js";
import { productFromUrl, normalizeProduct, PRODUCT_LABELS, PRODUCT_CODES } from "./lib/products.js";
import { generateStrategies } from "./lib/strategies.js";
import { hasAnthropicKey } from "./lib/claude.js";
import { newRunId, saveRun, loadRun, listRuns, getCachedExtraction, putCachedExtraction } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-flight runs live in memory; completed runs go to disk. A restart loses
// nothing that mattered — an interrupted capture is cheaper to re-run than to
// resume, and the extraction cache means the second attempt costs almost
// nothing in vision calls.
const ACTIVE = new Map();

// ---------------------------------------------------------------------------
// GET /api/health — what is configured, stated plainly.
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    serpapi: hasKey(),
    anthropic: hasAnthropicKey(),
    directorySize: DIRECTORY_SIZE,
    maxReadPerAdvertiser: MAX_READ_PER_ADVERTISER,
    defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
    products: PRODUCT_CODES.map((c) => ({ code: c, label: PRODUCT_LABELS[c] })),
  });
});

app.get("/api/clients", (_req, res) => res.json({ clients: listClients() }));

// ---------------------------------------------------------------------------
// POST /api/resolve — landing page in, context out.
//
// Deliberately does NO network work. The directory lookup is a file read and
// the product guess is a regex over the URL path, so this returns while the
// user's finger is still on the mouse. Everything expensive waits for an
// explicit Analyze.
// ---------------------------------------------------------------------------
app.post("/api/resolve", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const domain = normDomain(url);
  if (!domain) return res.status(400).json({ ok: false, reason: "bad_url" });

  const { product, from } = productFromUrl(url);
  const dir = suggestCompetitors({ domain, product, limit: 8 });
  const row = findClient(domain);

  // A homepage tells us the institution but not the product. Say so rather than
  // silently analysing "other" — the whole benchmark is scoped by product, so a
  // wrong guess here quietly wrecks every count downstream.
  const looksLikeHomepage = from === "none";

  res.json({
    ok: true,
    domain,
    url,
    product,
    productLabel: PRODUCT_LABELS[product],
    productFrom: from,
    looksLikeHomepage,
    knownClient: !!row,
    client: dir.matched ? dir.client : { name: "", domain, market: "", institutionType: "" },
    competitors: dir.competitors || [],
    directoryMiss: !dir.matched,
  });
});

// ---------------------------------------------------------------------------
// POST /api/capture — start a run.
// ---------------------------------------------------------------------------
app.post("/api/capture", (req, res) => {
  const body = req.body || {};
  const mode = body.mode === "benchmark" ? "benchmark" : "creative";
  const clientDomain = normDomain(body.clientDomain);
  const product = normalizeProduct(body.product || "");
  const days = Math.max(7, Math.min(365, Number(body.days) || DEFAULT_LOOKBACK_DAYS));

  const competitors = (Array.isArray(body.competitors) ? body.competitors : [])
    .map((c) => ({ label: String(c.label || c.name || "").trim(), domain: normDomain(c.domain) }))
    .filter((c) => c.domain)
    .slice(0, 8);

  if (!clientDomain) return res.status(400).json({ ok: false, reason: "bad_client_domain" });
  if (!competitors.length) return res.status(400).json({ ok: false, reason: "no_competitors" });
  if (!hasKey()) return res.status(400).json({ ok: false, reason: "serpapi_not_configured" });
  if (!hasAnthropicKey()) return res.status(400).json({ ok: false, reason: "anthropic_not_configured" });

  // CREATIVE reads image creatives — display work, which is what the creative
  // team asked to see. BENCHMARK reads text creatives, because a paid-search
  // campaign is diagnosed against paid-search ads. The format is the only thing
  // the mode changes about capture.
  const format = mode === "creative" ? "image" : "text";

  const run = {
    id: newRunId(),
    mode, format, product, days,
    productLabel: PRODUCT_LABELS[product],
    createdAt: new Date().toISOString(),
    status: "running",
    client: { label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain },
    competitors,
    // BENCHMARK captures the client's own ads through the identical path. That
    // is what makes it ads vs ads rather than ads vs a live rate page — the
    // comparison a consumer actually makes when they choose which link to click.
    targets: mode === "benchmark"
      ? [{ ...{ label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain }, isClient: true }, ...competitors.map((c) => ({ ...c, isClient: false }))]
      : competitors.map((c) => ({ ...c, isClient: false })),
    progress: {},
    ads: [],
    runs: [],
  };

  for (const t of run.targets) run.progress[t.domain] = { status: "queued", label: t.label };
  ACTIVE.set(run.id, run);

  res.json({ ok: true, runId: run.id, targets: run.targets.map((t) => ({ domain: t.domain, label: t.label, isClient: !!t.isClient })) });

  // Fire and forget. Every failure path below lands in run.progress rather than
  // throwing, because one competitor with no ads must never take down a capture
  // that succeeded for the other two.
  executeRun(run).catch((e) => {
    run.status = "error";
    run.error = e?.code === "NO_API_KEY" ? "anthropic_not_configured" : String(e?.message || e);
    saveRun(run);
  });
});

async function executeRun(run) {
  // All targets concurrently. Serial capture is the difference between a tool
  // somebody opens in front of a client and one they don't.
  await Promise.all(run.targets.map(async (target) => {
    const p = run.progress[target.domain];
    try {
      p.status = "fetching";
      const cap = await capture(target.domain, { format: run.format, days: run.days });

      if (!cap.ok) {
        p.status = "failed";
        p.reason = cap.reason;                 // structured reason, never an exception
        return;
      }

      run.runs.push(cap.run);
      p.found = cap.run.providerTotal;
      p.renderable = cap.run.renderable;
      p.previewOnly = cap.run.previewOnly;
      p.advertisers = cap.run.advertisers;
      p.multipleAdvertisers = cap.run.multipleAdvertisers;

      if (!cap.images.length) {
        p.status = "empty";
        p.reason = cap.reason;
        p.read = 0;
        return;
      }

      p.status = "reading";
      p.downloading = cap.images.length;

      // Extraction cache: a creative's transcription never changes, so it is
      // bought once and reused for every future run and refresh.
      const cached = [], fresh = [];
      for (const img of cap.images) {
        const hit = getCachedExtraction(img.creativeId);
        if (hit) cached.push({ ...hit, imageUrl: img.imageUrl, duplicateIds: img.duplicateIds || [] });
        else fresh.push(img);
      }

      const { ads, extractionFailed } = fresh.length
        ? await extractCreatives(fresh)
        : { ads: [], extractionFailed: 0 };

      for (const ad of ads) putCachedExtraction(ad.creativeId, ad);

      const all = [...cached, ...ads].map((a) => ({ ...a, isClient: !!target.isClient, institutionLabel: target.label }));
      run.ads.push(...all);

      p.status = "done";
      p.read = all.length;
      p.fromCache = cached.length;
      p.extractionFailed = extractionFailed;
      p.capped = cap.run.capped;
    } catch (e) {
      if (e?.code === "NO_API_KEY") throw e;
      p.status = "failed";
      p.reason = "unexpected";
      p.detail = String(e?.message || e).slice(0, 200);
    }
  }));

  run.status = "done";
  run.completedAt = new Date().toISOString();
  run.stats = {
    adsRead: run.ads.length,
    targetsOk: Object.values(run.progress).filter((p) => p.status === "done").length,
    targetsTotal: run.targets.length,
  };
  run.sampling = samplingNote(run.runs);
  saveRun(run);
}

// ---------------------------------------------------------------------------
// GET /api/run/:id — poll a run, or read a finished one.
// ---------------------------------------------------------------------------
app.get("/api/run/:id", (req, res) => {
  const run = ACTIVE.get(req.params.id) || loadRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, reason: "not_found" });

  const payload = {
    ok: true,
    id: run.id, mode: run.mode, status: run.status, error: run.error || null,
    product: run.product, productLabel: run.productLabel, days: run.days,
    client: run.client, competitors: run.competitors,
    progress: run.progress, sampling: run.sampling || null,
    stats: run.stats || null,
    createdAt: run.createdAt,
  };

  if (run.status !== "done") return res.json(payload);

  const competitorAds = run.ads.filter((a) => !a.isClient);
  payload.breakdown = productBreakdown(competitorAds);

  if (run.mode === "creative") {
    const scoped = filterByProduct(competitorAds, run.product);
    payload.creative = {
      summary: creativeSummary(scoped),
      // The wall shows IDEAS, not every execution. Three near-identical rate
      // banners are one idea with three pieces of evidence, and presenting them
      // as three findings produces a wall nobody reads.
      clusters: clusterAds(scoped),
      byCompetitor: run.competitors.map((c) => ({
        ...c,
        count: scoped.filter((a) => a.institution === c.domain).length,
      })),
    };
  } else {
    payload.benchmark = buildBenchmark({
      client: { ...run.client, ads: run.ads.filter((a) => a.isClient) },
      competitors: run.competitors.map((c) => ({ ...c, ads: run.ads.filter((a) => a.institution === c.domain) })),
      product: run.product,
      runs: run.runs,
    });
    payload.strategies = run.strategies || null;
  }

  // The evidence itself, keyed for the drawer. Base64 was discarded after
  // extraction; the URL is what lets the UI show the ad Google actually served.
  payload.ads = run.ads.map(({ data, ...a }) => a);
  res.json(payload);
});

app.get("/api/runs", (_req, res) => res.json({ runs: listRuns({ limit: 25 }) }));

// ---------------------------------------------------------------------------
// POST /api/run/:id/strategies — the GATE.
//
// Interpretation happens here and only here, on an explicit click. The
// benchmark table is the deliverable; this is the optional second screen.
// ---------------------------------------------------------------------------
app.post("/api/run/:id/strategies", async (req, res) => {
  const run = ACTIVE.get(req.params.id) || loadRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, reason: "not_found" });
  if (run.status !== "done") return res.status(409).json({ ok: false, reason: "run_not_finished" });
  if (run.mode !== "benchmark") return res.status(400).json({ ok: false, reason: "wrong_mode" });

  try {
    const benchmark = buildBenchmark({
      client: { ...run.client, ads: run.ads.filter((a) => a.isClient) },
      competitors: run.competitors.map((c) => ({ ...c, ads: run.ads.filter((a) => a.institution === c.domain) })),
      product: run.product,
      runs: run.runs,
    });

    const strategies = await generateStrategies({
      benchmark,
      product: run.product,
      clientLabel: run.client.label,
      sampling: run.sampling,
    });

    run.strategies = strategies;
    ACTIVE.set(run.id, run);
    saveRun(run);
    res.json({ ok: true, strategies });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e?.code === "NO_API_KEY" ? "anthropic_not_configured" : "generation_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RAIN Intelligence on :${PORT}`);
  console.log(`  SerpApi: ${hasKey() ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  Anthropic: ${hasAnthropicKey() ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  Directory: ${DIRECTORY_SIZE} clients`);
});
