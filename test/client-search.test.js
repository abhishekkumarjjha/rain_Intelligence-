/* ---------------------------------------------------------------------------
   client-search.test.js — what a few keystrokes should find.

   Runs the real browser file against the real directory. The landing page is
   the first thing anyone touches, and "type the client name" is only true if
   the shortenings people actually use resolve to the right institution.
   --------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { listClients } from "../lib/directory.js";

/* No bundler in this project, so the browser file is a plain script that hangs
   itself off `window`. Loading it the same way the page does keeps this test
   honest about the code that actually ships. */
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../public/client-search.js", import.meta.url), "utf8"), sandbox);
const CS = sandbox.window.ClientSearch;

const CLIENTS = listClients();

let pass = 0, fail = 0;
function check(what, fn) {
  try { fn(); console.log(`  ok  ${what}`); pass++; }
  catch (e) { console.log(`  FAIL ${what}\n       ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

const first = (q) => CS.match(CLIENTS, q, 8).list[0]?.name || null;
const names = (q) => CS.match(CLIENTS, q, 8).list.map((c) => c.name);

console.log("\nSTAGE 1 — the shortenings people actually type");

check("a name shortened across its spaces resolves", () => {
  // "La Capitol" has a space in it, so plain substring matching never saw
  // "lacap" in the name at all.
  eq(first("lacap"), "La Capitol Federal Credit Union");
  eq(first("lacapitol"), "La Capitol Federal Credit Union");
});

check("suggestions start at the first character, not after three", () => {
  ok(CS.match(CLIENTS, "l", 8).list.length > 0, "one letter returned nothing");
  ok(CS.match(CLIENTS, "w", 8).list.length > 0, "one letter returned nothing");
});

check("an empty field offers names rather than nothing", () => {
  eq(CS.match(CLIENTS, "", 8).list.length, 8);
});

check("initials find the institution", () => {
  // Nobody says "Utilities Employees Credit Union" out loud.
  eq(first("uecu"), "Utilities Employees Credit Union");
  eq(first("bvscu"), "Brazos Valley Schools Credit Union");
  eq(first("lcfcu"), "La Capitol Federal Credit Union");
});

check("a single letter is not treated as an initialism", () => {
  // "u" as initials would drag in every Union in the directory ahead of the
  // names that genuinely start with it.
  const top = names("u").slice(0, 3);
  ok(top.every((n) => CS.squash(n).startsWith("u") || CS.words(n).some((w) => w.startsWith("u"))),
    `one-letter query fell through to initials: ${top.join(" ; ")}`);
});

console.log("\nSTAGE 2 — ranking, not just filtering");

check("a word that starts with the query beats one that merely contains it", () => {
  // "Sc-ho-ols" is a real substring match. It is not what anyone typing "ho"
  // meant, and before ranking it outranked nothing — it just appeared.
  eq(first("ho"), "Horicon Bank");
  ok(names("ho").includes("Brazos Valley Schools Credit Union"),
    "the weaker match should still be offered, just lower");
});

check("a mid-word match still resolves when it is the only one", () => {
  ok(names("ell").includes("Isabella Bank"), "mid-word matches must not be dropped");
});

check("the domain finds a client whose name nobody spells out", () => {
  eq(first("lacapfcu"), "La Capitol Federal Credit Union");
  eq(first("weokie"), "WEOKIE Federal Credit Union");
});

check("a multi-word query matches across the space", () => {
  ok(names("bankof").includes("Bank of Botetourt"));
  ok(names("bank of").includes("Bank of Missouri"), "the raw space must not break the match");
});

console.log("\nSTAGE 3 — one slip, corrected and labelled");

check("a single-character typo still finds the client", () => {
  const r = CS.match(CLIENTS, "wieokie", 8);
  eq(r.list[0]?.name, "WEOKIE Federal Credit Union");
  eq(r.fuzzy, true, "a corrected spelling has to declare itself");
});

check("an exact match is never labelled as a correction", () => {
  eq(CS.match(CLIENTS, "weokie", 8).fuzzy, false);
  eq(CS.match(CLIENTS, "lacap", 8).fuzzy, false);
});

check("two errors are a different word, not a typo", () => {
  eq(CS.match(CLIENTS, "wieokei", 8).list.length, 0);
});

check("short queries are never spell-corrected", () => {
  // "we" is one edit from "he", "be", "me". Correcting it would be inventing
  // an answer the user never asked for.
  const r = CS.match(CLIENTS, "zzz", 8);
  eq(r.list.length, 0);
  eq(r.fuzzy, false);
});

check("a partial initialism resolves", () => {
  // "mfc" is three letters of Mirastar Federal Credit Union's four. Prefix
  // matching on initials means a half-typed acronym still lands.
  eq(first("mfc"), "Mirastar Federal Credit Union");
  eq(CS.match(CLIENTS, "mfc", 8).fuzzy, false);
});

check("a query matching nothing reports nothing", () => {
  // The honest answer, and the no-match state points at the landing-page URL.
  const r = CS.match(CLIENTS, "qqqqzz", 8);
  eq(r.list.length, 0);
  eq(r.fuzzy, false);
});

console.log("\nSTAGE 4 — the edit-distance primitive");

check("withinOneEdit counts insertion, deletion and substitution", () => {
  eq(CS.withinOneEdit("weokie", "weokie"), true);
  eq(CS.withinOneEdit("wieokie", "weokie"), true, "insertion");
  eq(CS.withinOneEdit("weoke", "weokie"), true, "deletion");
  eq(CS.withinOneEdit("weokia", "weokie"), true, "substitution");
  eq(CS.withinOneEdit("weokiea", "weokie"), true, "trailing insertion");
  eq(CS.withinOneEdit("wxokix", "weokie"), false, "two edits");
  eq(CS.withinOneEdit("abc", "abcde"), false, "length gap of two");
  eq(CS.withinOneEdit("", "a"), true);
});

check("every client in the directory is reachable by its own name", () => {
  const missed = CLIENTS.filter((c) => !names(c.name).includes(c.name));
  eq(missed.length, 0, `unreachable: ${missed.map((c) => c.name).join(", ")}`);
});

check("every client is reachable by its own domain root", () => {
  const missed = CLIENTS.filter((c) => {
    const root = c.domain.split(".")[0];
    return !names(root).includes(c.name);
  });
  eq(missed.length, 0, `unreachable: ${missed.map((c) => c.domain).join(", ")}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
