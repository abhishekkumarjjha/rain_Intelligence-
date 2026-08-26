// =============================================================================
// lib/platform-identity.js — domain -> Meta Page identity.
//
// Kept OUT of competitor-directory.json deliberately. That file lists
// competitors per client, and the same competitor domain recurs across several
// clients — so a Page ID stored inside each occurrence would become several
// sources of truth that drift apart the first time one is corrected.
//
// One domain, one identity, one place.
//
// ---------------------------------------------------------------------------
// WHY CONFIDENCE IS STORED AND NOT JUST THE ID
// ---------------------------------------------------------------------------
// The Chase probe resolved with a name score of 1.0 and a margin of 0.0033 over
// the runner-up. A perfect score with no margin means "many Pages are called
// this", which is the opposite of a confident match — and it is invisible if
// only the winning ID is persisted. Score alone is not identity. The margin is
// what says whether the winner was actually distinguishable.
//
// So an ambiguous match is never silently written here as truth. It comes back
// as `needs_confirmation` with the candidate list, and a human decides.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normDomain } from "./atc-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, "..", "data", "platform-identities.json");

// Confirmations made at runtime are written to the DATA dir, not back into the
// repo file. The repo file is the curated seed; the data dir is per-deployment
// state. Merging them at read time means a fresh checkout still knows about
// LaCap while a running instance keeps what its strategists confirmed.
const DATA_DIR = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const LEARNED_FILE = path.join(DATA_DIR, "platform-identities.json");

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return fallback; }
}

let SEED = readJson(SEED_FILE, { identities: {} }).identities || {};

function learned() {
  return readJson(LEARNED_FILE, { identities: {} }).identities || {};
}

/**
 * The identity for a domain, or null.
 * Learned confirmations win over the seed: a human correcting a mapping should
 * not be undone by whatever shipped in the repo.
 */
export function getIdentity(domain) {
  const d = normDomain(domain);
  if (!d) return null;
  const l = learned();
  return l[d] || SEED[d] || null;
}

export function getMetaPageId(domain) {
  const id = getIdentity(domain);
  return id && id.metaPageId ? String(id.metaPageId) : null;
}

/**
 * Persist a confirmed identity. Only ever called after a human confirms, or
 * after an automatic resolution that cleared BOTH the score and margin bars.
 */
export function saveIdentity(domain, identity) {
  const d = normDomain(domain);
  if (!d || !identity?.metaPageId) return false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const current = readJson(LEARNED_FILE, { identities: {} });
    current.identities = current.identities || {};
    current.identities[d] = {
      metaPageId: String(identity.metaPageId),
      metaPageName: String(identity.metaPageName || ""),
      resolvedBy: identity.resolvedBy || "page_search",
      confidence: identity.confidence || "medium",
      verifiedAt: new Date().toISOString(),
      note: String(identity.note || ""),
    };
    writeFileSync(LEARNED_FILE, JSON.stringify(current, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[identity] save failed:", e.message);
    return false;
  }
}

export function listIdentities() {
  return { ...SEED, ...learned() };
}

/**
 * Grade a page-search result.
 *
 * TWO bars, not one, and the second is the one that matters:
 *   score  — how well the winning name matches what we asked for
 *   margin — how much better it is than the next candidate
 *
 * A perfect score with a hairline margin is the Chase case: the name matched
 * exactly, and so did several other Pages. `high` requires both.
 */
export function gradeResolution({ score = 0, margin = 0, candidateCount = 0 }) {
  if (candidateCount === 0) return "none";
  if (candidateCount === 1 && score >= 0.9) return "high";
  if (score >= 0.85 && margin >= 0.15) return "high";
  if (score >= 0.7 && margin >= 0.05) return "medium";
  return "low";
}

/** Only a `high` grade may be persisted without a human in the loop. */
export function isAutoPersistable(grade) {
  return grade === "high";
}
