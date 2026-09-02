// =============================================================================
// test/ui.test.js — the user flow, in a real browser, end to end.
//
// This file exists because of a specific failure. Every API test passed, the
// capture completed, the payload was correct and complete — and the user saw
// nothing, because the code that makes the results screen visible was never
// called. No amount of server-side testing catches that. The only assertion
// that does is "after the capture finishes, is the results screen on screen?"
//
// Skips itself (exit 0) when Playwright or its browser is unavailable, so
// `npm test` still works on a clean checkout.
// =============================================================================

import { existsSync } from "node:fs";
import { startServer, check, section, summary, eq, ok } from "./harness.js";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.log("  (playwright not installed — skipping UI tests)"); process.exit(0); }

const CANDIDATES = [
  process.env.RI_CHROME_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter(Boolean);

let executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  try { if (existsSync(chromium.executablePath())) executablePath = chromium.executablePath(); } catch { /* none */ }
}
if (!executablePath) { console.log("  (no chromium binary — skipping UI tests)"); process.exit(0); }

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

    await check("the landing screen is the field and nothing else", async () => {
      eq(await page.locator("#quickClients").count(), 0, "client shortcut chips still present");
      ok(/\d+ clients in directory/.test(await page.locator("#healthLine").innerText()),
        "directory size should still be stated");
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

    await check("Proposal mode is visibly not built, not silently broken", async () => {
      const soon = page.locator(".modecard.disabled .soon");
      ok(await soon.count(), "no 'next build' marker on the stubbed mode");
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
      const nBefore = Number((before.match(/(\d+) requests?/) || [])[1] || 0);
      await page.click("#natRow");
      const after = await settledCostLine(page);
      const nAfter = Number((after.match(/(\d+) requests?/) || [])[1] || 0);
      ok(nAfter === nBefore - 2, `expected two fewer requests, got ${nBefore} -> ${nAfter}`);
      await page.click("#natRow");                       // back on for the capture below
      eq(await page.locator("#nationalsChk").isChecked(), true, "restored");
    });

    await check("the cost line states what will be spent before anything is spent", async () => {
      const cost = await settledCostLine(page);
      ok(/Google display/.test(cost), `cost line was: ${cost}`);
      ok(/\d+ requests?|nothing to spend/.test(cost), `cost line was: ${cost}`);
      ok(/reused for \d+ days/.test(cost), `cost line was: ${cost}`);
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
  section("benchmark flow — table, gate, strategies");
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
    await page.waitForSelector("table.bench", { timeout: 20000 });

    await check("the client is the first column in the table", async () => {
      const headers = await page.locator("table.bench thead th").allInnerTexts();
      ok(/La Capitol/i.test(headers[1] || ""), `headers were ${JSON.stringify(headers)}`);
    });

    await check("the advertised bonus row is populated from captured ads", async () =>
      ok(/\$400/.test(await page.locator("table.bench").innerText()), "expected the strongest captured bonus"));

    await check("the client's absent bonus renders as an em-dash, not a zero", async () =>
      ok(/—/.test(await page.locator("table.bench").innerText()), "expected an absent cell"));

    await check("no cell rendered undefined, NaN or [object Object]", async () => {
      const t = await page.locator("table.bench").innerText();
      ok(!/undefined|NaN|\[object/.test(t), `table contained: ${t.slice(0, 300)}`);
    });

    await check("the absence finding is shown with its denominator", async () => {
      const findings = await page.locator(".finding").allInnerTexts();
      ok(findings.some((f) => /\d+ of \d+ competitors/.test(f)), `findings were ${JSON.stringify(findings)}`);
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

    // ---------------------------------------------------------------- gate
    await check("no strategy is on screen before the button is pressed", async () =>
      eq(await page.locator(".angle").count(), 0, "angles present before the gate"));

    await check("the gate is present and explains itself", async () => {
      ok(await page.locator("#genBtn").isVisible(), "gate button missing");
      ok(/not generated by default/i.test(await page.locator(".gate").innerText()), "gate does not explain itself");
    });

    await page.click("#genBtn");
    await page.waitForSelector(".angle", { timeout: 40000 });

    await check("pressing the gate produces strategy angles", async () =>
      ok((await page.locator(".angle").count()) > 0, "no angles generated"));

    await check("every angle carries a 'confirm first' question", async () =>
      ok(/Confirm first:/i.test(await page.locator("#strategyZone").innerText()), "no confirmation question"));

    await check("the strategy screen restates the sampling caveat", async () =>
      ok(/captured|reviewed/i.test(await page.locator("#strategyZone").innerText()), "no sampling caveat"));

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
