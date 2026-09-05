# RAIN Intelligence

Competitive advertising evidence for RAIN. Two halves, one capture set.

```
npm install
cp .env.example .env      # SERPAPI_API_KEY + ANTHROPIC_API_KEY
npm run dev               # :3000 — reads .env

npm test                  # 196 tests — logic, pipeline, whole API, failure paths
npm run test:ui           # more, in a real browser (see Testing below)
```

`npm run dev` loads `.env` through Node's own `--env-file`; `npm start` does
not, deliberately — in production the platform injects real environment
variables and a `.env` file should not exist. Nothing here bundles dotenv, so
running `npm start` locally after filling in `.env` will start a server with no
keys at all and report every source as unconfigured.

Without `SERPAPI_API_KEY` nothing can be captured; without `ANTHROPIC_API_KEY`
creatives are retrieved but never read. `/api/health` reports both. `/api/health` reports availability per source.

---

## The two modes

**Creative Inspiration** — *"What are competitors making?"*
Captures **Google image creatives** (`creative_format=image`). Called *image*, not
*display*: `creative_format` filters on what the creative IS, and the provider has
no DISPLAY value in its platform enum, so nothing in the response says an image
creative served on the Display Network. The source KEY stays `google_display`
because it is written into every cache filename and every snapshot. Groups near-identical
executions into ideas and shows longevity; collapses
DCO cards into distinct messages. Chosen on the competitor screen, before
anything is spent.

Every Google display capture also includes **two standing national
benchmarks** — J.P. Morgan Chase and Capital One — appended without the user
selecting them, mirroring RAIN's six-column analysis where slots 4 and 5 never
change. See *The national tier* below.

**Campaign Benchmark** — *"How did our ads compare to theirs?"*
Captures `creative_format=text` for the client **and** every competitor over the
same window, then puts them side by side. Ads against ads. Google search only —
the source is pinned server-side, so a caller cannot change what the table is
comparing.

**Proposal Evidence** is stubbed in the UI and not built. It needs live
competitor discovery for prospects who are not in the directory, which is a
genuinely different problem from the two above.

---

## The national tier

Local institutions run very little display. A three-competitor capture can come
back with under ten cards after clustering, which reads as a broken tool rather
than a thin market.

So **Chase and Capital One are in every Google display capture**, appended
automatically. This mirrors how RAIN's competitor analysis has always worked:
slots 1–3 answer *"who actually takes our customers"* and are picked per
subject; slots 4–5 answer *"how do we compare to the ceiling"* and never change.
They are not there because they compete with a Baton Rouge credit union — they
almost never do.

**They are shared, not re-bought.** The capture cache is keyed on
`(source, domain, window)` rather than on the client, so one Chase capture
serves every analysis. TTL is 30 days rather than 7, and the read cap is 30
rather than 18 — the cost is paid once a month and amortised across every
client, which is exactly why reading *more* of them is the right call.

**They are tiered, never merged.** A community bank contributes four cards while
Chase contributes forty. Interleaved by volume, the screen becomes a Chase
screen and the local evidence — the part the strategist was actually asked
about — sits below the fold. Solving an empty wall by burying the local signal
is not solving it. So the wall renders **Local and regional** first, then
**National benchmarks** under a divider, and when the local set is thin the page
says so rather than letting the national section stand in for a market read.

**Scope.** Google display only. Benchmark is excluded because a national ceiling
in that table would sit in a column the client reads as a peer. **One prerequisite this exposed.** Clustering was keyed on
`[headline, offer, product]` with no advertiser, so two banks running the same
generic line collapsed into a single card credited to whichever ran longer. That
is invisible with three local competitors and severe once national copy is in
the mix — generic national headlines overlap with everyone. The key is now
advertiser-scoped, and a test holds it there.

---

## Sources are not filters

`google_display` and `google_search` never share a wall, a denominator,
a longevity column, a cache entry or a run diff.

Selecting **Both** creates **two runs**, not one run holding two kinds of record.
That is deliberate and load-bearing. Google's `totalDaysShown` is a
provider-supplied count of days served, and it means something different on
each surface.
Concatenating the two produces a column that is sometimes one measurement and
sometimes another with no way for a reader to tell which — and the front end
keeps one state tree per source so a filter chosen on one wall cannot silently
apply to the other's data.

`[...displayAds, ...searchAds]` is a bug even when it typechecks.

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

**Google (SerpApi)** — 1 credit per advertiser per capture. 3 competitors = 3
credits; Benchmark adds 1 for the client. Free tier is 250/month.

**The capture cache is the main saving.** Keyed on `(source, domain, window)`
and deliberately **not** on product, because capture is product-agnostic — one
capture of a competitor serves every product scope the team tests that week. If
three of four competitors are cached, one request is spent, and the cost line on
the competitor screen says so before anyone commits. Default TTL 7 days, which
is roughly one compliance-approval cycle. **Re-analyze** and **Force fresh
capture** both bypass it.

**Vision is not the constraint; provider requests are.** Two mechanisms keep it
that way:

- **Google** — byte-identical creatives collapse *before* extraction. On the
  recorded fixture that was 17 duplicates reduced to 1 vision call. Extractions
  then cache forever on `creativeId`, because a creative's pixels never change.


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
lib/sources.js           the three sources, their windows, and what each mode may capture
lib/atc-provider.js      Google adapter · capture record · selection · byte dedupe · domain links
lib/capture-cache.js     per-advertiser capture cache + the pre-spend cost plan
lib/extract.js           vision for BANNER creatives, and the format dispatcher
lib/analyze.js           every Google number · clustering · benchmark · findings
lib/strategies.js        the gated interpretation pass
lib/directory.js         RAIN's 40 curated clients (carried over)
lib/products.js          the 12-code taxonomy (must stay in sync with the SEM tool)
lib/store.js             run snapshots + extraction cache + source-aware diffing

docs/UI-SPEC.md       full UI + copy specification, written to be handed to a reviewer

test/fixture-lab.js   a synthetic Google market: 8 advertisers, distinct pixels, known answers
test/mock-net.js      preload that puts that market under the REAL server
test/harness.js       server runner + assertions
test/*.test.js        see Testing
```

Provider responses die at the normalizer. Every commercial ad-library source is
a reverse-engineered scraper — there is no official Google API for commercial
---

## Why a capture of 55 can show 2

Because six things happen between "listed by Google" and "on the wall", and each
one is legitimate:

```
listed by Google        what the provider says exists for this domain and window
  -> retrieved          one page of results; `num` is capped at 100
  -> readable image     the rest are preview-only JS links with no image to read
  -> selected to read   the RI_MAX_READ cap, because vision is priced per creative
  -> read               minus duplicate artwork, failed downloads, unreadable creatives
  -> on the product     minus everything classified as a different product
```

The results screen shows this chain as a strip, with a "Why the drop?" expander
naming what was lost at each step. Every figure comes from the capture-run
records in `analyze.js#captureFunnel`, so the chain always reconciles.

The last step is the one that surprises people. **Most display banners carry no
product signal at all** — a creative that says "Bank With Us" classifies as
`other`, and that is the correct answer. So the product scope is a DEFAULT
FILTER, never a gate: every captured creative is in the payload and reachable
from a chip, and the chips count over the whole capture rather than the current
slice.

---

## Testing

`npm test` runs 157 assertions with **no API keys, no network and no browser**.
`npm run test:ui` adds 52 more that drive the real UI in Chromium.

| file | what it covers |
| --- | --- |
| `smoke.test.js` | pure logic — clustering, phrasing, product bucketing |
| `pipeline.test.js` | the recorded SerpApi fixture through the provider layer |
| `flow.test.js` | every endpoint, driven the way the UI drives it |
| `degraded.test.js` | quota, bad key, timeout, unreadable creatives, blocked CDN, SSRF |
| `nationals.test.js` | the standing tier — injection, sharing, tiering, and scope |
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

## Moving the cache between environments

`RI_DATA_DIR` is portable by construction. Nothing under it stores an absolute
path, a hostname or a port, and no key encodes the machine that wrote it — so
the directory can be copied from a laptop to a Render disk to an S3-backed
volume and every entry is a hit. **No SerpApi request and no vision call is
repeated at any hop.** Roughly 18 MB after a few runs, most of it the evidence
archive.

```bash
# localhost -> a Render disk
scp -r runs/* srv-xxxx@ssh.oregon.render.com:/var/data/

# a Render disk -> S3
aws s3 sync /var/data s3://rain-intelligence-cache/
```

What each layer costs to lose:

| | rebuildable? |
|---|---|
| `_captures` | yes, at SerpApi's price |
| `_extractions` | yes, at Anthropic's price |
| `_snapshots`, `_evidence`, `run_*.json` | **no** — a new capture returns today's ads |

`manifest.json` records the schema the directory was written under. A cache from
an older build is not dangerous: extractions carry their reader VERSION in the
filename (`CR123.search-v2.json`), so entries written by a different prompt miss
rather than mislead, and the first run re-reads them. The startup line says which
schema it found.
