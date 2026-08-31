// =============================================================================
// lib/industry-context.js — GENERAL PATTERNS, NOT RECOMMENDATIONS.
//
// This is the only place in the benchmark where a model writes anything a user
// reads, and the constraint on it is unusual, so it is worth stating plainly.
//
// Han's line: "We just don't want to explicitly state it, because it's kind of
// hard to state your product is inferior. We just want to give them facts."
// He also ruled out the advisory register directly — "we're not giving them,
// hey, you should increase your rate."
//
// So this block must never say "you should", "we recommend", or "to compete,
// the client can". What it CAN do is state how the category generally behaves,
// with no reference to this client at all:
//
//     "In search advertising for deposit products, the institution with the
//      largest advertised bonus typically captures the most clicks."
//
// That is a statement about the industry. The reader connects it to the
// findings above unaided, which is the whole mechanism of quasi-analysis: the
// facts are allowed to land; RAIN is not the one asserting the conclusion.
//
// ---------------------------------------------------------------------------
// WHY A MODEL IS ALLOWED HERE AND NOWHERE ELSE IN THE BOARD
// ---------------------------------------------------------------------------
// Every other sentence on the board is arithmetic over captured ads, and a
// model on that path adds drift for nothing. This block is different: it is
// general category knowledge, not a claim about the capture. It cannot be
// computed from the ads, and it is not asserting anything about them.
//
// The hard boundary is enforced in code, not in the prompt alone:
//
//   · it runs AFTER findings are final and receives them read-only
//   · no client name, no competitor name, no domain reaches the model
//   · it may not introduce a figure — every numeral is checked against the
//     numbers already present in the findings, and a bullet carrying a new one
//     is dropped
//   · every bullet must name the finding rule it relates to, or it is dropped
//   · 2-4 bullets, hard-capped at 18 words each
//
// A bullet that survives all five is a general statement about the category
// that a strategist can act on. Anything else never renders.
// =============================================================================

import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";

const MAX_BULLETS = 4;
const MAX_WORDS = 18;

const SYSTEM = `You write short, neutral observations about how financial-services advertising generally works.

You are given anonymised findings from one competitive advertising analysis:
which offer types and message types were present or absent across a set of
advertisers, with the subject institution identified only as "the subject". You
never learn who anyone is.

Your job is to state GENERAL PATTERNS from financial-services and paid-search
advertising that are relevant to the shape of these findings.

=== THE REGISTER IS THE WHOLE JOB ===
These are NOT recommendations. Never write "you should", "we recommend", "the
client should", "to compete, consider", or any second-person instruction. Never
address the subject. Never refer to the subject's situation at all.

Write general observed facts about the category. The reader connects them to
their own findings without help.

  GOOD  "In deposit-account search advertising, the largest advertised bonus
         typically wins the click even at a lower rate."
  GOOD  "Cash bonuses convert faster than rate advantages because the value is
         immediate and easy to compare."
  GOOD  "Ads combining a rate and a bonus generally outperform either alone on
         click-through."
  BAD   "You should add a cash bonus to compete."            (instruction)
  BAD   "The client is losing on bonus offers."              (verdict)
  BAD   "Consider matching Campus Federal's $600."           (named, advisory)

=== NO NEW NUMBERS ===
Do not introduce any figure, percentage, dollar amount, share or statistic that
was not given to you. Do not cite studies, benchmarks or industry averages —
you do not have them, and an invented "industry average of 3.9%" would go into
a client conversation as fact. Write qualitatively: "typically", "generally",
"tends to".

=== KEEP THEM SHORT ===
Two to four bullets. Each a single sentence, at most ${MAX_WORDS} words. Each
must relate to one of the supplied finding rules, and you name which.

Return ONLY this JSON:
{
  "observations": [
    { "text": "one general sentence about the category", "relatesTo": "the finding rule id" }
  ]
}`;

/**
 * Strip a finding down to what the model may see.
 *
 * Names, domains and verbatim ad copy are removed entirely — not masked. A
 * model that never receives the client's name cannot address them, which is a
 * stronger guarantee than instructing it not to.
 */
function anonymise(f) {
  return {
    rule: f.rule,
    outcome: f.outcome,
    metric: f.metric || null,
    // Shape only: how many of the field did the thing, out of how many.
    count: f.count ?? null,
    denominator: f.denominator ?? null,
    subjectHasIt: f.outcome === "lead",
  };
}

/** Every numeral already present in the findings. Anything else is invented. */
function allowedNumbers(findings) {
  const set = new Set();
  for (const f of findings) {
    for (const v of [f.count, f.denominator]) {
      if (Number.isFinite(v)) set.add(String(v));
    }
  }
  return set;
}

/**
 * @param {Array}  findings  final, immutable
 * @param {string} productLabel  e.g. "Checking" — a category, not a client
 * @returns {Promise<{observations: Array}|null>}
 */
export async function industryContext(findings = [], productLabel = "") {
  const usable = findings.filter((f) => f.outcome !== "context");
  if (usable.length < 2) return null;          // nothing worth generalising over

  let raw;
  try {
    const msg = await createWithRetry({
      model: ANALYSIS_MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Product category: ${productLabel || "a retail banking product"}\n\nAnonymised findings:\n${
          JSON.stringify(usable.map(anonymise), null, 1)}\n\nWrite 2-4 general observations about how this category's advertising typically works.`,
      }],
    });
    raw = extractJSON(msg);
  } catch (e) {
    if (e.code === "NO_API_KEY") return null;
    return null;                                // never fails a board
  }
  if (!raw?.observations) return null;

  const rules = new Set(findings.map((f) => f.rule));
  const allowed = allowedNumbers(findings);

  const observations = raw.observations
    .map((o) => ({ text: String(o?.text || "").trim(), relatesTo: String(o?.relatesTo || "").trim() }))
    .filter((o) => {
      if (!o.text) return false;
      // Advisory register — the failure this whole module is shaped around.
      if (/\b(you|your|we recommend|should|must|consider |try |need to)\b/i.test(o.text)) return false;
      if (o.text.split(/\s+/).length > MAX_WORDS) return false;
      // A bullet floating free of any finding is a generic platitude.
      if (!rules.has(o.relatesTo)) return false;
      // No number the findings did not already contain.
      const nums = o.text.match(/\d+(?:\.\d+)?/g) || [];
      if (nums.some((n) => !allowed.has(n))) return false;
      return true;
    })
    .slice(0, MAX_BULLETS);

  if (observations.length < 2) return null;

  return {
    observations,
    // Rendered above the bullets, verbatim. The framing is part of the
    // guarantee, not decoration: it tells the reader these are category
    // patterns rather than advice about them.
    framing: "These are not recommendations. They are general patterns observed in financial-services advertising, offered as context for the findings above.",
    generated: true,
  };
}
