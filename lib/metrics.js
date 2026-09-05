// =============================================================================
// lib/metrics.js — THE METRIC REGISTRY.
//
// Direction is a property of the METRIC, not of the product.
//
// The earlier design put direction on the product class — deposits
// higher-better, lending lower-better. That is wrong the moment a product has
// two metrics that point opposite ways, which is most of them. A credit card
// wants a LOWER intro APR, a HIGHER rewards rate and a LOWER annual fee, all at
// once. A checking account wants a HIGHER APY and a LOWER monthly fee. There is
// no product-level answer to "is bigger better".
//
// So: the metric says HOW a comparison works. The product profile (profiles.js)
// says WHICH metrics are relevant. Those are different questions and they are
// answered in different files.
//
// COMPARABILITY IS THE OTHER HALF OF THIS FILE, and it is what stops the tool
// producing a technically-true, commercially-misleading rank:
//
//   Campus  5.00% APY on balances up to $5,000
//   Client  4.50% APY on balances up to $50,000
//
// "Campus advertises a higher APY" is a defensible sentence only if you say
// nothing about the caps. Every metric therefore declares which qualifiers must
// MATCH before two observations may be ranked against each other. When they do
// not match, the observation stays displayable and drops out of the arithmetic.
// It is never discarded — a fact you refuse to rank is still a fact.
// =============================================================================

/**
 * direction        "higher" | "lower" | "none" — which way is stronger for the
 *                  advertiser's customer. "none" means the metric is descriptive
 *                  (a CD term) and may be displayed but never ranked.
 * unit             percent | usd | months — governs parsing and rendering.
 * matchOn          Qualifier fields that must be EQUAL on both sides before two
 *                  observations may be ranked. A mismatch (or an unknown on one
 *                  side where the other has a value) makes the pair not
 *                  like-for-like.
 * qualifiers       Every qualifier field this metric can carry.
 * label            Column header / sentence noun.
 */
export const METRIC_REGISTRY = {
  apy: {
    label: "APY",
    unit: "percent",
    direction: "higher",
    // Term and balance cap change what an APY MEANS. Minimum deposit changes who
    // can get it but not what it is, so it is shown and not matched on.
    matchOn: ["term_months", "balance_cap"],
    qualifiers: ["term_months", "minimum_deposit", "balance_cap", "new_money_only", "relationship_required"],
  },
  apr: {
    label: "APR",
    unit: "percent",
    direction: "lower",
    matchOn: ["term_months", "credit_tier"],
    qualifiers: ["term_months", "credit_tier", "autopay_required", "loan_amount"],
  },
  intro_apr: {
    label: "Intro APR",
    unit: "percent",
    direction: "lower",
    // A 0% intro rate for 6 months is not the same offer as 0% for 21 months.
    // Matching on the intro period is what stops the tool calling them equal.
    matchOn: ["intro_months"],
    qualifiers: ["intro_months", "credit_tier"],
  },
  cash_bonus: {
    label: "Cash bonus",
    unit: "usd",
    direction: "higher",
    // Bonuses are the most qualification-sensitive figure in retail banking.
    // $600 for two direct deposits and $600 for $10,000 of new money are not
    // the same offer, and the ads usually print one of those and not the other.
    matchOn: ["direct_deposit_required", "new_money_required", "minimum_deposit"],
    qualifiers: ["direct_deposit_required", "new_money_required", "minimum_deposit", "new_members_only"],
  },
  monthly_fee: {
    label: "Monthly fee",
    unit: "usd",
    direction: "lower",
    // `applies_to` names an optional add-on the fee belongs to. It is in
    // matchOn because a $5.99 benefits bundle and a $5.00 account fee are not
    // the same number, and the LaCap capture had exactly that case — ranking
    // them would compare the price of a perk against the cost of an account.
    matchOn: ["waiver_condition", "applies_to"],
    qualifiers: ["waiver_condition", "applies_to"],
  },
  annual_fee: {
    label: "Annual fee",
    unit: "usd",
    direction: "lower",
    matchOn: [],
    qualifiers: ["first_year_waived"],
  },
  minimum_opening_deposit: {
    label: "Minimum to open",
    unit: "usd",
    direction: "lower",
    matchOn: [],
    qualifiers: [],
  },
  minimum_balance: {
    label: "Minimum balance",
    unit: "usd",
    direction: "lower",
    matchOn: [],
    qualifiers: ["waiver_condition"],
  },
  rewards_rate: {
    label: "Rewards rate",
    unit: "percent",
    direction: "higher",
    matchOn: ["category"],
    qualifiers: ["category", "spend_cap"],
  },
  closing_costs: {
    label: "Closing costs",
    unit: "usd",
    direction: "lower",
    matchOn: [],
    qualifiers: [],
  },
  points: {
    label: "Points",
    unit: "percent",
    direction: "lower",
    matchOn: [],
    qualifiers: [],
  },
  down_payment: {
    label: "Down payment",
    unit: "percent",
    direction: "lower",
    matchOn: [],
    qualifiers: [],
  },

  // ---- DISTINCT OFFER MECHANICS ------------------------------------------
  //
  // A lending ad carries several percentages and several dollar figures, and
  // they are not variants of one another. "4.59% APR", "0.65% off your rate"
  // and "up to 100% financing" are three different promises; "borrow up to
  // $30,000" and "earn a $300 bonus" are two.
  //
  // They were collapsing into apr and cash_bonus, and a metric's direction then
  // applied to all of them — so a rate DISCOUNT became the lowest, and
  // therefore best, APR the client advertised. Separate ids are the structural
  // fix: two facts with different metric ids can never be ranked against each
  // other, whatever any later stage decides to do.
  rate_discount: {
    label: "Rate discount",
    unit: "percent",
    // More off is more — but only ever against another discount.
    direction: "higher",
    matchOn: [],
    qualifiers: ["autopay_required", "relationship_required"],
  },
  financing_percent: {
    label: "Financing available",
    unit: "percent",
    direction: "higher",
    matchOn: [],
    qualifiers: ["credit_tier"],
  },
  // Descriptive. The size of a loan on offer is not a payment to the customer
  // and has no better direction: a bigger maximum is a different product, not
  // a better deal.
  loan_amount: {
    label: "Loan amount",
    unit: "usd",
    direction: "none",
    matchOn: [],
    qualifiers: ["credit_tier"],
  },
  // Descriptive. Displayed in the snapshot, never ranked — there is no globally
  // correct direction for a CD term, and pretending otherwise produces a
  // confident wrong answer on a number a client will recognise instantly.
  term_months: {
    label: "Term",
    unit: "months",
    direction: "none",
    matchOn: [],
    qualifiers: [],
  },
  draw_period_months: {
    label: "Draw period",
    unit: "months",
    direction: "none",
    matchOn: [],
    qualifiers: [],
  },
};

export const METRIC_IDS = Object.keys(METRIC_REGISTRY);

export function metricOf(id) {
  return METRIC_REGISTRY[id] || null;
}

export function isRankableMetric(id) {
  const m = metricOf(id);
  return !!m && m.direction !== "none";
}

/**
 * Are two observations of the same metric like-for-like?
 *
 * Returns { ok, reason } — `reason` is rendered to the user verbatim when a
 * comparison is refused, because "we are not ranking these" is only useful if
 * it says why.
 *
 * A qualifier that is ABSENT ON BOTH SIDES matches. That is deliberate: most
 * search ads print a figure and no terms at all, and refusing every comparison
 * on that basis would refuse nearly all of them. The unit being compared is
 * WHAT WAS ADVERTISED — which is also what the person clicking the ad saw.
 * The asymmetric case, where one side prints a qualifier and the other does
 * not, is the one that gets blocked, because that is where the reader would
 * silently assume equivalence.
 */
export function comparable(a, b) {
  const m = metricOf(a?.metric);
  if (!m) return { ok: false, reason: "unknown metric" };
  if (a.metric !== b.metric) return { ok: false, reason: "different metrics" };
  if (m.direction === "none") return { ok: false, reason: `${m.label} has no better or worse direction` };
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) {
    return { ok: false, reason: "figure could not be parsed" };
  }

  for (const key of m.matchOn) {
    const av = a.qualifiers?.[key] ?? null;
    const bv = b.qualifiers?.[key] ?? null;
    if (av === null && bv === null) continue;          // neither printed it
    if (av === null || bv === null) {
      return { ok: false, reason: `${QUALIFIER_LABELS[key] || key} shown on only one of the two ads` };
    }
    if (String(av) !== String(bv)) {
      return { ok: false, reason: `different ${QUALIFIER_LABELS[key] || key}` };
    }
  }
  return { ok: true, reason: "" };
}

export const QUALIFIER_LABELS = {
  term_months: "term",
  minimum_deposit: "minimum deposit",
  balance_cap: "balance cap",
  new_money_only: "new-money requirement",
  relationship_required: "relationship requirement",
  credit_tier: "credit tier",
  autopay_required: "autopay requirement",
  loan_amount: "loan amount",
  intro_months: "introductory period",
  direct_deposit_required: "direct-deposit requirement",
  new_money_required: "new-money requirement",
  new_members_only: "new-member restriction",
  waiver_condition: "fee waiver condition",
  applies_to: "what the fee covers",
  first_year_waived: "first-year waiver",
  category: "reward category",
  spend_cap: "spend cap",
};

/** Which of two values is stronger, per the metric's direction. */
export function better(metricId, a, b) {
  const m = metricOf(metricId);
  if (!m || m.direction === "none") return 0;
  if (a === b) return 0;
  return m.direction === "higher" ? (a > b ? 1 : -1) : (a < b ? 1 : -1);
}

/** Render a stored value back to display form. The verbatim string is preferred
 *  everywhere it exists; this is the fallback for computed cells. */
export function formatValue(metricId, value) {
  const m = metricOf(metricId);
  if (!m || !Number.isFinite(value)) return "—";
  if (m.unit === "percent") return `${value.toFixed(2).replace(/\.00$/, "")}%`;
  if (m.unit === "usd") return `$${value.toLocaleString("en-US")}`;
  if (m.unit === "months") return `${value} mo`;
  return String(value);
}
