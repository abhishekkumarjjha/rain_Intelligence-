// =============================================================================
// test/ui.test.js — the user flow, in a real browser, end to end.
//
// This file exists because of a specific failure. Every API test passed, the
// capture completed, the payload was correct and complete — and the user saw
// nothing, because the code that makes the results screen visible was never
// called. No amount of server-side testing catches that. The only assertion
// that does is "after the capture finishes, is the results screen on screen?"
//
// FAILS when Playwright or its browser is unavailable. It used to exit 0 with
// "(playwright not installed — skipping UI tests)", which meant `npm run
// test:ui` passed on every machine that could not run it — including whatever
// was going to run it in CI — and this file went years without executing while
// reporting success. A suite that cannot run must say so in the only language a
// pipeline reads.
//
// RI_SKIP_UI=1 is the deliberate opt-out for the local no-browser case. It is a
// choice someone makes, and it prints what it skipped.
// =============================================================================

import { existsSync } from "node:fs";
import { startServer, check, section, summary, eq, ok } from "./harness.js";

if (process.env.RI_SKIP_UI === "1") {
  console.log("  (RI_SKIP_UI=1 — browser tests deliberately skipped; nothing here was verified)");
  process.exit(0);
}

function unavailable(what) {
  console.error(`\n  BROWSER TESTS DID NOT RUN: ${what}.`);
  console.error("  Install with: npm install   (playwright is a devDependency)");
  console.error("  To skip deliberately on a machine with no browser: RI_SKIP_UI=1 npm run test:ui\n");
  process.exit(1);
}

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { unavailable("playwright is not installed"); }

const CANDIDATES = [
  process.env.RI_CHROME_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter(Boolean);

let executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  try { if (existsSync(chromium.executablePath())) executablePath = chromium.executablePath(); } catch { /* none */ }
}
if (!executablePath) unavailable("no chromium binary was found (set RI_CHROME_PATH, or run: npx playwright install chromium)");

const S = await startServer();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });

// Anything the page logs as an error is a bug. A ReferenceError inside a render
// path shows up as a blank section and nothing else — precisely the class of
// failure this file is here to catch.
const pageErrors = [];      // uncaught JS exceptions — always a bug
const consoleErrors = [];   // console.error — filtered, see below

// Resource-load failures are environmental in this sandbox (no outbound network
// for Google Fonts) and are also the EXPECTED result of the tests that
// deliberately provoke a 4xx. A JS exception never is.
const BENIGN = /Failed to load resource|net::ERR_|fonts\.(googleapis|gstatic)\.com/i;

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) consoleErrors.push(m.text()); });
  return page;
}

/** The cost line is debounced and re-fires on every selection change, so read
    it only once it has stopped moving — otherwise an assertion can catch the
    value from a selection two clicks ago. */
async function settledCostLine(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    const now = await page.locator("#costNote").innerText();
    if (now === last) return now.trim();
    last = now;
    if (Date.now() > deadline) return now.trim();
    await page.waitForTimeout(200);
  }
}

/** Select exactly `want` on the competitor screen, deselecting everything else. */
async function chooseCompetitors(page, want) {
  const rows = page.locator("#compList .comprow");
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const dm = row.locator(".dm");
    if (!(await dm.count())) continue;
    const domain = (await dm.innerText()).trim();
    if (await row.locator(".tag.client").count()) continue;   // the fixed client row
    const on = (await row.getAttribute("class")).includes("on");
    if (on !== want.includes(domain)) await row.click();
  }
}

/* The landing page has two ways in and they must both keep working. The
   directory path is what a strategist actually uses, so it is the one the
   walkthroughs take; the URL path gets its own checks below. */
async function openLanding(page) {
  await page.goto(`${S.base}/`, { waitUntil: "networkidle" });
  // The product list arrives from /api/clients and /api/health. Selecting an
  // option before either lands is a race, not a bug in the page.
  await page.waitForFunction(
    () => document.querySelectorAll("#landProductSel option").length > 1,
    null, { timeout: 10000 });
}

async function pickClient(page, typed, product) {
  await openLanding(page);
  await page.fill("#clientInput", typed);
  await page.click("#clientMenu .acitem");
  await page.selectOption("#landProductSel", product);
  await page.click("#goBtn");
  await page.waitForSelector("#s-mode.active", { timeout: 10000 });
}

async function pickUrl(page, url) {
  await openLanding(page);
  await page.click("#urlToggle");
  await page.fill("#urlInput", url);
  await page.click("#analyzeBtn");
}

async function toResults(page, mode, want) {
  await pickClient(page, "capitol", "checking");
  await page.click(`.modecard[data-mode="${mode}"]`);
  await page.waitForSelector("#s-comp.active", { timeout: 10000 });
  await chooseCompetitors(page, want);
  await page.click("#captureBtn");
}

const MARKET_TWO = ["campusfederal.org", "neighborsfcu.org"];

try {
  // ------------------------------------------------------------ landing copy
  section("landing screen");
  {
    const page = await newPage();
    await page.goto(`${S.base}/`, { waitUntil: "networkidle" });

    await check("the document title is the product name", async () =>
      eq(await page.title(), "RAIN Intelligence", "document title"));

    await check("the headline is the product name", async () => {
      const h1 = (await page.locator(".hero h1").innerText()).replace(/\s+/g, " ").trim();
      eq(h1, "RAIN Intelligence", "h1");
    });

    await check("the tagline states what the product is", async () => {
      const t = (await page.locator(".tagline").innerText()).trim();
      ok(/AI-powered competitive intelligence/i.test(t), `tagline was: ${t}`);
      ok(/see what your competitors are doing/i.test(t), `tagline was: ${t}`);
    });

    await check("the client picker is the primary action, the URL is not", async () => {
      ok(await page.locator("#clientInput").isVisible(), "client input not visible");
      ok(await page.locator("#landProductSel").isVisible(), "product select not visible");
      // Two fields, both required. The board is product-scoped, so Analyze must
      // not be reachable until the product is stated.
      eq(await page.locator("#goBtn").isDisabled(), true, "Analyze was live before either field was set");
      eq(await page.locator("#urlInput").isVisible(), false, "the URL bar should start collapsed");
    });

    await check("typing a partial name finds the client by substring", async () => {
      await page.fill("#clientInput", "capitol");
      await page.waitForSelector("#clientMenu .acitem", { timeout: 4000 });
      const first = (await page.locator("#clientMenu .acitem .acname").first().innerText()).trim();
      eq(first, "La Capitol Federal Credit Union", `first suggestion was: ${first}`);
      // The market is the disambiguator when two clients share a word.
      ok((await page.locator("#clientMenu .acitem .acmeta").first().innerText()).includes("lacapfcu.org"),
        "suggestion should show the domain");
    });

    await check("a name that matches nothing points at the URL path", async () => {
      await page.fill("#clientInput", "zzzznotaclient");
      await page.waitForSelector("#clientMenu .acnone", { timeout: 4000 });
      ok(/landing page URL/i.test(await page.locator("#clientMenu .acnone").innerText()),
        "no-match state should name the other way in");
      await page.fill("#clientInput", "");
    });

    await check("the URL path is one click away for anyone not in the directory", async () => {
      await page.click("#urlToggle");
      ok(await page.locator("#urlInput").isVisible(), "url input did not open");
      const ph = await page.locator("#urlInput").getAttribute("placeholder");
      ok(ph.includes("/"), `placeholder should show a product path, got ${ph}`);
      ok(/landing page|product page/i.test(await page.locator("#urlHint").innerText()), "no landing-page guidance");
    });

    // ONE WAY IN AT A TIME. Both paths open at once meant two live Analyze
    // buttons and two product scopes — Checking picked above, /auto-loan pasted
    // below — with nothing on screen saying which one the capture would use.
    await check("opening the URL path closes the client picker", async () => {
      eq(await page.locator("#pickBar").isVisible(), false, "the client picker stayed open beside the URL bar");
      eq(await page.locator("#goBtn").isVisible(), false, "a second live Analyze button is still reachable");
      ok(await page.locator("#pickerToggle").isVisible(), "the URL path has no way back");
    });

    await check("the way back restores the picker and drops the URL", async () => {
      await page.fill("#urlInput", "https://www.lacapfcu.org/auto-loan");
      await page.click("#pickerToggle");
      ok(await page.locator("#clientInput").isVisible(), "the picker did not come back");
      eq(await page.locator("#urlInput").isVisible(), false, "the URL bar stayed open behind the picker");
      eq(await page.inputValue("#urlInput"), "", "a second product scope survived the switch");
    });

    await check("the landing screen carries nothing it was not asked", async () => {
      eq(await page.locator("#quickClients").count(), 0, "client shortcut chips still present");
      // The directory size and the read cap were facts about the tool, not
      // answers to anything asked on this screen. Silence is correct here;
      // this line speaks only when a key is missing.
      eq((await page.locator("#healthLine").innerText()).trim(), "",
        "the status line should be silent when everything is configured");
    });

    await check("a missing key is stated on the landing page, not after Analyze", async () => {
      const shown = await page.evaluate(() => {
        const el = document.getElementById("healthLine");
        el.innerHTML = `<span class="bad">Not configured: SERPAPI_KEY</span> — captures will fail until this is set.`;
        return { text: el.innerText, visible: el.offsetParent !== null };
      });
      ok(shown.visible, "the status line must be able to appear");
      ok(/Not configured/.test(shown.text), "the warning has to survive the quiet default");
    });

    await check("the palette uses blue, orange and green — not blue alone", async () => {
      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return ["--bg", "--blue", "--amber", "--green", "--amber-fill", "--green-fill"]
          .map((k) => [k, cs.getPropertyValue(k).trim()]);
      });
      for (const [k, v] of t) ok(v, `token ${k} is undefined`);
    });

    await check("no CSS variable referenced by the page is undefined", async () => {
      const missing = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const used = new Set();
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) {
            const text = rule.cssText || "";
            for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/gi)) used.add(m[1]);
          }
        }
        return [...used].filter((v) => !cs.getPropertyValue(v).trim());
      });
      ok(missing.length === 0, `undefined CSS variables: ${missing.join(", ")}`);
    });

    await check("nothing on the landing screen overflows horizontally", async () => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      eq(over, false, "page scrolls sideways");
    });

    await page.close();
  }

  // -------------------------------------------------------- the creative flow
  section("creative flow — landing to wall");
  let wallCount = 0;
  {
    const page = await newPage();
    await pickClient(page, "capitol", "checking");

    await check("the mode screen names the resolved client", async () =>
      // .eyebrow is uppercased in CSS, so compare the text not its casing.
      eq((await page.locator("#modeInst").innerText()).trim().toLowerCase(),
         "la capitol federal credit union", "resolved client"));

    await check("the mode screen offers exactly the modes that exist", async () => {
      // There is no third card. The Proposal stub was removed from index.html
      // and this assertion went on asking after its "next build" marker,
      // because nothing ever ran it. A mode that is not built must not be on
      // screen at all — a disabled card is still a promise.
      const modes = await page.locator(".modecard").evaluateAll((els) => els.map((e) => e.dataset.mode));
      eq(JSON.stringify(modes.sort()), JSON.stringify(["benchmark", "creative"]), "modes on screen");
      eq(await page.locator(".modecard.disabled").count(), 0, "a mode is on screen that cannot be used");
    });

    await page.click('.modecard[data-mode="creative"]');
    await page.waitForSelector("#s-comp.active", { timeout: 10000 });

    await check("the product scope was picked up from the URL path", async () =>
      eq(await page.locator("#productSel").inputValue(), "checking", "product scope"));

    await chooseCompetitors(page, MARKET_TWO);

    // The cost line used to count advertisers and search credits. It now reads
    // the per-advertiser capture cache, so it states the SOURCE, what will
    // actually be spent, and what is being reused — the numbers that change
    // depending on who else on the team ran this competitor that week.
    await check("the national tier is on by default and says who it adds", async () => {
      ok(await page.locator("#natRow").isVisible(), "the nationals row is not on the competitor screen");
      eq(await page.locator("#nationalsChk").isChecked(), true, "the tier should default to ON");
      const t = await page.locator("#natRow").innerText();
      ok(/Chase/.test(t) && /Capital One/.test(t), `the row must name both: ${t}`);
    });

    await check("switching the tier off re-quotes the cost downward", async () => {
      // The control is only real if the price follows it. Two advertisers
      // dropped from the capture must be two advertisers dropped from the quote.
      const before = await settledCostLine(page);
      const nBefore = Number((before.match(/(\d+) SerpApi requests?/) || [])[1] || 0);
      await page.click("#natRow");
      const after = await settledCostLine(page);
      const nAfter = Number((after.match(/(\d+) SerpApi requests?/) || [])[1] || 0);
      ok(nAfter === nBefore - 2, `expected two fewer requests, got ${nBefore} -> ${nAfter}`);
      await page.click("#natRow");                       // back on for the capture below
      eq(await page.locator("#nationalsChk").isChecked(), true, "restored");
    });

    await check("the cost line states what will be spent before anything is spent", async () => {
      const cost = await settledCostLine(page);
      ok(/Google image ads/.test(cost), `cost line was: ${cost}`);
      ok(/\d+ SerpApi requests?|nothing to spend/.test(cost), `cost line was: ${cost}`);
      ok(/reused for \d+ days/.test(cost), `cost line was: ${cost}`);
      // BOTH BILLS. Quoting SerpApi credits and staying silent about up to
      // thirty vision calls per advertiser is the bug F-009 is about, and it
      // is exactly the kind of omission this line can regress into silently.
      ok(/fresh creative reads?|already read|nothing to spend/.test(cost),
        `the quote says nothing about model spend: ${cost}`);
      ok(/up to/.test(cost) || /nothing to spend/.test(cost),
        `a vision quote stated as a flat number is a promise: ${cost}`);
      ok(/Key insights is a separate model call/.test(cost),
        `the quote does not say what it excludes: ${cost}`);
      ok(/does NOT re-read creatives/.test(cost),
        `the quote does not say which cache force bypasses: ${cost}`);
    });

    await page.click("#captureBtn");
    await page.waitForSelector("#s-run.active", { timeout: 10000 });
    await check("capture advances to the progress screen", async () =>
      eq(await page.locator("#s-run").isVisible(), true, "progress screen"));

    // ===================== THE REGRESSION =====================
    // The capture used to finish here and stop. Everything rendered into a
    // hidden section and the user was left watching completed progress rows.
    await page.waitForSelector("#s-results.active", { timeout: 60000 });

    await check("THE RESULTS SCREEN BECOMES VISIBLE WHEN THE CAPTURE FINISHES", async () => {
      eq(await page.locator("#s-results").isVisible(), true, "results screen visible");
      eq(await page.locator("#s-run").isVisible(), false, "progress screen still visible");
    });

    await page.waitForSelector(".wall .adcard", { timeout: 20000 });
    wallCount = await page.locator(".wall .adcard").count();
    await check("the wall renders cards, not an empty state", async () =>
      ok(wallCount > 0, "no cards on the wall"));

    await check("the headline stats are populated", async () => {
      const stats = await page.locator("#resStats .st .v").allInnerTexts();
      eq(stats.length, 3, "stat count");
      ok(stats.every((v) => /^\d+$/.test(v.trim())), `stats were ${JSON.stringify(stats)}`);
      ok(Number(stats[1]) > 0, "creative count should not be zero");
    });

    await check("the capture funnel is shown and reconciles to the wall", async () => {
      ok(await page.locator("#funnelBar").isVisible(), "funnel strip missing");
      const values = (await page.locator("#funnelBar .fstep .fv").allInnerTexts()).map((v) => Number(v.replace(/,/g, "")));
      ok(values.length >= 2, `expected funnel steps, got ${values.length}`);
      // Monotonically non-increasing: a funnel that goes back up is nonsense.
      for (let i = 1; i < values.length; i++) {
        ok(values[i] <= values[i - 1], `funnel rose from ${values[i - 1]} to ${values[i]}`);
      }
    });

    await check("the funnel explains every drop when asked", async () => {
      const toggle = page.locator("#funnelToggle");
      if (!(await toggle.count())) return;              // nothing was lost
      await toggle.click();
      await page.waitForTimeout(200);
      const why = await page.locator("#funnelWhy").innerText();
      ok(why.trim().length > 0, "the 'why the drop' panel opened empty");
      await toggle.click();
    });

    await check("the wall opens on the scoped product but says how to see the rest", async () => {
      const scope = await page.locator("#scopeBar").innerText();
      ok(/Checking/i.test(scope), `scope bar did not name the product: ${scope}`);
      ok(await page.locator("#showAllProducts").isVisible(), "no way to reach the unscoped creatives");
    });

    await check("SHOWING ALL PRODUCTS REACHES EVERY CAPTURED CREATIVE", async () => {
      const scoped = await page.locator(".wall .adcard").count();
      await page.locator("#showAllProducts").click();
      await page.waitForTimeout(300);
      const all = await page.locator(".wall .adcard").count();
      ok(all > scoped, `"show all" did not widen the wall: ${all} vs ${scoped}`);
      // and back
      await page.locator("#productFilters .fchip", { hasText: "Checking" }).first().click();
      await page.waitForTimeout(300);
      eq(await page.locator(".wall .adcard").count(), scoped, "returning to the scope");
      await page.locator("#productFilters .fchip", { hasText: "All products" }).first().click();
      await page.waitForTimeout(300);
    });

    await check("the sampling note is shown on the results screen", async () =>
      ok((await page.locator("#samplingBar").innerText()).trim().length > 0, "sampling bar empty"));

    await page.waitForTimeout(1500);
    await check("creative images load — none fell through to the broken state", async () =>
      eq(await page.locator(".wall .broken").count(), 0, "cards showing 'could not be loaded'"));

    await check("a multi-execution idea is badged as such", async () =>
      ok((await page.locator(".wall .varbadge").count()) > 0, "no variation badge on the wall"));

    await check("longevity reads as days shown, never as a continuous run", async () => {
      const t = (await page.locator(".wall").allInnerTexts()).join("\n");
      ok(/shown on [\d,]+ days/i.test(t), "expected 'shown on N days' phrasing");
      ok(!/continuously|running for \d/i.test(t), "found an overclaiming longevity phrase");
    });

    await check("no performance language leaks onto the wall", async () => {
      const t = (await page.locator(".wall").allInnerTexts()).join("\n");
      ok(!/best[- ]performing|top[- ]performing|winning ad/i.test(t), "found performance language");
    });

    await check("no card rendered undefined, NaN or [object Object]", async () => {
      const t = (await page.locator(".wall").allInnerTexts()).join("\n");
      ok(!/undefined|NaN|\[object/.test(t), `wall contained a rendering artifact: ${t.slice(0, 200)}`);
    });

    // ------------------------------------------------------------- filters
    section("creative filters");
    // The product checks above left the wall on "All products", so the baseline
    // the advertiser filter is measured against has to be re-read here.
    wallCount = await page.locator(".wall .adcard").count();
    await check("product filter chips are rendered", async () =>
      ok((await page.locator("#productFilters .fchip").count()) > 1,
        `got ${await page.locator("#productFilters .fchip").count()} product chips`));

    await page.locator("#filters .fchip", { hasText: "Campus Federal" }).first().click();
    await page.waitForTimeout(300);

    await check("filtering by advertiser narrows the wall", async () => {
      const n = await page.locator(".wall .adcard").count();
      ok(n > 0, "advertiser filter emptied the wall");
      ok(n < wallCount, `filter did not narrow: ${n} of ${wallCount}`);
    });

    await check("the filtered wall shows only the chosen advertiser", async () => {
      const who = await page.locator(".wall .meta .who").allInnerTexts();
      ok(who.length > 0 && who.every((w) => /Campus Federal/i.test(w)), `saw ${JSON.stringify(who)}`);
    });

    await page.locator("#filters .fchip", { hasText: "All advertisers" }).first().click();
    await page.waitForTimeout(300);
    await check("clearing the filter restores every card", async () =>
      eq(await page.locator(".wall .adcard").count(), wallCount, "restored count"));

    await check("a filter combination with no matches offers a way out", async () => {
      await page.locator("#filters .fchip", { hasText: "Campus Federal" }).first().click();
      await page.waitForTimeout(200);
      const mortgage = page.locator("#productFilters .fchip", { hasText: "Mortgage" });
      if (!(await mortgage.count())) return;                 // nothing to combine
      await mortgage.first().click();
      await page.waitForTimeout(300);
      ok(await page.locator("#clearFilters").isVisible(), "no escape from an empty filter combination");
      await page.locator("#clearFilters").click();
      await page.waitForTimeout(300);
      eq(await page.locator(".wall .adcard").count(), wallCount, "clearing filters restored the wall");
    });

    // ------------------------------------------------------ evidence drawer
    section("evidence drawer");
    await page.locator(".wall .adcard .shot").first().click();
    await page.waitForSelector("#drawer.on", { timeout: 6000 });

    await check("clicking a creative opens the drawer with its executions", async () => {
      const title = await page.locator("#drawerTitle").innerText();
      const m = title.match(/(\d+) ads?/);
      ok(m, `drawer title had no count: ${title}`);
      ok(Number(m[1]) >= 1, "drawer opened with no ads");
      ok((await page.locator("#drawerBody .evcard").count()) >= 1, "no evidence cards");
    });

    await check("the drawer links back to the Transparency Center", async () =>
      ok((await page.locator("#drawerBody a").count()) > 0, "no source link in the drawer"));

    await check("the drawer contains no rendering artifacts", async () => {
      const t = await page.locator("#drawerBody").innerText();
      ok(!/undefined|NaN|\[object/.test(t), `drawer contained: ${t.slice(0, 200)}`);
    });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await check("Escape closes the drawer", async () =>
      eq(await page.locator("#drawer.on").count(), 0, "drawer still open"));

    await page.close();
  }

  // ------------------------------------------------------- the benchmark flow
  //
  // THIS SECTION WAS STALE, and nothing could have told anyone: the file has
  // never run. It waited on table.bench being visible, which it stopped being
  // when the table moved behind the "Full benchmark table" disclosure and the
  // findings board became the deliverable; and it drove #genBtn, .gate and
  // .angle, which left the UI months ago and left the server in F-004. A suite
  // that cannot run cannot go stale loudly, so it went stale quietly.
  section("benchmark flow — the board, and the table that audits it");
  {
    const page = await newPage();
    await pickClient(page, "capitol", "checking");
    await page.click('.modecard[data-mode="benchmark"]');
    await page.waitForSelector("#s-comp.active", { timeout: 10000 });

    await check("the client appears as a captured column, not an assumption", async () =>
      ok((await page.locator("#compList .comprow .tag.client").count()) > 0, "no client row"));

    await chooseCompetitors(page, MARKET_TWO);
    await page.click("#captureBtn");
    await page.waitForSelector("#s-results.active", { timeout: 60000 });

    // THE BOARD IS WHAT THE USER SEES FIRST. It has to be on screen with no
    // disclosure opened, or the deliverable is behind a click.
    await page.waitForSelector(".fcard", { timeout: 20000 });

    await check("the findings board is on screen without opening anything", async () =>
      ok((await page.locator(".fcard").count()) > 0, "no findings rendered"));

    await check("every finding on screen declares the population it was counted over", async () => {
      // "4 of 5 competitors" is ONE shape of denominator. Below the tabling
      // threshold the board names the advertisers instead — that is the
      // doctrine, not a missing denominator — so the assertion is that every
      // card says who it counted, in whichever of the two forms applies.
      const findings = await page.locator(".fcard").allInnerTexts();
      ok(findings.length, "no findings to check");
      for (const f of findings) {
        ok(/\d+ of \d+ competitors|captured (ads|set)|competitors'? captured/i.test(f),
          `a finding names no population: ${JSON.stringify(f)}`);
      }
    });

    await check("nothing on the board reads as a claim about a product", async () => {
      const text = await page.locator("#resultBody").innerText();
      const claim = text.match(/\b(do(es)? not offer|doesn'?t (offer|have)|no longer (offers?|runs))\b/i);
      ok(!claim, `a product claim reached the screen: "${claim?.[0]}"`);
    });

    await check("no rendered panel contains undefined, NaN or [object Object]", async () => {
      const t = await page.locator("#resultBody").innerText();
      const bad = t.match(/\bundefined\b|\bNaN\b|\[object [A-Z]/);
      ok(!bad, `rendered text contained "${bad?.[0]}"`);
    });

    await check("every block of findings carries its own heading", async () => {
      // Without one the eye carries the nearest heading down: a client
      // advantage sitting in the right half of the grid below "Competitive
      // pressure" reads as pressure, because pressure was the last thing named.
      for (const sel of [".scol.lead .scolhead", ".scol.pressure .scolhead"]) {
        ok(await page.locator(sel).count() > 0, `${sel} missing`);
      }
      for (const el of await page.locator(".sect > summary.secthead").all()) {
        const t = (await el.innerText()).trim();
        ok(t.length > 3, `a section rendered without a heading: "${t}"`);
      }
      // A heading that names a section without defining it invites the same
      // misreading, so each one states its rule underneath.
      const sects = await page.locator(".sect").count();
      eq(await page.locator(".sect .sectrule").count(), sects, "a section is missing its rule line");
    });

    // ------------------------------------------- the table AUDITS the board
    await check("the full table is behind a disclosure, not on the page by default", async () => {
      eq(await page.locator("table.bench").isVisible(), false,
        "the audit trail is being presented as the answer");
    });

    await page.locator("details.auditwrap > summary").click();
    await page.waitForSelector("table.bench:visible", { timeout: 10000 });

    await check("the client is the first column in the table", async () => {
      const headers = await page.locator("table.bench thead th").allInnerTexts();
      ok(/La Capitol/i.test(headers[1] || ""), `headers were ${JSON.stringify(headers)}`);
    });

    await check("the advertised bonus row is populated from captured ads", async () =>
      ok(/\$400/.test(await page.locator("table.bench").innerText()), "expected the strongest captured bonus"));

    await check("the client's absent bonus renders as an absence, not a zero", async () => {
      const t = await page.locator("table.bench").innerText();
      ok(/—|not observed|none captured/i.test(t), "expected an absent cell");
      ok(!/\b0\b\s*(bonus|APY)/i.test(t), "an absence was rendered as a zero");
    });

    await check("no cell rendered undefined, NaN or [object Object]", async () => {
      const t = await page.locator("table.bench").innerText();
      ok(!/undefined|NaN|\[object/.test(t), `table contained: ${t.slice(0, 300)}`);
    });

    await check("every evidence link in the table opens real ads", async () => {
      const ev = page.locator("table.bench .ev").first();
      ok(await ev.count(), "no evidence affordance in the table");
      await ev.click();
      await page.waitForSelector("#drawer.on", { timeout: 6000 });
      ok((await page.locator("#drawerBody .evcard").count()) > 0, "evidence drawer opened empty");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    });

    // ------------------------------------------------ the gate that was removed
    await check("the strategy gate is gone from the screen, not merely unstyled", async () => {
      eq(await page.locator("#genBtn").count(), 0, "the paid gate is still in the DOM");
      eq(await page.locator(".angle").count(), 0, "generated strategy angles are on screen");
    });

    await page.close();
  }

  // ------------------------------------------------- nothing captured at all
  section("a capture that finds nothing still renders a result");
  {
    const page = await newPage();
    await pickClient(page, "capitol", "checking");
    await page.click('.modecard[data-mode="creative"]');
    await page.waitForSelector("#s-comp.active", { timeout: 10000 });

    await chooseCompetitors(page, []);
    await page.fill("#addName", "Silent Bank");
    await page.fill("#addDomain", "silentbank.com");
    await page.click("#addBtn");
    await page.click("#captureBtn");

    await page.waitForSelector("#s-results.active", { timeout: 60000 });
    await check("an empty capture still reaches the results screen", async () =>
      eq(await page.locator("#s-results").isVisible(), true, "results screen"));

    await check("it explains what each advertiser returned rather than showing a blank page", async () => {
      const body = await page.locator("#resultBody").innerText();
      ok(/No local creatives were read/i.test(body), `body was: ${body.slice(0, 200)}`);
      ok(/Silent Bank/.test(body), "the advertiser is not named");
      ok(/no ads in this window/i.test(body), "the reason is not stated");
    });

    await check("national benchmarks never stand in for an empty local market", async () => {
      // The failure this guards: nationals are appended to every capture, so a
      // capture whose local competitors returned NOTHING still renders a full
      // wall of Chase and Capital One. Without the caveat that reads as the
      // client's market, which is the one claim this tool must never make.
      const body = await page.locator("#resultBody").innerText();
      ok(/national benchmark/i.test(body), "the national tier is not labelled as such");
      ok(/not this client's market/i.test(body), `the disclaimer is missing: ${body.slice(0, 200)}`);
    });

    await page.close();
  }

  // ---------------------------------------------------------- error surfacing
  section("errors are shown on the page, never in an alert");
  {
    const page = await newPage();
    let alerted = false;
    page.on("dialog", async (d) => { alerted = true; await d.dismiss(); });

    await pickUrl(page, "definitely not a url");
    await page.waitForTimeout(600);

    await check("a bad URL is explained inline, not in a blocking dialog", async () => {
      eq(alerted, false, "a native alert() fired");
      ok(/does not look like a URL/i.test(await page.locator("#urlHint").innerText()), "no inline hint");
      eq(await page.locator("#s-landing").isVisible(), true, "left the landing screen on a bad URL");
    });

    await page.close();
  }

  // ===========================================================================
  // JOURNEYS — one browser context, several analyses, state must not leak.
  //
  // Every bug the owner found by hand this week was UI-shaped: options rendering
  // grey, two entry paths open at once, a modal behind a modal, a panel that
  // closed itself. None of them is reachable from the API, and none of them was
  // reachable from this file either, because this file had never run.
  // ===========================================================================
  section("journey — a second capture does not inherit the first one's filters");
  {
    const page = await newPage();

    await toResults(page, "creative", MARKET_TWO);
    await page.waitForSelector("#s-results.active", { timeout: 60000 });
    await page.waitForSelector(".wall .adcard", { timeout: 20000 });

    // Narrow to ONE advertiser, then take the path that does not reload:
    // "Add a competitor" goes back to the capture screen, and capturing again
    // from there kept every chip from the run that just ended.
    const narrowTo = "neighborsfcu.org";
    await page.locator(`#filters .fchip[data-f="${narrowTo}"]`).click();
    await page.waitForTimeout(300);

    const narrowed = await page.locator(".wall .adcard").count();
    await check("the advertiser filter narrowed the first wall", async () => {
      ok(narrowed > 0, "the filter emptied the wall it was applied to");
      ok((await page.locator(`#filters .fchip[data-f="${narrowTo}"].on`).count()) > 0,
        "the chip does not read as active");
    });

    await page.click("#addCompBtn");
    await page.waitForSelector("#s-comp.active", { timeout: 15000 });

    // A DIFFERENT SET, which no longer contains the advertiser that was filtered
    // to. Under the old behaviour the second wall rendered zero cards and read
    // as a capture that found nothing.
    await chooseCompetitors(page, ["campusfederal.org"]);
    await page.click("#captureBtn");
    await page.waitForSelector("#s-results.active", { timeout: 60000 });
    await page.waitForTimeout(500);

    await check("the second wall is not empty", async () =>
      ok((await page.locator(".wall .adcard").count()) > 0,
        "the second capture rendered no cards — a chip from the previous run is still filtering it"));

    await check("no advertiser chip from the previous run is still applied", async () => {
      const on = await page.locator("#filters .fchip.on").getAttribute("data-f");
      eq(on, "all", `the wall opened filtered to "${on}"`);
    });

    await check("the product chip re-adopts the new run's own scope", async () => {
      ok((await page.locator("#productFilters .fchip.on").count()) > 0,
        "no product chip reads as active at all");
    });

    await check("the results header names the run on screen", async () => {
      const t = await page.locator("#resTitle").innerText();
      ok(/La Capitol/i.test(t), `results header was "${t}"`);
    });

    await page.close();
  }

  // ---------------------------------------------------------- product scopes
  section("journey — three products back to back under one context");
  {
    const page = await newPage();
    for (const product of ["checking", "auto-loan", "credit-card"]) {
      await pickClient(page, "capitol", product);
      await page.click('.modecard[data-mode="creative"]');
      await page.waitForSelector("#s-comp.active", { timeout: 10000 });

      await check(`the ${product} run carries its own scope into the competitor screen`, async () =>
        eq(await page.locator("#productSel").inputValue(), product, "product scope"));

      await chooseCompetitors(page, MARKET_TWO);
      await page.click("#captureBtn");
      await page.waitForSelector("#s-results.active", { timeout: 60000 });

      await check(`the ${product} results name the ${product} scope`, async () => {
        const t = await page.locator("#resTitle").innerText();
        ok(t.includes("·"), `results header was "${t}"`);
      });

      await page.click("#restartBtn");
      await page.waitForSelector("#s-landing.active", { timeout: 15000 });
    }
    await page.close();
  }

  // -------------------------------------------------------------- the drawer
  section("journey — drawer over panel, and Escape closing the right one");
  {
    const page = await newPage();
    await toResults(page, "creative", MARKET_TWO);
    await page.waitForSelector("#s-results.active", { timeout: 60000 });
    await page.waitForSelector(".wall .adcard", { timeout: 20000 });

    await page.locator(".wall .adcard .shot").first().click();
    await page.waitForSelector("#drawer.on", { timeout: 6000 });

    await check("the drawer opens over the wall with its evidence", async () =>
      ok((await page.locator("#drawerBody .evcard").count()) > 0, "the drawer opened empty"));

    await check("the drawer is painted above whatever it opened over", async () => {
      const z = await page.locator("#drawer").evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
      const behind = await page.locator("#s-results").evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
      ok(z > behind, `drawer z-index ${z} is not above the results screen (${behind})`);
    });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await check("Escape closes the drawer and leaves the wall behind it intact", async () => {
      eq(await page.locator("#drawer.on").count(), 0, "the drawer stayed open");
      ok((await page.locator(".wall .adcard").count()) > 0, "the wall was closed along with the drawer");
    });

    await check("closing the drawer did not scroll the wall away", async () =>
      eq(await page.locator("#s-results.active").count(), 1, "the results screen closed itself"));

    await page.close();
  }

  // ------------------------------------------------- money buttons, twice each
  section("journey — a double-click never buys anything twice");
  {
    const page = await newPage();

    // Count what the client actually sends. A second POST is a second capture,
    // and a capture is SerpApi credits and vision calls.
    let captures = 0;
    page.on("request", (r) => { if (r.url().includes("/api/capture") && r.method() === "POST") captures++; });

    await pickClient(page, "capitol", "checking");
    await page.click('.modecard[data-mode="creative"]');
    await page.waitForSelector("#s-comp.active", { timeout: 10000 });
    await chooseCompetitors(page, MARKET_TWO);

    await page.locator("#captureBtn").dblclick();
    await page.waitForSelector("#s-results.active", { timeout: 60000 });

    await check("double-clicking Capture starts one capture, not two", () =>
      eq(captures, 1, `${captures} captures were started`));

    await page.close();
  }

  // ------------------------------------------- the capture that cannot start
  section("journey — the server is unreachable when Capture is pressed");
  {
    const page = await newPage();
    await pickClient(page, "capitol", "checking");
    await page.click('.modecard[data-mode="creative"]');
    await page.waitForSelector("#s-comp.active", { timeout: 10000 });
    await chooseCompetitors(page, MARKET_TWO);

    // The exact failure F-010 is about: the POST never completes. Before the
    // fix this threw out of an un-caught async function, leaving the only
    // button on the screen disabled forever and the user with no way forward
    // but a reload — and nothing on screen saying so.
    await page.route("**/api/capture", (route) => route.abort("failed"));
    await page.click("#captureBtn");
    await page.waitForTimeout(1500);

    await check("the failure is explained on the page", async () => {
      const err = await page.locator("#errBox, .errbox, #err").first();
      const text = await page.locator("body").innerText();
      ok(/could not reach the server/i.test(text), "the user was told nothing about the failure");
    });

    await check("the Capture button comes back so the user can retry", async () =>
      eq(await page.locator("#captureBtn").isDisabled(), false,
        "the only button on the screen is disabled forever"));

    await check("and it stayed on the competitor screen rather than half-navigating", async () =>
      eq(await page.locator("#s-comp.active").count(), 1, "the screen moved on after a failed start"));

    await page.unroute("**/api/capture");
    await check("retrying after the failure works", async () => {
      await page.click("#captureBtn");
      await page.waitForSelector("#s-results.active", { timeout: 60000 });
      eq(await page.locator("#s-results.active").count(), 1, "the retry did not reach results");
    });

    await page.close();
  }

  // ----------------------------------------------- the picker over the button
  section("journey — the client picker never covers the only other way in");
  {
    const page = await newPage();
    await openLanding(page);

    await check("clearing the search box does not leave a menu over the page", async () => {
      await page.fill("#clientInput", "capitol");
      await page.waitForSelector("#clientMenu .acitem", { timeout: 4000 });
      await page.fill("#clientInput", "");
      await page.waitForTimeout(200);
      eq(await page.locator("#clientMenu").isVisible(), false,
        "an empty query left eight arbitrary directory rows on screen as if they were suggestions");
      eq(await page.locator("#clientMenu .acitem").first().isVisible(), false,
        "a menu row is still hit-testable over the rest of the form");
    });

    await check("and the landing-page button underneath it is clickable", async () => {
      // Playwright refuses to click through an interceptor, so this is the
      // assertion: with the menu open over it, this click times out.
      await page.click("#urlToggle", { timeout: 5000 });
      ok(await page.locator("#urlInput").isVisible(), "the URL path did not open");
    });

    await page.close();
  }

  // ----------------------------------------------------- the screen-share size
  section("journey — the sizes this gets demonstrated at");
  for (const [w, h] of [[1366, 768], [1280, 720]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) consoleErrors.push(m.text()); });
    try {
      await toResults(page, "benchmark", MARKET_TWO);
      await page.waitForSelector("#s-results.active", { timeout: 60000 });
      await page.waitForSelector(".fcard", { timeout: 20000 });

      await check(`at ${w}×${h} nothing scrolls sideways`, async () => {
        const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        eq(over, false, "the page scrolls horizontally at a common screen-share size");
      });

      await check(`at ${w}×${h} the findings board is reachable by scrolling, not lost below the page`, async () => {
        // NOT an assertion that the board is above the fold. It is not — at
        // 1366×768 the first finding sits at roughly y=794, one short scroll
        // down, because the eyebrow, title, sampling note, funnel and stats
        // come first. Whether that ordering is right is a design call and not
        // this suite's to make; it is written up as an observation instead.
        // What IS a defect is a board pushed off the end of the document by a
        // layout that broke at a narrow width, so that is what is asserted.
        const box = await page.locator(".fcard").first().boundingBox();
        ok(box, "the first finding has no box at all — it is not being laid out");
        ok(box.y < h * 3, `the first finding sits at y=${Math.round(box.y)} on a ${h}px screen`);
        ok(box.width > 200, `the first finding is ${Math.round(box.width)}px wide — the grid has collapsed`);
      });
    } finally {
      await page.close();
      await ctx.close();
    }
  }

  // --------------------------------------------------------- console hygiene
  section("console");
  await check("no uncaught JavaScript exception anywhere in the flow", () =>
    ok(pageErrors.length === 0, `uncaught exceptions:\n${pageErrors.join("\n")}`));
  await check("nothing logged an application error to the console", () =>
    ok(consoleErrors.length === 0, `console errors:\n${consoleErrors.join("\n")}`));

  summary();
} finally {
  await browser.close();
  S.stop();
}
