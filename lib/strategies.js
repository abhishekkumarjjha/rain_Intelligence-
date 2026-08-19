// =============================================================================
// lib/strategies.js — the GATED interpretation layer.
//
// Nothing in this file runs unless a human clicks "Generate recommended
// strategies". That gate is a product decision, not a performance one.
//
// WHY THE GATE EXISTS
// The CEO's framing for this mode was explicit: show the client the facts and
// let them draw the conclusion, because "it's kind of hard to state your
// product is inferior". A benchmark table that arrives with a recommendation
// already attached has made that statement on RAIN's behalf, in writing, in a
// monthly report. The table is the deliverable. This is the optional second
// screen a strategist chooses to open.
//
// WHAT THIS MODEL MAY AND MAY NOT DO
//   MAY: read the counted findings and say what angles the evidence suggests
//   MAY: name what competitors emphasise and what is thin in the captured set
//   MAY NOT: produce a number of any kind — every count arrives pre-computed
//   MAY NOT: assert the client's product is inferior
//   MAY NOT: claim anything about ads that were not captured
//   MAY NOT: state what the client "has" beyond what their own ads showed
//
// That last one is the subtle constraint. This tool captured the client's ADS,
// not their product set. "You have early direct deposit" is a claim about the
// institution that nothing here verified — so the model may only surface it as
// a QUESTION for the strategist, never as a fact for the client.
// =============================================================================

import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";
import { PRODUCT_LABELS } from "./products.js";

const SYSTEM = `You are a paid-media strategist reading a competitive advertising benchmark for a bank or credit union.

You are given FACTS THAT HAVE ALREADY BEEN COUNTED from captured advertising
evidence. Your job is to say what angles those facts suggest.

=== ABSOLUTE CONSTRAINTS ===

1. NEVER produce a number. Not a count, not a percentage, not a rate, not a
   dollar figure. Every number you need is already in the input; refer to facts
   by their wording, never by recomputing them. If you find yourself typing a
   digit that was not handed to you, stop.

2. NEVER say the client's product is inferior, worse, uncompetitive, or behind.
   You may say what competitors advertised and what the client's ads did not.
   The client draws their own conclusion. This is not a style preference — a
   report that tells an institution its product is bad is a report RAIN cannot
   send.

3. NEVER claim anything about the client's actual products, rates, features or
   capabilities. You saw their ADS, not their product sheet. If an angle depends
   on the client having something, phrase it as a question the strategist must
   answer, e.g. "Does the client have a differentiator here worth leading with?"
   — never as an assertion that they do.

4. NEVER describe the market. You saw a sample of captured ads over one date
   window. Say "in the ads captured" or "among the creatives reviewed". Never
   "nobody in this market", never "the market is doing X".

5. NEVER imply performance. No ad in this data has performance figures attached.
   A long-running ad is one an advertiser kept paying for; it is not a
   "top-performing" or "winning" ad.

=== WHAT GOOD OUTPUT LOOKS LIKE ===

Each angle names what the evidence shows, then what it opens up. Concrete and
short. A strategist should be able to act on it in a campaign brief the same
afternoon.

Weak:  "Consider differentiating your messaging to stand out from competitors."
Good:  "Every competitor creative reviewed led with the offer figure itself.
        None used service or speed as the lead. If the client has a genuine
        speed or access advantage, that territory is uncontested in the
        creatives reviewed."

Return ONLY this JSON, no prose:
{
  "angles": [
    {
      "title": "short imperative phrase",
      "evidence": "what the captured ads show, in one sentence",
      "opening": "what that opens up, in one or two sentences",
      "question": "the thing the strategist must confirm about the client before using this, or \\"\\"",
      "confidence": "high | medium | low"
    }
  ],
  "cautions": ["anything about the evidence a strategist should keep in mind"]
}`;

/**
 * @param {{benchmark: object, product: string, clientLabel: string, sampling: object}} args
 */
export async function generateStrategies({ benchmark, product, clientLabel, sampling }) {
  // Everything the model is allowed to reason from, and nothing else. It never
  // sees the raw ads — only facts that have already been counted in code.
  const facts = {
    client: clientLabel,
    product: PRODUCT_LABELS[product] || product,
    sampling: sampling?.note || "",
    countedFindings: (benchmark.findings || []).map((f) => f.text),
    table: (benchmark.rows || []).map((row) => ({
      row: row.label,
      comparability: row.comparability?.note || "",
      cells: row.cells.map((c) => {
        const col = benchmark.columns.find((x) => x.key === c.column);
        return {
          who: col?.label || c.column,
          isClient: !!col?.isClient,
          value: c.absent ? "not observed in captured ads" : c.value,
          detail: c.detail || "",
        };
      }),
    })),
  };

  const msg = await createWithRetry({
    model: ANALYSIS_MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Here are the counted facts from the benchmark. Produce the JSON described in your instructions.\n\n${JSON.stringify(facts, null, 2)}`,
    }],
  });

  const out = extractJSON(msg) || {};
  const angles = Array.isArray(out.angles) ? out.angles : [];

  return {
    angles: angles.map((a) => ({
      title: String(a.title || "").trim(),
      evidence: String(a.evidence || "").trim(),
      opening: String(a.opening || "").trim(),
      question: String(a.question || "").trim(),
      confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "medium",
    })).filter((a) => a.title && a.opening),
    // The sampling caveat is appended in CODE, not left to the model to
    // remember. It is the one caution that must appear every single time, and a
    // model that forgets it once has produced a page of recommendations that
    // reads as though it described the market.
    cautions: [
      ...(Array.isArray(out.cautions) ? out.cautions : []).map((c) => String(c).trim()).filter(Boolean),
      ...(sampling?.note ? [sampling.note] : []),
      "These angles read the ads captured in this window. They describe advertising, not either institution's actual product terms.",
    ],
    generatedAt: new Date().toISOString(),
    model: ANALYSIS_MODEL,
  };
}
