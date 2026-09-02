// =============================================================================
// lib/products.js — the product taxonomy.
//
// CARRIED OVER VERBATIM from the SEM Proposal Generator's competitor-rules.js.
// This is deliberate and load-bearing: if RAIN Intelligence and the SEM tool
// disagree about what "checking" means, a competitor ad classified one way in
// the proposal and another way in the benchmark becomes impossible to reconcile,
// and the two tools can never share an evidence store.
//
// 12 codes. Not an ontology — a bucketing aid whose only job is to separate a
// mortgage ad from a credit-card ad.
// =============================================================================

export const PRODUCT_CODES = [
  "checking", "savings", "cd", "money-market", "credit-card", "auto-loan",
  "personal-loan", "mortgage", "heloc", "business", "wealth", "other",
];

export const PRODUCT_LABELS = {
  "checking": "Checking",
  "savings": "Savings",
  "cd": "CD / Certificate",
  "money-market": "Money Market",
  "credit-card": "Credit Card",
  "auto-loan": "Auto Loan",
  "personal-loan": "Personal Loan",
  "mortgage": "Mortgage",
  "heloc": "HELOC",
  "business": "Business",
  "wealth": "Wealth",
  "other": "Other",
};

// PLURALS ARE NOT COSMETIC HERE.
//
// A landing page is "/credit-cards", not "/credit-card". The path is flattened
// to "credit cards" before matching, so a pattern ending in a hard \b after a
// singular noun fails on the URL people actually paste — and an undetected
// product scopes the entire benchmark to "other", which matches every ad ever
// captured. Every finding and every piece of evidence on that board is then
// about the wrong thing, while looking exactly as confident as a correct one.
const PRODUCT_PATTERNS = [
  ["heloc",         /\b(heloc|home equity|equity lines?|second mortgages?)\b/i],
  ["mortgage",      /\b(mortgages?|home loans?|homebuyers?|home buyers?|refinanc|purchase loans?|fha|va loan|usda|construction loans?)\b/i],
  ["auto-loan",     /\b(auto|car|vehicle|motorcycle|rv|boat)\s*(loan|financ|refinanc)|auto[- ]loan/i],
  ["credit-card",   /\b(credit cards?|cash back cards?|rewards cards?|visa|mastercard)\b/i],
  ["personal-loan", /\b(personal loans?|signature loans?|unsecured loans?|debt consolidat|lines? of credit)\b/i],
  ["cd",            /\b(cds?\b|certificates? of deposit|share certificates?|term deposits?)\b/i],
  ["money-market",  /\b(money markets?|mma\b)\b/i],
  ["savings",       /\b(savings|save |high[- ]yield|nest egg|christmas club)\b/i],
  ["checking",      /\b(checking|current accounts?|debit)\b/i],
  ["business",      /\b(business|commercial|sba\b|merchant|treasury)\b/i],
  ["wealth",        /\b(wealth|invest|retirement|ira\b|trust services|financial planning)\b/i],
];

/** Free text (a URL path, a product name a user typed) -> taxonomy code. */
export function normalizeProduct(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s.trim()) return "other";
  if (PRODUCT_CODES.includes(s)) return s;
  for (const [code, re] of PRODUCT_PATTERNS) if (re.test(s)) return code;
  return "other";
}

export function coerceProductCode(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (PRODUCT_CODES.includes(s)) return s;
  return normalizeProduct(s);
}

/* Adjacency is SYMMETRIC and deliberately narrow. A HELOC ad is useful evidence
   next to a mortgage campaign — same buyer, same moment. An auto-loan ad is not. */
const ADJACENT = {
  mortgage: ["heloc"],
  heloc: ["mortgage"],
  checking: ["savings", "money-market"],
  savings: ["checking", "money-market", "cd"],
  "money-market": ["savings", "checking", "cd"],
  cd: ["savings", "money-market"],
  "auto-loan": ["personal-loan"],
  "personal-loan": ["auto-loan", "credit-card"],
  "credit-card": ["personal-loan"],
  business: [], wealth: [], other: [],
};

export function isAdjacent(a, b) {
  return (ADJACENT[a] || []).includes(b);
}

/**
 * Bucket an ad's product against the product in scope.
 * FAIL-OPEN: an unknown scope must not discard every ad in the capture.
 */
export function bucketFor(adProduct, scopeProduct) {
  if (!scopeProduct || scopeProduct === "other") return "on";
  if (adProduct === scopeProduct) return "on";
  if (isAdjacent(adProduct, scopeProduct)) return "adjacent";
  return "off";
}

/** Guess the product from a landing-page URL path. Path is the strongest signal. */
export function productFromUrl(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const path = decodeURIComponent(u.pathname).replace(/[-_/]+/g, " ");
    const guess = normalizeProduct(path);
    return { product: guess, from: guess === "other" ? "none" : "path" };
  } catch {
    return { product: "other", from: "none" };
  }
}
