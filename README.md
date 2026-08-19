# RAIN Intelligence

Competitive advertising evidence for RAIN. Two modes over one capture pipeline.

```
npm install
cp .env.example .env      # add SERPAPI_API_KEY and ANTHROPIC_API_KEY
npm start                 # :3000

npm test                  # 88 tests — logic, pipeline, whole API, failure paths
npm run test:ui           # 46 more, in a real browser (see Testing below)
```

---

## The two modes

**Creative Inspiration** — *"What are competitors making?"*
Captures `creative_format=image` (display creatives). Groups near-identical
executions into single ideas, filters to the product, ranks by what is running
now with longevity shown as a badge.

**Campaign Benchmark** — *"How did our ads compare to theirs?"*
Captures `creative_format=text` for the client **and** every competitor over the
same window, then puts them side by side. Ads against ads.

**Proposal Evidence** is stubbed in the UI and not built. It needs live
competitor discovery for prospects who are not in the directory, which is a
genuinely different problem from the two above.

---

## Why the benchmark reads ads and not rate pages

The client's number comes from the client's own ads, captured through the
identical provider call, format and date window as every competitor's.

That is the point. A live rate page is current, states the term and states the
minimum; a competitor's banner creative may be three weeks old and print a
figure alone. Putting those in one table and calling it facts is the failure
this design exists to avoid.

It is also the *right* comparison for the question being asked. Someone clicking
a search ad never sees the term sheet — they see "$400 bonus" next to "$300
bonus" and choose. So when the question is *why did our ad underperform*, the
advertised offer is the correct unit.

The claim supported is deliberately narrow: **"over this window, in the ads we
captured, competitors advertised X and the client advertised Y."** Not
"competitors offer X" (their live product may differ) and not "the client's
product is worse" (the client's inference to draw, not RAIN's to state).

---

## Hard rules encoded in the code

**Every number is computed in `lib/analyze.js`.** No model counts anything, ever.
The strategy pass is handed pre-counted facts and is instructed never to emit a
digit. The first time a strategist checks a count and finds it invented, nothing
else in the tool is believed again — and this output goes in front of clients.

**`totalDaysShown` is days served, not a contiguous run.** The phrasing is fixed
in code so no caller can shorten it: *"shown on 1,169 days since Jun 2023"*.
Never "running continuously for 3 years", never "their best-performing ad" —
there is no performance data in this dataset at all.

**Sampling is stated, always.** One domain returned ~2,000 image creatives
against a retrieval ceiling of 100, so image captures are essentially always a
sample. `samplingNote()` decides whether the UI may say "the longest-running ad
**we captured**" or "**their** longest-running ad". Those are different claims.

**Institution ≠ advertiser.** MidFirst Bank's ads are verified under *Fogarty and
Klein, Inc.* The entered domain owns the ad; the verified advertiser is a
separate field, surfaced in the evidence drawer. A domain returning multiple
advertiser accounts is flagged in the capture progress, never silently merged.

**Absence is a first-class finding, scoped to the capture.** *"2 of 2 competitors
advertised a cash bonus. Lookout did not."* — with the denominator, and with the
ads behind it one click away.

**Strategies are gated.** The table is the deliverable. Recommendations are a
button a strategist chooses to press, and every angle comes back with a
*"confirm first"* question rather than an assertion about the client, because
this tool captured their ads, not their product set.

---

## Cost model

- **1 SerpApi credit per advertiser per capture.** 3 competitors = 3 credits.
  Benchmark adds 1 for the client. Free tier is 250/month.
- **1 vision call per creative read**, capped by `RI_MAX_READ` (default 18).
  At Haiku rates on banner-sized creatives this is roughly a tenth of a cent
  each — vision is not the constraint, provider credits are.
- **Extractions cache forever on `creativeId`.** A creative's pixels never
  change, so its transcription is bought once across the lifetime of the system.
- **Byte-identical creatives collapse before extraction.** On the recorded
  fixture that was 17 duplicates reduced to 1 vision call.

---

## Verify before trusting Creative mode

`creative_format=image` with `platform` unset is the **one call shape not yet
confirmed against the live API.** The recorded fixture is text creatives. Two
things to check on the first real run:

1. **What fraction of image creatives return a usable `image` URL** versus a
   `displayads-formats.googleusercontent.com` preview link. The fixture already
   contains one preview-only creative; that ratio is likely much worse for
   image formats. The capture progress line reports it per advertiser.
2. ~~**Whether `simgad` images render cross-origin.**~~ **Handled.** The wall no
   longer hotlinks Google's CDN — creative images are served through
   `GET /api/img`, same-origin, on a strict four-host allowlist. The direct URL
   is still tried as a fallback before a card is marked unloadable, so a working
   CDN costs nothing and a blocked one is invisible to the user.

Also worth one check on a domain RAIN manages: **who does Google list as the
verified advertiser?** If it is RAIN rather than the bank, the agency-attribution
path is pointed at your own book of business.

---

## Layout

```
lib/atc-provider.js   provider adapter · capture-run record · selection · dedupe
lib/extract.js        vision transcription for BANNER creatives (not the SEM grid prompt)
lib/analyze.js        every number in the app · clustering · benchmark · findings
lib/strategies.js     the gated interpretation pass
lib/directory.js      RAIN's 40 curated clients (carried over)
lib/products.js       the 12-code taxonomy (carried over — must stay in sync with the SEM tool)
lib/store.js          run snapshots + extraction cache + creativeId diffing

test/fixture-lab.js   a synthetic market: 8 advertisers, distinct pixels, known answers
test/mock-net.js      preload that puts that market under the REAL server
test/harness.js       server runner + assertions
test/*.test.js        see Testing
```

Provider responses die at the normalizer. Every commercial Transparency Center
source is a reverse-engineered scraper, so swapping SerpApi for SearchApi (or
adding Meta) should be a new file in the provider layer and nothing else.

---

## Testing

`npm test` runs 88 assertions with **no API keys, no network and no browser**.
`npm run test:ui` adds 46 more that drive the real UI in Chromium.

| file | what it covers |
| --- | --- |
| `smoke.test.js` | pure logic — clustering, phrasing, product bucketing |
| `pipeline.test.js` | the recorded SerpApi fixture through the provider layer |
| `flow.test.js` | every endpoint, driven the way the UI drives it |
| `degraded.test.js` | quota, bad key, timeout, unreadable creatives, blocked CDN, SSRF |
| `ui.test.js` | the user flow in a browser, landing to strategies |

### How the offline tests work

`test/mock-net.js` is a `--import` preload, so the **real** `server.js`, the
**real** provider adapter and the **real** Anthropic SDK all run unmodified —
only the socket underneath them is fake. A test that stubs `lib/` modules proves
the stubs work; this proves the app does.

Two interception points, because the two clients differ. The provider adapter
calls global `fetch`, which is replaced in-process. The Anthropic SDK binds
`node-fetch` at module load and never consults global `fetch`, so it cannot be
stubbed at all — it is pointed at a loopback HTTP server via
`ANTHROPIC_BASE_URL` instead, which has the side benefit of exercising the real
request path.

The fake market in `test/fixture-lab.js` gives every creative **distinct pixels**
and a **known** headline, offer and product. The recorded fixture cannot do this:
all 21 of its creatives share one 1×1 png, so they collapse to a single vision
call — perfect for testing dedupe, useless for testing any count downstream.

Failure injection is by environment variable, so the unhappy paths need no code
changes: `RI_MOCK_FAIL=quota|auth`, `RI_MOCK_FAIL_DOMAIN=`, `RI_MOCK_VISION_FAIL=1`,
`RI_MOCK_IMG_403=1`.

### Why the browser pass exists

A capture completed, the payload was correct and complete, every server-side
assertion passed — and the user saw nothing, because the results screen was
rendered into a hidden section and never made visible. They sat on "Capturing"
watching finished progress rows.

No amount of API testing catches that. The only assertion that does is *after
the capture finishes, is the results screen on screen?* — so that is now the
loudest test in the file, along with checks that no card renders `undefined`,
that longevity never reads as a continuous run, and that no uncaught exception
reaches the console anywhere in the flow.

Playwright is deliberately **not** a dependency — `npm install` stays small and
`ui.test.js` exits 0 when it is missing. To run it:

```
npm i -D playwright && npx playwright install chromium
npm run test:ui
npm run shots ./shots     # screenshots of every screen
```
