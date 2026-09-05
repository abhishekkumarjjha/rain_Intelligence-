/* ---------------------------------------------------------------------------
   client-search.js — how the landing page finds a client from a few keystrokes.
   Separate from app.js because this is the one piece of the landing page with
   behaviour worth pinning down in tests: what "lacap" should find, and why.

   Plain substring matching got two things wrong. It missed "lacap", because
   the name is "La Capitol" and the space breaks the run of letters — it only
   worked at all by accident, via the domain lacapfcu.org. And it ranked
   "Brazos Valley Schools" as a match for "ho", because "Sc-ho-ols" contains
   those letters, with nothing to say Horicon was the better answer.

   So matching is scored rather than filtered. Every rule below still returns
   real matches; the ranking decides which of them a strategist meant.
   --------------------------------------------------------------------------- */
(function (root) {
  "use strict";

  const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  /* Credit unions are known by their initials at least as often as by their
     names — nobody says "Utilities Employees Credit Union" out loud. */
  const initials = (s) => words(s).map((w) => w[0]).join("");

  /* The domain minus its suffix. "lacapfcu.org" -> "lacapfcu", and .bank /
     .coop are as common as .com in this directory, so this cannot assume
     three letters after the dot. */
  const root_ = (d) => squash(String(d || "").split(".")[0]);

  /* Tiers, best first. The gap between 1 and 4 is the whole point: a word that
     STARTS with what you typed is what you meant, and a word that merely
     contains it somewhere in the middle is a coincidence worth showing only
     once the real answers have had their turn. */
  const TIER = {
    NAME_PREFIX: 0,   // "lacap"  -> La Capitol Federal Credit Union
    WORD_PREFIX: 1,   // "cap"    -> La (Cap)itol
    INITIALS: 2,      // "uecu"   -> (U)tilities (E)mployees (C)redit (U)nion
    DOMAIN_PREFIX: 3, // "weokie" -> weokie.org
    NAME_INSIDE: 4,   // "ell"    -> Isab(ell)a Bank
    DOMAIN_INSIDE: 5, // catch-all on the URL
    MISS: 99,
  };

  function tierOf(c, q) {
    const nameSq = squash(c.name);
    const domSq = squash(c.domain);
    const ws = words(c.name);

    if (nameSq.startsWith(q)) return TIER.NAME_PREFIX;
    if (ws.some((w) => w.startsWith(q))) return TIER.WORD_PREFIX;
    // Two letters is the shortest initialism worth honouring; one letter would
    // match a third of the directory and tell the user nothing.
    if (q.length >= 2 && initials(c.name).startsWith(q)) return TIER.INITIALS;
    if (root_(c.domain).startsWith(q)) return TIER.DOMAIN_PREFIX;
    if (nameSq.includes(q)) return TIER.NAME_INSIDE;
    if (domSq.includes(q)) return TIER.DOMAIN_INSIDE;
    return TIER.MISS;
  }

  /* One insertion, deletion or substitution — no more. Full edit distance
     would turn four-letter queries into a lottery; a single slip is the error
     people actually make, and it is cheap to be sure about. */
  function withinOneEdit(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
  }

  /* Only ever a fallback, and only for queries long enough that a near miss
     means something. Correcting "we" to "he" would be guessing; correcting
     "wieokie" to "weokie" is reading a typo. */
  const FUZZY_MIN = 4;

  function fuzzy(clients, q) {
    if (q.length < FUZZY_MIN) return [];
    return clients.filter((c) =>
      words(c.name).some((w) => withinOneEdit(q, w)) ||
      withinOneEdit(q, root_(c.domain)) ||
      withinOneEdit(q, initials(c.name)));
  }

  /* Returns { list, fuzzy }. The flag travels with the result because a
     corrected spelling has to be labelled — a suggestion the user did not type
     and cannot explain reads as a bug. */
  function match(clients, query, limit) {
    const cap = limit || 8;
    const all = (clients || []).slice();
    const q = squash(query);

    // No query is not an error state: showing the first few names tells a new
    // user what kind of thing this field wants.
    if (!q) return { list: all.slice(0, cap), fuzzy: false };

    const scored = [];
    for (const c of all) {
      const t = tierOf(c, q);
      if (t !== TIER.MISS) scored.push({ c, t });
    }
    if (scored.length) {
      scored.sort((a, b) => a.t - b.t || a.c.name.localeCompare(b.c.name));
      return { list: scored.map((x) => x.c).slice(0, cap), fuzzy: false };
    }

    const near = fuzzy(all, q);
    near.sort((a, b) => a.name.localeCompare(b.name));
    return { list: near.slice(0, cap), fuzzy: near.length > 0 };
  }

  root.ClientSearch = { match, TIER, squash, words, initials, withinOneEdit, FUZZY_MIN };
})(typeof window !== "undefined" ? window : globalThis);
