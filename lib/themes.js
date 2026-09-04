// =============================================================================
// lib/themes.js — WHAT THE DISPLAY CREATIVES ARE ABOUT.
//
// The Wall shows every banner a competitor is running. At forty creatives that
// is a lot of looking and no reading: the thing a strategist wants out of it is
// "there are three ideas in this category and here they are", which is a
// clustering problem over language and imagery. That is genuinely a model job —
// unlike counting, which lives in set-shape.js and channel-shape.js and must
// never come near one.
//
// THIS REPLACES THE RECOMMENDED-STRATEGY PASS, AND THE DIFFERENCE IS THE POINT.
//
// A theme DESCRIBES what exists: "rate-led typography, no imagery, figure in
// the headline". A recommendation PRESCRIBES what to do: "lead with your rate".
// The first is a summary of evidence on screen and is defensible in front of a
// client. The second is RAIN advising a bank on its product, which was ruled
// out, and no amount of hedging in the prompt turns one into the other. So the
// constraints are enforced in code, after the model has answered, and a finding
// that breaks them is dropped rather than repaired.
//
// FOUR THINGS THE EARLIER VERSION GOT WRONG
//
//   1. FAMILIES, NOT CREATIVES. It was handed raw ads, so one design resized
//      into five banner slots read as five independent confirmations of a
//      theme. It is now handed CLUSTERS: one idea, one vote, however many sizes
//      it was cut into. This was the single biggest evidence defect.
//   2. WHOSE PATTERN IT IS. Advertiser identity was stripped entirely, so a
//      theme carried by four creatives from ONE advertiser was indistinguishable
//      from one shared across the market. Advertisers are now anonymised to
//      stable tokens rather than removed, which keeps brands out of the prose
//      while making "cross-advertiser" a decidable fact — and the CODE decides
//      it, not the model.
//   3. COHORT. Regional and national creative answer different questions, and
//      the contrast between them was unavailable because the model could not
//      tell them apart.
//   4. STERILITY. "There is no reader to help" kept the model safe and made it
//      dull. The register is now an evidence-bound analyst — precise about what
//      is visible — with the prohibition on advice carried by explicit rules
//      and by the code below, which is where it belonged all along.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// It does not write the set-level takeaway. The most prominent line on a panel
// is the one that most needs to be counted, and the takeaway worth having —
// how many creatives each advertiser lists in each channel — is not present in
// any creative, so a model asked for it could only invent it. See
// channel-shape.js.
// =============================================================================

import { ANALYSIS_MODEL, createWithRetry, extractJSON } from "./claude.js";

const SYSTEM = `You are an evidence-bound display advertising analyst. You give a
factual, executive-readable account of what appears in a captured set of display
creatives: the recurring messages, the recurring ways they are executed, and the
observable differences between regional and national advertisers.

You describe what is observable. You do not recommend actions, evaluate
effectiveness, infer performance, or claim to know an advertiser's intent.

NEVER
- Recommend, advise, evaluate, or address the reader.
- Call an approach effective, weak, strong, successful, better, or likely to work.
- Infer targeting, audience, objectives, spend, placement, budget, or strategy.
  The word "strategy" implies intent you cannot see. Describe approaches instead.
- Treat the captured creatives as the whole market.
- Say an advertiser does not do something. Say it "was not observed in the
  captured set".
- Name an advertiser, bank, or product brand. Refer to cohorts as "regional",
  "national" and "client", and to advertisers by the tokens given in the input.

WHAT TO LOOK FOR, SEPARATELY

MESSAGE THEMES - recurring subjects or claims: rates, cash incentives,
convenience, member ownership, local presence, trust, rewards, financing
flexibility, limited-time promotions.

EXECUTION PATTERNS - recurring ways a message is presented: photography subject,
illustration, typography, offer hierarchy, branding prominence, CTA treatment,
copy density, urgency devices, layout structure, reuse of one visual system
across different products.

THE CLIENT'S OWN DESIGNS carry cohort "client". They are in the set so that an
idea can be seen to run across the client's creative as well as the
competitors' — cite them in a theme exactly as you would any other design when
the same idea is present. Never single the client out for comment, never say
what it should do, and never treat its absence from a theme as a finding: a
theme is a description of designs that exist, and the code counts the rest.

COHORT CONTRASTS - differences between regional and national creatives. Only
when BOTH sides have supporting evidence in the input.

EVIDENCE
- Each input item is a creative FAMILY: one design, possibly cut to several
  sizes. Cite familyIds. A family is one piece of evidence no matter how many
  sizes it was made in.
- A theme or pattern needs at least two distinct families.
- Cite only ids present in the input. Never invent or alter one.
- Prefer fewer, well-supported findings. Do not report universal banner
  conventions - having a logo, having a button - unless the TREATMENT
  distinguishes part of the set.

LANGUAGE
- Use concrete verbs: foregrounds, pairs, repeats, leads with, sets, crops,
  was not observed.
- Describe prevalence only "within the captured set".
- NO NUMBERS ANYWHERE IN PROSE - not digits, not words. Not "three", not
  "several", not "seventy-five thousand", not "4.50%". Refer to figures
  generically: "a prominent rate figure", "a cash incentive", "a term-led
  offer". Ids inside the id arrays are exempt; this rule is about sentences.
- Names: two to five words. Observations: one sentence, at most thirty words.

Return ONLY this JSON:
{
  "messageThemes":     [{ "name": "", "observation": "", "familyIds": ["", ""] }],
  "executionPatterns": [{ "name": "", "observation": "", "familyIds": ["", ""] }],
  "cohortContrasts":   [{ "name": "", "observation": "",
                          "regionalFamilyIds": [], "nationalFamilyIds": [] }]
}

At most three message themes, two execution patterns, two cohort contrasts.
Empty arrays are correct when the evidence does not support a category.`;

/** Words that turn a description into advice. Checked after the model answers. */
const PRESCRIPTIVE = /\b(you|your|should|shouldn't|must|consider|recommend|recommended|try|opportunity|opportunities|could|would|suggest|advise|better|best|improve|leverage|instead|need to|ought|strategy|strategic|strategies)\b/i;

/** Evaluation of outcomes. The capture has no performance data of any kind. */
const PERFORMANCE = /\b(wins?|winning|works?|working|performs?|performing|effective|successful|converts?|conversion|engaging|drives?|resonates?|compelling)\b/i;

/* NUMBERS IN WORDS WERE THE LOOPHOLE.
   Digits were stripped and the rule read "no digits", so "seventy-five thousand
   bonus points" and "several dozen creatives" walked straight through. A
   model-written figure with no digit in it is still a model-written figure, and
   still cannot be traced back to anything counted. */
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|dozens|hundred|hundreds|thousand|thousands|million|millions|half|third|quarter|majority|most|few|several|many|numerous|handful|couple)\b/i;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Advertisers become STABLE TOKENS rather than disappearing.
 *
 * The old version deleted advertiser identity outright, which kept brands out
 * of the prose and also made "four designs from one advertiser" look exactly
 * like "four advertisers doing the same thing". Those are completely different
 * findings. A token preserves the distinction without ever giving the model a
 * brand name to repeat back.
 */
function tokenise(families) {
  const map = new Map();
  for (const f of families) {
    const d = f.institution || f.domain || "";
    if (d && !map.has(d)) map.set(d, `A${map.size + 1}`);
  }
  return map;
}

/* SHORT LABELS, AND THIS IS A CORRECTNESS FIX, NOT A TIDY-UP.
   The model used to be handed the provider's own creative ids —
   "CR01145745112471437313", twenty-two opaque characters — and asked to echo
   them back as its evidence. One transposed digit and the citation resolves to
   nothing, the finding is dropped for citing no real creative, and if it
   happens across the answer EVERY finding is dropped and the panel says there
   was nothing recurring in the set. That failure is silent, intermittent, and
   indistinguishable from a genuinely unremarkable wall — it is what produced
   "no insights" on a checking wall of fourteen legible designs.

   Nothing needs the model to handle those ids. It gets F1, F2, F3; the code
   holds the mapping and resolves the citation afterwards. */
const labelFamilies = (families) =>
  new Map(families.map((f, i) => [f.creativeId, `F${i + 1}`]));

function anonymise(family, tokens, labels) {
  return {
    familyId: labels?.get(family.creativeId) || family.creativeId,
    advertiser: tokens.get(family.institution || family.domain || "") || "A?",
    cohort: family.tier === "national" ? "national" : family.tier === "client" ? "client" : "regional",
    // How many sizes this one design was cut into. Useful as an execution
    // observation (template reuse) and explicitly NOT as weight of evidence.
    sizesInFamily: (family.sizes || []).length || 1,
    headline: family.headline || "",
    subhead: family.subhead || "",
    cta: family.cta || "",
    visualStyle: family.visualStyle || "",
    hasPeople: !!family.hasPeople,
    tone: family.tone || "",
    product: family.product || "other",
    // The offer TYPE, never its value. "a rate is present" is a treatment fact;
    // "4.50% APY" is a figure, and figures are counted in code or not at all.
    offerType: family.offer?.type || "none",
  };
}

/** Shared shape checks for one themes/patterns entry. */
function usableFinding(t, known, familyOf, byLabel) {
  const name = clean(t?.name);
  const observation = clean(t?.observation ?? t?.description);
  // A citation may arrive as the short label the model was given, as a family's
  // representative id, or as any resized member of that family. All three
  // resolve to the same family, and the family is counted once — which is the
  // entire reason for clustering before asking.
  const cited = Array.isArray(t?.familyIds) && t.familyIds.length
    ? t.familyIds
    : (Array.isArray(t?.creativeIds) ? t.creativeIds : []);
  const resolve = (id) => byLabel?.get(id.toUpperCase()) || (known.has(id) ? id : familyOf?.get(id));
  const familyIds = [...new Set(cited
    .map(clean).map(resolve)
    .filter((id) => id && known.has(id)))];

  if (!name || !observation) return null;
  if (name.split(/\s+/).length > 5) return null;
  if (observation.split(/\s+/).length > 30) return null;
  // Two FAMILIES, which is the whole point of clustering before we ask.
  if (familyIds.length < 2) return null;
  for (const re of [PRESCRIPTIVE, PERFORMANCE, NUMBER_WORDS, /\d/]) {
    if (re.test(name) || re.test(observation)) return null;
  }
  return { name, observation, familyIds };
}

/* Below four distinct designs there is no recurring anything; naming a "theme"
   over three is describing three ads with extra words. Exported because the
   CALLER has to be able to tell "there was not enough on this product to read"
   apart from "the read failed" — they are different sentences to the user, and
   collapsing them into one null is what produced "Too few legible creatives"
   on a wall holding seventeen of them. */
export const MIN_FAMILIES = 4;
export const usableFamilies = (families = []) =>
  families.filter((a) => a.legible !== false && (a.headline || a.subhead));

/**
 * @param {Array} families      CLUSTERED creatives — one entry per design
 * @param {string} productLabel for the framing line only — never sent
 * @returns the themes, or null when nothing the model proposed survived the
 *          rules below. Throws with `code` when the model could not be reached.
 */
export async function readThemes(families = [], productLabel = "") {
  const usable = usableFamilies(families);
  if (usable.length < MIN_FAMILIES) return { themes: null, audit: { families: usable.length, proposed: 0, kept: 0 } };

  const tokens = tokenise(usable);
  const labels = labelFamilies(usable);
  const byLabel = new Map([...labels].map(([id, label]) => [label, id]));
  const known = new Set(usable.map((a) => a.creativeId));
  const cohortOf = new Map(usable.map((a) => [a.creativeId,
    a.tier === "national" ? "national" : a.tier === "client" ? "client" : "regional"]));
  const advertiserOf = new Map(usable.map((a) => [a.creativeId, a.institution || a.domain || ""]));
  // A family stands for every creative behind it, so an evidence chip opens the
  // resized versions too rather than only the representative.
  const membersOf = new Map(usable.map((a) => [a.creativeId, (a.variationIds?.length ? a.variationIds : [a.creativeId])]));
  // The reverse: any resized member back to the family that represents it.
  const familyOf = new Map();
  for (const [fam, members] of membersOf) for (const m of members) familyOf.set(m, fam);

  let raw;
  try {
    const msg = await createWithRetry({
      model: ANALYSIS_MODEL,
      max_tokens: 1400,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `${usable.length} display creative families:\n\n${
          JSON.stringify(usable.map((f) => anonymise(f, tokens, labels)), null, 1)
        }\n\nDescribe the recurring messages, the recurring executions, and any cohort contrast the evidence supports.`,
      }],
    });
    raw = extractJSON(msg);
  } catch (e) {
    // NOT null. A model that could not be reached is a transport failure, and
    // returning the same value as "nothing recurring here" made the endpoint
    // report an overloaded API as a thin capture — telling the user to widen a
    // window that was never the problem. It is raised so the caller can say
    // what actually happened.
    if (e?.code === "NO_API_KEY") throw e;
    throw Object.assign(new Error(`themes read failed: ${e?.message || e}`), { code: "MODEL_UNAVAILABLE" });
  }
  if (!raw || typeof raw !== "object") return { themes: null, audit: { families: usable.length, proposed: 0, kept: 0 } };

  /* SCOPE AND SUPPORT ARE DERIVED, NOT ASKED FOR.
     The model was never offered the chance to label these. A label it assigns
     is a claim we would have to verify anyway — and anything we can verify from
     the cited ids we can simply derive from them instead. */
  const decorate = (t) => {
    const advertisers = new Set(t.familyIds.map((id) => advertiserOf.get(id)).filter(Boolean));
    const cohorts = new Set(t.familyIds.map((id) => cohortOf.get(id)).filter(Boolean));

    // THE CLIENT IS A THIRD POPULATION, NOT A COHORT OF THE MARKET. Folding it
    // into `scope` would make a theme carried by the client and one national
    // read as "mixed", which on this panel means regional-and-national — a
    // claim about the competitive set that nothing supports. So it is derived
    // separately, and `scope` describes the competitors only.
    const clientToo = cohorts.has("client");
    const market = [...cohorts].filter((c) => c !== "client");
    const clientFamilies = t.familyIds.filter((id) => cohortOf.get(id) === "client");

    return {
      ...t,
      // Four designs from one advertiser is that advertiser repeating itself.
      // Worth showing, and NOT a pattern across the market.
      supportType: advertisers.size >= 2 ? "cross_advertiser" : "within_advertiser",
      advertiserCount: advertisers.size,
      familyCount: t.familyIds.length,
      scope: market.length > 1 ? "mixed" : (market[0] || "unknown"),
      clientToo,
      clientDesigns: clientFamilies.length,
      // A theme the model built ENTIRELY out of the client's own designs is a
      // description of the client's creative, not of the market it competes in.
      clientOnly: clientToo && market.length === 0,
      creativeIds: [...new Set(t.familyIds.flatMap((id) => membersOf.get(id) || [id]))],
    };
  };

  // Counted, because a total drop must never again be invisible. When the model
  // answers and every proposal is refused, the panel has to be able to say so —
  // "nothing recurring in this set" and "the answer did not survive the rules"
  // look identical from outside and are diagnosed completely differently.
  let proposed = 0, kept = 0;
  const pick = (arr, max) => {
    const rows = Array.isArray(arr) ? arr : [];
    proposed += rows.length;
    const out = rows.map((t) => usableFinding(t, known, familyOf, byLabel))
      .filter(Boolean).map(decorate).slice(0, max);
    kept += out.length;
    return out;
  };

  const messageThemes = pick(raw.messageThemes ?? raw.themes, 3);
  const executionPatterns = pick(raw.executionPatterns, 2);

  const contrastsRaw = Array.isArray(raw.cohortContrasts) ? raw.cohortContrasts : [];
  proposed += contrastsRaw.length;
  const cohortContrasts = contrastsRaw
    .map((t) => {
      // Verified against the REAL cohorts rather than trusting the arrays were
      // filled correctly. A contrast with nothing on one side is not a contrast.
      const fam = (arr) => [...new Set((arr || []).map(clean)
        .map((id) => byLabel.get(id.toUpperCase()) || (known.has(id) ? id : familyOf.get(id)))
        .filter(Boolean))];
      const regRaw = fam(t?.regionalFamilyIds);
      const natRaw = fam(t?.nationalFamilyIds);

      // OVERLAP DISQUALIFIES, and silently repairing it would be worse than
      // dropping it. A model that lists the same design as both the regional
      // and the national side has not found a contrast — filtering each side
      // by its true cohort would leave a clean-looking split the model never
      // actually claimed, and we would be rendering our own finding under its
      // name.
      if (regRaw.some((id) => natRaw.includes(id))) return null;

      const reg = regRaw.filter((id) => cohortOf.get(id) === "regional");
      const nat = natRaw.filter((id) => cohortOf.get(id) === "national");
      // Both sides must survive their own cohort check, or it is one cohort
      // being described twice.
      if (!reg.length || !nat.length) return null;
      const base = usableFinding({ ...t, familyIds: [...reg, ...nat] }, known, familyOf, byLabel);
      if (!base) return null;
      return {
        ...base, scope: "mixed", supportType: "cross_advertiser",
        familyCount: reg.length + nat.length,
        creativeIds: [...new Set([...reg, ...nat].flatMap((id) => membersOf.get(id) || [id]))],
      };
    })
    .filter(Boolean).slice(0, 2);
  kept += cohortContrasts.length;

  const audit = { families: usable.length, proposed, kept };

  // Answered, and nothing it proposed survived the rules. The AUDIT travels
  // with the emptiness, because "the set has no recurring idea in it" and
  // "seven ideas were proposed and all seven were refused" are the same screen
  // and completely different problems.
  if (!messageThemes.length && !executionPatterns.length && !cohortContrasts.length) {
    return { themes: null, audit };
  }

  return { audit, themes: {
    messageThemes,
    executionPatterns,
    cohortContrasts,
    // Back-compat for any caller still reading `.themes`.
    themes: messageThemes,
    framing: `Recurring ideas across the ${usable.length} distinct ${
      productLabel ? `${productLabel.toLowerCase()} ` : ""
    }display designs captured — one entry per design, however many sizes it was cut into. These describe what the ads are, not what anyone should do, and they cover what was captured rather than the whole market.`,
    creativesRead: usable.length,
  } };
}
