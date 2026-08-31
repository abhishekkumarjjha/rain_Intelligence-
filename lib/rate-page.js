// =============================================================================
// lib/rate-page.js — the CURRENT picture, beside the historical one.
//
// Ads are historical: a creative served in June advertises June's rate. The
// product page is current. Putting them in one column would be wrong; putting
// them side by side is exactly what a strategist wants.
//
// TWO HARD RULES, and they are what make this safe to ship:
//
// 1. NEVER RANKABLE. Rate-page figures are display-only and never enter a
//    denominator. Coverage of rate pages is wildly inconsistent — some are
//    JS-rendered tables, some are PDFs, some sit behind a "view all rates"
//    link — and inconsistent coverage produces biased counts. "3 of 5
//    competitors currently offer a higher APY" is a sentence this module must
//    never enable. "Campus Federal's rate page showed 4.50% on Aug 30" is fine.
//
// 2. TIMESTAMPED AND SNAPSHOTTED. Same evidence discipline as an ad. A page a
//    client disputes in November needs the August fetch, and pages change
//    without notice or history.
//
// The finding it earns is the one with zero CEO-constraint risk, because it
// names nobody's product as worse than anybody else's: a client still running a
// creative that advertises a figure their own page no longer shows.
// =============================================================================

import { METRIC_IDS } from "./metrics.js";
import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";

const FETCH_TIMEOUT_MS = 12000;
const MAX_CHARS = 30000;

const SYSTEM = `You are reading the visible text of a bank or credit union product page and reporting the rates and fees printed on it.

You are a TRANSCRIBER. Report only figures that are actually printed on the page
for the product asked about. Never infer, never average, never carry a figure
over from a different product on the same page.

Rate pages routinely list MANY products in one table. Return only rows that
belong to the product named in the user message. If you cannot tell which
product a figure belongs to, omit it — a savings APY reported as a checking APY
is worse than no figure at all, because it will be shown beside advertising as a
current fact.

Allowed "metric" values, and nothing else:
${METRIC_IDS.join(", ")}

Keep "raw" exactly as printed, including the percent sign and any asterisk.
Report qualifiers ONLY when printed: term_months, minimum_deposit, balance_cap.

Return ONLY this JSON, no prose:
{
  "facts": [
    { "metric": "apy", "raw": "4.25% APY", "qualifiers": { "term_months": null, "minimum_deposit": 25, "balance_cap": null }, "context": "the row or heading this came from" }
  ],
  "productFound": true,
  "note": "anything that limits confidence, e.g. rates behind a link, or a PDF"
}`;

const num = (s) => {
  const t = String(s || "");
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return parseFloat(pct[1]);
  const usd = t.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (usd) return parseFloat(usd[1].replace(/,/g, ""));
  return null;
};

/** Strip a fetched HTML document down to readable text. No dependency, on purpose. */
export function toText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // Table structure is the signal on a rate page: keeping cell boundaries as
    // separators is what lets the model tell "4.25%" in the checking row from
    // "4.50%" in the savings row two rows down.
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
}

/**
 * Fetch and read one product page.
 *
 * Every failure mode returns `ok: false` with a reason rather than throwing: a
 * rate page is a bonus signal, and a bank with an unreadable site must not be
 * able to fail a benchmark run.
 */
export async function readRatePage(url, { product, productLabel } = {}) {
  const fetchedAt = new Date().toISOString();
  let html;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(/^https?:\/\//i.test(url) ? url : `https://${url}`, {
      signal: ctrl.signal,
      headers: { "user-agent": "RAIN-Intelligence/1.0 (+rainlocal.com)", accept: "text/html" },
    }).finally(() => clearTimeout(t));
    if (!res.ok) return { ok: false, url, fetchedAt, reason: `http_${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!/text\/html/i.test(type)) return { ok: false, url, fetchedAt, reason: "not_html" };
    html = await res.text();
  } catch (e) {
    return { ok: false, url, fetchedAt, reason: e.name === "AbortError" ? "timeout" : "fetch_failed" };
  }

  const text = toText(html);
  if (text.length < 200) return { ok: false, url, fetchedAt, reason: "no_readable_text" };

  let out;
  try {
    const msg = await createWithRetry({
      model: ANALYSIS_MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Product: ${productLabel || product}\n\nPage text:\n\n${text}`,
      }],
    });
    out = extractJSON(msg) || {};
  } catch (e) {
    if (e.code === "NO_API_KEY") throw e;
    return { ok: false, url, fetchedAt, reason: "read_failed" };
  }

  const facts = (Array.isArray(out.facts) ? out.facts : [])
    .slice(0, 12)
    .map((f) => ({
      metric: String(f?.metric || "").toLowerCase(),
      raw: String(f?.raw || "").trim(),
      value: num(f?.raw),
      qualifiers: (f && typeof f.qualifiers === "object" && f.qualifiers) || {},
      context: String(f?.context || "").trim(),
      // Set here, once, so no caller has to remember. Every downstream consumer
      // reads this flag rather than deciding for itself.
      rankable: false,
      displayOnly: true,
    }))
    .filter((f) => METRIC_IDS.includes(f.metric) && f.raw);

  return {
    ok: true,
    url,
    fetchedAt,
    product,
    productFound: out.productFound !== false,
    note: String(out.note || "").trim(),
    facts,
    // The fetched text is archived with the run for the same reason ad bytes
    // are: a page a client disputes in three months will have changed by then.
    textSnapshot: text.slice(0, 8000),
  };
}

/** Read several pages concurrently. Failures are isolated per domain. */
export async function readRatePages(targets = [], { product, productLabel } = {}) {
  const out = {};
  await Promise.all(targets.map(async (t) => {
    if (!t?.url || !t?.domain) return;
    try {
      out[t.domain] = await readRatePage(t.url, { product, productLabel });
    } catch (e) {
      if (e.code === "NO_API_KEY") throw e;
      out[t.domain] = { ok: false, url: t.url, reason: "error", fetchedAt: new Date().toISOString() };
    }
  }));
  return out;
}
