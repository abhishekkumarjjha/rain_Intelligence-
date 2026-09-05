// =============================================================================
// lib/claude.js — Anthropic plumbing for RAIN Intelligence.
//
// Near-identical to the SEM tool's competitor-client.js and DUPLICATED ON
// PURPOSE. These are two applications; a retry-policy change here must not be
// able to alter the behaviour of a live proposal generator.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";

// Transcribing a banner creative is structured reading, not judgement — a fast
// model is the right tool and the cost difference at ~100 creatives per run is
// the whole vision budget. Independently overridable.
export const VISION_MODEL = process.env.RI_VISION_MODEL || "claude-haiku-4-5-20251001";

// The gated strategy pass is judgement about positioning, so it defaults up.
export const ANALYSIS_MODEL = process.env.RI_ANALYSIS_MODEL || "claude-sonnet-5";

function client() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error("ANTHROPIC_API_KEY is not set"); e.code = "NO_API_KEY"; throw e; }
  return new Anthropic({ apiKey: key });
}

// ---------------------------------------------------------------------------
// ONE CEILING FOR THE WHOLE PROCESS.
//
// extractCreatives() caps itself at 6 concurrent vision calls PER ADVERTISER,
// and server.js runs every target in parallel. So the real ceiling was
// targets x 6 — about 30 in a typical run, 78 with ten competitors — plus the
// analysis calls, which were not counted at all. Nothing anywhere expressed a
// limit on this process as a whole.
//
// That is not only a rate-limit problem. Every one of those is money in flight
// at the same instant, and a 429 storm turns into retries, which turn into more
// calls. The per-advertiser cap is kept — it is what stops one advertiser
// monopolising the budget — and this sits underneath it as the real bound.
//
// It lives here because this is the ONE function every model call in the
// application goes through, vision and analysis alike. A limiter anywhere else
// would have to be remembered by each new call site, and the two existing ones
// already disagreed about whether a limit existed.
// ---------------------------------------------------------------------------
const MODEL_CONCURRENCY = Math.max(1, Number(process.env.RI_MODEL_CONCURRENCY) || 8);

let inFlight = 0;
let peakInFlight = 0;
const waiting = [];

/** How many calls were ever in flight at once. Recorded on the run so the
    ceiling can be read against what actually happened rather than guessed. */
export function modelCallPeak() { return peakInFlight; }
export function resetModelCallPeak() { peakInFlight = inFlight; }
export function modelConcurrencyLimit() { return MODEL_CONCURRENCY; }

function acquire() {
  if (inFlight < MODEL_CONCURRENCY) {
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  // Hand the slot straight on rather than decrementing and re-acquiring: a gap
  // between the two is a window for a caller that has not queued yet to jump
  // in, which is how a "limit" quietly becomes a suggestion under load.
  if (next) { next(); return; }
  inFlight--;
}

export async function createWithRetry(params, tries = 3) {
  await acquire();
  try {
    return await createWithRetryInner(params, tries);
  } finally {
    release();
  }
}

// The retry loop itself holds the slot for its whole life, backoff included.
// Releasing between attempts would let the queue drain into the same overloaded
// endpoint that just returned 429, which is the opposite of backing off.
async function createWithRetryInner(params, tries) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await client().messages.create(params); }
    catch (e) {
      lastErr = e;
      if (e.code === "NO_API_KEY") throw e;
      const st = e && e.status;
      const retryable = st === 429 || st === 500 || st === 502 || st === 503 || st === 529 ||
        (e && (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError"));
      if (!retryable || i === tries) throw e;
      await new Promise((r) => setTimeout(r, 700 * 2 ** (i - 1) + Math.random() * 300));
    }
  }
  throw lastErr;
}

export function extractJSON(msg) {
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const s = clean.indexOf(open), e = clean.lastIndexOf(close);
    if (s !== -1 && e !== -1 && e > s) {
      try { return JSON.parse(clean.slice(s, e + 1)); } catch { /* try next */ }
    }
  }
  return null;
}

export function hasAnthropicKey() {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}
