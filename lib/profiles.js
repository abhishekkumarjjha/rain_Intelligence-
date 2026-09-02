// =============================================================================
// lib/profiles.js — PRODUCT COMPARISON PROFILES.
//
// A checking account and a mortgage do not have the same meaningful comparison
// dimensions, and a universal taxonomy that covers both covers neither. The
// profile is what makes the benchmark product-aware BEFORE comparison rather
// than only for filtering.
//
// A profile declares:
//   metrics       which numbers matter for this product, in display order.
//                 Direction and comparability come from metrics.js — the
//                 profile only says "relevant here".
//   primaryRate   the metric a "rate position" finding is about. Every product
//                 has at most one, and some have none.
//   claims        the normalized advertised claims worth counting. NOT free
//                 text — a fixed vocabulary, because "4 of 5 competitors
//                 mention X" requires X to mean the same thing in every ad.
//   snapshot      the columns of the compact offer matrix.
//
// PROFILES ARE DATA, NOT CODE, in intent: this file is a JS module only so it
// can be imported without a loader. Nothing here is logic. It is meant to be
// edited by whoever knows what banks are actually advertising this quarter,
// without a deploy touching the findings engine. The maintenance risk is real —
// ~170 definitions that rot silently — which is why observations.js keeps an
// `unclassified` bucket. That bucket is how you learn what a profile is missing
// instead of never finding out.
// =============================================================================

import { PRODUCT_CODES } from "./products.js";

/** Claims that mean the same thing in every product. Merged into every profile. */
const CORE_CLAIMS = {
  local_service: "Local or community service",
  online_opening: "Open online / fast application",
  mobile_banking: "Online and mobile banking",
  member_owned: "Member-owned / not-for-profit",
  insured: "Federally insured (NCUA / FDIC)",
  no_hidden_fees: "No hidden fees",
};

const P = (o) => ({ ...o, claims: { ...CORE_CLAIMS, ...(o.claims || {}) } });

export const PROFILES = {
  checking: P({
    label: "Checking",
    metrics: ["apy", "cash_bonus", "monthly_fee", "minimum_opening_deposit"],
    primaryRate: "apy",
    snapshot: ["apy", "cash_bonus", "monthly_fee", "minimum_opening_deposit"],
    claims: {
      no_monthly_fee: "No monthly fee",
      early_direct_deposit: "Early direct deposit",
      overdraft_relief: "Overdraft relief / no overdraft fees",
      atm_access: "ATM network or fee reimbursement",
      cash_back: "Cash back or debit rewards",
      no_minimum_balance: "No minimum balance",
    },
  }),

  savings: P({
    label: "Savings",
    metrics: ["apy", "cash_bonus", "monthly_fee", "minimum_balance"],
    primaryRate: "apy",
    snapshot: ["apy", "cash_bonus", "monthly_fee", "minimum_balance"],
    claims: {
      high_yield: "High-yield positioning",
      no_monthly_fee: "No monthly fee",
      automatic_savings: "Automatic / round-up savings",
      no_minimum_balance: "No minimum balance",
    },
  }),

  cd: P({
    label: "CD / Certificate",
    // Han's worked example lives here: 4.00% against 3.85% and 4.50%.
    metrics: ["apy", "term_months", "minimum_opening_deposit"],
    primaryRate: "apy",
    snapshot: ["apy", "term_months", "minimum_opening_deposit"],
    claims: {
      promotional_term: "Promotional / special term",
      no_penalty: "No-penalty withdrawal",
      bump_up: "Bump-up or flexible rate",
      ladder: "CD laddering",
    },
  }),

  "money-market": P({
    label: "Money Market",
    metrics: ["apy", "monthly_fee", "minimum_balance"],
    primaryRate: "apy",
    snapshot: ["apy", "monthly_fee", "minimum_balance"],
    claims: {
      tiered_rates: "Tiered rates",
      check_writing: "Check writing / debit access",
      no_monthly_fee: "No monthly fee",
    },
  }),

  "auto-loan": P({
    label: "Auto Loan",
    // Five distinct mechanics, because a lender competing on financing
    // availability is not competing on rate, and a rate DISCOUNT is not a rate.
    // Separate ids make ranking one against another impossible by construction.
    metrics: ["apr", "rate_discount", "financing_percent", "term_months", "loan_amount", "cash_bonus"],
    primaryRate: "apr",
    snapshot: ["apr", "rate_discount", "financing_percent", "term_months", "cash_bonus"],
    claims: {
      refinance: "Refinance offer",
      preapproval: "Preapproval",
      fast_decision: "Fast decision / same-day",
      payment_deferral: "Payment deferral",
      no_payment_days: "No payments for N days",
    },
  }),

  "personal-loan": P({
    label: "Personal Loan",
    // loan_amount is the headline on most personal-loan creatives ("borrow up
    // to $30,000"). Descriptive, never ranked: a bigger maximum is a different
    // product, not a better deal — and it is emphatically not a cash bonus.
    metrics: ["apr", "rate_discount", "term_months", "loan_amount", "cash_bonus"],
    primaryRate: "apr",
    snapshot: ["apr", "rate_discount", "term_months", "loan_amount", "cash_bonus"],
    claims: {
      debt_consolidation: "Debt consolidation",
      fast_funding: "Fast funding",
      no_collateral: "No collateral required",
      prequalify_no_impact: "Prequalify with no credit impact",
    },
  }),

  mortgage: P({
    label: "Mortgage",
    metrics: ["apr", "points", "closing_costs", "down_payment"],
    primaryRate: "apr",
    snapshot: ["apr", "points", "closing_costs", "down_payment"],
    claims: {
      first_time_buyer: "First-time buyer program",
      preapproval: "Preapproval",
      local_underwriting: "Local loan officer / local decisions",
      rate_lock: "Rate lock",
      low_down_payment: "Low or no down payment",
    },
  }),

  heloc: P({
    label: "HELOC",
    metrics: ["intro_apr", "apr", "draw_period_months", "closing_costs"],
    primaryRate: "intro_apr",
    snapshot: ["intro_apr", "apr", "draw_period_months", "closing_costs"],
    claims: {
      no_closing_costs: "No closing costs",
      flexible_access: "Flexible access to funds",
      fast_funding: "Fast funding",
    },
  }),

  "credit-card": P({
    label: "Credit Card",
    // The product that proves direction belongs on the metric: intro APR wants
    // to be low, rewards rate wants to be high, annual fee wants to be low.
    metrics: ["intro_apr", "apr", "rewards_rate", "cash_bonus", "annual_fee"],
    primaryRate: "intro_apr",
    snapshot: ["intro_apr", "apr", "rewards_rate", "cash_bonus", "annual_fee"],
    claims: {
      balance_transfer: "Balance transfer",
      travel_rewards: "Travel rewards",
      cash_back: "Cash back",
      no_annual_fee: "No annual fee",
      signup_bonus: "Signup bonus",
    },
  }),

  business: P({
    label: "Business",
    metrics: ["apy", "monthly_fee", "cash_bonus"],
    primaryRate: "apy",
    snapshot: ["apy", "monthly_fee", "cash_bonus"],
    claims: {
      no_monthly_fee: "No monthly fee",
      merchant_services: "Merchant services",
      treasury: "Treasury management",
      sba: "SBA lending",
    },
  }),

  wealth: P({
    label: "Wealth",
    metrics: [],
    primaryRate: null,
    snapshot: [],
    claims: {
      financial_planning: "Financial planning",
      retirement: "Retirement / IRA",
      local_advisor: "Local advisor",
    },
  }),

  other: P({
    label: "Other",
    metrics: [],
    primaryRate: null,
    snapshot: [],
    claims: {},
  }),
};

// Fail loudly at import if the taxonomy and the profiles drift apart. A product
// code with no profile silently produces a benchmark with no metrics and no
// claims, which looks like "these competitors advertise nothing".
for (const code of PRODUCT_CODES) {
  if (!PROFILES[code]) throw new Error(`profiles.js: no profile for product code "${code}"`);
}

export function profileFor(product) {
  return PROFILES[product] || PROFILES.other;
}

/** Every claim id across every profile — the vocabulary handed to the extractor,
 *  which classifies before the product is known. */
export const ALL_CLAIM_IDS = [...new Set(
  Object.values(PROFILES).flatMap((p) => Object.keys(p.claims))
)].sort();

export const ALL_CLAIM_LABELS = Object.values(PROFILES)
  .reduce((acc, p) => Object.assign(acc, p.claims), {});

export function claimLabel(id) {
  return ALL_CLAIM_LABELS[id] || id;
}
