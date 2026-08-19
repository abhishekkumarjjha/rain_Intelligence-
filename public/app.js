/* =========================================================================
   RAIN Intelligence — client.
   State is one object. Screens are shown/hidden, never re-created, so the
   browser keeps scroll position and nothing flickers on a filter change.
   ========================================================================= */

const S = {
  url: "", domain: "", clientLabel: "", product: "other", productLabel: "",
  mode: "", days: 30,
  competitors: [],          // {label, domain, typeTag, reason, relevance, on}
  runId: "", run: null,
  filter: "all",            // competitor filter on the wall
  productFilter: "all",     // product filter on the wall
  health: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

    const c = await (await fetch("/api/clients")).json();
    $("quickClients").innerHTML = (c.clients || []).slice(0, 6)
      .map((x) => `<span class="qc" data-d="${esc(x.domain)}">${esc(x.name)}</span>`).join("");
    $("quickClients").querySelectorAll(".qc").forEach((n) =>
      n.onclick = () => { $("urlInput").value = n.dataset.d; resolve(); });
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
    if (r.looksLikeHomepage) {
      $("compSub").innerHTML += `<br><span style="color:var(--amber)">No product detected in that URL — set the product scope on the right, or re-enter using the product page.</span>`;
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
  sel.onchange = () => { S.product = sel.value; S.productLabel = productLabel(S.product); refreshCompetitors(); };
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

/* ---------------- mode ---------------- */
document.querySelectorAll(".modecard[data-mode]").forEach((card) => {
  card.onclick = () => {
    S.mode = card.dataset.mode;
    renderCompetitors();
    show("s-comp");
  };
});

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

function renderCost() {
  const n = S.competitors.filter((c) => c.on).length + (S.mode === "benchmark" ? 1 : 0);
  const max = S.health?.maxReadPerAdvertiser || 18;
  $("costNote").innerHTML = n
    ? `${n} advertiser${n > 1 ? "s" : ""} · <b>${n}</b> search credit${n > 1 ? "s" : ""} · up to ${n * max} creatives read`
    : `Select at least one competitor.`;
  $("captureBtn").disabled = !S.competitors.some((c) => c.on);
}

/* ---------------- capture ---------------- */
$("captureBtn").onclick = async () => {
  const competitors = S.competitors.filter((c) => c.on).map((c) => ({ label: c.label || c.name, domain: c.domain }));
  $("captureBtn").disabled = true;
  const r = await (await fetch("/api/capture", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: S.mode, clientDomain: S.domain, clientLabel: S.clientLabel,
      product: S.product, days: S.days, competitors,
    }),
  })).json();
  $("captureBtn").disabled = false;

  if (!r.ok) {
    showError({
      serpapi_not_configured: "SERPAPI_API_KEY is not set on the server, so no ads can be fetched.",
      anthropic_not_configured: "ANTHROPIC_API_KEY is not set on the server, so creatives cannot be read.",
      no_competitors: "Select at least one competitor before capturing.",
      bad_client_domain: "That client domain could not be read. Re-enter the landing page URL.",
    }[r.reason] || `Could not start the capture: ${r.reason}`);
    return;
  }

  clearError();
  $("runNote").textContent = "";
  S.runId = r.runId;
  $("progList").innerHTML = r.targets.map((t) => `
    <div class="progrow" data-d="${esc(t.domain)}">
      <div class="lamp"></div>
      <div class="pn">${esc(t.label)}${t.isClient ? ' <span class="tag client">Your client</span>' : ""}</div>
      <div class="ps">queued</div>
    </div>`).join("");
  show("s-run");
  poll();
};

/* A capture takes tens of seconds and the poll is the only thing driving the UI
   forward. A single failed request used to end the loop silently, leaving the
   user on a progress screen that would never move again — indistinguishable
   from a hung capture. Transient failures are retried; a persistent one says so
   on the page. */
let pollMisses = 0;

async function poll() {
  let r;
  try {
    const res = await fetch(`/api/run/${S.runId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    r = await res.json();
    pollMisses = 0;
  } catch (e) {
    pollMisses++;
    if (pollMisses >= 5) {
      $("runNote").innerHTML = `<span class="bad">Lost contact with the server while capturing. The run may still be going — reload and it will be in the run list.</span>`;
      return;
    }
    setTimeout(poll, 1400 * pollMisses);
    return;
  }

  if (!r.ok) {
    $("runNote").innerHTML = `<span class="bad">That run could not be read back: ${esc(r.reason || "unknown")}.</span>`;
    return;
  }

  for (const [domain, p] of Object.entries(r.progress || {})) {
    const row = document.querySelector(`.progrow[data-d="${CSS.escape(domain)}"]`);
    if (!row) continue;
    row.className = "progrow " + ({ done: "ok", failed: "bad", empty: "bad" }[p.status] || "run");
    row.querySelector(".ps").innerHTML = progressLine(p);
  }

  if (r.status === "done") { S.run = r; renderResults(); return; }
  if (r.status === "error") {
    $("runNote").innerHTML = `<span class="bad">Capture failed: ${esc(reasonText(r.error))}</span>`;
    return;
  }
  setTimeout(poll, 1400);
}

function progressLine(p) {
  if (p.status === "queued") return "queued";
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
  $("resEyebrow").textContent = r.mode === "creative" ? "Creative Inspiration" : "Campaign Benchmark";
  $("resTitle").textContent = `${r.client.label} · ${r.productLabel}`;

  const s = r.sampling || {};
  $("samplingBar").className = "samplingbar" + (s.complete ? " clean" : "");
  $("samplingBar").textContent = s.note || "";

  // Every target can legitimately come back with nothing — no ads in the window,
  // preview-only creatives, a provider outage. That is a RESULT and it has to be
  // rendered as one, with the per-target reasons still visible, rather than
  // dropping the user onto an empty results screen.
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

function renderNothingCaptured(r) {
  $("resStats").innerHTML = "";
  $("filters").innerHTML = "";
  $("productFilters").innerHTML = "";
  $("scopeBar").classList.add("hidden");

  const rows = Object.entries(r.progress || {}).map(([domain, p]) => `
    <li><b>${esc(p.label || domain)}</b> — ${
      p.status === "failed" || p.status === "empty"
        ? esc(reasonText(p.reason))
        : `${p.read ?? 0} read`
    }${p.found != null ? ` · ${Number(p.found).toLocaleString()} found` : ""}${
      p.previewOnly ? ` · ${p.previewOnly} preview-only` : ""}</li>`).join("");

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
  $("resStats").innerHTML = `
    <div class="st"><div class="v">${c.summary.ideas}</div><div class="k">Ideas</div></div>
    <div class="st"><div class="v">${c.summary.total}</div><div class="k">Creatives</div></div>
    <div class="st"><div class="v">${c.summary.withOffer}</div><div class="k">With an offer</div></div>`;

  // When the product scope matched nothing, the server widened the wall rather
  // than handing back an empty one. Saying so matters: "these are all the
  // creatives captured" and "these are the checking creatives" are different
  // claims and the user has to know which one they are looking at.
  const scope = $("scopeBar");
  if (c.fellBackToAll) {
    scope.classList.remove("hidden");
    scope.innerHTML = `No creative in this capture classified as <b>${esc(r.productLabel)}</b> — most display banners carry no product signal at all. Showing all <b>${c.capturedCount}</b> creatives captured instead.`;
  } else if (c.scopedCount < c.capturedCount) {
    scope.classList.remove("hidden");
    scope.innerHTML = `Scoped to <b>${esc(r.productLabel)}</b>: <b>${c.scopedCount}</b> of <b>${c.capturedCount}</b> creatives captured.`;
  } else {
    scope.classList.add("hidden");
  }

  // Two independent filters. Product narrows what the wall is about; competitor
  // narrows whose work it is.
  const prodChips = [{ code: "all", label: "All products", count: c.summary.total },
    ...(c.byProduct || []).map((x) => ({ code: x.code, label: x.label, count: x.count }))];
  $("productFilters").innerHTML = prodChips.map((x) =>
    `<button class="fchip ${S.productFilter === x.code ? "on" : ""}" data-f="${esc(x.code)}">${esc(x.label)}<span class="n">${x.count}</span></button>`).join("");
  $("productFilters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { S.productFilter = n.dataset.f; renderCreative(r); });

  const compChips = [{ code: "all", label: "All advertisers", count: c.summary.total },
    ...c.byCompetitor.filter((x) => x.count).map((x) => ({ code: x.domain, label: x.label, count: x.count }))];
  $("filters").innerHTML = compChips.map((x) =>
    `<button class="fchip ${S.filter === x.code ? "on" : ""}" data-f="${esc(x.code)}">${esc(x.label)}<span class="n">${x.count}</span></button>`).join("");
  $("filters").querySelectorAll(".fchip").forEach((n) =>
    n.onclick = () => { S.filter = n.dataset.f; renderCreative(r); });

  const clusters = (c.clusters || [])
    .filter((a) => S.filter === "all" || a.institution === S.filter)
    .filter((a) => S.productFilter === "all" || a.product === S.productFilter);

  $("resultBody").innerHTML = clusters.length
    ? `<div class="wall">${clusters.map(adCard).join("")}</div>`
    : `<div class="empty">Nothing matches both filters. <button class="linkbtn" id="clearFilters">Clear filters</button></div>`;

  const clear = $("clearFilters");
  if (clear) clear.onclick = () => { S.filter = "all"; S.productFilter = "all"; renderCreative(r); };

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
    return `<tr><td class="rl">${esc(row.label)}</td>${cells}</tr>${warn}`;
  }).join("");

  $("resultBody").innerHTML = `
    ${findings ? `<div class="findings">${findings}</div>` : ""}
    <div class="bwrap"><table class="bench"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <div id="strategyZone">${r.strategies ? strategyHtml(r.strategies) : gateHtml()}</div>`;

  wireEvidence();
  wireGate();
}

function gateHtml() {
  return `
  <div class="gate">
    <h3>Strategies are not generated by default</h3>
    <p>The table above is evidence — what was advertised, by whom, over the same window. Recommendations are a separate, optional read that a strategist chooses to open.</p>
    <button class="btn primary lg" id="genBtn">Generate recommended strategies</button>
  </div>`;
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
        ${a.detailsLink ? `<a href="${esc(a.detailsLink)}" target="_blank" rel="noopener">View in Google Ads Transparency Center ↗</a>` : ""}
      </div>
    </div>`).join("") : `<div class="empty">No creatives matched.</div>`;
  wireImages($("drawerBody"));
  $("drawer").classList.add("on"); $("drawerBg").classList.add("on");
}

const closeDrawer = () => { $("drawer").classList.remove("on"); $("drawerBg").classList.remove("on"); };
$("drawerClose").onclick = closeDrawer;
$("drawerBg").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

function monthYear(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
