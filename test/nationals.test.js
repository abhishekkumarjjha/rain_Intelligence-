// =============================================================================
// test/nationals.test.js — the standing national tier.
//
// The problem this feature solves is an EMPTY WALL: local competitors often run
// a handful of display creatives, and after clustering into ideas a three-
// competitor capture can produce under ten cards.
//
// The problem it could CREATE is a wall that is nothing but Chase. These tests
// hold both ends: the wall fills, and the local evidence survives.
// =============================================================================

import { check, section, summary, eq, ok, startServer } from "./harness.js";
import { rmSync } from "node:fs";
import { withNationals, isNational, captureOptionsFor, NATIONAL_TTL_DAYS, NATIONAL_READ_CAP } from "../lib/national-tier.js";
import { clusterAds } from "../lib/analyze.js";

section("pure logic — the tier");

await check("the two standing nationals are appended without being chosen", () => {
  const out = withNationals([{ label: "Local CU", domain: "localcu.org" }]);
  eq(out.length, 3, "1 chosen + 2 standing");
  ok(out.find((c) => c.domain === "chase.com")?.auto, "Chase added automatically");
  ok(out.find((c) => c.domain === "capitalone.com")?.auto, "Capital One added automatically");
  eq(out[0].tier, "local", "the chosen one is local");
});

await check("a national picked by hand is tiered, not duplicated", () => {
  const out = withNationals([{ label: "Chase", domain: "chase.com" }]);
  eq(out.filter((c) => c.domain === "chase.com").length, 1, "no duplicate");
  eq(out.find((c) => c.domain === "chase.com").tier, "national", "still tiered national");
  eq(out.length, 2, "Capital One still appended");
});

await check("nationals read deeper and cache far longer", () => {
  const nat = captureOptionsFor("chase.com", {});
  eq(nat.max, NATIONAL_READ_CAP, "deeper read");
  eq(nat.ttlDays, NATIONAL_TTL_DAYS, "longer TTL");
  ok(NATIONAL_TTL_DAYS >= 30, "at least a month");
  // A local competitor keeps the defaults: its cost is per client per run,
  // while a national's is bought once and shared by everyone.
  eq(Object.keys(captureOptionsFor("localcu.org", {})).length, 0, "locals unchanged");
});

await check("clustering is advertiser-scoped, so a national cannot absorb a local card", () => {
  const mk = (institution, id, days) => ({
    creativeId: id, institution, headline: "Open An Account Today",
    product: "checking", offer: null, totalDaysShown: days, width: 728, height: 90,
  });
  // Chase ran it longer. Without the advertiser in the key, the local card is
  // swallowed and credited to Chase.
  const out = clusterAds([mk("lacapfcu.org", "L1", 40), mk("chase.com", "C1", 640)]);
  eq(out.length, 2, "two competitors making the same bet is a finding, not a variation");
  ok(out.some((c) => c.institution === "lacapfcu.org"), "the local evidence survives");
});

// ---------------------------------------------------------------------------
section("live server — the wall fills, the local signal survives");

const S = await startServer();
try {
  let run;
  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
      competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
    });
    await check("one chosen competitor becomes four captured advertisers", () => {
      // The client is captured on the Wall too now — as its own population,
      // counted in none of the wall's figures. See flow.test.js.
      eq(body.targets.length, 4, "the client + 1 local + 2 standing nationals");
    });
    run = await S.awaitRun(body.runs[0].runId);
  }

  await check("every ad carries its tier, and the client's is its own", () => {
    ok(run.ads.every((a) => ["local", "national", "client"].includes(a.tier)), "tier present on all");
    ok(run.ads.some((a) => a.tier === "national"), "nationals captured");
    ok(run.ads.some((a) => a.tier === "local"), "locals captured");
    // THE CLIENT IS NEVER IN A COMPETITOR TIER. Every count on the wall is
    // computed over the two market tiers, so a client ad landing in "local"
    // would inflate the local set with the client's own creative.
    ok(run.ads.filter((a) => a.isClient).every((a) => a.tier === "client"),
      "a client ad must never be tiered as a competitor");
    ok(!run.creative.tiers.local.domains.includes("lacapfcu.org"), "the client is not in the local tier");
    ok(!run.creative.byCompetitor.some((c) => c.domain === "lacapfcu.org"),
      "the client must not appear as a competitor chip");
  });

  await check("the payload groups the two tiers separately", () => {
    const t = run.creative.tiers;
    ok(t.local.count > 0, "local tier populated");
    ok(t.national.count > 0, "national tier populated");
    ok(t.national.domains.includes("chase.com"), "Chase in the national tier");
    ok(t.national.note.includes("not because they compete locally"), "the note explains why they are there");
  });

  await check("the nationals are what fill the wall", () => {
    const nat = run.creative.clusters.filter((c) => c.tier === "national").length;
    const loc = run.creative.clusters.filter((c) => c.tier === "local").length;
    ok(nat > loc, `nationals ${nat} vs locals ${loc} — this is the emptiness fix`);
    ok(nat + loc >= 8, `wall has ${nat + loc} cards`);
  });

  await check("but no local card was absorbed by a national one", () => {
    // lacapfcu and chase both run "Open An Account Today" in the fixture.
    const local = run.creative.clusters.filter((c) => c.tier === "local");
    ok(local.length > 0, "local cards still on the wall");
    const byComp = run.creative.byCompetitor.find((c) => c.domain === "neighborsfcu.org");
    ok(byComp.count > 0, "the chosen competitor still has creatives of its own");
  });

  await check("competitor chips carry the tier so the UI can group them", () => {
    const chips = run.creative.byCompetitor;
    eq(chips.filter((c) => c.tier === "national").length, 2, "two national chips");
    eq(chips.filter((c) => c.tier === "local").length, 1, "one local chip");
  });

  // -------------------------------------------------------------------------
  section("live server — nationals are shared, not re-bought");

  {
    // A DIFFERENT client, a different product. Chase's display advertising is
    // identical either way, so it must come from cache: it is not per-client
    // evidence and should never be bought per client.
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "campusfederal.org", clientLabel: "Campus Federal", product: "mortgage",
      competitors: [{ label: "Pelican State CU", domain: "pelicanstatecu.com" }],
    });
    const second = await S.awaitRun(body.runs[0].runId);
    await check("a second client reuses the same national capture", () => {
      ok(second.progress["chase.com"].fromCaptureCache, "Chase from cache");
      ok(second.progress["capitalone.com"].fromCaptureCache, "Capital One from cache");
      ok(!second.progress["pelicanstatecu.com"].fromCaptureCache, "the local competitor is fetched fresh");
    });
    await check("so only the local competitor and the client cost a request", () => {
      // Two now, and the second one is the point of the change: the client's
      // own creative is what "competitors lead with a bonus" is measured
      // against. The nationals are still free.
      eq(second.requests, 2, "the chosen local and the client; both nationals cached");
    });
  }

  {
    const { body } = await S.post("/api/cost", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "efcufinancial.org",
      competitors: [{ label: "Unseen Bank", domain: "silentbank.com" }],
      days: 30,
    });
    await check("the cost line quotes the nationals it is about to capture", () => {
      const plan = body.plans[0];
      eq(plan.total, 4, "the client + 1 chosen + 2 nationals");
      eq(plan.fromCache, 2, "both nationals already held");
      eq(plan.willFetch, 2, "the unseen local and the client");
      eq(plan.nationalWillFetch, 0, "no national spend");
    });
  }

  // -------------------------------------------------------------------------
  section("live server — scope");

  {
    const { body } = await S.post("/api/capture", {
      mode: "benchmark",
      clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
      competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
    });
    // CHANGED DELIBERATELY. Benchmark used to exclude the nationals entirely,
    // on the grounds that a national column reads as a peer. That objection is
    // now answered by TIERING rather than by omission: they are captured, shown
    // under their own heading in the offer snapshot, and excluded from every
    // denominator and every finding (asserted in flow.test.js). A strategist
    // sitting with a client can see the national ceiling without it ever
    // becoming part of a "4 of 5 competitors" sentence.
    await check("Benchmark captures nationals as a reference tier", () => {
      const domains = body.targets.map((t) => t.domain);
      ok(domains.includes("chase.com"), "Chase should be captured for reference");
      ok(domains.includes("capitalone.com"), "Capital One should be captured for reference");
      eq(body.targets.length, 4, "client + one chosen peer + two nationals");
      const nationals = body.targets.filter((t) => t.domain === "chase.com" || t.domain === "capitalone.com");
      for (const n of nationals) ok(!n.isClient, "a national is never the client");
    });

    // The opt-out still holds, and it still means "no national rows at all".
    {
      const { body: optedOut } = await S.post("/api/capture", {
        mode: "benchmark",
        clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
        competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
        includeNationals: false,
      });
      await check("Benchmark honours the nationals opt-out", () => {
        eq(optedOut.targets.length, 2, "client + the one chosen peer");
      });
    }
  }

  {
    const { status, body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
      competitors: [],
    });
    await check("nationals alone are not a capture", () => {
      eq(status, 400, "refused");
      eq(body.reason, "no_competitors", "validated on what the user chose");
    });
  }

  {
    const { body } = await S.post("/api/capture", {
      mode: "creative", sources: ["google_display"], includeNationals: false,
      clientDomain: "lacapfcu.org", clientLabel: "La Capitol", product: "checking",
      competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
    });
    await check("a caller can opt out of the tier", () => {
      eq(body.targets.length, 2, "what was chosen, plus the client");
      ok(!body.targets.some((t) => t.domain === "chase.com"), "no national was appended");
    });
  }

  /* The cost quote and the capture must agree about the tier. If the quote
     ignored the opt-out it would price two advertisers the capture is not going
     to fetch — the mirror of the surprise this endpoint exists to prevent. */
  {
    const on = await S.post("/api/cost", {
      mode: "creative", sources: ["google_display"],
      clientDomain: "lacapfcu.org",
      competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
    });
    const off = await S.post("/api/cost", {
      mode: "creative", sources: ["google_display"], includeNationals: false,
      clientDomain: "lacapfcu.org",
      competitors: [{ label: "Neighbors FCU", domain: "neighborsfcu.org" }],
    });
    await check("the cost quote honours the opt-out", () => {
      // The client is quoted either way — it is captured either way. The
      // opt-out is about the national tier and nothing else.
      eq(on.body.plans[0].total, 4, "the client + 1 chosen + 2 nationals");
      eq(off.body.plans[0].total, 2, "the client + 1 chosen, tier off");
    });
  }
} finally {
  await S.stop();
}

// ---------------------------------------------------------------------------
// H16 — ONE DOMAIN, TWO ROLES, ONE CACHE ENTRY.
//
// The capture cache is keyed on source + domain + days and deliberately NOT on
// the client, which is the whole saving: one La Capitol capture serves every
// run that mentions La Capitol. That also means the same entry is replayed once
// as THE CLIENT and once as A COMPETITOR, and if any client framing were stored
// in it, the second run would inherit it — a competitor rendered on the client's
// own tier, inside the client wall, and out of every competitor denominator.
// ---------------------------------------------------------------------------
section("regression — a cached advertiser carries no client framing into its next role");
{
  const S = await startServer({}, { keepData: true });
  let dataDir = S.dataDir;
  try {
    // RUN ONE: lacapfcu.org is the CLIENT.
    const { body: first } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "lacapfcu.org", clientLabel: "La Capitol",
      product: "checking", days: 30,
      competitors: [{ label: "Campus Federal", domain: "campusfederal.org" }],
    });
    const runA = await S.awaitRun(first.runId);
    await check("run one captured the client on the client tier", () => {
      const own = runA.ads.filter((a) => a.institution === "lacapfcu.org");
      ok(own.length > 0, "no client ads captured");
      ok(own.every((a) => a.isClient === true), "the client is not flagged as the client");
      ok(own.every((a) => a.tier === "client"), "the client is not on the client tier");
    });

    // RUN TWO: the SAME domain, now a COMPETITOR of somebody else. Served from
    // the capture cache the first run wrote.
    const { body: second } = await S.post("/api/capture", {
      mode: "creative", clientDomain: "efcufinancial.org", clientLabel: "EFCU Financial",
      product: "checking", days: 30,
      competitors: [{ label: "La Capitol", domain: "lacapfcu.org" }],
    });
    const runB = await S.awaitRun(second.runId);

    await check("the second run really did replay the cached capture", () =>
      ok(runB.progress["lacapfcu.org"]?.fromCaptureCache,
        "not a cache hit, so this proves nothing — check the cache key"));

    await check("NO CLIENT FRAMING SURVIVED the replay", () => {
      const asCompetitor = runB.ads.filter((a) => a.institution === "lacapfcu.org");
      ok(asCompetitor.length > 0, "the cached advertiser produced no ads in the second run");
      ok(asCompetitor.every((a) => a.isClient === false),
        "an advertiser cached as the client came back flagged as the client of a different run");
      ok(asCompetitor.every((a) => a.tier !== "client"),
        "an advertiser cached as the client came back on the client tier");
    });

    await check("and it is counted as a competitor, not shown on the client's wall", () => {
      const wallDomains = new Set((runB.creative?.clusters || []).map((c) => c.institution));
      ok(wallDomains.has("lacapfcu.org"), "the cached competitor is missing from the wall");
      const clientOwn = (runB.ads || []).filter((a) => a.isClient).map((a) => a.institution);
      ok(clientOwn.every((d) => d === "efcufinancial.org"),
        `the client population of run two contains ${JSON.stringify([...new Set(clientOwn)])}`);
    });

    await check("the new client is the one this run was started for", () =>
      eq(runB.client.domain, "efcufinancial.org", "client domain"));
  } finally {
    S.stop();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

summary();
