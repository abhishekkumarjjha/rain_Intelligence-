/* =========================================================================
   RAIN Intelligence — client.
   State is one object. Screens are shown/hidden, never re-created, so the
   browser keeps scroll position and nothing flickers on a filter change.
   ========================================================================= */

const S = {
  url: "", domain: "", clientLabel: "", product: "other", productLabel: "",
  mode: "", days: 30, productConfirmed: true,
  sourceChoice: "google_display",   // google_display | google_search
  force: false,
  includeNationals: true,   // the standing tier; on unless switched off
  competitors: [],          // {label, domain, typeTag, reason, relevance, on}
  runId: "", run: null,
  filter: "all",            // competitor filter on the wall
  productFilter: null,      // product filter; null = adopt the run's scope once
  health: null,

  // ONE STATE TREE PER SOURCE, keyed by source name.
  //
  // Not one array with a `source` field and a filter over it. The tab switches
  // which tree is rendered; it does not filter a combined collection. That is
  // what makes it structurally impossible for two surfaces' counts
  // to end up in the same denominator, or for one source's filter selection to
  // silently apply to the other's data.
  bySource: {},             // { [source]: { runId, status, run, filter, productFilter } }
  activeSource: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* esc() makes a string safe as TEXT or as an attribute VALUE. It does not make
   it safe as a URL: it leaves `javascript:` and `data:` untouched, because
   neither contains a character worth escaping.

   Every URL rendered into an href here comes from a provider, and two of them
   are chosen by the advertiser rather than observed about them — a card's
   `link_url` is whatever the buyer typed. So the scheme is checked before the
   link is built, not escaped afterwards, and anything that is not plain http(s)
   renders as no link at all rather than as a link that runs. */
const safeUrl = (u) => {
  const s = String(u ?? "").trim();
  if (!s) return "";
  // Relative paths are ours (/api/media/…), so they never need a scheme check.
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const parsed = new URL(s, location.origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : "";
  } catch { return ""; }
};

/* Errors belong on the page, next to the thing that failed. alert() blocks the
   whole tab, cannot be read back, and is the first thing that makes a tool feel
   unfinished when it is shown to a client. */
function showError(msg) {
  const bar = $("errBar");
  bar.textContent = msg;
  bar.classList.remove("hidden");
  bar.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearError() { $("errBar").classList.add("hidden"); }

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  $("restartBtn").classList.toggle("hidden", id === "s-landing");
  window.scrollTo({ top: 0, behavior: "smooth" });
  crumbs(id);
}

function crumbs(id) {
  const steps = [["s-mode", S.clientLabel || S.domain], ["s-comp", "Competitors"], ["s-results", "Results"]];
  const idx = { "s-mode": 0, "s-comp": 1, "s-run": 2, "s-results": 2 }[id];
  $("crumbs").innerHTML = idx == null ? "" :
    steps.map((s, i) => `<span class="c ${i <= idx ? "on" : ""}">${esc(s[1])}</span>`).join("");
}

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    const h = await (await fetch("/api/health")).json();
    S.health = h;
    const missing = [];
    if (!h.serpapi) missing.push("SERPAPI_API_KEY");
    if (!h.anthropic) missing.push("ANTHROPIC_API_KEY");
    $("healthLine").innerHTML = missing.length
      ? `<span class="bad">Not configured: ${missing.join(", ")}</span> · ${h.directorySize} clients in directory`
      : `${h.directorySize} clients in directory · reads up to ${h.maxReadPerAdvertiser} creatives per advertiser`;

  } catch { /* health is informational only */ }
})();

/* ---------------- resolve ---------------- */
$("analyzeBtn").onclick = resolve;
$("urlInput").onkeydown = (e) => { if (e.key === "Enter") resolve(); };
$("restartBtn").onclick = () => location.reload();

async function resolve() {
  const url = $("urlInput").value.trim();
  if (!url) return;
  $("analyzeBtn").disabled = true;
  try {
    const r = await (await fetch("/api/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    })).json();

    if (!r.ok) { $("urlHint").innerHTML = `<span class="warn">That does not look like a URL. Try <b>yourbank.com/checking</b>.</span>`; return; }
    clearError();

    S.url = url; S.domain = r.domain; S.product = r.product;
    S.productLabel = r.productLabel;
    S.clientLabel = r.client?.name || r.domain;
    S.competitors = (r.competitors || []).map((c, i) => ({ ...c, on: i < 3 }));

    $("modeInst").textContent = S.clientLabel;
    $("compInst").textContent = S.clientLabel;
    $("compSub").innerHTML = r.directoryMiss
      ? `Not in the curated directory — add competitors manually below.`
      : `${esc(r.client.market || "")}${r.client.market ? " · " : ""}${esc(r.client.institutionType || "")}`;

    // A homepage names the institution but not the product, and every count in
    // this tool is product-scoped. Say so instead of quietly analysing "other".
    // Detected or not. Until the user settles it, the capture stays blocked.
    S.productConfirmed = !r.looksLikeHomepage;
    if (r.looksLikeHomepage) {
      $("compSub").innerHTML += `<br><span style="color:var(--amber)">No product detected in that URL — choose a product scope on the right, or re-enter using the product page.</span>`;
    }

    buildProductSelect();
    show("s-mode");
  } catch {
    showError("Could not reach the server. Is it still running on this port?");
  } finally { $("analyzeBtn").disabled = false; }
}

/* The taxonomy comes from /api/health. If that request failed the selector must
   still be usable, otherwise a transient blip on page load leaves the user
   unable to set a product scope at all. */
const FALLBACK_PRODUCTS = [
  ["checking", "Checking"], ["savings", "Savings"], ["cd", "CD / Certificate"],
  ["money-market", "Money Market"], ["credit-card", "Credit Card"], ["auto-loan", "Auto Loan"],
  ["personal-loan", "Personal Loan"], ["mortgage", "Mortgage"], ["heloc", "HELOC"],
  ["business", "Business"], ["wealth", "Wealth"], ["other", "Other"],
].map(([code, label]) => ({ code, label }));

function productList() {
  return S.health?.products?.length ? S.health.products : FALLBACK_PRODUCTS;
}
const productLabel = (code) => productList().find((p) => p.code === code)?.label || code;

function buildProductSelect() {
  const sel = $("productSel");
  sel.innerHTML = productList().map((p) =>
    `<option value="${p.code}" ${p.code === S.product ? "selected" : ""}>${esc(p.label)}</option>`).join("");
  // Competitor ordering is product-dependent — a competitor scoped to "checking"
  // outranks a market-wide one — so changing the scope has to re-ask the
  // directory rather than just re-render a stale list.
  sel.onchange = () => {
    S.product = sel.value; S.productLabel = productLabel(S.product);
    // An explicit choice settles it, including a deliberate "Other".
    S.productConfirmed = true;
    refreshCompetitors();
  };
  $("daysSel").onchange = () => { S.days = Number($("daysSel").value); renderCost(); };
}

async function refreshCompetitors() {
  try {
    const r = await (await fetch("/api/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: S.url, product: S.product }),
    })).json();
    if (r.ok && r.competitors?.length) {
      // Keep whatever the user has already chosen; re-rank the rest.
      const chosen = new Map(S.competitors.filter((c) => c.on).map((c) => [c.domain, c]));
      const manual = S.competitors.filter((c) => c.typeTag === "Manual");
      const fresh = r.competitors.map((c, i) => ({ ...c, on: chosen.has(c.domain) || (!chosen.size && i < 3) }));
      const seen = new Set(fresh.map((c) => c.domain));
      S.competitors = [...fresh, ...manual.filter((c) => !seen.has(c.domain))];
    }
  } catch { /* keep the list we already have */ }
  renderCompetitors();
}

/* The two halves of the tool, named the way the team names them. One capture
   set, two readings of it: the Wall is what competitors MADE, Competitive
   Intelligence is how the client COMPARES. */
const MODE_LABEL = { creative: "The Wall of Creatives", benchmark: "Competitive Intelligence" };
const OTHER_MODE = { creative: "benchmark", benchmark: "creative" };
const CROSS_LABEL = { creative: "Competitive Intelligence →", benchmark: "← The Wall" };

/* One picker value -> the sources actually captured. The Wall is DISPLAY only:
   search ads reach it as a free view over the Competitive Intelligence run that
   already paid to capture and read them. See SOURCES_FOR_MODE in lib/sources.js. */
function sourcesForChoice(choice) {
  return [choice === "both" ? "google_display" : choice];
}

/**
 * Enter a mode and land on the confirm screen.
 *
 * Extracted from the mode-card handler so the cross-navigation buttons on the
 * results screen go through EXACTLY the same path. The alternative — starting
 * the other mode's capture directly from a button — would spend SerpApi credits
 * on a click, and the display side of that switch is never cached.
 */
function enterMode(mode) {
  S.mode = mode;
  // NEITHER half offers a source chooser any more.
  //
  // Competitive Intelligence has exactly one legal source and always did. The
  // Wall now has exactly one too: it is display, by the cost decision in
  // lib/sources.js, so a picker would offer a choice that does not exist.
  const isBench = mode === "benchmark";
  S.sourceChoice = isBench ? "google_search" : "google_display";
  $("sourceSel").value = "google_display";
  $("sourceSel").style.display = "none";
  document.querySelectorAll(".scopebox label").forEach((l) => {
    if (l.textContent.trim() === "Sources") l.style.display = "none";
  });
  $("winGoogleWrap").classList.remove("hidden");
  syncNationalsRow();
  renderCompetitors();
  show("s-comp");
}

/* ---------------- mode ---------------- */
document.querySelectorAll(".modecard[data-mode]").forEach((card) => {
  card.onclick = () => {
    enterMode(card.dataset.mode);
  };
});

/* The cross-link. Client, competitors and window are already in S, so switching
   halves keeps the whole selection — the user re-confirms rather than re-enters,
   and the cost line on that screen tells them what the switch costs. Going Wall
   -> Competitive Intelligence is usually free, because the Wall already bought
   the google_search capture the board needs. */
$("crossBtn").onclick = () => enterMode(OTHER_MODE[S.run?.mode] || "benchmark");

/* ---------------- competitors ---------------- */
function renderCompetitors() {
  const list = $("compList");
  list.innerHTML = "";

  if (S.mode === "benchmark") {
    // The client is a captured column, not an assumption. Shown as a fixed row
    // so nobody wonders where the 4.00% is going to come from.
    const row = el("div", "comprow on");
    row.innerHTML = `
      <div class="tick">✓</div>
      <div class="who">
        <div class="nm">${esc(S.clientLabel)} <span class="tag client">Your client</span></div>
        <div class="dm">${esc(S.domain)}</div>
        <div class="rz">Their own ads are captured the same way, over the same window — so the comparison is ads against ads.</div>
      </div>`;
    list.appendChild(row);
  }

  S.competitors.forEach((c, i) => {
    const row = el("div", "comprow" + (c.on ? " on" : ""));
    row.innerHTML = `
      <div class="tick">✓</div>
      <div class="who">
        <div class="nm">${esc(c.label || c.name)}</div>
        <div class="dm">${esc(c.domain)}</div>
        ${c.reason ? `<div class="rz">${esc(c.reason)}</div>` : ""}
      </div>
      ${c.typeTag ? `<span class="tag">${esc(c.typeTag)}</span>` : ""}
      ${c.relevance === "product-matched" ? `<span class="tag match">Product match</span>` : ""}`;
    row.onclick = () => { S.competitors[i].on = !S.competitors[i].on; renderCompetitors(); };
    list.appendChild(row);
  });

  if (!S.competitors.length) {
    list.appendChild(el("div", "empty", "No curated competitors for this client yet. Add them below."));
  }
  renderCost();
}

$("addBtn").onclick = () => {
  const label = $("addName").value.trim();
  const domain = $("addDomain").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!domain) return;
  S.competitors.push({ label: label || domain, domain, typeTag: "Manual", reason: "", on: true });
  $("addName").value = ""; $("addDomain").value = "";
  renderCompetitors();
};

/* Delegates to refreshCost(), which asks the server what the per-advertiser
   cache already holds. The old version multiplied competitors by one credit
   each, which was right before the cache existed and is now an overstatement
   every time somebody re-tests a competitor the team already captured. */
function renderCost() {
  // AN UNDETECTED PRODUCT BLOCKS THE CAPTURE. It used to be a note the user
  // could read past, and reading past it scoped the whole benchmark to "other"
  // — which matches every ad ever captured, so every finding and every piece of
  // evidence came back about the wrong product while looking entirely
  // confident. A scope this tool cannot infer is one the user has to supply.
  const needsProduct = !S.productConfirmed;
  $("captureBtn").disabled = needsProduct || !S.competitors.some((c) => c.on);
  if (needsProduct) {
    $("costNote").innerHTML = `<span class="bad">No product was detected in that URL. `
      + `Choose a product scope above before capturing — every count on the board is scoped to one product, `
      + `and "Other" matches everything.</span>`;
    return;
  }
  refreshCost();
}

/* ---------------- capture ---------------- */
$("captureBtn").onclick = () => startCapture({ force: $("forceChk").checked });

async function startCapture({ force = false } = {}) {
  const competitors = S.competitors.filter((c) => c.on).map((c) => ({ label: c.label || c.name, domain: c.domain }));
  const sources = S.mode === "benchmark"
    ? ["google_search"]
    : sourcesForChoice(S.sourceChoice);

  $("captureBtn").disabled = true;
  const r = await (await fetch("/api/capture", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: S.mode, clientDomain: S.domain, clientLabel: S.clientLabel,
      product: S.product, competitors, sources, force,
      includeNationals: S.includeNationals,
      // Per-source windows, because "last 30 days" means a served window on
      days: { google_display: S.days, google_search: S.days },
    }),
  })).json();
  $("captureBtn").disabled = false;

  if (!r.ok) {
    showError({
      serpapi_not_configured: "SERPAPI_API_KEY is not set on the server, so Google ads cannot be fetched.",
      anthropic_not_configured: "ANTHROPIC_API_KEY is not set on the server, so creatives cannot be read.",
      no_competitors: "Select at least one competitor before capturing.",
      bad_client_domain: "That client domain could not be read. Re-enter the landing page URL.",
      product_required: "Competitive Intelligence needs a product scope. Every count on the board means \"among the ads about this product\", and \"Other\" matches everything — pick a product and capture again.",
    }[r.reason] || `Could not start the capture: ${r.reason}`);
    return;
  }

  clearError();
  $("runNote").textContent = "";

  // A source refused for a missing key does NOT stop the others. The user is
  // told which one dropped out and why, and the rest of the capture proceeds.
  if (r.refused?.length) {
    $("runNote").innerHTML = r.refused.map((x) =>
      `<span class="bad">${esc(SRC_LABEL[x.source] || x.source)} skipped — ${esc(reasonText(x.reason))}.</span>`).join("<br>");
  }

  S.bySource = {};
  S.activeSource = r.runs[0].source;
  S.runId = r.runs[0].runId;

  for (const run of r.runs) {
    S.bySource[run.source] = {
      source: run.source, sourceLabel: run.sourceLabel, runId: run.runId,
      days: run.days, status: "running", run: null,
      filter: "all", productFilter: null,
    };
  }

  // Progress rows are grouped per source when there is more than one, because
  // the same competitor appears once per source and two rows with the same name
  // and different numbers is unreadable otherwise.
  const multi = r.runs.length > 1;
  $("progList").innerHTML = r.runs.map((run) => `
    ${multi ? `<div class="proghead">${esc(run.sourceLabel)}</div>` : ""}
    ${run.targets.map((t) => `
      <div class="progrow" data-s="${esc(run.source)}" data-d="${esc(t.domain)}">
        <div class="lamp"></div>
        <div class="pn">${esc(t.label)}${t.isClient ? ' <span class="tag client">Your client</span>' : ""}</div>
        <div class="ps">queued</div>
      </div>`).join("")}
  `).join("");

  show("s-run");
  for (const run of r.runs) poll(run.source);
}

const SRC_LABEL = { google_display: "Google display", google_search: "Google search" };

/* A capture takes tens of seconds and the poll is the only thing driving the UI
   forward. A single failed request used to end the loop silently, leaving the
   user on a progress screen that would never move again — indistinguishable
   from a hung capture. Transient failures are retried; a persistent one says so
   on the page. */
const pollMisses = {};

async function poll(source) {
  const st = S.bySource[source];
  if (!st) return;
  let r;
  try {
    const res = await fetch(`/api/run/${st.runId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    r = await res.json();
    pollMisses[source] = 0;
  } catch {
    pollMisses[source] = (pollMisses[source] || 0) + 1;
    if (pollMisses[source] >= 5) {
      $("runNote").innerHTML = `<span class="bad">Lost contact with the server while capturing ${esc(SRC_LABEL[source] || source)}. The run may still be going — reload and it will be in the run list.</span>`;
      st.status = "lost";
      maybeShowResults();
      return;
    }
    setTimeout(() => poll(source), 1400 * pollMisses[source]);
    return;
  }

  if (!r.ok) {
    st.status = "error";
    $("runNote").innerHTML = `<span class="bad">That run could not be read back: ${esc(r.reason || "unknown")}.</span>`;
    maybeShowResults();
    return;
  }

  for (const [domain, p] of Object.entries(r.progress || {})) {
    const row = document.querySelector(`.progrow[data-s="${CSS.escape(source)}"][data-d="${CSS.escape(domain)}"]`);
    if (!row) continue;
    row.className = "progrow " + ({
      done: "ok", failed: "bad", empty: "bad", needs_confirmation: "bad",
    }[p.status] || "run");
    row.querySelector(".ps").innerHTML = progressLine(p, source);
  }

  if (r.status === "done") { st.status = "done"; st.run = r; maybeShowResults(); return; }
  if (r.status === "error") {
    st.status = "error";
    $("runNote").innerHTML = `<span class="bad">${esc(SRC_LABEL[source] || source)} capture failed: ${esc(reasonText(r.error))}</span>`;
    maybeShowResults();
    return;
  }
  setTimeout(() => poll(source), 1400);
}

/* Show results as soon as the FIRST source finishes rather than waiting for
   both. Two sources land at different times — making
   someone stare at a finished Google wall they cannot see, because a second
   provider is still paginating, is a worse experience than a tab that fills in.
   The still-running tab shows a pulse. */
function maybeShowResults() {
  const states = Object.values(S.bySource);
  const anyDone = states.some((x) => x.status === "done");
  const allSettled = states.every((x) => x.status !== "running");
  if (!anyDone && !allSettled) return;

  if (!S.activeSource || S.bySource[S.activeSource]?.status !== "done") {
    S.activeSource = (states.find((x) => x.status === "done") || states[0]).source;
  }
  renderSourceTabs();
  const active = S.bySource[S.activeSource];
  if (active?.run) { S.run = active.run; renderResults(); }
}

/* The tabs. Switching one swaps the ENTIRE rendered dataset — a different run,
   different counts, different filters, different date vocabulary. */
function renderSourceTabs() {
  const el = $("srcTabs");
  const states = Object.values(S.bySource);
  if (states.length < 2) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");

  el.innerHTML = states.map((x) => {
    const n = x.status === "done" ? countFor(x.run) : null;
    const dead = x.status === "error" || x.status === "lost";
    return `<button class="srctab ${x.source === S.activeSource ? "on" : ""} ${dead ? "dead" : ""}" data-s="${esc(x.source)}">
      ${esc(x.sourceLabel)}
      ${x.status === "running" ? '<span class="spin"></span>' : ""}
      ${n != null ? `<span class="n">${n}</span>` : ""}
      ${dead ? '<span class="n">failed</span>' : ""}
    </button>`;
  }).join("");

  el.querySelectorAll(".srctab").forEach((n) => {
    n.onclick = () => {
      const st = S.bySource[n.dataset.s];
      if (!st || st.status !== "done") return;
      S.activeSource = n.dataset.s;
      S.run = st.run;
      // Filters live PER SOURCE, so switching tabs restores that source's own
      // selection instead of carrying one source's product chip onto another
      // where the counts behind it are different.
      S.filter = st.filter; S.productFilter = st.productFilter;
      renderSourceTabs();
      renderResults();
    };
  });
}

function countFor(run) {
  if (!run) return null;
  if (run.mode === "creative") return run.creative?.capturedCount ?? (run.ads?.length || 0);
  return run.ads?.length || 0;
}

function progressLine(p, source) {
  if (p.status === "queued") return "queued";

  // A capture served entirely from cache never touched a provider, and saying so
  // is the difference between "this is fast" and "this is stale". The age is
  // always shown so the reader can decide whether it is fresh enough.
  if (p.fromCaptureCache) {
    const age = p.captureAgeDays;
    const when = age == null ? "cached"
      : age < 1 ? "captured today"
      : age < 2 ? "captured yesterday"
      : `captured ${Math.round(age)} days ago`;
    return `<b>${p.read}</b> read · <span style="color:var(--green)">${when}, no request spent</span>`;
  }


  if (p.status === "fetching") return "fetching creatives…";
  if (p.status === "reading") return `reading <b>${p.downloading}</b> creatives…`;
  if (p.status === "failed") return `<span style="color:var(--amber)">${esc(reasonText(p.reason))}</span>`;
  if (p.status === "empty") return `<span style="color:var(--amber)">no readable creatives${p.previewOnly ? ` · ${p.previewOnly} preview-only` : ""}</span>`;
  // The chain has to reconcile: found -> renderable -> read.
  const bits = [`<b>${p.read}</b> read`];
  if (p.found != null) bits.push(`of ${Number(p.found).toLocaleString()} found`);
  if (p.previewOnly) bits.push(`${p.previewOnly} preview-only`);
  if (p.fromCache) bits.push(`${p.fromCache} cached`);
  if (p.multipleAdvertisers) bits.push(`<span style="color:var(--amber)">${p.advertisers.length} advertiser accounts</span>`);
  return bits.join(" · ");
}

const reasonText = (r) => ({
  auth: "provider key rejected", quota: "provider quota exhausted",
  timeout: "provider timed out", bad_domain: "invalid domain",
  no_ads: "no ads in this window", preview_only: "creatives are preview-only",
  not_configured: "provider not configured",
  extraction_failed: "creatives found but none could be read",
  unexpected: "unexpected error",
  serpapi_not_configured: "SERPAPI_API_KEY is not set",
  anthropic_not_configured: "ANTHROPIC_API_KEY is not set",
}[r] || r || "failed");

/* ---------------- results ---------------- */
function renderResults() {
  const r = S.run;
  $("resEyebrow").textContent = (MODE_LABEL[r.mode] || r.mode)
    + (r.sourceLabel ? ` · ${r.sourceLabel}` : "");
  $("resTitle").textContent = `${r.client.label} · ${r.productLabel}`;

  // Each half gets the one extra view that belongs to it. The search wall is
  // free because Competitive Intelligence already captured and read those ads;
  // Key insights is a model call, so it lives behind a click on the Wall.
  $("searchWallBtn").classList.toggle("hidden", !(r.mode === "benchmark" && r.ads?.length));
  $("insightsBtn").classList.toggle("hidden", !(r.mode === "creative" && (r.ads?.length || 0) >= 4));
  $("insightsBtn").textContent = "Key insights";
  $("insightsBtn").disabled = false;

  $("crossBtn").classList.add("hidden");

  const s = r.sampling || {};
  $("samplingBar").className = "samplingbar" + (s.complete ? " clean" : "");
  $("samplingBar").textContent = s.note || "";

  // Every target can legitimately come back with nothing — no ads in the window,
  // preview-only creatives, a provider outage. That is a RESULT and it has to be
  // rendered as one, with the per-target reasons still visible, rather than
  // dropping the user onto an empty results screen.
  renderFunnel(r.mode === "creative" ? r.creative?.funnel : r.funnel);
  renderDiff(r.diff);

  if (!r.ads?.length) {
    renderNothingCaptured(r);
  } else if (r.mode === "creative") {
    renderCreative(r);
  } else {
    renderBenchmark(r);
  }

  // The whole reason the results screen was never reached: this call did not
  // exist. The capture finished, the payload arrived, everything rendered into
  // a hidden section, and the user sat on "Capturing" watching completed rows.
  show("s-results");
}

/* The reconciliation strip. Every step is a number computed in analyze.js —
   nothing here is derived in the browser, so the chain shown is the chain that
   actually happened. Collapsed to the numbers by default; the "why" expands. */
function renderFunnel(f) {
  const bar = $("funnelBar");
  if (!f || !f.steps?.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");

  const steps = f.steps.map((st, i) => `
    <div class="fstep ${i === f.steps.length - 1 ? "last" : ""}">
      <div class="fv">${Number(st.value).toLocaleString()}</div>
      <div class="fl">${esc(st.label)}</div>
    </div>`).join("");

  const lost = f.steps.filter((st) => st.lost > 0);
  const why = lost.length ? `
    <div class="flost hidden" id="funnelWhy">
      <ul>${lost.map((st) => `<li><b>${Number(st.lost).toLocaleString()}</b> ${esc(st.why)}</li>`).join("")}</ul>
    </div>` : "";

  bar.innerHTML = `
    <div class="fhead">
      <span class="ftitle">Where the creatives went</span>
      ${lost.length ? `<button class="ftoggle" id="funnelToggle">Why the drop?</button>` : ""}
    </div>
    <div class="fsteps">${steps}</div>
    ${why}`;

  const toggle = $("funnelToggle");
  if (toggle) toggle.onclick = () => {
    const box = $("funnelWhy");
    const open = !box.classList.toggle("hidden");
    toggle.textContent = open ? "Hide" : "Why the drop?";
  };
}

/* The Transparency Center serves a rotating SAMPLE, so the same capture run
   twice returns overlapping but different creatives. One run cannot say what a
   competitor is running; two runs can say what we had not seen before. The
   phrasing is deliberate — "no longer observed", never "stopped running". */
function renderDiff(d) {
  const bar = $("diffBar");
  if (!d || !d.previousAt) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");

  const when = String(d.previousAt).slice(0, 10);
  const bits = [];
  if (d.appeared) bits.push(`<b>${d.appeared}</b> we had not captured before`);
  if (d.stillRunning) bits.push(`<b>${d.stillRunning}</b> seen in both captures`);
  if (d.noLongerObserved) bits.push(`<b>${d.noLongerObserved}</b> no longer observed`);

  bar.innerHTML = `
    <span class="dlabel">Since ${esc(when)}</span>
    ${bits.join(" · ") || "no change against the previous capture"}
    <span class="dnote">Each capture is a sample — an ad missing here may simply not have been sampled this time, not stopped.</span>`;
}

/* What each advertiser actually returned, as list items.
   Shared by the nothing-captured screen and by the wall's zero-local case,
   because "here is what each advertiser returned" is the same answer in both
   and two copies of it would drift. `onlyDomains` narrows the list to one tier. */
function outcomeRows(r, onlyDomains = null) {
  return Object.entries(r.progress || {})
    .filter(([domain]) => !onlyDomains || onlyDomains.includes(domain))
    .map(([domain, p]) => `
    <li><b>${esc(p.label || domain)}</b> — ${
      p.status === "failed" || p.status === "empty"
        ? esc(reasonText(p.reason))
        : `${p.read ?? 0} read`
    }${p.found != null ? ` · ${Number(p.found).toLocaleString()} found` : ""}${
      p.previewOnly ? ` · ${p.previewOnly} preview-only` : ""}</li>`).join("");
}

function renderNothingCaptured(r) {
  $("resStats").innerHTML = "";
  $("filters").innerHTML = "";
  $("productFilters").innerHTML = "";
  $("scopeBar").classList.add("hidden");
  $("funnelBar").classList.add("hidden");
  $("diffBar").classList.add("hidden");

  const rows = outcomeRows(r);

  $("resultBody").innerHTML = `
    <div class="empty big">
      <h3>No creatives were read in this capture</h3>
      <p>Nothing was invented to fill the gap. Here is what each advertiser returned:</p>
      <ul class="whylist">${rows}</ul>
      <p class="dim">A window of 30 days is often the cause — try 60 or 90, or check the advertiser is running Google ads at all.</p>
    </div>`;
}

function renderCreative(r) {
  const c = r.creative;

  // The product scope is the DEFAULT FILTER, not a gate — every captured
  // creative is in hand and reachable. Applied once, then the user is in charge.
  if (S.productFilter == null) S.productFilter = c.defaultProductFilter || "all";

  const shown = (c.clusters || [])
    .filter((a) => S.filter === "all" || a.institution === S.filter)
    .filter((a) => S.productFilter === "all" || a.product === S.productFilter);

  // The stats describe WHAT IS ON SCREEN. The capture totals live in the funnel
  // above — showing "6 ideas" over three visible cards is the same category of
  // confusion as "55 found" over a wall of two.
  const shownExecutions = shown.reduce((n, a) => n + (a.variations || 1), 0);
  $("resStats").innerHTML = `
    <div class="st"><div class="v">${shown.length}</div><div class="k">Ideas shown</div></div>
    <div class="st"><div class="v">${shownExecutions}</div><div class="k">Executions</div></div>
    <div class="st"><div class="v">${shown.filter((a) => a.offer).length}</div><div class="k">With an offer</div></div>`;

  // Which slice of the capture is on screen, and how to see the rest. The old
  // wording implied the rest had been discarded; they are one chip away.
  const scope = $("scopeBar");
  if (S.productFilter === "all" && c.scopedCount === 0 && c.capturedCount > 0) {
    scope.classList.remove("hidden");
    scope.innerHTML = `No creative in this capture classified as <b>${esc(r.productLabel)}</b> — most display banners carry no product signal at all, so they read as <b>Other</b>. Showing all <b>${c.capturedCount}</b> creatives captured.`;
  } else if (S.productFilter !== "all" && shown.length < c.summary.ideas) {
    scope.classList.remove("hidden");
    scope.innerHTML = `Showing <b>${esc(productLabel(S.productFilter))}</b> only. <button class="linkbtn" id="showAllProducts">Show all ${c.capturedCount} creatives captured</button>`;
  } else {
    scope.classList.add("hidden");
  }

  // Two independent filters. Product narrows what the wall is about; competitor
  // narrows whose work it is. BOTH count over everything captured — chips that
  // only count the current slice cannot be used to escape it.
  const prodChips = [{ code: "all", label: "All products", count: c.summary.total },
    ...(c.byProduct || []).map((x) => ({ code: x.code, label: x.label, count: x.count }))];
  $("productFilters").innerHTML = prodChips.map((x) =>
    `<button class="fchip ${S.productFilter === x.code ? "on" : ""}" data-f="${esc(x.code)}">${esc(x.label)}<span class="n">${x.count}</span></button>`).join("");
  $("productFilters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { S.productFilter = n.dataset.f; renderCreative(r); });

  // Advertiser chips are grouped by tier, because the two answer different
  // questions: locals are "who takes our customers", nationals are "how do we
  // compare to the ceiling". A flat row hides that Chase is standing furniture
  // rather than something the strategist chose.
  const live = c.byCompetitor.filter((x) => x.count);
  const locals = live.filter((x) => (x.tier || "local") === "local");
  const nationals = live.filter((x) => x.tier === "national");
  const chip = (x) => `<button class="fchip ${S.filter === x.code ? "on" : ""}" data-f="${esc(x.code)}">${esc(x.label)}<span class="n">${x.count}</span></button>`;

  $("filters").innerHTML = [
    chip({ code: "all", label: "All advertisers", count: c.summary.total }),
    ...locals.map((x) => chip({ code: x.domain, label: x.label, count: x.count })),
    nationals.length
      ? `<span class="chipdiv" title="Chase and Capital One are in every analysis as a fixed national ceiling, not because they compete locally">National</span>`
      : "",
    ...nationals.map((x) => chip({ code: x.domain, label: x.label, count: x.count })),
  ].join("");
  $("filters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { S.filter = n.dataset.f; renderCreative(r); });

  // The wall is TIERED, not merged.
  //
  // Volume asymmetry is the reason. A community bank might contribute four
  // cards while Chase contributes forty; interleaved, the screen is a Chase
  // screen and the local evidence sits below the fold. Solving an empty wall by
  // burying the local signal would not be solving it.
  //
  // Local first, always: it is what the strategist was actually asked about.
  const localCards = shown.filter((a) => (a.tier || "local") === "local");
  const natCards = shown.filter((a) => a.tier === "national");
  const t = c.tiers;

  const sectionFor = (cards, meta, cls) => cards.length ? `
    <div class="tierhead ${cls}">
      <h3>${esc(meta.label)}<span class="tiern">${cards.length}</span></h3>
      <p>${esc(meta.note)}</p>
    </div>
    <div class="wall">${cards.map(adCard).join("")}</div>` : "";

  $("resultBody").innerHTML = shown.length
    ? (t
        ? sectionFor(localCards, t.local, "loc") + sectionFor(natCards, t.national, "nat")
        : `<div class="wall">${shown.map(adCard).join("")}</div>`)
    : `<div class="empty">Nothing matches both filters. <button class="linkbtn" id="clearFilters">Clear filters</button></div>`;

  // When the locals are thin, say so rather than letting the national section
  // silently stand in for a market read.
  //
  // ZERO local is the case that matters most and the one a truthiness guard
  // misses: `localCards.length &&` is false at 0, so the thinnest possible
  // local set was the only one rendering no caveat at all — a wall of Chase and
  // Capital One with nothing saying the client's actual market returned
  // nothing. At zero the per-advertiser outcomes are shown too, because
  // "national benchmarks only" is a statement about the locals that the reader
  // is entitled to see the reasons behind.
  if (t && natCards.length && localCards.length < 4) {
    const caveat = localCards.length
      ? `Only <b>${localCards.length}</b> local creative${localCards.length === 1 ? "" : "s"} matched — local institutions often run very little display. The national benchmarks below are a reference ceiling, not this client's market.`
      : `<b>No local creatives were read in this capture.</b> Everything below is a national benchmark — a reference ceiling, not this client's market. Nothing was invented to fill the gap; here is what each advertiser returned:`;
    const detail = localCards.length ? "" :
      `<ul class="whylist">${outcomeRows(r, (t.local?.domains) || [])}</ul>`;
    $("resultBody").insertAdjacentHTML("afterbegin",
      `<div class="scopebar" style="display:block">${caveat}${detail}</div>`);
  }

  const clear = $("clearFilters");
  if (clear) clear.onclick = () => { S.filter = "all"; S.productFilter = "all"; renderCreative(r); };
  const showAll = $("showAllProducts");
  if (showAll) showAll.onclick = () => { S.productFilter = "all"; renderCreative(r); };

  wireImages();
  // A card stands for an IDEA, so opening it must show every execution behind
  // it, not just the one representative the wall happened to render.
  $("resultBody").querySelectorAll(".shot").forEach((n) =>
    n.onclick = () => openEvidence((n.dataset.ids || "").split(",").filter(Boolean), "Creative"));
}

/* Creative images are served through the app's own origin.
   simgad URLs are meant for the Transparency Center's front end and can be
   refused cross-origin; when that happens every card reads "could not be
   loaded" and the tool looks broken rather than hotlink-blocked. The proxy is
   tried first, the original URL second, and only then is the card marked. */
function wireImages(root) {
  (root || document).querySelectorAll("img.cimg:not([data-wired])").forEach((img) => {
    img.dataset.wired = "1";
    img.onerror = () => {
      if (img.dataset.stage === "proxy") {
        img.dataset.stage = "direct";
        img.src = img.dataset.direct;
        return;
      }
      img.replaceWith(Object.assign(document.createElement("div"), {
        className: "broken",
        textContent: "Creative could not be loaded",
      }));
    };
    img.dataset.stage = "proxy";
    img.src = `/api/img?u=${encodeURIComponent(img.dataset.direct)}`;
  });
}

function adCard(a) {
  const days = a.totalDaysShown != null
    ? `shown on ${a.totalDaysShown.toLocaleString()} days${a.firstShown ? ` since ${monthYear(a.firstShown)}` : ""}` : "";
  const ids = [a.creativeId, ...(a.variationIds || [])].filter((v, i, arr) => v && arr.indexOf(v) === i);
  return `
  <div class="adcard">
    <div class="shot" data-cid="${esc(a.creativeId)}" data-ids="${esc(ids.join(","))}">
      <img class="cimg" data-direct="${esc(a.imageUrl)}" alt="" loading="lazy" />
    </div>
    <div class="meta">
      <div class="who">${esc(a.institutionLabel || a.institution)}</div>
      <div class="hl">${esc(a.headline || "(no legible headline)")}</div>
      ${a.subhead ? `<div class="sh">${esc(a.subhead)}</div>` : ""}
      ${a.offer ? `<div class="offer">${esc(a.offer.value)}${a.offer.term ? ` · ${esc(a.offer.term)}` : ""}</div>` : ""}
      <div class="foot">
        ${a.tier === "national" ? `<span class="tag natbadge">National benchmark</span>` : ""}
        ${a.variations > 1 ? `<span class="tag varbadge">${a.variations} variations</span>` : ""}
        ${a.sizes?.length ? `<span>${esc(a.sizes.slice(0, 2).join(", "))}</span>` : ""}
        ${days ? `<span class="dot">·</span><span>${esc(days)}</span>` : ""}
        ${!a.legible ? `<span class="tag" style="color:var(--amber)">partly legible</span>` : ""}
      </div>
    </div>
  </div>`;
}

function renderBenchmark(r) {
  const b = r.benchmark;
  $("resStats").innerHTML = `
    <div class="st"><div class="v">${b.columns.find((c) => c.isClient)?.adCount ?? 0}</div><div class="k">Your ads</div></div>
    <div class="st"><div class="v">${b.columns.filter((c) => !c.isClient).reduce((s, c) => s + c.adCount, 0)}</div><div class="k">Their ads</div></div>
    <div class="st"><div class="v">${b.columns.length - 1}</div><div class="k">Competitors</div></div>`;
  $("filters").innerHTML = "";
  $("productFilters").innerHTML = "";

  // A product scope that discards every captured ad produces a table of
  // em-dashes that looks like "nobody advertises anything". Say what happened.
  const captured = (r.ads || []).length;
  const inTable = b.columns.reduce((s, c) => s + c.adCount, 0);
  const scope = $("scopeBar");
  if (captured && !inTable) {
    scope.classList.remove("hidden");
    scope.innerHTML = `<b>${captured}</b> ads were captured but none classified as <b>${esc(r.productLabel)}</b>, so every cell below is empty. Re-run with a different product scope.`;
  } else if (inTable < captured) {
    scope.classList.remove("hidden");
    scope.innerHTML = `Scoped to <b>${esc(r.productLabel)}</b>: <b>${inTable}</b> of <b>${captured}</b> captured ads are in this table.`;
  } else {
    scope.classList.add("hidden");
  }

  const findings = (b.findings || []).map((f) => `
    <div class="finding ${esc(f.kind)}">
      <div>${esc(f.text)}</div>
      ${f.evidence?.length ? `<span class="ev" data-ev="${esc(f.evidence.join(","))}">${f.evidence.length} ads</span>` : ""}
    </div>`).join("");

  const head = `<tr><th></th>${b.columns.map((c) =>
    `<th class="${c.isClient ? "cl" : ""}">${esc(c.label)}<span class="sm">${esc(c.domain)}</span></th>`).join("")}</tr>`;

  const body = b.rows.map((row) => {
    const cells = row.cells.map((c) => {
      const col = b.columns.find((x) => x.key === c.column);
      return `<td class="${col?.isClient ? "clientcol" : ""}">
        <div class="val ${c.absent ? "absent" : ""}">${esc(c.value)}</div>
        ${c.detail ? `<div class="det">${esc(c.detail)}</div>` : ""}
        ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
        ${c.evidence?.length ? `<span class="ev" data-ev="${esc(c.evidence.join(","))}">View ${c.evidence.length} ad${c.evidence.length > 1 ? "s" : ""}</span>` : ""}
      </td>`;
    }).join("");
    // The comparability caveat rides WITH its row, not in a footnote.
    const warn = row.comparability?.note
      ? `<tr><td colspan="${b.columns.length + 1}" class="comprow-note">${esc(row.comparability.note)}</td></tr>` : "";
    // Offer rows carry the emphasis colour — they are the reason for the table.
    return `<tr class="${row.kind === "offer" ? "offerrow" : ""}"><td class="rl">${esc(row.label)}</td>${cells}</tr>${warn}`;
  }).join("");

  // ---- THE BOARD IS THE ANSWER; THE TABLE IS THE AUDIT TRAIL --------------
  // Findings first, then the compact offer snapshot, then the report lines the
  // strategist actually pastes. The old table drops to the bottom behind a
  // disclosure — it is what you open when someone asks where a number came
  // from, not what you read to answer the question.
  //
  // "Generate recommended strategies" is GONE from this mode. Han asked
  // Fulfillment for quasi-analysis: counted facts a client draws their own
  // conclusion from. That gate belongs in Creative and Sales.
  $("resultBody").innerHTML = `
    ${boardHtml(r.board)}
    <details class="auditwrap">
      <summary>Full benchmark table and capture detail</summary>
      ${findings ? `<div class="findings">${findings}</div>` : ""}
      <div class="bwrap"><table class="bench"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    </details>`;

  wireEvidence();
  wireReportLines();
}

// ===========================================================================
// THE FINDINGS BOARD
// ===========================================================================

function boardHtml(board) {
  if (!board) return "";

  // Coverage first, because every denominator below depends on it and a reader
  // who does not know the capture was thin reads thin numbers as findings.
  const warnings = (board.coverage?.suggestions || []).map((sug) => `
    <div class="cov ${esc(sug.severity)}">
      <div class="covt">${esc(sug.text)}</div>
      ${sug.remedy ? `<div class="covr">${esc(sug.remedy)}</div>` : ""}
    </div>`).join("");

  const drift = board.setDrift
    ? `<div class="cov warning"><div class="covt">${esc(board.setDrift.note)}</div></div>` : "";

  const b = board.boards || { lead: [], pressure: [], context: board.findings || [] };
  const nothing = !b.lead.length && !b.pressure.length && !b.context.length;

  return `
    <section class="board">
      <div class="boardhead">
        <h3 class="bh">Competitive findings</h3>
        ${(board.reportLines || []).length
          ? `<button class="btn ghost sm" id="copyAll">Copy findings</button><span class="repstatus" id="repStatus"></span>`
          : ""}
      </div>
      ${warnings}${drift}
      ${primaryReadHtml(board.primaryRead)}

      ${nothing ? `
        <div class="fempty">
          <div class="femptyt">${esc(board.empty?.text || "No findings.")}</div>
          ${board.empty?.remedy ? `<div class="femptyr">${esc(board.empty.remedy)}</div>` : ""}
        </div>` : `
        <div class="scoreboard">
          ${columnHtml("lead", "Where you lead", b.lead.filter(notIsolated),
            "Nothing in the captured ads put this client ahead.")}
          <!-- "Where competitors LEAD" was too strong for what sat under it.
               One competitor printing a $5 minimum does not establish that they
               lead — it is a difference observed in a single advertiser. The
               column now holds only shared or comparable pressure; lone tactics
               move to their own block below, where they cannot be mistaken for
               a market standard. -->
          ${columnHtml("pressure", "Competitive pressure", b.pressure.filter(notIsolated),
            "No competitor was ahead across the captured set.")}
        </div>
        ${isolatedOf(b).length ? `
          <details class="ctxwrap" open>
            <summary>Other differences observed — ${isolatedOf(b).length}</summary>
            <div class="fgrid ctx">${isolatedOf(b).map(cardHtml).join("")}</div>
          </details>` : ""}
        ${b.context.length ? `
          <!-- OPEN by default, and named neutrally. These are the findings that
               are neither a win nor a loss — the mixed-message question, the age
               of a creative. Collapsed behind the word "Context" they read as
               small print, and the card most likely to start a real conversation
               with the client was the one nobody opened. -->
          <details class="ctxwrap" open>
            <summary>Some observations — ${b.context.length}</summary>
            <div class="fgrid ctx">${b.context.map(cardHtml).join("")}</div>
          </details>` : ""}
      `}

      ${setShapeHtml(board.setShape)}
      ${snapshotHtml(board.snapshot)}
    </section>`;
}

/**
 * THE PRIMARY READ — the one sentence at the top.
 *
 * Six true cards still leave the reader assembling the picture themselves, and
 * two readers assemble it differently. This is the same findings arranged into
 * a read: where the client stands on the headline figure, what is creating the
 * difference, and what the evidence cannot settle.
 *
 * Written in code, never by a model — see lib/primary-read.js for why. It is
 * the most quotable thing on this page and the most likely to be read aloud to
 * a client, which is exactly the wrong place for prose that can drift.
 */
function primaryReadHtml(pr) {
  if (!pr) return "";
  return `
    <div class="pread">
      <div class="preadframe">${esc(pr.framing)}</div>
      <h4 class="preadhead">${esc(pr.headline)}</h4>
      ${pr.participation ? `<div class="preadpart">${esc(pr.participation)}</div>` : ""}
      <div class="preaddiff">${esc(pr.differences)}</div>
      ${pr.localVsNational ? `<div class="preadlocal">${esc(pr.localVsNational)}</div>` : ""}
      ${pr.changes?.length ? `
        <div class="preadchange">
          <div class="preadchangeh">Since the previous review</div>
          ${pr.changes.map((c) => `<div class="preadchangeline">${esc(c.text)}</div>`).join("")}
        </div>` : ""}
      <div class="preadbound">${esc(pr.boundary)}</div>
    </div>`;
}

/**
 * One scoreboard column.
 *
 * "Where you lead" / "Where competitors lead" — NOT "winning" and "losing".
 * Sales reads this sitting beside the client, and a header reading LOSING is
 * RAIN asserting the client's product is inferior, which is the one thing Han
 * ruled out. These headers describe the ADVERTISING, which is all that was
 * observed, and let the client draw the conclusion.
 *
 * An empty column still renders. "No competitor was ahead in the captured ads"
 * is a finding; a missing column just looks like the tool did not finish.
 */
function columnHtml(kind, title, findings, emptyText) {
  return `
    <div class="scol ${esc(kind)}">
      <div class="scolhead">
        <span class="sdot"></span>${esc(title)}
        <span class="scount">${findings.length}</span>
      </div>
      ${findings.length
        ? [...findings].sort((a, b) => SIG_ORDER.indexOf(a.significance) - SIG_ORDER.indexOf(b.significance)).map(cardHtml).join("")
        : `<div class="scolempty">${esc(emptyText)}</div>`}
    </div>`;
}

/* Each metric keeps ONE colour everywhere it appears, so "the pink one" is
   always the fee and a board can be scanned by hue before it is read. Assigned
   per metric rather than per outcome — the lead/pressure split is already
   carried by the two columns and the card's left border, and repeating it here
   would spend all the colour on a distinction the layout has made twice. */
const CHIP_TONE = {
  apy: "t-green", apr: "t-green", intro_apr: "t-green",
  // No amber in the chip set. Amber now means caution on this page and nothing
  // else, so a metric label cannot borrow it — "Cash bonus" in a warning colour
  // reads as a problem rather than as the figure it names.
  cash_bonus: "t-violet",
  monthly_fee: "t-pink", annual_fee: "t-pink", closing_costs: "t-pink",
  minimum_opening_deposit: "t-cyan", minimum_balance: "t-cyan", down_payment: "t-cyan",
  rewards_rate: "t-slate", points: "t-slate", term_months: "t-slate",
};
const chipTone = (f) => CHIP_TONE[f.metric] || "t-slate";

/* Heaviest first inside a column, so the order carries weight as well as the type size. */
const SIG_ORDER = ["primary", "supporting", "isolated", "internal"];
/* A tactic used by one advertiser is a difference, not a competitor leading. */
const notIsolated = (f) => f.significance !== "isolated";
const isolatedOf = (b) => [...b.lead, ...b.pressure].filter((f) => f.significance === "isolated");

/** One finding: one bold sentence, one line of detail, one evidence chip. */
function cardHtml(f) {
  const ev = [...new Set(f.evidence || [])];
  return `
    <article class="fcard ${esc(f.outcome || "context")} sig-${esc(f.significance || "supporting")}">
      <div class="flabel">
        <span class="fchip ${esc(chipTone(f))}">${esc(f.chip || f.label)}</span>${
        f.chip && f.chip !== f.label ? `<span class="frule">${esc(f.label)}</span>` : ""}${
        f.significance === "isolated"
          // Said on the card, not just implied by size. "One competitor prints a
          // $5 minimum" is a tactic; without this it reads as a market standard.
          ? `<span class="fsig" title="Advertised by a single competitor in the captured set — a tactic, not a pattern across the local market">One advertiser</span>`
          : ""}</div>
      <h4>${esc(f.headline)}</h4>
      ${f.detail ? `<div class="fdetail">${esc(f.detail)}</div>` : ""}
      ${(f.excluded || []).length ? `<div class="fexcl">Not ranked: ${
        f.excluded.map((x) => `${esc(x.label)} ${esc(x.raw)} (${esc(x.reason)})`).join(" · ")}</div>` : ""}
      ${ev.length ? `<span class="ev" data-ev="${esc(ev.join(","))}">View ${ev.length} ad${ev.length > 1 ? "s" : ""}</span>` : ""}
    </article>`;
}

/**
 * What the captured set is competing on — counted, never written.
 *
 * Arithmetic over the ads we actually read, naming its denominator on every
 * line. This replaced a model-written "what generally holds in this category"
 * block: on a page a client reads over your shoulder, "bonuses convert faster"
 * invites the question "based on what?" and this capture cannot answer it.
 */
function setShapeHtml(shape) {
  if (!shape?.observations?.length) return "";
  return `
    <h3 class="bh">What this set is competing on</h3>
    <div class="shape">
      <div class="shapeframe">${esc(shape.framing)}</div>
      <div class="shapelist">
        ${shape.observations.map((o) => `
          <div class="shapeitem${o.reference ? " ref" : ""}">
            <div class="shapechip"><span class="fchip ${esc(CHIP_TONE[o.metric] || "t-slate")}">${esc(o.chip)}</span></div>
            <div class="shapebody">
              <div class="shapetext">${esc(o.text)}</div>
              ${o.detail ? `<div class="shapedetail">${esc(o.detail)}</div>` : ""}
              ${o.evidence?.length
                ? `<span class="ev sm" data-ev="${esc(o.evidence.join(","))}">View ${o.evidence.length} ad${o.evidence.length > 1 ? "s" : ""}</span>`
                : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}

/**
 * WHAT EACH ADVERTISER IS COMPETING ON.
 *
 * This was a metric matrix, and a matrix is right for a rich product and wrong
 * for a thin one. The checking board filled four columns; the auto-loan board
 * filled two, showed a grid of "none captured", and carried three rows that
 * said nothing at all. Worse, columns fixed to the profile had nowhere to put
 * Neighbors' "Up to 100% Financing" — so the one thing that advertiser was
 * competing on was dropped, and they read as having printed nothing.
 *
 * A line per advertiser instead, carrying every figure they printed and what
 * they message on. The metric-by-metric grid still exists in the full table
 * below; this answers the different question a salesperson is actually asked.
 */
function snapshotHtml(snap) {
  if (!snap?.summaries?.length) return "";
  const row = (x) => `
    <div class="osrow${x.isClient ? " client" : ""}${x.tier === "national" ? " ref" : ""}">
      <div class="osname">${esc(x.label)}${x.isClient ? `<span class="ostag">Your client</span>` : ""}</div>
      <div class="ostext">${esc(x.text)}</div>
      ${x.figures?.length
        ? `<div class="osfigs">${x.figures.map((f) => `
            <span class="osfig">${esc(f.label)} <b>${esc(f.raw)}</b>${f.note ? ` <i>${esc(f.note)}</i>` : ""}${
              f.evidence?.length ? `<span class="ev sm" data-ev="${esc(f.evidence.join(","))}">${f.evidence.length}</span>` : ""}</span>`).join("")}</div>`
        : ""}
    </div>`;

  return `
    <h3 class="bh">What each advertiser is competing on</h3>
    <div class="oslist">${snap.summaries.map(row).join("")}</div>
    ${snap.referenceSummaries?.length ? `
      <div class="osrefhead">National reference — not counted in any finding</div>
      <div class="oslist">${snap.referenceSummaries.map(row).join("")}</div>` : ""}
    ${snap.absent?.length ? `
      <div class="osabsent">
        <b>Not advertising this product in what we captured:</b>
        ${snap.absent.map((a) => `<div>${esc(a.text)}</div>`).join("")}
      </div>` : ""}
    <div class="snapnote">Every figure is the strongest the advertiser printed in the captured ads, with the qualifiers it carried. The metric-by-metric comparison is in the full table below.${
      snap.referenceNote ? ` ${esc(snap.referenceNote)}` : ""}</div>`;
}

/**
 * ONE copy button, in the header.
 *
 * The old "For the monthly report" section restated all four findings verbatim
 * — the same content twice on a screen meant to be scanned in seconds. The
 * capability is what mattered, not the section, so it collapsed to a button.
 */
function wireReportLines() {
  const btn = $("copyAll");
  if (!btn) return;
  btn.onclick = async () => {
    const lines = (S.run?.board?.reportLines || []).map((l) => l.text).filter(Boolean);
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.map((t) => `\u2022 ${t}`).join("\n"));
      $("repStatus").textContent = `${lines.length} line${lines.length > 1 ? "s" : ""} copied`;
    } catch {
      $("repStatus").textContent = "Could not copy";
    }
    setTimeout(() => { const el = $("repStatus"); if (el) el.textContent = ""; }, 3000);
  };
}

function wireGate() {
  const btn = $("genBtn");
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Reading the evidence…";
    let r;
    try {
      r = await (await fetch(`/api/run/${S.runId}/strategies`, { method: "POST" })).json();
    } catch {
      btn.disabled = false; btn.textContent = "Generate recommended strategies";
      showError("Could not reach the server to generate strategies.");
      return;
    }
    if (!r.ok) {
      btn.disabled = false; btn.textContent = "Generate recommended strategies";
      showError(r.reason === "anthropic_not_configured"
        ? "ANTHROPIC_API_KEY is not set on the server, so strategies cannot be generated."
        : `Could not generate strategies: ${r.reason}`);
      return;
    }
    S.run.strategies = r.strategies;
    $("strategyZone").innerHTML = strategyHtml(r.strategies);
  };
}

function strategyHtml(s) {
  const angles = (s.angles || []).map((a) => `
    <div class="angle">
      <h4>${esc(a.title)}</h4>
      <div class="lab">What the captured ads show</div>
      <div class="txt">${esc(a.evidence)}</div>
      <div class="lab">What it opens up</div>
      <div class="txt">${esc(a.opening)}</div>
      ${a.question ? `<div class="q"><b>Confirm first:</b> ${esc(a.question)}</div>` : ""}
    </div>`).join("");

  const cautions = (s.cautions || []).map((c) => `<div class="finding">${esc(c)}</div>`).join("");

  return `
    <h3 style="margin:34px 0 14px;font-size:20px">Recommended strategies</h3>
    <div class="samplingbar" style="margin-bottom:18px">
      Generated from the counted facts above. Every angle is an internal prompt for the strategist — confirm anything it asks about the client before putting it in front of them.
    </div>
    ${angles}
    ${cautions ? `<h3 style="margin:26px 0 12px;font-size:16px">Cautions</h3><div class="findings">${cautions}</div>` : ""}`;
}

/* ---------------- evidence drawer ---------------- */
function wireEvidence() {
  document.querySelectorAll(".ev").forEach((n) =>
    n.onclick = () => openEvidence(n.dataset.ev.split(",").filter(Boolean), "Evidence"));
}

function openEvidence(ids, title) {
  const ads = (S.run.ads || []).filter((a) => ids.includes(a.creativeId));
  $("drawerTitle").textContent = `${title} · ${ads.length} ad${ads.length === 1 ? "" : "s"}`;
  $("drawerBody").innerHTML = ads.length ? ads.map((a) => `
    <div class="evcard">
      <div class="shot"><img class="cimg" data-direct="${esc(a.imageUrl)}" alt="" /></div>
      <div class="m">
        <b>${esc(a.institutionLabel || a.institution)}</b>${a.advertiser && a.advertiser !== a.institutionLabel
          ? ` <span style="color:var(--amber)">· verified advertiser: ${esc(a.advertiser)}</span>` : ""}<br />
        ${esc(a.headline || "")}<br />
        ${a.offer ? `<b>${esc(a.offer.value)}</b>${a.offer.term || a.offer.minimum ? ` — ${esc([a.offer.term, a.offer.minimum, a.offer.qualifier].filter(Boolean).join(" · "))}` : " — no term or minimum printed on this creative"}<br />` : ""}
        ${a.totalDaysShown != null ? `Shown on ${a.totalDaysShown.toLocaleString()} days${a.firstShown ? ` since ${monthYear(a.firstShown)}` : ""}` : ""}
        ${a.lastShown ? ` · last observed ${esc(a.lastShown)}` : ""}<br />
        ${safeUrl(a.detailsLink) ? `<a href="${esc(safeUrl(a.detailsLink))}" target="_blank" rel="noopener">View in Google Ads Transparency Center ↗</a>` : ""}
      </div>
    </div>`).join("") : `<div class="empty">No creatives matched.</div>`;
  wireImages($("drawerBody"));
  $("drawer").classList.add("on"); $("drawerBg").classList.add("on");
}

const closeDrawer = () => { $("drawer").classList.remove("on"); $("drawerBg").classList.remove("on"); };
$("drawerClose").onclick = closeDrawer;
$("drawerBg").onclick = closeDrawer;

/* ---------------------------------------------------------------------------
   THE WIDE SHEET — the search wall, and the themes popup.
   Both render from data already in S.run: no fetch, no capture, no cost.
   --------------------------------------------------------------------------- */
function openSheet(title, sub, html) {
  $("sheetTitle").textContent = title;
  $("sheetSub").textContent = sub || "";
  $("sheetBody").innerHTML = html;
  wireImages($("sheetBody"));
  $("sheet").classList.add("on"); $("sheetBg").classList.add("on");
}
const closeSheet = () => { $("sheet").classList.remove("on"); $("sheetBg").classList.remove("on"); };
$("sheetClose").onclick = closeSheet;
$("sheetBg").onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); closeDrawer(); } });

/* ---------------------------------------------------------------------------
   THE WALL OF SEARCH ADS — its own screen.
   Every creative here was captured and read by the Competitive Intelligence run
   behind it, so browsing costs nothing: no request, no vision call, no model.
   --------------------------------------------------------------------------- */
const SW = { product: "all", brand: "all" };

function openSearchWall() {
  // OPEN ON THE SCOPED PRODUCT, matching the title above it and the display
  // wall's own convention. The heading reads "· Checking" and the run is a
  // checking analysis, so landing on all 131 creatives contradicted both.
  //
  // Falls back to everything when the scope has nothing in it — landing on an
  // empty wall is the one failure worse than landing on a broad one. The chips
  // still reach every captured ad, so the scope narrows and never hides.
  const ads = S.run?.ads || [];
  const scoped = ads.filter((a) => (a.product || "other") === S.run?.product).length;
  SW.product = scoped ? S.run.product : "all";
  SW.brand = "all";
  renderSearchWall();
  show("s-searchwall");
  window.scrollTo(0, 0);
}

function renderSearchWall() {
  const r = S.run;
  const ads = r?.ads || [];
  $("swTitle").textContent = `${r.client.label} · ${r.productLabel}`;
  // The subtitle describes WHAT IS ON SCREEN, then the capture total. "131
  // creatives" over a wall showing thirty is the same confusion as the title
  // saying Checking while the filter said All.
  const shownCount = ads
    .filter((a) => SW.product === "all" || (a.product || "other") === SW.product)
    .filter((a) => SW.brand === "all" || a.institution === SW.brand).length;
  const scopeName = SW.product === "all" ? "" : ` ${productLabel(SW.product).toLowerCase()}`;
  $("swSub").textContent = shownCount === ads.length
    ? `All ${ads.length} creatives captured and read for this run. This is what was captured, not the whole market.`
    : `Showing ${shownCount}${scopeName} of ${ads.length} creatives captured and read for this run. This is what was captured, not the whole market.`;

  // Counts are over EVERYTHING captured, never over the current slice — a chip
  // whose number only describes the filtered view cannot be used to escape it.
  const label = (a) => a.institutionLabel || a.institution;
  const byProduct = new Map();
  const byBrand = new Map();
  for (const a of ads) {
    const p = a.product || "other";
    byProduct.set(p, (byProduct.get(p) || 0) + 1);
    if (!byBrand.has(a.institution)) byBrand.set(a.institution, { label: label(a), tier: a.tier, isClient: a.isClient, n: 0 });
    byBrand.get(a.institution).n++;
  }

  const chip = (on, key, text, n) =>
    `<button class="fchip ${on ? "on" : ""}" data-f="${esc(key)}">${esc(text)}<span class="n">${n}</span></button>`;

  $("swProductFilters").innerHTML = [
    chip(SW.product === "all", "all", "All products", ads.length),
    ...[...byProduct.entries()].sort((a, b) => b[1] - a[1])
      .map(([code, n]) => chip(SW.product === code, code, productLabel(code), n)),
  ].join("");
  $("swProductFilters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { SW.product = n.dataset.f; renderSearchWall(); });

  // Client first, then locals by volume, then the national reference tier —
  // the same ordering the board uses, so the two screens agree on who matters.
  const brands = [...byBrand.entries()].map(([domain, v]) => ({ domain, ...v }));
  const rank = (b) => (b.isClient ? 0 : b.tier === "national" ? 2 : 1);
  brands.sort((a, b) => rank(a) - rank(b) || b.n - a.n);
  const locals = brands.filter((b) => b.tier !== "national");
  const nationals = brands.filter((b) => b.tier === "national");

  $("swFilters").innerHTML = [
    chip(SW.brand === "all", "all", "All advertisers", ads.length),
    ...locals.map((b) => chip(SW.brand === b.domain, b.domain, b.label + (b.isClient ? " (you)" : ""), b.n)),
    nationals.length
      ? `<span class="chipdiv" title="Chase and Capital One are in every analysis as a fixed national ceiling, not because they compete locally">National</span>`
      : "",
    ...nationals.map((b) => chip(SW.brand === b.domain, b.domain, b.label, b.n)),
  ].join("");
  $("swFilters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { SW.brand = n.dataset.f; renderSearchWall(); });

  // ONE wall, exactly like the display wall — not a list per advertiser. The
  // advertiser is already on every card, and grouping by brand turns browsing
  // into scrolling past four banks to reach the fifth.
  const shown = ads
    .filter((a) => SW.product === "all" || (a.product || "other") === SW.product)
    .filter((a) => SW.brand === "all" || a.institution === SW.brand);

  $("swBody").innerHTML = shown.length
    ? `<div class="wall">${shown.map(adCard).join("")}</div>`
    : `<div class="empty">No captured search ad matches this filter.</div>`;
  wireImages($("swBody"));
  $("swBody").querySelectorAll(".shot").forEach((n) =>
    n.onclick = () => openEvidence((n.dataset.ids || "").split(",").filter(Boolean), "Creative"));
}

$("searchWallBtn").onclick = openSearchWall;
$("swBack").onclick = () => { show("s-results"); window.scrollTo(0, 0); };

/**
 * Key insights — the recurring ideas across the captured display creatives.
 *
 * Fetched on click, then cached on the run so reopening is instant and costs
 * nothing twice. Descriptive only: see lib/themes.js for the constraints, which
 * are enforced in code after the model answers rather than asked for in a
 * prompt and hoped for.
 */
function themesHtml(t) {
  return `
    <div class="shapeframe" style="margin-bottom:16px">${esc(t.framing)}</div>
    <div class="shapelist">
      ${t.themes.map((x) => `
        <div class="shapeitem">
          <div class="shapechip"><span class="fchip t-violet">Theme</span></div>
          <div class="shapebody">
            <div class="shapetext"><b>${esc(x.name)}</b></div>
            <div class="shapedetail">${esc(x.description)}</div>
            ${x.creativeIds?.length
              ? `<span class="ev sm" data-ev="${esc(x.creativeIds.join(","))}">View ${x.creativeIds.length} ad${x.creativeIds.length > 1 ? "s" : ""}</span>`
              : ""}
          </div>
        </div>`).join("")}
    </div>`;
}

$("insightsBtn").onclick = async () => {
  const btn = $("insightsBtn");
  if (S.run?.themes) return openSheet("Key insights", "", themesHtml(S.run.themes));

  btn.disabled = true; btn.textContent = "Reading…";
  let r;
  try {
    r = await (await fetch(`/api/run/${S.run.id}/themes`, { method: "POST" })).json();
  } catch {
    btn.disabled = false; btn.textContent = "Key insights";
    return showError("Could not reach the server to read the creatives.");
  }
  btn.disabled = false; btn.textContent = "Key insights";

  if (!r.ok) {
    return showError(r.reason === "anthropic_not_configured"
      ? "ANTHROPIC_API_KEY is not set on the server, so themes cannot be read."
      : r.reason === "not_enough_creative"
        ? "Too few legible creatives on this wall to name a recurring idea. Widen the window or add a competitor."
        : `Could not read themes: ${r.reason}`);
  }
  S.run.themes = r.themes;
  openSheet("Key insights", "", themesHtml(r.themes));
};

function monthYear(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/* Nationals apply to both halves; the row only ever hides itself when there is
   no capture it could affect. */
$("nationalsChk").onchange = () => { S.includeNationals = $("nationalsChk").checked; refreshCost(); };

function syncNationalsRow() {
  // Shown for BOTH halves. v4 gave Competitive Intelligence a national
  // reference tier, but this row stayed creative-only — so Chase and Capital
  // One appeared in the results of a benchmark the user was never offered the
  // chance to opt out of. A capture the user did not agree to is the one thing
  // the cost line exists to prevent.
  const applies = true;
  $("natRow").classList.toggle("hidden", !applies);
  $("natWhy").textContent = S.mode === "benchmark"
    ? "Chase and Capital One as a reference ceiling. They are shown in their own block and are excluded from every finding and every denominator — we cannot tell whether their ads served in this market."
    : "A fixed national ceiling added to every display capture, shown in their own section below the local results — not as local competitors.";
}
$("reanalyzeBtn").onclick = () => startCapture({ force: true });

/* The cost line reads the per-advertiser cache before anything is spent, so
   "3 from cache, 1 request" is visible at the moment of choosing rather than
   discovered afterwards on an invoice. */
let costTimer = null;
async function refreshCost() {
  clearTimeout(costTimer);
  costTimer = setTimeout(async () => {
    const competitors = S.competitors.filter((c) => c.on).map((c) => ({ label: c.label || c.name, domain: c.domain }));
    if (!competitors.length) { $("costNote").textContent = "Select at least one competitor."; return; }

    const sources = S.mode === "benchmark"
      ? ["google_search"]
      : sourcesForChoice(S.sourceChoice);
    try {
      const r = await (await fetch("/api/cost", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: S.mode, sources, competitors, force: S.force,
          includeNationals: S.includeNationals,
          clientDomain: S.domain,
          days: { google_display: S.days, google_search: S.days },
        }),
      })).json();
      if (!r.ok) return;

      $("costNote").innerHTML = r.plans.map((p) => {
        const bits = [`<b>${SRC_LABEL[p.source]}</b>`];
        if (p.willFetch) bits.push(`<span class="fetch">${p.willFetch} request${p.willFetch > 1 ? "s" : ""}</span>`);
        if (p.fromCache) bits.push(`<span class="cached">${p.fromCache} from cache</span>`);
        if (!p.willFetch) bits.push(`<span class="cached">nothing to spend</span>`);
        return bits.join(" · ");
      }).join("<br>") + `<br><span class="cacheage">Captures are reused for ${r.plans[0]?.ttlDays ?? 7} days. Tick “Force fresh capture” to ignore them.</span>`;
    } catch { /* the cost line is advisory; a failure must not block capture */ }
  }, 120);
}
