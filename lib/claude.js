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

export async function createWithRetry(params, tries = 3) {
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
