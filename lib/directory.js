// =============================================================================
// lib/directory.js — RAIN's curated competitor directory.
//
// A LOOKUP, not a model. Carried over from the SEM Proposal Generator with the
// same 40 curated rows, because the judgement encoded in that file IS the
// product and re-deriving it with an LLM would be strictly worse:
//   - it cannot hallucinate a bank that does not exist, or a domain that 404s
//   - it is instant and free, so it runs while the user is still typing
//   - a wrong suggestion is fixable in one line of JSON, forever, for everyone
//
// A client not in the directory is a row somebody adds later. lookup() says so
// honestly rather than guessing — the miss path is a manual-entry field, not a
// fabricated competitor list. (Live discovery for unknown PROSPECTS is the
// Proposal mode's problem, and Proposal mode is not built yet.)
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProduct } from "./products.js";
import { normDomain } from "./atc-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DIRECTORY = [];
let LOAD_ERROR = null;
try {
  const raw = readFileSync(path.join(__dirname, "..", "data", "competitor-directory.json"), "utf8");
  const parsed = JSON.parse(raw);
  DIRECTORY = Array.isArray(parsed) ? parsed : [];
} catch (e) {
  LOAD_ERROR = e.message;
}

export const DIRECTORY_SIZE = DIRECTORY.length;

const SCOPE_ALIASES = {
  "auto-loan": "auto-loan", "personal-loan": "personal-loan", "credit-card": "credit-card",
  "business-loan": "business", "money-market": "money-market", heloc: "heloc",
  mortgage: "mortgage", checking: "checking", savings: "savings", cd: "cd",
};

function scopeCodes(scope) {
  const list = Array.isArray(scope) ? scope : [];
  if (!list.length || list.includes("all")) return ["all"];
  return list.map((s) => SCOPE_ALIASES[String(s).trim().toLowerCase()] || normalizeProduct(s)).filter(Boolean);
}

export function findClient(domain) {
  const d = normDomain(domain);
  if (!d) return null;
  return DIRECTORY.find((row) => normDomain(row.client_domain) === d) || null;
}

/**
 * Suggest competitors for a known client.
 *
 * Ordering is deterministic and explainable, because someone will ask "why is
 * this one first?":
 *   1. competitors explicitly scoped to THIS product beat "all"-scoped ones
 *   2. same institution type as the client beats cross-type
 *   3. directory order (RAIN's own ranking) breaks the remaining ties
 */
export function suggestCompetitors({ domain, product = "", limit = 5 } = {}) {
  if (LOAD_ERROR) return { ok: false, matched: false, competitors: [], reason: "directory_unavailable" };

  const row = findClient(domain);
  if (!row) return { ok: true, matched: false, competitors: [], reason: "not_in_directory" };

  // "" means "product not known yet". normalizeProduct spells that "other" — a
  // truthy string — so it must be flattened here or every product-scoped
  // competitor gets filtered out against a comparison that was never made.
  const n = normalizeProduct(product);
  const target = n === "other" ? "" : n;
  const clientType = String(row.institution_type || "").toLowerCase();
  const isCU = /credit union|cu\b/.test(clientType);

  const scored = (row.competitors || []).map((c, i) => {
    const codes = scopeCodes(c.product_scope);
    const scopedToProduct = !!target && codes.includes(target);
    const scopedToAll = codes.includes("all");
    const cType = String(c.type_tag || "").toLowerCase();
    const typeMatch = isCU ? /cu\b|credit union/.test(cType) : /bank/.test(cType);
    return {
      name: String(c.name || "").trim(),
      domain: normDomain(c.domain),
      typeTag: String(c.type_tag || "").trim(),
      productScope: codes,
      reason: String(c.reason || "").trim(),
      relevance: scopedToProduct ? "product-matched" : scopedToAll ? "market-wide" : "other-product",
      _rank: [scopedToProduct ? 0 : scopedToAll ? 1 : 2, typeMatch ? 0 : 1, i],
    };
  }).filter((c) => c.name && c.domain);

  // PRODUCT SCOPE RANKS. IT NEVER REMOVES.
  //
  // This used to drop every competitor whose product_scope did not name the
  // current product, and the field's semantics are not consistent enough to
  // carry that weight: Campus Federal lists ["checking","auto-loan","heloc"]
  // while EFCU lists ["all"], so a credit-card analysis silently dropped Campus
  // and kept EFCU — two Baton Rouge credit unions with near-identical
  // descriptions, landing on opposite sides of a decision nobody saw.
  //
  // It also changed the comparison SET between products. "3 of 4 competitors"
  // in checking and "3 of 4" in credit card were different fours, and nothing on
  // the board said so. Scope now decides the ORDER competitors are offered in;
  // the strategist decides the set.
  const pool = scored;
  pool.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a._rank[i] !== b._rank[i]) return a._rank[i] - b._rank[i];
    return 0;
  });

  return {
    ok: true,
    matched: true,
    client: {
      name: String(row.client || "").trim(),
      domain: normDomain(row.client_domain),
      market: String(row.market || "").trim(),
      institutionType: String(row.institution_type || "").trim(),
    },
    product: target,
    competitors: pool.slice(0, Math.max(1, Math.min(8, limit))).map(({ _rank, ...c }) => c),
  };
}

export function listClients() {
  return DIRECTORY.map((r) => ({
    name: String(r.client || "").trim(),
    domain: normDomain(r.client_domain),
    market: String(r.market || "").trim(),
  })).filter((c) => c.domain);
}
