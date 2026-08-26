// =============================================================================
// server.js — RAIN Intelligence
//
// Two modes:
//   CREATIVE   — what are competitors making? (inspiration wall)
//   BENCHMARK  — how do our ads compare to theirs? (ads vs ads, counted facts)
//
// Three SOURCES underneath them:
//   google_display — SerpApi, Transparency Center, image creatives
//   google_search  — SerpApi, Transparency Center, text creatives (Benchmark only)
//   meta           — SearchApi, Meta Ad Library, cards
//
// A source is a provider AND a surface AND a set of temporal semantics. Creative
// may capture Google display, Meta, or both — but "both" means TWO RUNS, not one
// run holding two kinds of record. That is deliberate and load-bearing: separate
// runs make it structurally impossible for a Google count and a Meta count to
// end up in the same denominator, or for a Meta capture to be diffed against a
// Google one. The results screen renders them as sibling tabs.
//
// Capture is asynchronous with polling rather than a blocking POST, for one
// reason: a run touches N+1 advertisers concurrently and the user needs to see
// which ones have landed. A spinner that says nothing for 40 seconds is how a
// salesperson decides a tool is broken.
// =============================================================================

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capture, hasKey, normDomain, buildDomainLink, MAX_READ_PER_ADVERTISER, DEFAULT_LOOKBACK_DAYS } from "./lib/atc-provider.js";
import { extractCreatives, extractMetaMessages } from "./lib/extract.js";
import { clusterAds, productBreakdown, filterByProduct, buildBenchmark, creativeSummary, samplingNote, captureFunnel } from "./lib/analyze.js";
import { captureMeta, hasSearchApiKey, MAX_META_PAGES, MAX_META_READ, DEFAULT_META_LOOKBACK_DAYS } from "./lib/meta-provider.js";
import {
  dedupeMessages, enrichDeterministic, metaProductBreakdown, filterMetaByProduct,
  metaCreativeSummary, metaFunnel, metaSamplingNote,
} from "./lib/meta-analyze.js";
import { storeMessageMedia, readMedia } from "./lib/media-store.js";
import * as captureCache from "./lib/capture-cache.js";
import { SOURCES, SOURCE_LABELS, resolveSources, googleFormatFor, isMeta, WINDOW_OPTIONS, defaultWindowFor } from "./lib/sources.js";
import { listIdentities, saveIdentity } from "./lib/platform-identity.js";
import { withNationals, isNational, captureOptionsFor, NATIONAL_BENCHMARKS, NATIONAL_TTL_DAYS, NATIONAL_READ_CAP } from "./lib/national-tier.js";
import { suggestCompetitors, findClient, listClients, DIRECTORY_SIZE } from "./lib/directory.js";
import { productFromUrl, normalizeProduct, PRODUCT_LABELS, PRODUCT_CODES } from "./lib/products.js";
import { generateStrategies } from "./lib/strategies.js";
import { hasAnthropicKey } from "./lib/claude.js";
import { newRunId, saveRun, loadRun, listRuns, getCachedExtraction, putCachedExtraction, findPreviousRun, diffRuns } from "./lib/store.js";

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
    searchapi: hasSearchApiKey(),
    anthropic: hasAnthropicKey(),
    directorySize: DIRECTORY_SIZE,
    maxReadPerAdvertiser: MAX_READ_PER_ADVERTISER,
    defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
    // Availability is PER SOURCE. A missing SearchApi key must not disable
    // Google display, and a missing SerpApi key must not disable a Meta-only
    // capture — the two providers fail independently because they are
    // independent, and one unpaid invoice should not take the product down.
    sources: [
      { key: SOURCES.GOOGLE_DISPLAY, label: SOURCE_LABELS.google_display, available: hasKey(), needs: "SERPAPI_API_KEY" },
      { key: SOURCES.META, label: SOURCE_LABELS.meta, available: hasSearchApiKey(), needs: "SEARCHAPI_API_KEY" },
    ],
    windows: WINDOW_OPTIONS,
    meta: {
      maxPages: MAX_META_PAGES,
      maxRead: MAX_META_READ,
      defaultLookbackDays: DEFAULT_META_LOOKBACK_DAYS,
      identities: Object.keys(listIdentities()).length,
    },
    cacheTtlDays: captureCache.TTL_DAYS,
    nationals: {
      benchmarks: NATIONAL_BENCHMARKS.map(({ label, domain, role, why }) => ({ label, domain, role, why })),
      ttlDays: NATIONAL_TTL_DAYS,
      readCap: NATIONAL_READ_CAP,
    },
    products: PRODUCT_CODES.map((c) => ({ code: c, label: PRODUCT_LABELS[c] })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/cost — what a capture would spend, BEFORE spending it.
//
// Reads the per-advertiser cache without touching a provider, so the competitor
// screen can say "1 request, 3 from cache" while the user is still choosing.
// ---------------------------------------------------------------------------
app.post("/api/cost", (req, res) => {
  const body = req.body || {};
  const mode = body.mode === "benchmark" ? "benchmark" : "creative";
  const sources = resolveSources({ mode, sources: body.sources });
  const force = !!body.force;

  const picked = (Array.isArray(body.competitors) ? body.competitors : [])
    .map((c) => ({ domain: normDomain(c.domain), label: c.label || c.name || c.domain }))
    .filter((c) => c.domain);

  // Quote the cost of what will ACTUALLY be captured, nationals included. A
  // cost line that omits two advertisers the capture is about to fetch is
  // exactly the surprise this endpoint exists to prevent.
  const domainsFor = (source) => {
    const withTier = (mode === "creative" && source === SOURCES.GOOGLE_DISPLAY && body.includeNationals !== false)
      ? withNationals(picked).map((c) => ({ ...c, ttlDays: isNational(c.domain) ? NATIONAL_TTL_DAYS : undefined }))
      : picked.map((c) => ({ ...c, tier: "local" }));
    if (mode === "benchmark" && normDomain(body.clientDomain)) {
      return [{ domain: normDomain(body.clientDomain), label: body.clientLabel || body.clientDomain, tier: "local" }, ...withTier];
    }
    return withTier;
  };

  res.json({
    ok: true,
    plans: sources.map((source) => captureCache.planCost({
      source, domains: domainsFor(source),
      days: Number(body.days?.[source] ?? body.days) || defaultWindowFor(source),
      force,
    })),
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

  // The URL is the default signal, not the only one. Once the user has set a
  // product scope explicitly, competitor ranking has to be re-asked against
  // THAT product — a competitor curated for "checking" should outrank a
  // market-wide one the moment checking is what we are looking at.
  const guessed = productFromUrl(url);
  const override = String(req.body?.product || "").trim();
  const product = override ? normalizeProduct(override) : guessed.product;
  const from = override ? "explicit" : guessed.from;

  const dir = suggestCompetitors({ domain, product, limit: 8 });
  const row = findClient(domain);

  // A homepage tells us the institution but not the product. Say so rather than
  // silently analysing "other" — the whole benchmark is scoped by product, so a
  // wrong guess here quietly wrecks every count downstream.
  const looksLikeHomepage = guessed.from === "none" && !override;

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
  const force = !!body.force;

  // Benchmark is pinned to Google search inside resolveSources, so no caller can
  // quietly change what that table is comparing.
  const sources = resolveSources({ mode, sources: body.sources });

  // Targets are keyed by domain in run.progress, so a repeated domain would
  // overwrite its own progress row and be counted as two columns holding the
  // same ads. In benchmark the client is already a target, so it cannot also be
  // its own competitor. Deduped here rather than trusting the caller.
  const claimed = new Set(mode === "benchmark" && clientDomain ? [clientDomain] : []);
  const chosen = (Array.isArray(body.competitors) ? body.competitors : [])
    .map((c) => ({ label: String(c.label || c.name || "").trim(), domain: normDomain(c.domain) }))
    .filter((c) => c.domain && !claimed.has(c.domain) && claimed.add(c.domain))
    .slice(0, 8);

  /* THE STANDING NATIONALS — appended per source, not globally.
   *
   * Mirrors RAIN's six-column analysis, where slots 4 and 5 are Chase and
   * Capital One and never change. The user does not choose them.
   *
   * GOOGLE DISPLAY ONLY, on evidence:
   *
   *   · Benchmark — that mode compares the client's own ads to peers on one
   *     product. A national ceiling dropped into that table sits in a column
   *     the client reads as a peer, which is a different and wrong claim.
   *
   *   · Meta — the live probe found Chase's Meta presence is influencer and
   *     brand content (#Chasepartner), with 1 of 36 ads product-classifiable
   *     and Page resolution graded LOW at a 0.0033 margin. Injecting it would
   *     spend a page-search request to land in needs_confirmation, and if
   *     confirmed would fill the wall with creator posts rather than product
   *     advertising. Filling an empty wall with the wrong ads is not filling it.
   *     Revisit when a national's Meta coverage has actually been tested.
   *
   * `includeNationals: false` turns it off for a caller that wants only what
   * was selected.
   */
  const nationalsAllowed = (source) =>
    mode === "creative" && source === SOURCES.GOOGLE_DISPLAY && body.includeNationals !== false;

  const competitorsFor = (source) =>
    withNationals(chosen, { enabled: nationalsAllowed(source) })
      .filter((c) => !claimed.has(c.domain) || chosen.some((x) => x.domain === c.domain));

  if (!clientDomain) return res.status(400).json({ ok: false, reason: "bad_client_domain" });
  // Validated against what the USER CHOSE, not the final list. The standing
  // nationals are always appended, so checking the final list would let a
  // capture with nothing selected proceed on Chase and Capital One alone — a
  // wall of two national brands and no local evidence, which answers a question
  // nobody asked.
  if (!chosen.length) return res.status(400).json({ ok: false, reason: "no_competitors" });
  if (!hasAnthropicKey()) return res.status(400).json({ ok: false, reason: "anthropic_not_configured" });

  // Per-source key checks. A missing SearchApi key refuses the Meta source only
  // and leaves a Google capture in the same request running normally.
  const usable = [], refused = [];
  for (const source of sources) {
    if (isMeta(source) && !hasSearchApiKey()) refused.push({ source, reason: "searchapi_not_configured" });
    else if (!isMeta(source) && !hasKey()) refused.push({ source, reason: "serpapi_not_configured" });
    else usable.push(source);
  }
  if (!usable.length) {
    return res.status(400).json({ ok: false, reason: refused[0]?.reason || "not_configured", refused });
  }

  // ONE RUN PER SOURCE. Two sources means two runs with separate ids, separate
  // funnels, separate sampling notes and separate diffs — which is what makes a
  // merged denominator impossible rather than merely discouraged.
  const runs = usable.map((source) => {
    const days = Math.max(7, Math.min(365,
      Number(body.days?.[source] ?? body.days) || defaultWindowFor(source)));
    const competitors = competitorsFor(source);

    const run = {
      id: newRunId(),
      mode, source, product, days, force,
      sourceLabel: SOURCE_LABELS[source],
      format: isMeta(source) ? null : googleFormatFor(source),
      productLabel: PRODUCT_LABELS[product],
      createdAt: new Date().toISOString(),
      status: "running",
      client: { label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain },
      competitors,
      // BENCHMARK captures the client's own ads through the identical path. That
      // is what makes it ads vs ads rather than ads vs a live rate page — the
      // comparison a consumer actually makes when they choose which link to click.
      targets: mode === "benchmark"
        ? [{ label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain, isClient: true },
           ...competitors.map((c) => ({ ...c, isClient: false }))]
        : competitors.map((c) => ({ ...c, isClient: false })),
      progress: {},
      ads: [],
      messages: [],
      runs: [],
      requests: 0,
    };
    for (const t of run.targets) run.progress[t.domain] = { status: "queued", label: t.label };
    ACTIVE.set(run.id, run);
    return run;
  });

  res.json({
    ok: true,
    // `runId` and `targets` stay for the single-source callers that predate
    // multi-source capture; `runs` is what the current UI reads.
    runId: runs[0].id,
    targets: runs[0].targets.map((t) => ({ domain: t.domain, label: t.label, isClient: !!t.isClient })),
    runs: runs.map((r) => ({
      source: r.source, sourceLabel: r.sourceLabel, runId: r.id, days: r.days,
      targets: r.targets.map((t) => ({ domain: t.domain, label: t.label, isClient: !!t.isClient })),
    })),
    refused,
  });

  // Fire and forget. Every failure path below lands in run.progress rather than
  // throwing, because one competitor with no ads must never take down a capture
  // that succeeded for the other two.
  for (const run of runs) {
    const exec = isMeta(run.source) ? executeMetaRun : executeRun;
    exec(run).catch((e) => {
      run.status = "error";
      run.error = e?.code === "NO_API_KEY" ? "anthropic_not_configured" : String(e?.message || e);
      saveRun(run);
    });
  }
});

async function executeRun(run) {
  // All targets concurrently. Serial capture is the difference between a tool
  // somebody opens in front of a client and one they don't.
  await Promise.all(run.targets.map(async (target) => {
    const p = run.progress[target.domain];
    try {
      // ---- cache first ------------------------------------------------------
      // Keyed on (source, domain, window) and NOT on product, because capture is
      // product-agnostic: one LaCap capture serves every product scope the team
      // tests that week. Bank creative moves on a compliance cycle measured in
      // weeks, so a fresh entry is the right answer far more often than a fetch.
      // Per-tier options: a national is read deeper and kept far longer,
      // because that capture is shared by every client rather than bought per
      // analysis. See lib/national-tier.js.
      const opts = captureOptionsFor(target.domain, {});
      const ck = { source: run.source, domain: target.domain, days: run.days };
      const cached = captureCache.get({ ...ck, force: run.force, ttlDays: opts.ttlDays });
      if (cached) {
        p.status = "done";
        p.fromCaptureCache = true;
        p.captureAgeDays = cached._cache.ageDays;
        p.found = cached.run?.providerTotal;
        p.renderable = cached.run?.renderable;
        p.previewOnly = cached.run?.previewOnly;
        p.advertisers = cached.run?.advertisers;
        p.multipleAdvertisers = cached.run?.multipleAdvertisers;
        p.read = (cached.ads || []).length;
        p.tier = target.tier || "local";
        if (cached.run) run.runs.push(cached.run);
        run.ads.push(...(cached.ads || []).map((a) => ({
          ...a, isClient: !!target.isClient, institutionLabel: target.label, tier: target.tier || "local",
        })));
        return;
      }

      p.status = "fetching";
      const cap = await capture(target.domain, { format: run.format, days: run.days, max: opts.max });
      run.requests += 1;

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
      const cachedExtractions = [], fresh = [];
      for (const img of cap.images) {
        const hit = getCachedExtraction(img.creativeId);
        // The cache stores a TRANSCRIPTION, which never changes. Attribution is
        // not part of it: the same creative retrieved under a different entered
        // domain belongs to that domain now, so provider-side fields are always
        // re-applied from this capture rather than replayed from the cache.
        if (hit) {
          cachedExtractions.push({
            ...hit,
            imageUrl: img.imageUrl,
            duplicateIds: img.duplicateIds || [],
            institution: img.domain,
            advertiser: img.advertiser || "",
            advertiserId: img.advertiserId || "",
            targetDomain: img.targetDomain || "",
            firstShown: img.firstShown,
            lastShown: img.lastShown,
            totalDaysShown: img.totalDaysShown,
          });
        } else fresh.push(img);
      }

      const { ads, extractionFailed } = fresh.length
        ? await extractCreatives(fresh)
        : { ads: [], extractionFailed: 0 };

      for (const ad of ads) putCachedExtraction(ad.creativeId, ad);

      const all = [...cachedExtractions, ...ads].map((a) => ({
        ...a, isClient: !!target.isClient, institutionLabel: target.label, tier: target.tier || "local",
      }));
      p.tier = target.tier || "local";
      run.ads.push(...all);

      // Downloading creatives and then reading none of them is a failure with a
      // cause, not a completed capture that happens to be empty. Reporting it as
      // "done · 0 read" is how a broken vision path looks exactly like a
      // competitor who simply is not advertising.
      p.status = all.length ? "done" : "empty";
      p.reason = all.length ? undefined : "extraction_failed";
      p.read = all.length;
      p.fromCache = cachedExtractions.length;

      // Only a capture that actually produced readable evidence is cached. An
      // empty or failed one must be retried next time, not remembered for a week.
      if (all.length) {
        captureCache.put(ck, {
          run: cap.run,
          // Per-run framing is stripped: the same Chase capture is reused for
          // every client, so nothing client-specific may be baked into it.
          ads: all.map(({ isClient, institutionLabel, tier, ...a }) => a),
        });
      }
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

  // ---- what changed since the last comparable capture ----------------------
  // The provider returns a rotating SAMPLE, not an inventory: the same query
  // twice returns overlapping but different creatives. A single run therefore
  // cannot say what a competitor is running — but two runs can say what we have
  // and have not seen before, which is the honest version of the same question.
  //
  // Note the wording downstream: an ad missing from this capture is "no longer
  // observed", never "stopped running". It may simply not have been sampled.
  const prev = findPreviousRun(run);
  if (prev) {
    run.diff = { ...diffRuns(prev, run), previousRunId: prev.id, previousAt: prev.createdAt };
  }

  saveRun(run);
}

// ---------------------------------------------------------------------------
// META EXECUTION — its own path, on purpose.
//
// Shares no state with executeRun above. The two produce different record types
// with different grains and different temporal semantics, and a shared function
// with `if (isMeta)` branches is how those differences leak into each other.
// ---------------------------------------------------------------------------
async function executeMetaRun(run) {
  await Promise.all(run.targets.map(async (target) => {
    const p = run.progress[target.domain];
    const ck = { source: run.source, domain: target.domain, days: run.days };
    try {
      const cached = captureCache.get({ ...ck, force: run.force });
      if (cached) {
        p.status = "done";
        p.fromCaptureCache = true;
        p.captureAgeDays = cached._cache.ageDays;
        applyMetaCapture(run, target, p, cached);
        return;
      }

      p.status = "resolving";
      const cap = await captureMeta({
        domain: target.domain, label: target.label,
        days: run.days, maxPages: MAX_META_PAGES,
      });
      run.requests += cap.requests || 0;
      p.requests = cap.requests || 0;

      if (!cap.ok) {
        // A Page we could not resolve and a Page with no ads are DIFFERENT
        // facts, and the UI renders them differently. Collapsing them turns a
        // lookup failure into a claim about a competitor's advertising.
        p.status = cap.reason === "needs_confirmation" ? "needs_confirmation" : "failed";
        p.reason = cap.reason;
        p.pageResolved = !!cap.pageResolved;
        p.candidates = cap.candidates || null;
        return;
      }

      p.pageResolved = true;
      p.pageId = cap.run.pageId;
      p.pageName = cap.run.pageName;
      p.pageGrade = cap.run.pageGrade;
      p.found = cap.run.providerTotal;
      p.retrieved = cap.run.retrieved;
      p.pagesFetched = cap.run.pagesFetched;
      p.moreAvailable = cap.run.moreAvailable;

      if (!cap.units.length) {
        p.status = "empty";
        p.reason = "no_ads";
        p.read = 0;
        run.runs.push(cap.run);
        return;
      }

      p.status = "reading";

      // ---- dedupe BEFORE anything is paid for ------------------------------
      // 420 cards behind 111 probed ads, most of them the same copy rendered at
      // different sizes. Reading every asset would buy the same answer several
      // times over.
      const messages = dedupeMessages(cap.units);
      p.rawUnits = cap.units.length;
      p.messages = messages.length;

      // ---- tiers 1 and 2: free -------------------------------------------
      const det = enrichDeterministic(messages);
      p.fromUrl = det.fromUrl;
      p.fromText = det.fromText;

      // ---- media: download now, because these URLs expire -----------------
      const media = await storeMessageMedia(messages);
      p.mediaStored = media.stored;
      p.mediaFailed = media.failed;

      // ---- tier 3: vision, only on what is still unresolved ---------------
      const needing = det.needsVision.filter((m) => m.mediaStored).slice(0, MAX_META_READ);
      for (const m of needing) {
        const stored = readMedia(m.mediaHash);
        if (stored) { m._mediaData = stored.buffer.toString("base64"); m._mediaType = stored.contentType; }
      }
      const vision = needing.length ? await extractMetaMessages(needing) : { read: 0, failed: 0 };
      for (const m of messages) { delete m._mediaData; delete m._mediaType; }

      p.visionRead = vision.read;
      p.visionFailed = vision.failed;
      p.read = messages.length;
      p.rainManaged = messages.filter((m) => m.rainManaged).length;

      run.runs.push({ ...cap.run, visionRead: vision.read });
      run.messages.push(...messages.map((m) => ({
        ...m, isClient: !!target.isClient, institutionLabel: target.label,
      })));
      p.status = "done";

      captureCache.put(ck, {
        run: { ...cap.run, visionRead: vision.read },
        messages: messages.map(({ isClient, institutionLabel, ...m }) => m),
      });
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
    messagesRead: run.messages.length,
    targetsOk: Object.values(run.progress).filter((x) => x.status === "done").length,
    targetsTotal: run.targets.length,
    requests: run.requests,
  };
  run.sampling = metaSamplingNote(run.runs);
  saveRun(run);
}

function applyMetaCapture(run, target, p, cached) {
  const messages = cached.messages || [];
  p.found = cached.run?.providerTotal;
  p.retrieved = cached.run?.retrieved;
  p.rawUnits = cached.run?.rawUnits;
  p.messages = messages.length;
  p.read = messages.length;
  p.pageResolved = true;
  p.pageId = cached.run?.pageId;
  p.pageName = cached.run?.pageName;
  p.pageGrade = cached.run?.pageGrade;
  p.moreAvailable = cached.run?.moreAvailable;
  p.rainManaged = messages.filter((m) => m.rainManaged).length;
  if (cached.run) run.runs.push(cached.run);
  run.messages.push(...messages.map((m) => ({
    ...m, isClient: !!target.isClient, institutionLabel: target.label,
  })));
}

/**
 * Assemble the benchmark for a finished run.
 *
 * ONE definition, used by both the table and the gated strategy pass, because a
 * strategy generated from a differently-assembled benchmark is a strategy about
 * numbers the client never saw.
 */
function benchmarkFor(run) {
  return buildBenchmark({
    client: { ...run.client, ads: run.ads.filter((a) => a.isClient) },
    competitors: run.competitors.map((c) => ({
      ...c, ads: run.ads.filter((a) => !a.isClient && a.institution === c.domain),
    })),
    product: run.product,
    runs: run.runs,
  });
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
    source: run.source || SOURCES.GOOGLE_DISPLAY,
    sourceLabel: run.sourceLabel || SOURCE_LABELS[run.source] || SOURCE_LABELS.google_display,
    product: run.product, productLabel: run.productLabel, days: run.days,
    client: run.client, competitors: run.competitors,
    progress: run.progress, sampling: run.sampling || null,
    diff: run.diff || null,
    stats: run.stats || null,
    requests: run.requests || 0,
    createdAt: run.createdAt,
  };

  if (run.status !== "done") return res.json(payload);

  // ---- META ---------------------------------------------------------------
  // Its own branch, its own payload shape, its own counts. Nothing here is ever
  // merged with, compared to, or summed alongside a Google run.
  if (isMeta(run.source)) {
    const all = run.messages.filter((m) => !m.isClient);
    // RAIN-managed work stays IN the wall, badged. Most RAIN clients compete in
    // different markets, so a client's own agency-run creative appearing as a
    // "competitor" is rare — and the creative team gains from seeing prior work.
    // Flagged, never hidden, and never silently counted as an external
    // competitor's strategy.
    const scoped = filterMetaByProduct(all, run.product);

    payload.meta = {
      productScope: run.product,
      defaultProductFilter: scoped.length ? run.product : "all",
      scopedCount: scoped.length,
      capturedCount: all.length,
      messages: all,
      summary: metaCreativeSummary(all),
      scopedSummary: metaCreativeSummary(scoped),
      byProduct: metaProductBreakdown(all),
      byCompetitor: run.competitors.map((c) => ({
        ...c,
        count: all.filter((m) => m.institution === c.domain).length,
        rainManaged: all.filter((m) => m.institution === c.domain && m.rainManaged).length,
      })),
      rainManaged: all.filter((m) => m.rainManaged).length,
      funnel: metaFunnel(run.runs, all, scoped.length,
        run.runs.reduce((n, r) => n + (Number(r?.visionRead) || 0), 0)),
    };
    return res.json(payload);
  }

  const competitorAds = run.ads.filter((a) => !a.isClient);
  payload.breakdown = productBreakdown(competitorAds);

  if (run.mode === "creative") {
    const scoped = filterByProduct(competitorAds, run.product);

    // A banner that says "Bank With Us" and nothing else classifies as "other",
    // and that is the CORRECT classification — most display creatives carry no
    // product signal at all. Scoping the wall strictly to one product therefore
    // empties it routinely, which reads as "retrieval is broken" when in fact
    // the creatives were read and shown to nobody.
    //
    // EVERY captured creative is sent, always. The product scope becomes the
    // DEFAULT FILTER rather than a gate on the payload — previously the chips
    // were computed over the scoped slice, so a capture that read 12 and scoped
    // to 2 rendered a chip saying "All products 2" and the other 10 were
    // unreachable from the UI. The counts a filter offers have to describe what
    // is actually in hand.
    payload.creative = {
      productScope: run.product,
      // Pre-select the scope only when it has something in it. Landing on an
      // empty wall is the failure this whole path exists to avoid.
      defaultProductFilter: scoped.length ? run.product : "all",
      scopedCount: scoped.length,
      capturedCount: competitorAds.length,
      summary: creativeSummary(competitorAds),
      scopedSummary: creativeSummary(scoped),
      // The wall shows IDEAS, not every execution. Three near-identical rate
      // banners are one idea with three pieces of evidence, and presenting them
      // as three findings produces a wall nobody reads.
      clusters: clusterAds(competitorAds),
      byProduct: productBreakdown(competitorAds),
      byCompetitor: run.competitors.map((c) => ({
        ...c,
        tier: c.tier || "local",
        count: competitorAds.filter((a) => a.institution === c.domain).length,
      })),
      // The wall renders these as two groups. Volume asymmetry is the reason:
      // a community bank might contribute four cards while Chase contributes
      // forty, and an undifferentiated wall is then a Chase wall with the local
      // evidence — the part that answers "who takes our customers" — buried.
      // Fixing an empty wall by burying the local signal is not a fix.
      tiers: {
        local: {
          label: "Local and regional",
          note: "Who actually competes for this client's customers.",
          domains: run.competitors.filter((c) => (c.tier || "local") === "local").map((c) => c.domain),
          count: competitorAds.filter((a) => (a.tier || "local") === "local").length,
        },
        national: {
          label: "National benchmarks",
          note: "Chase and Capital One are in every analysis as a fixed national ceiling, not because they compete locally.",
          domains: run.competitors.filter((c) => c.tier === "national").map((c) => c.domain),
          count: competitorAds.filter((a) => a.tier === "national").length,
        },
      },
      // Where every creative went, listed -> on-product. See captureFunnel().
      funnel: captureFunnel(run.runs, competitorAds, scoped.length),
    };
  } else {
    payload.benchmark = benchmarkFor(run);
    payload.funnel = captureFunnel(run.runs, run.ads,
      payload.benchmark.columns.reduce((n, c) => n + c.adCount, 0));
    payload.strategies = run.strategies || null;
  }

  // The evidence itself, keyed for the drawer. Base64 was discarded after
  // extraction; the URL is what lets the UI show the ad Google actually served.
  //
  // `domainLink` is added here and becomes the PRIMARY "view source" link.
  // The provider's own details_link opens /advertiser/AR…/creative/CR…, which
  // is titled with whoever Google verified as the advertiser — frequently a
  // media agency rather than the bank. On a screen share that reads as the tool
  // having pulled the wrong institution. The domain-scoped view is titled with
  // the domain that was entered and shows every advertiser account pointing at
  // it, which is both less confusing and more complete. details_link stays as
  // the secondary "this exact creative" link in the drawer.
  payload.ads = run.ads.map(({ data, ...a }) => ({
    ...a,
    domainLink: buildDomainLink(a.institution, { days: run.days, format: run.format }),
  }));
  res.json(payload);
});

app.get("/api/runs", (_req, res) => res.json({ runs: listRuns({ limit: 25 }) }));

// ---------------------------------------------------------------------------
// GET /api/img?u= — creative image proxy.
//
// The wall used to point <img> straight at Google's CDN. That works until it
// does not: simgad URLs are served for the Transparency Center's own front end
// and can be refused cross-origin, and when they are, every card on the wall
// renders as "could not be loaded" and the tool looks broken rather than
// hotlink-blocked. The bytes are already fetched server-side during capture, so
// serving them through the same origin removes the whole failure class.
//
// STRICT HOST ALLOWLIST. A proxy that will fetch any URL a query string names is
// an SSRF hole pointed at whatever else is reachable from this host, so only the
// two CDNs the provider actually returns are permitted.
// ---------------------------------------------------------------------------
const IMAGE_HOSTS = new Set([
  "tpc.googlesyndication.com",
  "s0.2mdn.net",
  "displayads-formats.googleusercontent.com",
  "lh3.googleusercontent.com",
]);

app.get("/api/img", async (req, res) => {
  let target;
  try { target = new URL(String(req.query.u || "")); }
  catch { return res.status(400).end(); }

  if (target.protocol !== "https:" || !IMAGE_HOSTS.has(target.hostname)) {
    return res.status(400).end();
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const upstream = await fetch(target.href, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!upstream.ok) return res.status(502).end();

    const ct = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(ct)) return res.status(415).end();

    const buf = Buffer.from(await upstream.arrayBuffer());
    // A creative's pixels never change, which is the same reason the extraction
    // cache exists. Cache hard.
    res.set("content-type", ct);
    res.set("cache-control", "public, max-age=86400, immutable");
    res.send(buf);
  } catch {
    res.status(504).end();
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:hash — locally stored Meta creative.
//
// Not a proxy. The bytes were downloaded during capture, while the signed
// fbcdn.net URL was still valid, and stored by content hash. This serves what
// we own — which is the only reason a Meta wall still renders a week later.
// ---------------------------------------------------------------------------
app.get("/api/media/:hash", (req, res) => {
  const stored = readMedia(req.params.hash);
  if (!stored) return res.status(404).end();
  res.set("content-type", stored.contentType || "image/jpeg");
  res.set("cache-control", "public, max-age=604800, immutable");
  res.send(stored.buffer);
});

// ---------------------------------------------------------------------------
// POST /api/meta/confirm-page — a human settles an ambiguous Page match.
//
// The Chase case: a name score of 1.0 with a margin of 0.0033 over the next
// candidate means many Pages share that name, so the resolver refuses to guess
// and asks. Once confirmed the mapping is persisted and nobody is asked again.
// ---------------------------------------------------------------------------
app.post("/api/meta/confirm-page", (req, res) => {
  const domain = normDomain(req.body?.domain);
  const pageId = String(req.body?.pageId || "").trim();
  if (!domain || !pageId) return res.status(400).json({ ok: false, reason: "bad_request" });

  const saved = saveIdentity(domain, {
    metaPageId: pageId,
    metaPageName: String(req.body?.pageName || "").trim(),
    resolvedBy: "manual",
    confidence: "high",
    note: "confirmed by a strategist in the capture flow",
  });
  res.json({ ok: saved, domain, pageId });
});

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
    // Built from the same function that produced the table the user is looking
    // at. Two call sites that assemble the benchmark separately is how the
    // strategy pass ends up reasoning over numbers nobody was shown.
    const benchmark = benchmarkFor(run);

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
