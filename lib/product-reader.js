// =============================================================================
// lib/product-reader.js — the model fallback for "what product is this page?"
//
// The regex in products.js catches the category word: /checking-accounts,
// /auto-loan, /credit-cards. It cannot catch a BRAND NAME, and banks name
// everything:
//
//   /choice-checking      /lagniappe-checking     /simply-checking
//   /platinum-card        /signature-visa         /gold-rewards
//   /motorcycle-loan      /powersports            /toy-financing
//
// There is no finite list of these — every institution invents its own — so
// pattern-matching is the wrong shape of tool for the residual case. Reading
// the words and deciding which of twelve categories they name is exactly the
// job a small model does well and a regex cannot do at all.
//
// THE ORDER MATTERS, AND SO DOES THE FLOOR.
//
//   1. regex   free, instant, and right for the common case
//   2. model   one cheap call, only when the regex found nothing
//   3. the user, when the model is not confident
//
// Step 3 is not a fallback, it is the point. A product this tool cannot infer
// is one the strategist has to supply, because "other" disables the scope
// filter entirely and every count on the board becomes a count over every ad
// ever captured. The model narrows how often we have to ask — it never removes
// the asking.
// =============================================================================

import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";
import { PRODUCT_CODES, PRODUCT_LABELS, normalizeProduct } from "./products.js";

const SYSTEM = `You identify which retail banking product a landing page URL is about.

You are given a URL path. Banks brand their products, so the path often carries
a NAME rather than a category: "choice-checking", "lagniappe-checking",
"platinum-card", "signature-visa", "motorcycle-loan", "powersports-financing".
Your job is to say which category the name belongs to.

Allowed product codes, and nothing else:
${PRODUCT_CODES.map((c) => `  ${c} — ${PRODUCT_LABELS[c]}`).join("\n")}

RULES
- Decide from the words in the path. Do not guess from the bank's name.
- A branded name still maps: "platinum-card" is credit-card, "choice-checking"
  is checking, "motorcycle-loan" is auto-loan.
- If the path names no product — a homepage, /about, /locations, /rates, a blog
  post, a login page — answer "other" with low confidence. That is a useful
  answer and the correct one; the user will be asked to choose.
- Never invent a code outside the list.
- Confidence is how sure you are that a strategist would agree, 0 to 1.

Return ONLY:
{ "product": "<code>", "confidence": 0.0, "why": "<six words or fewer>" }`;

/**
 * @param {string} url  the landing page the user pasted
 * @returns {Promise<{product, confidence, why}|null>} null when unavailable
 */
export async function readProductFromUrl(url) {
  let path;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    path = decodeURIComponent(u.pathname + u.search);
  } catch { return null; }

  // Nothing to read. A bare domain is a homepage and the answer is already
  // known without spending anything.
  if (!path || path === "/" || path.length < 2) return null;

  let raw;
  try {
    const msg = await createWithRetry({
      model: ANALYSIS_MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: "user", content: `URL path: ${path}` }],
    });
    raw = extractJSON(msg);
  } catch {
    // A failed classification is a missing hint, never a failed resolve. The
    // user is asked to choose, which is what would have happened anyway.
    return null;
  }

  const product = normalizeProduct(String(raw?.product || ""));
  const confidence = Number(raw?.confidence);
  if (!PRODUCT_CODES.includes(product)) return null;

  return {
    product,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    why: String(raw?.why || "").trim().slice(0, 60),
  };
}

/**
 * The bar for accepting the model's answer WITHOUT asking the user.
 *
 * Deliberately high, and "other" never clears it however confident the model
 * claims to be. The cost of asking is one dropdown; the cost of being wrong is
 * an entire board of confident findings about the wrong product, which is the
 * failure this whole path exists to prevent.
 */
export const CONFIDENT = (r) => !!r && r.product !== "other" && r.confidence >= 0.7;
