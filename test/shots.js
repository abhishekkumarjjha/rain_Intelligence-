// Drives the app and writes screenshots of every screen. Not part of `npm test`
// — this is for looking at the thing.  node test/shots.js [outDir]
import { existsSync, mkdirSync } from "node:fs";
import { startServer } from "./harness.js";
import { chromium } from "playwright";

const OUT = process.argv[2] || "./shots";
mkdirSync(OUT, { recursive: true });

const exe = [process.env.RI_CHROME_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"].filter(Boolean).find((p) => existsSync(p))
  || chromium.executablePath();

const S = await startServer();
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

const shot = async (name, opts = {}) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log(`  ${OUT}/${name}.png`);
};

async function pick(want) {
  const rows = page.locator("#compList .comprow");
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    if (await row.locator(".tag.client").count()) continue;
    const d = (await row.locator(".dm").innerText()).trim();
    const on = (await row.getAttribute("class")).includes("on");
    if (on !== want.includes(d)) await row.click();
  }
}

await page.goto(`${S.base}/`, { waitUntil: "networkidle" });
await shot("1-landing");

await page.waitForFunction(() => document.querySelectorAll("#landProductSel option").length > 1);
await page.fill("#clientInput", "capitol");
await page.click("#clientMenu .acitem");
await page.selectOption("#landProductSel", "checking");
await page.click("#goBtn");
await page.waitForSelector("#s-mode.active");
await shot("2-mode");

await page.click('.modecard[data-mode="creative"]');
await page.waitForSelector("#s-comp.active");
await pick(["campusfederal.org", "neighborsfcu.org"]);
await shot("3-competitors");

await page.click("#captureBtn");
await page.waitForSelector("#s-results.active", { timeout: 60000 });
await page.waitForSelector(".wall .adcard");
await page.waitForTimeout(1500);
await shot("4-creative-wall", { fullPage: true });

await page.locator(".wall .adcard .shot").first().click();
await page.waitForSelector("#drawer.on");
await shot("5-evidence-drawer");
await page.keyboard.press("Escape");

await page.goto(`${S.base}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll("#landProductSel option").length > 1);
await page.fill("#clientInput", "capitol");
await page.click("#clientMenu .acitem");
await page.selectOption("#landProductSel", "checking");
await page.click("#goBtn");
await page.waitForSelector("#s-mode.active");
await page.click('.modecard[data-mode="benchmark"]');
await page.waitForSelector("#s-comp.active");
await pick(["campusfederal.org", "neighborsfcu.org"]);
await page.click("#captureBtn");
await page.waitForSelector("table.bench", { timeout: 60000 });
await shot("6-benchmark", { fullPage: true });

await browser.close();
S.stop();
