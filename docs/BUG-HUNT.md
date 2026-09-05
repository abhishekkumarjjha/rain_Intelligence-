# RAIN Intelligence — Bug Hunt

A work order for an agent with **no context from the session that wrote it**. Everything
needed to start is in this file. Read all of §0–§3 before touching code.

- **Repo**: `abhishekkumarjjha/rain_Intelligence-`
- **Start from**: branch `benchmark-v4-truncation-and-set-shape` (open PR #6 → `main`)
- **Work on**: a new branch off that one, named `bughunt/<phase>` (e.g. `bughunt/phase-0`)
- **Hand back**: see §11. The reporting contract is not optional — the results of this
  work are diffed and audited by another agent, and a fix with no evidence attached
  cannot be reviewed.

---

## 0. Mission, and the one rule

Find and fix real bugs. The owner reports that **every real run surfaces a new problem
while 273 assertions stay green**, which is the central fact about this codebase: the
test suite proves the arithmetic is right *given* a correct model read, and most of the
damage happens before that.

**The rule the whole product is built on:**

> Every number is a count of **what was captured**, never a claim about a product.

"Not observed in 3 competitors' captured ads" is true. "They don't offer it" is false,
and it would be a bank's agency telling a client something untrue in front of that
client's own competitors. Most bugs in this repo have been one sentence quietly crossing
that line. If a fix makes a sentence stronger than its evidence, the fix is wrong.

**Fail closed.** When a scope, product or comparison cannot be established, refuse it.
Never fall back to "other", never silently widen, never rank two things that carry
different qualifiers.

---

## 1. Orientation

Node + Express, ES modules, **zero devDependencies**, flat-file persistence, runs locally.

Two products over one capture pipeline:

| | source | question |
|---|---|---|
| **Competitive Intelligence** ("benchmark") | Google **search** ads | "How did our ads compare?" — findings board + benchmark table |
| **The Wall of Creatives** ("creative") | Google **display** ads | "What are competitors making?" |

```
lib/findings.js        the deterministic findings engine — this file is the product
lib/observations.js    THE GATE between model proposals and counted facts  ← read this
lib/metrics.js         metric registry: unit, direction, comparability
lib/profiles.js        per-product comparison profile (which metrics/claims count)
lib/benchmark.js       the snapshot table that audits the board
lib/primary-read.js    the one sentence at the top (no model)
lib/set-shape.js       "what this set is competing on" (no model)
lib/channel-shape.js   counted set-level observations (no model)
lib/extract.js         VISION read of display creatives (Haiku)
lib/extract-search.js  read of search ads (Haiku)
lib/themes.js          Key insights — the only model-written prose on the Wall
lib/atc-provider.js    SerpApi Google Ads Transparency Center
lib/national-tier.js   Chase + Capital One, the standing national reference
lib/capture-cache.js   per-advertiser capture cache
lib/store.js           runs, evidence, extractions, snapshots on disk
lib/rate-page.js       opt-in current-rate page read (display-only figures)
public/app.js          the entire front end, one file
public/index.html      screens: landing → mode → competitors → run → results
```

### Running it

```bash
npm install
npm test          # 7 suites, ~273 assertions, NO API KEYS NEEDED (test/mock-net.js stubs both providers)
npm run test:ui   # Playwright — currently prints "not installed — skipping" and EXITS 0
npm run dev       # needs a real .env with SERPAPI_API_KEY and ANTHROPIC_API_KEY
```

`npm test` needs no keys and no network. It spawns the server with
`node --import ./test/mock-net.js server.js`, which fakes SerpApi and Anthropic and
injects placeholder keys. **You can do almost all of this work with no credentials.**

### Traps that have cost hours

- **On Windows `pkill -f "node server.js"` does not kill the process.** It exits 0, the
  old server keeps port 3000, the new one fails to bind silently, and you test stale
  code. Use `Get-Process node | Stop-Process -Force` (PowerShell).
- Data lives under `./runs` (override with `RI_DATA_DIR`), gitignored. Caches there are
  portable — copy the folder and the cache comes with it.
- Line endings are CRLF in the working tree. Do not reformat files.

---

## 2. Doctrine you must not break

These are not style preferences. Each was paid for with a client-facing mistake.

1. **Counted, not written.** A model may propose structure and cluster language. It may
   never emit a number, a denominator, or a set-level takeaway. `themes.js` drops any
   finding containing a digit *or a number written in words*, and that is deliberate.
2. **The model proposes, `observations.js` decides.** Validation happens in code *after*
   the model answers, never by asking the prompt nicely.
3. **Nationals (Chase, Capital One) are a reference ceiling.** They are excluded from
   every local denominator, because we cannot tell from the Transparency Center whether
   their ads served in a given market.
4. **The client is a third population** on the Wall — captured, but out of every
   competitor tier, chip, cluster, denominator, funnel step and sampling note.
5. **The product chosen on the landing page is the scope.** Filter chips on the results
   screen are a *view*; they never change what is read or counted.
6. **A sentence that was accurate can stop being accurate.** When you change what
   something counts, grep the prose. A caveat once said nationals were "not counted in
   any finding" — true until national findings existed.
7. **Colour**: amber/yellow means caution and nothing else; periwinkle `#B9A7F5` is
   emphasis. A metric label in amber reads as a problem.
8. **Money**: SerpApi credits and model calls are real spend. See §10.

Commit messages in this repo carry reasoning — what broke, why, and what the fix
protects. Match that register. Do not write "fix bug".

---

## 3. The bug patterns this codebase actually produces

Hunt these, not generic QA categories. Each has already bitten at least once.

| # | Pattern | Evidence it has happened |
|---|---|---|
| **P1** | **Two meanings, one return value.** A function returns `null`/`false`/`"other"` for several different reasons and the caller picks one sentence. | `readThemes` returned `null` for "thin set", "model unreachable" and "nothing survived" → users told to widen a window that was fine |
| **P2** | **An identifier crossing a boundary unverified.** model↔code, cache↔reader, payload↔DOM↔payload. Resolves to nothing, silently; the result merely looks empty. | The model was asked to echo back 22-char creative ids (`CR01145745112471437313`) as evidence. One wrong digit dropped the finding; enough of them dropped the entire answer, and a wall of 14 legible designs reported "nothing recurring". |
| **P3** | **A cache key missing a dimension that changes the answer.** | A `_captures` entry stores the ads it *read*, not the listing it read them from, so raising the read cap was invisible until `run.readCap` was recorded in the key comparison. |
| **P4** | **Population leakage** — something enters a denominator it does not belong in. | nationals in local counts; unreadable competitors counted as a "no"; the client's own listings adjacent to every wall figure |
| **P5** | **Prose that went stale.** A sentence true when written. | see doctrine #6 |
| **P6** | **UI state outliving its run.** | two landing entry paths both live with separate product scopes; filters set once and never reset |
| **P7** | **Payload/renderer drift.** The client assumes a field the server stopped sending. | `themes` absent from the GET payload → every reopen re-billed a model call; a chip rendered "undefined advertisers" |
| **P8** | **Last-write-wins.** Two writers, one file, no locking. | see H14 |

---

## 4. Already verified — do NOT spend time re-confirming

These were checked against the code on 2026-09-04 at commit `37ca25a`. Treat as given.

| Finding | Status |
|---|---|
| `/api/rate-pages` fetches arbitrary user-supplied URLs with **no host validation** (no loopback / private-IP / metadata / redirect / size guards), while `/api/img` has a strict allowlist *and tests* for exactly those cases | confirmed |
| `observations.js` never checks that a fact's `raw` string appears in the transcribed ad text. Only `retype()` reads `allText`, and only for the loan-amount case | confirmed |
| `productConfidence` is computed and clamped by both extractors and **read by nothing** | confirmed |
| `saveRun()` returns `false` on failure and logs; **no call site checks the return value** | confirmed |
| `ACTIVE` map: three `.set`, zero `.delete` | confirmed |
| Concurrency is per-advertiser (6, capped 12) inside `extractCreatives`; `server.js` runs all targets in parallel → **targets × 6** model calls in flight (~30 typical, ~78 with ten competitors). No global ceiling | confirmed |
| The cost line quotes SerpApi requests and cache hits only — **fresh vision reads and theme calls are never quoted** | confirmed |
| `/api/run/:id/strategies` is removed from the UI but still routed, still generating, still billing | confirmed |
| `startCapture()` in `public/app.js` has no try/catch; a failed POST leaves the capture button permanently disabled | confirmed |
| `/api/health` reports key presence only — green with unwritable or full storage | confirmed |
| `npm audit`: 3 moderate (`qs` → `body-parser` → `express`), fix available | confirmed |
| `npm run test:ui` exits **0** while running no browser tests | confirmed |

**Known and deliberate — do not "fix" these:**
- The **Re-analyze button is greyed out on purpose** at the owner's request. Leave it.
- No authentication. This runs locally for demos. Do **not** add auth unless §9 is
  explicitly enabled for you.
- `lib/strategies.js` and `lib/industry-context.js` are orphaned. Deleting `strategies.js`
  is in scope (F-004); `industry-context.js` may be deleted with it if nothing references it.
- Pagination is not implemented (`num: 100`, no `next_page_token`). Known gap, tracked
  in §8 H20 — do not implement it without approval, it changes spend.

---

## 5. PHASE 0 — close the verified holes

One commit per item, each with a regression test that fails before and passes after.
Use the finding ids below verbatim so the report maps to commits.

### F-001 · Ground every fact to the transcribed text · **blocker** · `lib/observations.js`
A model returns `{metric:"apy", raw:"5.55% APY"}`. Nothing verifies that `"5.55% APY"`
appears anywhere in the ad's transcribed headline, description, sitelinks or `allText`.
An invented or hallucinated figure passes every existing gate and becomes a brand's
advertised position.

This is the same defect class as the citation bug already fixed in `themes.js` (P2) —
a model-supplied string that nothing checks against reality. `observations.js` describes
itself as "the gate between what a model PROPOSED and what the findings engine is allowed
to COUNT"; grounding is that file's own stated job and it is not doing it.

- Add a grounding check: the fact's `raw` (normalised — whitespace, unicode `…`, `%`/`$`
  spacing, curly quotes) must be findable in the concatenated source text.
- **Ungrounded ≠ deleted.** Follow the file's existing idiom: keep it as evidence, mark
  it, exclude it from counting. A `grounded:false` fact must never enter `positions`,
  never be rankable, never appear in a denominator.
- Do the same for `claims[]` — a claim's `verbatim` must appear in the ad text.
- Apply to the **display** extractor path too (`lib/extract.js` output), not just search.
- Tests: a grounded fact counts; an invented fact is kept, marked and never counted;
  a fact grounded only in a *different* ad of the same brand does not count.

### F-002 · Honour `productConfidence` · **high** · `lib/analyze.js` / `lib/observations.js`
A creative classified `auto-loan` at 0.1 confidence enters the auto-loan denominator
identically to one at 0.95.

- Pick a threshold, state it in a comment with the reasoning, and make low-confidence
  creatives **visible but uncounted** — the same treatment as a clipped figure.
- The funnel and the product chips must still show them (they were captured), so
  reconciliation cannot break. Verify `captureFunnel` still adds up.
- Test: a low-confidence creative is reachable on the wall and absent from every count.

### F-003 · SSRF-guard `/api/rate-pages` · **blocker** · `server.js`, `lib/rate-page.js`
Reuse the exact guard `/api/img` already has, and its test cases.
- https only; hostname must resolve outside loopback, link-local (`169.254.0.0/16`),
  private ranges (RFC1918), IPv6 loopback/ULA, and `metadata.google.internal`.
- Block redirects to anything failing the same check (`redirect: "manual"`, re-validate).
- Cap response size and time.
- Tests mirroring the existing image-proxy suite in `test/degraded.test.js`.

### F-004 · Delete the dead paid endpoint · **medium** · `server.js`
`/api/run/:id/strategies` still generates and bills. Remove the route, the import, the
dead client call in `public/app.js`, and `lib/strategies.js`. Keep the tests that assert
it is refused only if you keep the route — otherwise delete them and say so in the report.

### F-005 · Durable, checked persistence · **high** · `lib/store.js` + call sites
- Atomic write: temp file + `renameSync`.
- `saveRun` already returns a boolean nobody reads. Either check it at every call site
  and mark the run degraded, or throw and have the caller decide — but the user must
  never be told a run completed when nothing was written.
- Surface it: a `persisted:false` flag on the payload and one sentence in the UI.
- Test: make the data dir unwritable mid-run; the run must report degraded, not success.

### F-006 · `ACTIVE` grows without bound · **high** · `server.js`
Completed runs are never evicted. Add eviction (age or LRU cap) that does not break
`loadRun` fallback. Test that a run evicted from memory still loads from disk identically.

### F-007 · Parallel scope reads lose a scope · **high** · `server.js` themes endpoint
Opening Key insights fires two POSTs at once (`all` + the run's product). If the run is
not in `ACTIVE`, each handler `loadRun()`s a **separate object**, writes its own scope
into `themesByScope`, and `saveRun()`s. Last write wins; one scope is lost from disk and
re-billed on next open.
- Fix with single-flight per `runId` (an in-flight promise map) or read-modify-write
  under a per-run lock.
- Test: two concurrent POSTs for different scopes, server restarted between save and
  read, both scopes present on disk.

### F-008 · Global model-call ceiling · **high** · `server.js` / `lib/extract.js`
Per-advertiser concurrency is 6; targets run in parallel. Add a process-wide semaphore
across all model calls (vision + analysis). Make the limit configurable
(`RI_MODEL_CONCURRENCY`, default 8) and record the observed peak in the run record.

### F-009 · The cost line must quote model spend · **high** · `server.js` `/api/cost`, `public/app.js`
It currently quotes SerpApi requests and cache hits only. The quote must separately state:
SerpApi requests, **fresh vision reads** (creatives not in `_extractions` for the current
reader version), cached extractions, and whether `force` bypasses each cache.
- The Key insights panel already says "one model call per product"; make the capture
  screen equally explicit.
- Test: quote versus actual for creative/benchmark × nationals on/off × force on/off ×
  client cached/not. The quote must never under-count.

### F-010 · `startCapture()` error handling · **medium** · `public/app.js`
Wrap the POST; on failure re-enable the button and show the failure. Today the button
stays disabled forever and the error is unhandled.

### F-011 · Real readiness check · **medium** · `server.js` `/api/health`
Report storage writability and free space alongside key presence. A green health line
with an unwritable `RI_DATA_DIR` is a lie.

### F-012 · `npm audit fix` · **low**
3 moderate (`qs`/`body-parser`/`express`). Run it, confirm `npm test` still passes,
commit the lockfile change separately.

### F-013 · Single-creative re-read · **medium** · `lib/store.js`, `server.js`
Today a wrong extraction is cached until the **reader version** bumps, which invalidates
*every* extraction. Add a way to force re-reading one `creativeId`. This is the
cheapest half of a human-correction workflow and it unblocks the golden corpus.

### F-014 · "Display ads" vs "image creatives" · **medium** · prose audit
SerpApi returns *image creatives*; the UI calls them *display ads*. Establish whether the
provider's `creative_format: image` actually means the ad served on the display network.
If it does not, every "display" label is a claim the data does not support (P5). Report
the finding; change the wording only if the evidence says so.

---

## 6. PHASE 1 — semantic accuracy and the golden corpus

**This is the highest-value phase.** Existing tests begin *after* the model returned a
perfect structured answer, because the fixture decides what the model returns. They prove
"if the read is right, the arithmetic is right". They cannot catch a wrong read, and a
wrong read is what the owner sees on every live run.

### Build the corpus

- Source: `runs/_evidence` already holds **real creatives as base64** — no network, no
  SerpApi, no re-capture needed to assemble. `runs/_extractions` holds what the model
  said about each.
- Target ~60 creatives, spread across every supported product and both formats
  (search text, display image).
- Store as `test/corpus/<id>.json`: the creative reference, the source text/image ref,
  and a **human-verified expected label**.

### Label schema (per creative)

```jsonc
{
  "creativeId": "CR...", "source": "google_search|google_display",
  "advertiser": "chase.com",
  "expect": {
    "product": "checking", "productConfidenceAtLeast": 0.6,
    "facts": [{ "metric": "apy", "raw": "5.55% APY", "value": 5.55,
                "qualifiers": { "term_months": 12 }, "complete": true, "rankable": true }],
    "claims": ["no_monthly_fee"],
    "truncated": false, "legible": true
  },
  "notes": "why a human says so"
}
```

### Cases that must be represented

The traps below are all real; several already have scar tissue in `observations.js`.

1. **Rate discount vs APR** — "0.65% off your rate" must not become a 0.65% auto loan.
2. **Loan amount vs cash bonus** — "borrow up to $30,000" is not a $30,000 bonus.
3. **Financing percent vs down payment** — "up to 100% financing" is not a deposit.
4. **Add-on price vs account fee** — "$5.99/month with BaZing" is not the monthly fee.
5. **Clipped figures** — "Earn Up To 5.5…" where the real ad reads "5.55% APY".
6. **Adjectives as figures** — "Low APR", "Great Rates" must never become a rate position.
7. **Institution identity as strategy** — "Federal Credit Union" is not member-owned positioning.
8. **One mechanic, two names** — "No Payments For 60 Days" must produce one claim, not two.
9. **Multiple offers in one ad** — both survive, neither cannibalises the other.
10. **Multi-product ads** — must not silently enter one product's findings.
11. **Generic ads** — "Bank With Us" must be `other`, at low confidence.
12. **Cross-product figure** — a savings APY quoted inside a checking ad is evidence, not
    a checking rate position.
13. **Unreadable / preview-only / Transparency-Center chrome** — must be excluded and counted.

### How to run it

- A corpus runner that replays each creative through the **real** extractor prompt and
  diffs against the expected label, reporting per-field accuracy.
- Replaying costs **one Haiku vision call per creative**. Do not run it without the
  approval described in §10. Build the corpus and the runner first; report the exact
  call count you would need.
- Add every wrong client-facing result the owner has ever reported as a permanent case.
- A finding should be permitted only when product, fact and evidence all pass grounding
  (F-001) and confidence (F-002).

---

## 7. PHASE 2 — browser CI that cannot silently pass

`test/ui.test.js` is written, kept current, and **has never run**. Every bug the owner
found by hand this week was UI-shaped: options rendering grey, two entry paths open at
once, a modal behind a modal, a panel that closed itself.

- Install Playwright as the repo's **first and only devDependency**. Keep it in
  `devDependencies`; production install must stay clean.
- `npm run test:ui` must **fail** when the browser is unavailable, never skip with exit 0.
  Keep a separate opt-in escape hatch (`RI_SKIP_UI=1`) for the local no-browser case.
- CI job: install Chromium, run `npm test` and the browser suite, upload screenshots,
  console logs and traces on failure, block merge unless both pass.

### Journey tests (one browser context, state must not leak between steps)

1. Analysis A → "New analysis" → Analysis B — **filters, product scope and cached themes
   from A must not appear in B**.
2. Checking → auto loan → credit card, back to back.
3. Wall → Key insights → evidence drawer → close → another scope → client's own ads.
4. Search wall → filter → back → reopen.
5. Add a competitor → re-capture.
6. Refresh mid-capture.
7. Double-click every button that spends money.
8. Browser back/forward.
9. Two tabs open on the same run.
10. 1366×768 (the common screen-share size) and 1280×720.

---

## 8. PHASE 3 — hypothesis hunt

Named, falsifiable suspects. Report each as confirmed, not-reproducible, or
already-correct — **negative results are results and must appear in the report.**

**Front-end state (P6)**
- **H1** `S.productFilter` / `S.filter` are set only when `null`. Run one analysis then
  another in the same session: does the second open under the first one's filter? Same
  question for `SW.product` / `SW.brand` on the search wall, and across source-tab switches.
- **H2** Modal stacking: sheet ↔ evidence drawer ↔ client wall. Does Escape close the
  right one? Does the drawer render above the sheet in every combination?

**Benchmark / search side — least covered, owner reports bugs here**
- **H3** Board vs table disagreement. Two aggregations over the same ads; this exact
  class already produced 4.84% in a finding and 6.74% in the table below it. Assert
  cell-for-cell agreement over adversarial fixtures, not just the happy path.
- **H4** An unreadable competitor must be excluded from a denominator, never counted as
  a "no". Assert for **every** finding type, the set shape, the primary read and the
  snapshot diff — not just the two currently covered.
- **H5** Nationals must never enter a local denominator. Same sweep as H4.
- **H6** Comparability refusals (CD terms, balance caps, add-on vs account fee): does
  every refusal reach the UI **with its reason**, or does a cell go silently blank?
- **H7** Snapshots: change the competitor set, or the window, between runs. "Newly
  observed" must never be manufactured by adding a competitor.
- **H8** Client column empty (client ran no search ads): do all client-gap findings
  suppress, everywhere?

**Wall / display side**
- **H9** Clustering is advertiser-scoped so a national cannot absorb a local card. The
  `client` tier is new — verify a client design cannot absorb, or be absorbed by, a
  competitor's.
- **H10** Funnel reconciliation with the client excluded, verified on a client that
  actually has captured ads (current fixtures have none).
- **H11** Preview-only, download-failed and extraction-failed creatives leave every
  count consistent.

**Key insights**
- **H12** Migration of an old `run.themes` into the right scope slot, including runs
  whose saved read was a general fallback.
- **H13** The scope switcher offers a product whose designs are all unreadable — you pay
  a model call to discover it was empty.
- **H14** *(now F-007)*.
- **H15** Client designs are included in the themes read, so `creativesRead` and the
  framing sentence ("across the 17 distinct designs") now include them. Is that still an
  honest *competitor* count?

**Cache (P3)**
- **H16** The same domain as a client in one run and a competitor in another shares one
  capture-cache entry. `isClient`/`tier` are stripped on write and re-applied per target —
  verify no client framing survives into a competitor's replay.
- **H17** Window (`days`) changes: 30 vs 60 vs 90 must be separate keys; snapshot
  comparability across differing windows.
- **H18** Extraction cache keyed on `creativeId + reader version`: verify a search
  reader can never consume a display extraction (this bug has happened).
- **H19** National TTL (90d) outrunning the client's window — the age note must appear
  exactly when it should.
- **H20** Pagination: one page of `num:100` against ~4,000 listed for Chase. Any
  *absence* claim about a national is sampling-dependent. Audit every sentence that
  leans on national absence and confirm it is phrased as "not observed in what was
  captured". **Do not implement pagination** — report the exposure.

**Cross-cutting invariant sweeps — cheapest, highest yield**

Run over **every** payload and **every** rendered panel, not per-feature:
1. No user-facing string contains `undefined`, `null`, `NaN`, `[object Object]`. (Such a
   test exists for the board only; a chip rendering "undefined advertisers" got through.)
2. Every evidence id resolves to an ad in that run.
3. Every number carries a denominator or a unit.
4. Every finding names the population it was counted over.
5. No sentence asserts a product fact — regex sweep for "does not offer", "doesn't have",
   "no longer runs", and similar.

**Adversarial fixtures** (extend `test/fixture-lab.js`): zero ads; exactly one ad; all
preview-only; duplicate creative ids; missing headline; 200-character headline; unicode
and RTL; absurd counts; every competitor failing; one competitor returning 500 ads.

---

## 9. PHASE 4 — deployment-conditional. **DISABLED unless told otherwise.**

Only start this if the work order explicitly says deployment is in scope. As of writing
the app runs locally for demos, so "no authentication" means "no listener on a network",
not a vulnerability. If it is going on Render or AWS with a URL, all of the following
become blockers: authentication on every route; per-user authorization to runs and
evidence; rate limits and a monthly provider budget; CSRF / same-origin protection on
paid POST routes; security headers; retention and disk-capacity policy; structured logs
with run ids and provider usage totals; and a decision about single-writer persistence —
the flat-file design is **not** safe across multiple app instances.

---

## 10. Rules of engagement

- **Do not spend money without explicit written approval.** The owner's standing
  instruction is: *"confirm the costs and when I say build, only then build."*
  - `npm test` and everything in §5, §7, §8 costs **nothing** (mocks).
  - Phase 1 corpus **assembly** costs nothing. Corpus **replay** costs one Haiku vision
    call per creative — quote the exact number and wait.
  - **No live SerpApi calls at all** without approval. Each is a paid credit.
- **Do not** add dependencies other than Playwright (dev only).
- **Do not** reformat, re-indent, or rewrite the doctrine comments. They are load-bearing
  documentation of past failures. Extend them; do not tidy them.
- **Do not** widen scope: no refactors, no renames, no "while I was here" changes.
- **Do not** weaken a rule to make a test pass. If a rule looks wrong, report it as a
  finding with your reasoning and leave the rule in place.
- One commit per finding. Message convention:
  `F-00N: <what broke, in the repo's voice>` with a body explaining why it matters.
- `npm test` must pass at every commit.

---

## 11. REQUIRED DELIVERABLES — the reporting contract

Everything below is diffed and audited by another agent that has **no visibility into
your session**. A fix without its evidence cannot be reviewed and will be reverted.

Create a `bughunt/` directory at the repo root:

```
bughunt/
  REPORT.md            human-readable narrative — what you found, what you fixed, what you could not
  findings.json        structured, machine-diffable (schema below)
  logs/
    00-baseline-test.txt        full `npm test` output BEFORE any change
    01-npm-audit-before.txt
    02-<F-00N>-before.txt       failing test output for each finding, before the fix
    03-<F-00N>-after.txt        the same test passing after
    90-final-test.txt           full `npm test` output AFTER all changes
    91-npm-audit-after.txt
    92-playwright.txt           browser suite output, or the exact error if unavailable
    99-commands.txt             every command you ran, in order, with exit codes
  corpus/                       Phase 1 only: the labelled creatives and the runner's diff output
```

### `findings.json`

```jsonc
{
  "generatedAt": "2026-09-05T00:00:00Z",
  "baseCommit": "37ca25a",
  "branch": "bughunt/phase-0",
  "node": "v24.19.0",
  "suites": {
    "before": { "assertions": 273, "failed": 0 },
    "after":  { "assertions": 0,   "failed": 0 }
  },
  "findings": [
    {
      "id": "F-001",
      "phase": 0,
      "severity": "blocker|high|medium|low",
      "pattern": "P2",
      "title": "one line",
      "file": "lib/observations.js",
      "line": 142,
      "status": "fixed|not-fixed|not-reproducible|already-correct|wontfix",
      "clientFacing": true,
      "repro": "exact command or click sequence",
      "evidence": "the actual output that proves it, quoted",
      "rootCause": "why it happens, not what happens",
      "fix": "what you changed and why that is the right place for it",
      "riskOfFix": "what could regress",
      "testAdded": "test/flow.test.js :: 'a fact not in the ad text is never counted'",
      "commit": "abc1234"
    }
  ],
  "notAttempted": [{ "id": "H20", "why": "would change spend; needs approval" }],
  "newSuspicions": [{ "title": "", "file": "", "why": "" }]
}
```

### `REPORT.md` must contain

1. **Summary** — findings by severity, how many fixed, assertions before/after.
2. **Per finding**: the `findings.json` fields written out readably, with the diff
   hunk for the fix.
3. **Negative results** — every hypothesis in §8 you tested and found already correct.
   These are as valuable as the bugs; without them the next agent re-tests everything.
4. **What you did not do, and why.**
5. **New suspicions** you did not have time to chase — file, line, and the reason you
   are suspicious.
6. **Anything in this document that turned out to be wrong.** This plan was written from
   one session's understanding; if a claim in §4 does not hold, say so plainly.

### Hand back

- Push your branch, or supply `git format-patch` output if you cannot push.
- Include `git log --oneline <base>..HEAD` and `git diff --stat <base>..HEAD` in the report.
- Do **not** merge to `main` or to `benchmark-v4-truncation-and-set-shape`.

---

## 12. Suggested order

1. Read §0–§4. Run `npm test`, capture `logs/00-baseline-test.txt`.
2. **Phase 0** (§5) — F-001 and F-007 first; they are the two most likely to be
   producing wrong client-facing output right now.
3. **Phase 3 invariant sweeps** (§8, "cross-cutting") — cheapest bugs per hour.
4. **Phase 2** (§7) if Playwright is approved.
5. **Phase 1** (§6) — build corpus and runner, quote the replay cost, wait for approval.
6. **Phase 3 hypotheses** (§8) in the listed order.
7. Phase 4 only if enabled.

Report as you go. A finding raised on day one is worth more than a perfect report on day five.
