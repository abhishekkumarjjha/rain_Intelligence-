// =============================================================================
// server.js — RAIN Intelligence
//
// Two modes:
//   CREATIVE   — what are competitors making? (inspiration wall)
//   BENCHMARK  — how do our ads compare to theirs? (ads vs ads, counted facts)
//
// Two SOURCES underneath them:
//   google_display — SerpApi, Transparency Center, image creatives
//   google_search  — SerpApi, Transparency Center, text creatives (Benchmark only)
//
// A source is a provider AND a surface AND a set of temporal semantics. One run
// per source, always: separate runs make it structurally impossible for two
// surfaces' counts to end up in the same denominator, or for one to be diffed
// against the other. The results screen renders them as sibling tabs.
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
import { extractByFormat, readerFor, readerKey } from "./lib/extract.js";
import { buildBoard } from "./lib/benchmark.js";
import { readThemes, usableFamilies, MIN_FAMILIES } from "./lib/themes.js";
import { channelShape, cohortShape } from "./lib/channel-shape.js";
import { readRatePages } from "./lib/rate-page.js";
import {
  putEvidence, getEvidence, putSnapshot, previousSnapshot,
  competitorSetVersion, putWatchedSet, getWatchedSet,
} from "./lib/snapshot.js";
import { clusterAds, productBreakdown, filterByProduct, buildBenchmark, creativeSummary, samplingNote, captureFunnel, isShowable } from "./lib/analyze.js";
import * as captureCache from "./lib/capture-cache.js";
import { SOURCES, SOURCE_LABELS, resolveSources, googleFormatFor, WINDOW_OPTIONS, defaultWindowFor } from "./lib/sources.js";
import { withNationals, isNational, captureOptionsFor, NATIONAL_BENCHMARKS, NATIONAL_TTL_DAYS, NATIONAL_READ_CAP } from "./lib/national-tier.js";
import { suggestCompetitors, findClient, listClients, DIRECTORY_SIZE } from "./lib/directory.js";
import { productFromUrl, normalizeProduct, PRODUCT_LABELS, PRODUCT_CODES } from "./lib/products.js";
import { readProductFromUrl, CONFIDENT } from "./lib/product-reader.js";
import { hasAnthropicKey } from "./lib/claude.js";
import { newRunId, saveRun, loadRun, listRuns, getCachedExtraction, putCachedExtraction, findPreviousRun, diffRuns, writeManifest, readManifest, CACHE_SCHEMA } from "./lib/store.js";

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
// ONE WRITER PER RUN.
//
// Opening Key insights fires TWO POSTs at once — the general read and the run
// own product — and the run record is a single JSON file. When the run is not
// in ACTIVE (evicted, or the process restarted since the capture), each handler
// loadRun()s its OWN copy of the record, writes its own scope into
// themesByScope, and saveRun()s the whole object. The second save overwrites the
// first: one scope is silently lost from disk, and the next time someone opens
// that panel it is paid for again.
//
// Serialising the read-modify-write is the fix, not serialising the model call.
// The two scopes are genuinely independent reads and should still run at the
// same time; it is only the merge into the file that has to be one at a time,
// and it has to re-read the record INSIDE the lock — a copy loaded before the
// lock was taken is already stale by the time it is granted.
// ---------------------------------------------------------------------------
const RUN_WRITE_LOCKS = new Map();

function withRunLock(runId, fn) {
  const prev = RUN_WRITE_LOCKS.get(runId) || Promise.resolve();
  // .then(fn, fn): a previous holder that threw must not wedge the queue.
  const result = prev.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  RUN_WRITE_LOCKS.set(runId, tail);
  tail.then(() => { if (RUN_WRITE_LOCKS.get(runId) === tail) RUN_WRITE_LOCKS.delete(runId); });
  return result;
}

/**
 * Read the run, apply `mutate`, write it back — with nobody else in between.
 *
 * Always re-reads through ACTIVE/disk inside the lock, so a scope written by a
 * request that finished while this one was waiting on the model survives.
 */
function updateRun(runId, mutate) {
  return withRunLock(runId, () => {
    const current = ACTIVE.get(runId) || loadRun(runId);
    if (!current) return { ok: false, run: null, persisted: false };
    mutate(current);
    ACTIVE.set(runId, current);
    return { ok: true, run: current, persisted: saveRun(current) };
  });
}

// The same panel opening twice — a double-click, or a reopened tab — must not
// buy the same read twice. Keyed on run AND scope, because two DIFFERENT scopes
// are two different questions and both are legitimately in flight at once.
const THEMES_INFLIGHT = new Map();

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
    // Availability is PER SOURCE.
    sources: [
      { key: SOURCES.GOOGLE_DISPLAY, label: SOURCE_LABELS.google_display, available: hasKey(), needs: "SERPAPI_API_KEY" },
    ],
    windows: WINDOW_OPTIONS,
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
    // BOTH halves capture the client now, so both quote it. A cost line that
    // omits an advertiser the capture is about to fetch is exactly the surprise
    // this endpoint exists to prevent.
    if (normDomain(body.clientDomain)) {
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
app.post("/api/resolve", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const domain = normDomain(url);
  if (!domain) return res.status(400).json({ ok: false, reason: "bad_url" });

  // The URL is the default signal, not the only one. Once the user has set a
  // product scope explicitly, competitor ranking has to be re-asked against
  // THAT product — a competitor curated for "checking" should outrank a
  // market-wide one the moment checking is what we are looking at.
  const guessed = productFromUrl(url);
  const override = String(req.body?.product || "").trim();

  // THE MODEL ONLY RUNS WHEN THE PATTERN FOUND NOTHING.
  //
  // The regex handles /checking-accounts and /credit-cards for free. It cannot
  // handle /choice-checking or /platinum-card, because banks brand everything
  // and there is no finite list of the names they invent. One cheap call reads
  // the words; anything short of confident still goes to the user, because a
  // product this tool cannot infer is one the strategist has to supply.
  let read = null;
  if (!override && guessed.from === "none") {
    try { read = await readProductFromUrl(url); } catch { read = null; }
  }
  const inferred = CONFIDENT(read) ? read.product : guessed.product;
  const product = override ? normalizeProduct(override) : inferred;
  const from = override ? "explicit" : (CONFIDENT(read) ? "model" : guessed.from);

  const dir = suggestCompetitors({ domain, product, limit: 8 });
  const row = findClient(domain);

  // A homepage tells us the institution but not the product. Say so rather than
  // silently analysing "other" — the whole benchmark is scoped by product, so a
  // wrong guess here quietly wrecks every count downstream.
  // Blocks the capture until the user settles it. True whenever neither the
  // path nor the model produced a product we are willing to act on.
  const looksLikeHomepage = !override && guessed.from === "none" && !CONFIDENT(read);

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
   * GOOGLE DISPLAY ONLY here. Competitive Intelligence gets its own national
   * reference tier, rendered below a rule and excluded from every denominator —
   * a national ceiling dropped inline into that table sits in a column the
   * client reads as a peer, which is a different and wrong claim.
   *
   * `includeNationals: false` turns it off for a caller that wants only what
   * was selected.
   */
  // Benchmark now carries the nationals too, but as a REFERENCE TIER: they get
  // a row in the offer snapshot and are excluded from every denominator (see
  // benchmark.js). Previously they were blocked here entirely, on the grounds
  // that a national column reads as a peer — that objection is answered by
  // tiering and labelling the rows rather than by omitting them.
  const nationalsAllowed = (source) =>
    body.includeNationals !== false && (
      (mode === "creative" && source === SOURCES.GOOGLE_DISPLAY) ||
      (mode === "benchmark" && source === SOURCES.GOOGLE_SEARCH)
    );

  const competitorsFor = (source) =>
    withNationals(chosen, { enabled: nationalsAllowed(source) })
      .filter((c) => !claimed.has(c.domain) || chosen.some((x) => x.domain === c.domain));

  if (!clientDomain) return res.status(400).json({ ok: false, reason: "bad_client_domain" });
  // Validated against what the USER CHOSE, not the final list. The standing
  // nationals are always appended, so checking the final list would let a
  // capture with nothing selected proceed on Chase and Capital One alone — a
  // wall of two national brands and no local evidence, which answers a question
  // nobody asked.
  //
  // A SEED is the one legitimate exception, and it is a different intent
  // rather than a loophole. Nationals are captured once per quarter and shared
  // by every client, so somebody has to fill that cache before any wall can
  // read from it — and doing it by attaching a local competitor nobody asked
  // about would distort a real analysis to get a side effect. `seed: true`
  // says plainly what it is: warm the shared national cache, produce no
  // client-facing wall. The guard still stands for every ordinary capture.
  const seed = body.seed === true;
  if (!chosen.length && !seed) return res.status(400).json({ ok: false, reason: "no_competitors" });
  if (seed && chosen.length) return res.status(400).json({ ok: false, reason: "seed_takes_no_competitors" });
  if (!hasAnthropicKey()) return res.status(400).json({ ok: false, reason: "anthropic_not_configured" });

  // ---- FAIL CLOSED ON AN UNKNOWN PRODUCT ----------------------------------
  //
  // Competitive Intelligence is product-scoped by definition: every
  // denominator, every ratio and every piece of evidence means "among the ads
  // about THIS product". "Other" is not a product — bucketFor() treats it as a
  // wildcard, so the scope filter switches OFF and every captured ad becomes
  // on-product.
  //
  // That is how a credit-card run came back citing Google Maps listings and
  // auto-loan ads as message-gap evidence, over a funnel proudly reporting
  // "131 of 131 on the product in scope". Nothing downstream was broken. Every
  // engine worked correctly on a population that had never been filtered.
  //
  // The UI blocks this as well, but a UI guard is a courtesy and this is an
  // invariant: no later stage can repair an invalid scope, so the run must not
  // start at all. The Wall is unaffected — browsing everything is its job.
  if (mode === "benchmark" && (!product || product === "other")) {
    return res.status(400).json({ ok: false, reason: "product_required" });
  }

  // Per-source key checks.
  // and leaves a Google capture in the same request running normally.
  const usable = [], refused = [];
  for (const source of sources) {
    if (!hasKey()) refused.push({ source, reason: "serpapi_not_configured" });
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
      format: googleFormatFor(source),
      productLabel: PRODUCT_LABELS[product],
      createdAt: new Date().toISOString(),
      status: "running",
      client: { label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain },
      competitors,
      // BOTH HALVES capture the client's own ads through the identical path.
      //
      // Benchmark always did: it is what makes it ads vs ads rather than ads vs
      // a live rate page, the comparison a consumer actually makes when they
      // choose which link to click. The Wall did not, on the grounds that it
      // showed what competitors MADE — and that reading does not survive
      // contact with the job. You cannot say "competitors lead with a bonus"
      // and mean anything by it without knowing whether the client does too,
      // and a strategist looking at a wall of competitor creative has no way to
      // answer that from the screen.
      //
      // The client is captured, tiered as `client`, and kept OUT of every
      // competitor count, chip, denominator and funnel step. It is a third
      // population beside regional and national, never a member of either.
      targets: [
        { label: String(body.clientLabel || "").trim() || clientDomain, domain: clientDomain, isClient: true, tier: "client" },
        ...competitors.map((c) => ({ ...c, isClient: false })),
      ],
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
    executeRun(run).catch((e) => {
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

      // A CACHE ENTRY STORES THE ADS IT READ, NOT THE LISTING IT READ THEM FROM.
      //
      // So a raised read cap is invisible to it. Chase's entry held the 30 its
      // capture was capped at, and every later run replayed those 30 out of 92
      // renderable — the new ceiling silently did nothing, and the board went
      // on saying "30 of about 4,000 listed ads were sampled" as though that
      // were a fact about Chase rather than about our own cap.
      //
      // An entry is short when it was captured under a LOWER cap than the one
      // in force now. Comparing read-count against renderable instead looks
      // more direct and is wrong: dedupe collapses identical artwork and some
      // reads fail, so held is routinely below renderable through no fault of
      // the cap. That version re-fetched three of seven advertisers on every
      // single run and could never catch up.
      //
      // Entries captured before readCap existed are treated as current. They
      // expire on their own TTL, and refusing to guess is cheaper than
      // re-fetching the whole directory on a hunch.
      const capNow = opts.max || MAX_READ_PER_ADVERTISER;
      const held = (cached?.ads || []).length;
      const capThen = cached?.run?.readCap;
      const shortRead = !!cached && Number.isFinite(capThen) && capThen < capNow;

      if (cached && !shortRead) {
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
      if (shortRead) p.reReadReason = `cap raised to ${capNow}; cached entry held ${held} of ${cached.run?.renderable} renderable`;
      const cap = await capture(target.domain, { format: run.format, days: run.days, max: opts.max });
      run.requests += 1;

      if (!cap.ok) {
        p.status = "failed";
        p.reason = cap.reason;                 // structured reason, never an exception
        return;
      }

      run.runs.push(cap.run);
      p.found = cap.run.providerTotal;
      // coverage.js distinguishes "not advertising" from "nothing on this product"
      // by comparing what the provider LISTED against what we READ. Same number
      // as p.found, named for the consumer that has to reason about it.
      p.listed = cap.run.providerTotal;
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
      // bought once and reused for every future run and refresh — but only
      // within the reader that produced it. A banner record has no description
      // and no sitelinks, so serving one to a benchmark run would drop the
      // fields the board counts without any of them registering as a miss.
      // Versioned, so a prompt change retires old readings on its own.
      const reader = readerKey(readerFor({ format: run.format }, cap.images));
      const cachedExtractions = [], fresh = [];
      for (const img of cap.images) {
        const hit = getCachedExtraction(img.creativeId, reader);
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

      // FORMAT-BRANCHED. Benchmark runs are creative_format=text — rendered
      // SEARCH ads with a description and sitelinks — and were previously read
      // with the banner prompt, which explicitly told the model those fields do
      // not exist. Every rate living in a description was discarded before
      // anything downstream could count it.
      const { ads, extractionFailed } = fresh.length
        ? await extractByFormat(fresh, { format: run.format })
        : { ads: [], extractionFailed: 0 };

      // EVIDENCE IS WRITTEN NOW OR NEVER. The base64 is discarded a few lines
      // below and Transparency Center creatives disappear from Google without
      // notice. If a figure from this run lands in a client report and is
      // disputed in three months, this archive is the only way to answer.
      for (const ad of ads) {
        const img = fresh.find((f) => f.creativeId === ad.creativeId);
        putEvidence({
          creativeId: ad.creativeId,
          source: run.source,
          brandDomain: target.domain,
          capturedAt: new Date().toISOString(),
          providerRaw: img ? { ...img, data: undefined } : null,
          mediaType: img?.mediaType,
          data: img?.data,
          extraction: ad,
        });
      }

      for (const ad of ads) putCachedExtraction(ad.creativeId, ad, reader);

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
  // THE WALL'S NUMBERS DESCRIBE THE COMPETITOR SET. The client is captured
  // beside it, not inside it, so its listing counts never enter the sampling
  // note or the funnel — "98 of about 696 listed" has to reconcile against the
  // creatives actually on the wall.
  run.sampling = samplingNote(run.mode === "creative"
    ? run.runs.filter((r) => r.domain !== run.client?.domain)
    : run.runs);

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

  // ---- BENCHMARK SNAPSHOT --------------------------------------------------
  // Written every run from day one, read months later. Month-over-month change
  // is the most diagnostically valuable thing this tool can produce and it
  // cannot be reconstructed after the fact — the delta UI can wait, the storage
  // cannot. This also records the competitor set as part of the measurement:
  // "4 of 5" in July and "3 of 7" in August are not the same number, and
  // nothing else on the page would tell the reader that.
  if (run.mode === "benchmark") {
    try {
      const board = boardFor(run);

      // Runs AFTER findings are final and receives them read-only, anonymised.
      putSnapshot({
        clientDomain: run.client.domain,
        product: run.product,
        source: run.source,
        runId: run.id,
        brands: board.brands,
        // THE BOARD'S OWN SET VERSION — never a second computation of it.
        // Recomputing from run.competitors silently included the national
        // reference tier, which buildBoard deliberately excludes. Every
        // snapshot stored 6 domains, every board compared 4, and every run
        // reported a phantom "competitor set changed: −2, Chase and Capital
        // One removed" that no user action could clear. A national cannot move
        // a finding, so it must not move set identity either.
        competitorSet: board.competitorSet,
        windowStart: run.days ? new Date(Date.now() - run.days * 864e5).toISOString().slice(0, 10) : null,
        windowEnd: new Date().toISOString().slice(0, 10),
      });
      // The watched set is the DEFAULT for next month, never a restriction.
      // Fulfillment may pick anyone; prefilling last month's set just makes
      // stability the path of least resistance and drift deliberate.
      putWatchedSet(run.client.domain, run.product, run.competitors);
    } catch (e) {
      // A snapshot that failed to write must never take a completed run down.
      console.error("[snapshot] post-run write failed:", e.message);
    }
  }

  saveRun(run);
}

/**
 * Assemble the benchmark for a finished run.
 *
 * ONE definition, used by both the table and the gated strategy pass, because a
 * strategy generated from a differently-assembled benchmark is a strategy about
 * numbers the client never saw.
 */
function benchmarkFor(run, brands = null) {
  const bm = buildBenchmark({
    brands,
    client: { ...run.client, ads: run.ads.filter((a) => a.isClient) },
    competitors: run.competitors.map((c) => ({
      ...c, ads: run.ads.filter((a) => !a.isClient && a.institution === c.domain),
    })),
    product: run.product,
    runs: run.runs,
  });

  // A NATIONAL CAPTURE CAN BE OLDER THAN THE WINDOW IT SITS BESIDE.
  //
  // Nationals are cached for a quarter because that is how often their creative
  // turns over, and that is the right trade — but it means the ads in the
  // reference rows may have been captured over a window months away from the
  // one the client is being read over. The note already explains why nationals
  // are in no local count; it has to say this too, or the reader reasonably
  // assumes every row on the page describes the same stretch of time.
  const ages = (run.competitors || [])
    .filter((c) => c.tier === "national")
    .map((c) => run.progress?.[c.domain]?.captureAgeDays)
    .filter((n) => Number.isFinite(n));
  const oldest = ages.length ? Math.max(...ages) : 0;
  if (bm.referenceNote && oldest > run.days) {
    bm.referenceNote += ` Their creative was captured ${Math.round(oldest)} days ago and is refreshed quarterly, so it may fall outside the ${run.days}-day window the local rows describe.`;
  }
  return bm;
}

/**
 * Assemble the FINDINGS BOARD — the deliverable.
 *
 * benchmarkFor() above still runs and its table is still sent, but it renders
 * BELOW this as the audit trail: the thing you open when someone asks where a
 * number came from, not the thing you read to answer the question.
 *
 * One definition, used by the payload and by the snapshot writer, so the
 * snapshot a future delta compares against is the same board the user saw.
 */
function boardFor(run) {
  const previous = previousSnapshot({
    clientDomain: run.client.domain, product: run.product, source: run.source,
    excludeRunId: run.id,
  });
  return buildBoard({
    client: { ...run.client, ads: run.ads.filter((a) => a.isClient) },
    competitors: run.competitors.map((c) => ({
      ...c, ads: run.ads.filter((a) => !a.isClient && a.institution === c.domain),
    })),
    product: run.product,
    progress: run.progress,
    previous,
    ratePages: run.ratePages || null,
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
    // A creative the reader could find no copy in — or found only the
    // Transparency Center's own buttons in — is not competitor creative. It is
    // dropped from the wall and COUNTED, so the funnel still reconciles and
    // nobody has to wonder where a card went.
    const showable = competitorAds.filter(isShowable);
    const unreadable = competitorAds.length - showable.length;
    const scopedShowable = scoped.filter(isShowable);

    // THE CLIENT'S OWN WALL, kept as its own block rather than merged in.
    // Merging would corrupt every count on the screen — the tier totals, the
    // advertiser chips, the "no local creatives were read" note — and it would
    // also be the wrong reading: the question is what the client runs AGAINST
    // this set, which is a comparison between two populations, not one bigger
    // population.
    const clientAds = run.ads.filter((a) => a.isClient).filter(isShowable);
    const clientScoped = filterByProduct(clientAds, run.product);

    payload.client = {
      ...run.client,
      captured: clientAds.length,
      onProduct: clientScoped.length,
      // Scoped when there is anything in scope, everything otherwise — the same
      // rule the wall uses, for the same reason: an empty panel behind a button
      // that says there are ads is worse than a wider one.
      ads: clientScoped.length ? clientScoped : clientAds,
      productScoped: clientScoped.length > 0,
      designs: clusterAds(clientScoped.length ? clientScoped : clientAds).length,
      status: run.progress?.[run.client.domain] || null,
    };

    payload.creative = {
      productScope: run.product,
      unreadable,
      // Pre-select the scope only when it has something in it. Landing on an
      // empty wall is the failure this whole path exists to avoid.
      defaultProductFilter: scopedShowable.length ? run.product : "all",
      scopedCount: scopedShowable.length,
      capturedCount: showable.length,
      summary: creativeSummary(showable),
      scopedSummary: creativeSummary(scopedShowable),
      // The wall shows IDEAS, not every execution. Three near-identical rate
      // banners are one idea with three pieces of evidence, and presenting them
      // as three findings produces a wall nobody reads.
      clusters: clusterAds(showable),
      byProduct: productBreakdown(showable),
      byCompetitor: run.competitors.map((c) => ({
        ...c,
        tier: c.tier || "local",
        count: showable.filter((a) => a.institution === c.domain).length,
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
      funnel: captureFunnel(run.runs.filter((r) => r.domain !== run.client?.domain), competitorAds, scoped.length),
    };

    // Key insights, if this run has already paid for them. They were saved on
    // the run and then never handed back, so every reopened run read as a run
    // that had never been analysed: the client refetched, the model was billed
    // again for an answer already on disk, and the reader waited out a model
    // call to see a page that was sitting in the file all along.
    payload.themes = run.themes || null;
  } else {
    // THE BOARD IS THE ANSWER. The table is the audit trail.
    payload.board = boardFor(run);
    // The table AUDITS the board, so it is handed the board's own rollup. Two
    // aggregations over the same ads is how one screen showed 4.84% APR in a
    // finding and 6.74% in the table below it.
    payload.benchmark = benchmarkFor(run, payload.board.brands);
    payload.funnel = captureFunnel(run.runs, run.ads,
      payload.benchmark.columns.reduce((n, c) => n + c.adCount, 0));
    // Recommended strategies are a Creative/Sales deliverable. Han asked
    // Fulfillment for quasi-analysis — counted facts the client draws their own
    // conclusion from — so the benchmark no longer offers a strategy pass.
    // The generator, its route and its client code are gone as of F-004; the
    // field stays null so an older saved run rendering through this payload
    // does not suddenly grow an undefined where a null used to be.
    payload.strategies = null;
    payload.ratePages = run.ratePages || null;
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
// GET /api/watched — last month's competitor set for this client and product.
//
// The stability problem is solved by the DEFAULT, not by permission. Fulfillment
// can pick literally anyone; this just means they do not have to re-pick the
// same five every month, which is what keeps month-over-month deltas meaningful.
// ---------------------------------------------------------------------------
app.get("/api/watched", (req, res) => {
  const domain = normDomain(req.query.clientDomain);
  const product = normalizeProduct(req.query.product || "");
  if (!domain) return res.status(400).json({ ok: false, reason: "bad_client_domain" });
  const watched = getWatchedSet(domain, product);
  res.json({ ok: true, watched: watched?.competitors || [], updatedAt: watched?.updatedAt || null });
});

// ---------------------------------------------------------------------------
// GET /api/evidence/:creativeId — reproduce one creative exactly as RAIN saw it.
//
// This is what answers "that competitor never advertised 4.50%, show me". The
// creative may be gone from Google by then; this bundle is dated, carries the
// raw provider record and the verbatim transcription, and is never rewritten.
// ---------------------------------------------------------------------------
app.get("/api/evidence/:creativeId", (req, res) => {
  const bundle = getEvidence(req.params.creativeId);
  if (!bundle) return res.status(404).json({ ok: false, reason: "not_found" });
  res.json({ ok: true, evidence: bundle });
});

// ---------------------------------------------------------------------------
// POST /api/rate-pages — read current product pages for a finished run.
//
// Ads are historical; the page is current. Deliberately a SEPARATE, opt-in call
// rather than part of capture: rate-page coverage is inconsistent, so these
// figures are display-only and never enter a denominator. See rate-page.js.
// ---------------------------------------------------------------------------
app.post("/api/rate-pages", async (req, res) => {
  const run = ACTIVE.get(req.body?.runId) || loadRun(req.body?.runId);
  if (!run) return res.status(404).json({ ok: false, reason: "not_found" });
  if (run.mode !== "benchmark") return res.status(400).json({ ok: false, reason: "wrong_mode" });

  const targets = (Array.isArray(req.body?.pages) ? req.body.pages : [])
    .map((t) => ({ domain: normDomain(t.domain), url: String(t.url || "").trim() }))
    .filter((t) => t.domain && t.url)
    .slice(0, 8);
  if (!targets.length) return res.status(400).json({ ok: false, reason: "no_pages" });

  try {
    run.ratePages = { ...(run.ratePages || {}),
      ...(await readRatePages(targets, { product: run.product, productLabel: run.productLabel })) };
    saveRun(run);
    res.json({ ok: true, ratePages: run.ratePages, board: boardFor(run) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e?.code === "NO_API_KEY" ? "anthropic_not_configured" : "read_failed" });
  }
});

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
// POST /api/run/:id/themes — the recurring ideas on the Wall.
//
// Gated behind a click for the same reason the strategy pass was: it is the one
// model call on that screen, and a strategist scrolling a wall should not be
// billed for an analysis they did not ask for.
//
// Wall only. Competitive Intelligence answers a different question with counted
// facts, and a model-written summary sitting beside a counted board invites the
// reader to trust them equally.
// ---------------------------------------------------------------------------
app.post("/api/run/:id/themes", async (req, res) => {
  const run = ACTIVE.get(req.params.id) || loadRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, reason: "not_found" });
  if (run.status !== "done") return res.status(409).json({ ok: false, reason: "run_not_finished" });
  if (run.mode !== "creative") return res.status(400).json({ ok: false, reason: "wrong_mode" });

  // ONE SCOPE PER REQUEST, and the scope is named by the caller.
  //
  //   "all"        every product captured — the general read of the wall
  //   "<product>"  that product alone
  //
  // The panel asks for the general read AND the run's own product, always, and
  // for any further product only when someone picks one. There is no silent
  // widening any more: a thin product says it is thin, and the general read is
  // already on the same screen to fall back to. A fallback you can see is a
  // section; one you cannot is a false heading.
  const requested = String(req.body?.scope || run.product || "all");
  const scope = requested === "all" || PRODUCT_LABELS[requested] ? requested : run.product;
  const isAll = scope === "all";
  const scopeLabel = isAll ? "Every product captured" : PRODUCT_LABELS[scope];

  // MIGRATION. Runs read before this endpoint took a scope hold a single
  // `themes`; it was always the run's own product unless it said otherwise.
  if (!run.themesByScope) {
    run.themesByScope = run.themes
      ? { [run.themes.readScope === "all_products" ? "all" : run.product]: run.themes }
      : {};
  }

  // Already read, and reading is the one billable act on that screen. The wall
  // cannot change under a finished run, so the saved answer IS the answer.
  if (run.themesByScope[scope] && !req.body?.force) {
    return res.json({ ok: true, scope, scopeLabel, themes: run.themesByScope[scope], cached: true });
  }

  // SINGLE-FLIGHT PER RUN AND SCOPE. Two requests for the same scope are one
  // question and must cost one model call — a double-clicked button, or the
  // panel reopened in a second tab, otherwise buys the same read twice. Two
  // requests for DIFFERENT scopes are two questions and still run side by side;
  // only their merge into the run file is serialised, below.
  const key = `${run.id}::${scope}`;
  let job = THEMES_INFLIGHT.get(key);
  if (!job) {
    job = readThemesForScope({ run, scope, isAll, scopeLabel })
      .finally(() => { if (THEMES_INFLIGHT.get(key) === job) THEMES_INFLIGHT.delete(key); });
    THEMES_INFLIGHT.set(key, job);
  }
  const { status, body } = await job;
  res.status(status).json(body);
});

/**
 * Read one scope of the wall. Always RESOLVES — to the status and body the
 * endpoint should return — so that every caller sharing one in-flight read gets
 * the same answer, including the same failure.
 */
async function readThemesForScope({ run, scope, isAll, scopeLabel }) {
  // The filter chips on the results screen are a VIEW and never reach this
  // endpoint: clicking an advertiser narrows what is drawn, not what is read.
  const showable = (run.ads || []).filter((a) => !a.isClient).filter(isShowable);
  const pool = isAll ? showable : filterByProduct(showable, scope);

  // CLUSTERED FIRST, and this is evidence, not tidying. Handed raw ads, the
  // model saw one design cut into five banner sizes as five independent
  // confirmations of a theme, so the most heavily resized creative always
  // looked like the strongest pattern in the set.
  const families = clusterAds(pool);
  const designs = usableFamilies(families).length;

  const counts = {
    product: scopeLabel, productKey: scope,
    designs, allDesigns: usableFamilies(clusterAds(showable)).length, needed: MIN_FAMILIES,
  };

  // THE COUNTED OBSERVATIONS DO NOT DEPEND ON THE MODEL, so they are computed
  // before it is called and returned whatever it does. A panel that threw these
  // away because the themes pass came back empty was discarding the most
  // defensible thing on it.
  const advertisers = (run.competitors || []).map((c) => ({
    domain: c.domain, label: c.label, tier: c.tier || "local",
  }));
  const clientShowable = (run.ads || []).filter((a) => a.isClient).filter(isShowable);
  const clientFamilies = clusterAds(isAll ? clientShowable : filterByProduct(clientShowable, scope));
  const counted = {
    channel: channelShape({
      advertisers, days: run.days,
      peek: (q) => captureCache.peek({ ...q, ttlDays: Number.MAX_SAFE_INTEGER }),
    }),
    cohort: cohortShape({
      families: usableFamilies(families), advertisers, days: run.days,
      productLabel: isAll ? "" : scopeLabel,
      client: { label: run.client?.label, designs: usableFamilies(clientFamilies).length },
    }),
  };

  // NOT AN ERROR, AND NOT RED. A product too thin to generalise over is a fact
  // about what Google listed, and the wall below it is unaffected. Decided
  // before the model call, so it also costs nothing.
  if (designs < MIN_FAMILIES) {
    return { status: 200, body: { ok: true, scope, scopeLabel, themes: null, reason: "too_little_captured", counted, ...counts } };
  }

  try {
    // The framing line names the product only when a product is what was read.
    const { themes, audit } = await readThemes(
      [...families, ...clientFamilies], isAll ? "" : scopeLabel);

    // Reached, answered, and nothing it proposed held up. Not an error — and
    // not the end of the panel either: the counted observations go back
    // regardless, and the audit says whether the set was quiet or the answer
    // was refused, which look identical from outside.
    if (!themes) {
      return { status: 200, body: { ok: true, scope, scopeLabel, themes: null, reason: "nothing_recurring", audit, counted, ...counts } };
    }

    // Carried ON the themes so a re-open — served from the saved copy, never
    // re-read — labels itself exactly as the first open did.
    themes.readScope = isAll ? "all_products" : "product";
    themes.scopeKey = scope;
    themes.scopeLabel = scopeLabel;
    themes.readOver = counts;
    themes.channel = counted.channel;
    themes.cohort = counted.cohort;
    themes.audit = audit;

    // READ-MODIFY-WRITE UNDER THE LOCK, against a record re-read inside it. The
    // copy captured at the top of the request is stale the moment a sibling
    // scope finishes first, and writing it back is what silently dropped that
    // sibling's scope from disk and re-billed it on the next open.
    const { persisted } = await updateRun(run.id, (current) => {
      if (!current.themesByScope) current.themesByScope = {};
      current.themesByScope[scope] = themes;
      // Back-compat: anything still reading `run.themes` gets the run's own
      // product, which is what that field always meant.
      if (scope === current.product || !current.themes) current.themes = themes;
    });
    // Keep the caller's in-memory copy in step for the cached-answer check.
    run.themesByScope[scope] = themes;

    return { status: 200, body: { ok: true, scope, scopeLabel, themes, counted, persisted, ...counts } };
  } catch (e) {
    const reason = e?.code === "NO_API_KEY" ? "anthropic_not_configured"
      : e?.code === "MODEL_UNAVAILABLE" ? "model_unavailable"
        : "generation_failed";
    // The status stays 500 — something really did fail server-side — but the
    // counts travel with it so the panel can still name the product it was
    // reading, and say plainly that nothing was spent.
    return { status: 500, body: { ok: false, scope, scopeLabel, reason, counted, ...counts } };
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RAIN Intelligence on :${PORT}`);

  // Say what cache this process is sitting on. When a directory has been copied
  // between environments — which is the supported way to move it — this is the
  // line that tells you whether it came from this build or an older one.
  const man = readManifest();
  if (man && man.schema !== CACHE_SCHEMA) {
    console.log(`  Cache: schema ${man.schema}, this build expects ${CACHE_SCHEMA}`);
    console.log("         Entries written by the older build are keyed differently and will");
    console.log("         simply miss. Nothing is served stale; the first run re-reads them.");
  } else if (man) {
    console.log(`  Cache: schema ${man.schema}, first written ${String(man.createdAt).slice(0, 10)}`);
  }
  writeManifest({ lastBuild: CACHE_SCHEMA });
  console.log(`  SerpApi: ${hasKey() ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  Anthropic: ${hasAnthropicKey() ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  Directory: ${DIRECTORY_SIZE} clients`);
});
