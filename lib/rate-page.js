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

import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { METRIC_IDS } from "./metrics.js";
import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";

const FETCH_TIMEOUT_MS = 12000;
const MAX_CHARS = 30000;

// ---------------------------------------------------------------------------
// THE URL GATE.
//
// This is the only place in the product that fetches a URL a user typed. The
// image proxy fetches user-supplied URLs too, and it is safe because it holds a
// four-host allowlist — every URL it will ever see comes from one of two Google
// CDNs. That guard cannot be reused here: a competitor's rate page is, by
// definition, an arbitrary host on the public internet, and an allowlist of
// arbitrary hosts is not an allowlist.
//
// So the rule is the other one: the request must leave this machine. A URL
// naming loopback, a private range, link-local (which is where every cloud
// provider parks its instance-metadata service), or a hostname that resolves
// into one of those, is a request to read something on this host or inside its
// network and hand the text of it to a model. That it takes a domain and a URL
// from a form and returns the page contents is exactly the shape of an SSRF
// probe, and the deployment note in the README says this app is meant for a
// Render disk, where 169.254.169.254 is a live credential endpoint.
//
// FAIL CLOSED, like everything else in this codebase: a hostname that will not
// resolve is refused rather than attempted, because "we could not check" and
// "we checked and it is fine" are different answers.
//
// Known residual: between resolving a hostname and fetching it, DNS can change
// its answer (rebinding). Closing that needs connecting by address with an
// explicit Host header, which fetch() does not offer. It is a much narrower
// hole than the one being closed here, and it is recorded rather than pretended
// away.
// ---------------------------------------------------------------------------

const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

/** Names that never belong to a competitor's rate page. */
const PRIVATE_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

function ipv4Blocked(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                             // 0.0.0.0/8 "this network"
  if (a === 10) return true;                            // RFC1918
  if (a === 127) return true;                           // loopback
  if (a === 169 && b === 254) return true;              // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true;     // RFC1918
  if (a === 192 && b === 168) return true;              // RFC1918
  if (a === 192 && b === 0) return true;                // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                            // multicast, reserved, broadcast
  return false;
}

function ipv6Blocked(ip) {
  const s = String(ip).toLowerCase().split("%")[0];
  if (s === "::1" || s === "::") return true;           // loopback, unspecified
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);            // v4 wearing a v6 hat
  // ...and the same address after WHATWG URL parsing, which rewrites
  // "::ffff:127.0.0.1" to "::ffff:7f00:1". Reading only the dotted spelling let
  // loopback through the front door of the guard that exists to stop it.
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return ipv4Blocked([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."));
  }
  if (/^f[cd]/.test(s)) return true;                    // fc00::/7 unique local
  if (/^fe[89ab]/.test(s)) return true;                 // fe80::/10 link local
  if (/^ff/.test(s)) return true;                       // multicast
  return false;
}

/** Anything that is not a public unicast address, including "not an address". */
export function isBlockedAddress(ip) {
  const v = net.isIP(String(ip));
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true;
}

const defaultResolve = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Is this URL safe to fetch on the user's behalf?
 *
 * @param resolve  injectable so the guard is testable without a network. The
 *                 default is the real resolver; nothing in the app passes this.
 * @returns { ok: true, url } | { ok: false, reason }
 */
export async function checkPublicUrl(raw, { resolve = defaultResolve } = {}) {
  let u;
  try {
    const s = String(raw ?? "").trim();
    if (!s) return { ok: false, reason: "bad_url" };
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch { return { ok: false, reason: "bad_url" }; }

  // https ONLY. Not http — a rate page reached over plaintext can be rewritten
  // in flight, and what comes back is quoted to a client as a current fact.
  // And certainly not file:, data: or gopher:.
  if (u.protocol !== "https:") return { ok: false, reason: "not_https" };

  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return { ok: false, reason: "bad_url" };
  if (PRIVATE_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, reason: "private_host" };
  }

  if (net.isIP(host)) {
    return isBlockedAddress(host) ? { ok: false, reason: "private_address" } : { ok: true, url: u };
  }

  let addresses;
  try { addresses = await resolve(host); } catch { return { ok: false, reason: "dns_failed" }; }
  if (!addresses?.length) return { ok: false, reason: "dns_failed" };
  // EVERY answer must be public. A name that resolves to one public address and
  // one private one is a name that can be served either way.
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "private_address" };
  return { ok: true, url: u, addresses };
}

/**
 * Fetch a page with the gate applied at every hop.
 *
 * redirect: "manual" is the point. Left to follow redirects itself, fetch()
 * checks the URL we vetted and then cheerfully walks to 169.254.169.254 because
 * a remote server told it to. Each Location is re-validated from scratch.
 *
 * One AbortController covers headers AND body, and the body is read through a
 * byte counter — a timeout that stops at the headers is not a timeout, and a
 * page with no content-length can otherwise stream until memory runs out.
 */
async function fetchGuarded(rawUrl, { resolve } = {}) {
  let current = String(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await checkPublicUrl(current, { resolve });
    if (!guard.ok) return { ok: false, reason: guard.reason };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(guard.url.href, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "user-agent": "RAIN-Intelligence/1.0 (+rainlocal.com)", accept: "text/html" },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        if (!loc) return { ok: false, reason: `http_${res.status}` };
        current = new URL(loc, guard.url).href;
        continue;
      }
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };

      const type = res.headers.get("content-type") || "";
      if (!/text\/html/i.test(type)) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        return { ok: false, reason: "not_html" };
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        return { ok: false, reason: "too_large" };
      }

      if (!res.body) return { ok: true, html: await res.text() };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch { /* already gone */ }
          return { ok: false, reason: "too_large" };
        }
        chunks.push(Buffer.from(value));
      }
      return { ok: true, html: Buffer.concat(chunks).toString("utf8") };
    } catch (e) {
      return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "fetch_failed" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}

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
export async function readRatePage(url, { product, productLabel, resolve } = {}) {
  const fetchedAt = new Date().toISOString();
  // Every refusal reason travels back to the UI beside the domain it belongs
  // to, exactly like a failed capture does. A page we declined to fetch reads
  // as "we did not read this", never as "this competitor has no rates".
  const fetched = await fetchGuarded(url, { resolve });
  if (!fetched.ok) return { ok: false, url, fetchedAt, reason: fetched.reason };
  const html = fetched.html;

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
export async function readRatePages(targets = [], { product, productLabel, resolve } = {}) {
  const out = {};
  await Promise.all(targets.map(async (t) => {
    if (!t?.url || !t?.domain) return;
    try {
      out[t.domain] = await readRatePage(t.url, { product, productLabel, resolve });
    } catch (e) {
      if (e.code === "NO_API_KEY") throw e;
      out[t.domain] = { ok: false, url: t.url, reason: "error", fetchedAt: new Date().toISOString() };
    }
  }));
  return out;
}
