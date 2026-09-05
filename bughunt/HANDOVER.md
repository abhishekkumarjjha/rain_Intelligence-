# RAIN Intelligence — bug hunt: handover for review

**For the session that wrote `docs/BUG-HUNT.md`.** This is the whole of the work,
where it lives, what to check, and what I could not do. Read §1 and §9; the rest
is reference.

---

## 0. In one paragraph

I worked the bug hunt against `benchmark-v4-truncation-and-set-shape` at
**7010b4e**. I checked 35 things: **22 were real bugs and all 22 are fixed**, 13
came back clean and now have a regression test each. Test coverage went 273 → 466
API assertions, plus 88 browser assertions from a suite that **had never executed
once**, plus a 142-field corpus. `npm audit` went 3 moderate → 0. **Nothing was
spent** — no SerpApi credit, no model call, no API key present in the
environment. Four claims in the work order did not hold and are documented in §7.
The one thing I could not do is the Phase 1 *read* pass: it needs real creatives
from `runs/`, which is gitignored and therefore empty in a clone.

---

## 1. Where everything is

**Repository** `https://github.com/abhishekkumarjjha/rain_Intelligence-`
**Branch** `bughunt/phase-0` — **pushed**, 25 commits
**Head** the tip of `bughunt/phase-0` — no sha printed here, because a file
cannot honestly contain the hash of the commit that adds it
**Base** `7010b4e` — the tip of `benchmark-v4-truncation-and-set-shape`

```bash
git fetch origin
git checkout bughunt/phase-0
git log --oneline 7010b4e..HEAD          # 25 commits, one per finding
git diff --stat 7010b4e..HEAD            # ~113 files; app code is 18 of them
```

Branch base, verified rather than asserted:

```
$ git merge-base --is-ancestor origin/benchmark-v4-truncation-and-set-shape HEAD
  YES — bughunt/phase-0 contains all of benchmark-v4-truncation-and-set-shape
$ git branch -r
  origin/benchmark-v4-truncation-and-set-shape
  origin/bughunt/phase-0        ← origin/main was never fetched into this container
```

**Not merged to `main`. Not merged to `benchmark-v4-truncation-and-set-shape`.
No pull request opened.**

### The reporting contract, all of it, in the repo

| path | what it is |
|---|---|
| `bughunt/REPORT.md` | the narrative report — every finding with its diff hunk and reasoning |
| `bughunt/findings.json` | 37 structured entries (22 fixed + 13 clean + 2 cross-refs), 3 blocked, 8 new suspicions |
| `bughunt/HANDOVER.md` | this file |
| `bughunt/logs/` | 47 files — baseline, before/after per finding, final runs, command log |
| `bughunt/corpus/` | the 14 labelled trap cases + README + runner output |

**Evidence for every fix is a before-log and an after-log**, e.g.
`bughunt/logs/02-F-020-before.txt` (failing) and `03-F-020-after.txt` (passing).
Four findings have no separate after-log because their proof is a whole-suite
run: F-010/F-015/F-016 → `92-playwright.txt`, F-012 → `91-npm-audit-after.txt`.

Two defects are proved by **runnable probes**, not quoted output:

```bash
node bughunt/logs/f008-concurrency-probe.mjs     # peak model calls in flight
node bughunt/logs/f017-primary-read-probe.mjs    # the primary read, printed
```

---

## 2. The numbers

| | before | after |
|---|---|---|
| API assertions (`npm test`) | 273 | **466** |
| Browser assertions (`npm run test:ui`) | 0 — *the suite exited 0 without running* | **88** |
| Corpus fields (`test/corpus-runner.js`) | 0 | **142** |
| `npm audit` | 3 moderate | **0** |
| failures | 0 | **0** |

`npm test` passes at **every** commit. The browser suite passes at every commit
except `3c46e4a`, where two assertions still matched the cost line's old wording;
`00727ec` is the fix. Stated because an auditor checking out that commit would
find it and be right to.

---

## 3. Every fix

Severity is mine, pattern refers to §3 of the work order.

| id | sev | pat | file | what was wrong | commit |
|---|---|---|---|---|---|
| **F-001** | blocker | P2 | `lib/observations.js` | A model-returned figure was never checked against the ad's own transcription. An invented rate became the brand's advertised position and was ranked against the client. | `e16e763` |
| **F-002** | high | P4 | `lib/analyze.js` | `productConfidence` computed, clamped, stored — read by nothing. A creative scored 0.15 put "1.99% APR" into the snapshot. | `d85b3f7` |
| **F-003** | blocker | P2 | `lib/rate-page.js` | `/api/rate-pages` fetched any URL. Probe: loopback hits **1** before, **0** after. | `e956178` |
| **F-004** | medium | P5 | `server.js` | The strategy route was removed from the UI months ago and still generated and billed. | `01e4868` |
| **F-005** | high | P8 | `lib/store.js` | `saveRun()` returned a boolean no call site read. A run could finish, be paid for, save nothing, report success. | `ad581d1` |
| **F-006** | high | P6 | `server.js` | `ACTIVE` had three `.set` calls and no `.delete`. | `7751e59` |
| **F-007** | high | P8 | `server.js` | Two concurrent theme scopes; last write wins; one scope lost from disk and re-billed. | `099a0d9` |
| **F-008** | high | P4 | `lib/claude.js` | No process-wide model-call ceiling. Probe: peak in flight **40** before, **8** after. | `0afbb46` |
| **F-009** | high | P3 | `server.js` | The cost line quoted SerpApi only, silent about up to 30 vision reads per advertiser. | `3c46e4a`, `00727ec` |
| **F-010** | medium | P6 | `public/app.js` | `startCapture()` had no `try/catch`; a failed POST disabled the only button forever. | `8e338cf` |
| **F-011** | medium | P5 | `server.js` | `/api/health` reported `ok: true` over an unwritable data directory. | `55d091a` |
| **F-012** | low | P5 | `package.json` | 3 moderate advisories with **no reachable fix**; pinned explicitly. | `9ee0121` |
| **F-013** | medium | P3 | `lib/store.js` | A wrong transcription was permanent until the whole cache was retired. | `2b05458` |
| **F-014** | medium | P5 | `lib/sources.js` | "Display ads" was a claim about a delivery network built out of a filter on artwork type. | `e2c3749` |
| **F-015** | high | P6 | `public/app.js` | The client dropdown covers "Use a landing page instead"; clicking it silently picks a client. | `8e338cf` |
| **F-016** | high | P6 | `public/app.js` | Wall filters outlived their run (**H1 confirmed**). Second wall rendered zero cards. | `8e338cf` |
| **F-017** | blocker | P1 | `lib/primary-read.js` | The top sentence contradicted the card beneath it, and merged a national count into a local clause. | `6fd3ad7` |
| **F-018** | medium | P1 | `lib/observations.js` | An add-on's price was marked `rankable` at fact level. | `b0bb18d` |
| **F-019** | high | P4 | `lib/themes.js` | Key insights framing counted the client among the competitors (**H15**). | `100dcad` |
| **F-020** | blocker | P3 | `lib/snapshot.js` | A 30-day snapshot was offered as the previous of a 90-day run (**H17**). | `302f736` |
| **F-021** | high | P1 | `lib/atc-provider.js` | A failed artwork download read as a competitor who is not advertising. | `7523411` |
| **F-022** | medium | P7 | `server.js` | The national age caveat appends to a field that is never produced — **it has never once fired**. | `7523411` |

### The six that were producing wrong client-facing output *right now*

1. **F-001** — an invented figure became a competitor's advertised rate.
2. **F-017** — *"Client CU holds the strongest advertised APY of the 4 comparable
   local competitors captured"* over a set where **no competitor printed an APY**,
   with the client counted as the fourth. The card directly beneath said *"Only
   Client CU shows APY in the captured set."*
3. **F-002** — a read scored 0.15 confidence supplied a competitor's rate.
4. **F-020** — *"Pelican State CU's cash bonus of $750 is newly observed since the
   September 2026 benchmark."* Nothing was newly observed; the window widened.
5. **F-021** — a CDN refusing us artwork rendered as a competitor not advertising.
6. **F-022** — the opposite: a **true** caveat that could never be said.

All six are one failure in different clothes: **a sentence stronger than its
evidence** — except F-022, which is a sentence weaker than the evidence demanded.

---

## 4. What came back clean

**13 hypotheses tested and found already correct.** Each now has a regression
test, so nobody re-derives them.

| id | what it checks | note |
|---|---|---|
| H1 (search half) | `SW.product`/`SW.brand` leak between runs | reset unconditionally on every open. Only the *display* wall leaked → F-016 |
| H2 | modal stacking; Escape closes the wrong one | drawer z-index above the results screen; Escape leaves the wall intact |
| H3 | board vs table disagreement | table reads the board's own rollup. Asserted **cell-for-cell over 6 adversarial fixtures** |
| H4 | an unreadable competitor counted as a "no" | correct in findings, set shape, snapshot, coverage. The primary read was the exception → F-017 |
| H5 | nationals in a local denominator | same — **failed only in the primary read** → F-017 |
| H6 | a comparability refusal goes silently blank | reason travels in words; figures still shown; no blank cells |
| H8 | client column empty; client-gap findings suppress | `allowClientGapFindings` false, `empty.kind = no_client_ads` |
| H9 | a client design absorbs a competitor's | two cards in **both** directions; a national cannot absorb a local |
| H10 | the wall's funnel double-counts the client | verified at last on a client that *has* ads |
| H11 | preview-only + download-failed + extraction-failed | arithmetic closes in all three, including at zero |
| H12 | old themes migrate to the wrong scope slot | written to disk pre-scope, read back through the real endpoint |
| H13 | an empty scope costs a model call to discover | decided *before* the call |
| H16 | a shared cache entry carries client framing | stripped on write, re-applied per target — **nothing had tested it** |
| H17 | 30/60/90 share a cache key | `cacheKey` hashes days. *Snapshot* comparability did not → F-020 |
| H18 | a search reader consumes a display extraction | reader family + version in the cache path |

### Cross-cutting sweeps — all clean

Over **three whole run payloads**, walking every string with its path:

- no `undefined`, `NaN`, `[object Object]`, or bare `null` in any user-facing string
- **no sentence asserts a product fact**, anywhere
- every evidence id resolves to an ad in the same run
- every finding names its population; every counted figure has a denominator or unit
- F-001 and F-002 hold across the sweep, not just at their own tests

---

## 5. Application code touched — the review surface

Tests and `bughunt/` are additive. **This is what actually ships:**

| file | lines | what changed |
|---|---|---|
| `server.js` | +459/−? | LRU eviction + `getRun`, per-run write lock + single-flight, `persist()` at every save, storage health, model-spend quote, re-read route, F-022 caveat relocation, funnel `counted` step |
| `lib/rate-page.js` | +222 | the SSRF guard (the largest single addition) |
| `lib/observations.js` | +156 | grounding, and `scopedToAddOn` in `rankable` |
| `lib/store.js` | +124 | atomic writes, `storageHealth()`, `forgetCachedExtraction()` |
| `public/app.js` | +205/−? | capture error handling, filter reset, empty-query menu, cost line, persistence warning, health line, wording |
| `lib/claude.js` | +61 | the process-wide semaphore |
| `lib/analyze.js` | +63 | confidence floor, `confident` filter option, funnel step |
| `lib/snapshot.js` | +47 | window in the comparability gate |
| `lib/themes.js` | +38 | competitor-scoped design count |
| `lib/primary-read.js` | +30 | sole-advertiser wording, national scope filter |
| `lib/extract.js` | +27 | display-offer grounding, `shape` exported |
| `lib/sources.js` | +25 | labels, with the reasoning |
| `lib/atc-provider.js` | +20 | empty-capture reason |
| `lib/findings.js` | +17 | `sole` flag, grounded evidence lookup |
| `lib/benchmark.js` | +5 | the confident scope |
| `lib/channel-shape.js` | +4 | wording |
| `public/index.html` | +11 | persistence warning element, wording |
| `lib/strategies.js` | **−149** | **deleted** |
| `.github/workflows/test.yml` | +58 | **new** — both suites, Chromium, artefacts on failure |

**Deliberately not changed**, each with reasoning in a commit message:

- `google_display` — the **source key** stays. It is in every cache filename,
  every `run.source` and every snapshot. Renaming it invalidates the cache and
  re-buys the captures: a spend decision, not a wording one.
- **Model prompts** — untouched. They describe the picture to a reader, and
  editing one bumps the reader version, retiring every extraction in the cache.
- `lib/industry-context.js` — kept though §4 permits deleting it. The doctrine
  comment at `set-shape.js:26` names it. The orphan is cheaper than the lie.
- The greyed-out **Re-analyze** button — left alone, as instructed.

---

## 6. Risk register — where to look hardest

Ranked by what I would review first.

1. **F-001 grounding is the widest blast radius.** If a legitimate figure's form
   differs from its transcription it is now refused. Mitigated by normalising
   unicode, curly quotes, ellipsis and whitespace plus a whitespace-stripped
   second pass — but this is the one change that can make a *true* figure vanish.
   **Two fixtures in `benchmark.test.js` encoded reads that could not have
   happened** and I corrected them; check I corrected them honestly.
2. **F-002's 0.5 floor is a judgement call.** 0.5 is where both shapers park a
   missing confidence, so the gate refuses only an *actively* unsure read. If
   real reads cluster near 0.5, this discards more than intended.
3. **F-012's `qs` override forces a version outside `~6.15.1`.** If `body-parser`
   depends on 6.15-specific behaviour, this is where it breaks. First thing to
   remove when express ships a 4.x pinning a patched `qs`.
4. **F-020 costs a delta for one cycle** for any client who changes window. That
   is correct — the captures are not comparable — but it will be noticed.
5. **F-014 and F-019 changed user-facing wording.** Read them as prose, not code.
6. **F-003 has a known residual**, recorded not hidden: DNS rebinding between
   resolve and fetch. Closing it needs connecting by address with an explicit
   `Host` header, which `fetch()` does not offer.

---

## 7. Where the work order was wrong

§11 asks for this. Four claims did not hold.

1. **§5 F-003 — "Reuse the exact guard `/api/img` already has."** You cannot.
   The image proxy is a four-host allowlist; a rate page is an arbitrary public
   host. The *test cases* transfer; the guard does not.
2. **§4 — "npm audit: 3 moderate … fix available — confirmed."** The advisories
   are real; the fix is **not reachable**. `express` and `body-parser` both pin
   `qs` at `~6.15.1` and the patch is 6.16.0. `npm audit fix` exits 0 having
   changed nothing.
3. **§6 — "runs/_evidence already holds real creatives … no re-capture needed."**
   True on your machine. **False in a clone** — `runs/` is gitignored, so
   `_evidence` and `_extractions` are empty directories. This is the single
   blocker on Phase 1.
4. **§7 — "test/ui.test.js is written, kept current, and has never run."**
   Written and never run, yes. **Not kept current** — and it could not have been:
   a suite that cannot fail cannot go stale loudly. It drove `#genBtn`/`.gate`/
   `.angle` (removed months ago), waited on `table.bench` being visible (it moved
   behind a disclosure), asked after a Proposal mode card that is not in the HTML,
   and carried a results-screen assertion inside the landing-screen section.

Two smaller notes. §4 says `/api/health` "reports key presence only" — correct,
and it also returned `ok: true` unconditionally, which is what made it a lie
rather than merely incomplete. And §4 understates `saveRun()`: it had **four**
call sites, none of which read the return value.

---

## 8. What is still open

### Blocked on you — 1

**The Phase 1 corpus read pass.** Built and ready; cannot run here.

- `test/corpus/` holds **14 entries, one per trap named in §6** — rate discount
  vs APR, loan amount vs cash bonus, financing percent vs down payment, add-on
  price vs account fee, clipped figure, adjective as figure, institution identity,
  one mechanic two names, two offers one ad, cross-product figure, multi-product,
  generic ad, ungrounded figure, and Transparency Center chrome.
- The **gate pass is free and already in `npm test`** — it replays
  `modelAnswer → shape → observations.js` and diffs against the expected
  *counted* facts. Nine of the fourteen are cases where the model's answer is
  **correct** and the engine must do something other than count it. It already
  caught F-018 on its first run.
- The **read pass costs one Haiku vision call per creative** and refuses to run
  without `RI_CORPUS_APPROVED=1`.
- **The quoted cost today is 0 calls, and that is the finding:**

```
    corpus entries                  14
    with a creative attached        0
    entries awaiting evidence       14
    VISION CALLS A FULL REPLAY WOULD MAKE:  0
```

**To unblock:** on a machine whose `runs/_evidence` holds the creatives, rename
each entry's `creativeId` to the provider id of the creative that shows that
trap, then:

```bash
node test/corpus-runner.js --attach     # links entries to real creatives
npm run corpus:cost                     # prints the exact call count
RI_CORPUS_APPROVED=1 npm run corpus -- --read   # only after approving that count
```

At the §6 target of ~60 creatives that is **60 vision calls per pass** — at the
~⅓ ¢ per creative recorded in `atc-provider.js`, roughly **$0.20 a pass**. The
corpus is at 14, not 60; the remaining ~46 need that disk.

### Out of scope by instruction — 2

- **H20 pagination** — §4 says do not implement; it changes spend. **Exposure
  audited instead:** every sentence leaning on national absence already reads as
  an observation about the capture (`channel-shape.js:179`, the snapshot's absent
  cells, the national row's context line). The cross-cutting sweep now checks
  this automatically.
- **Phase 4 (deployment security)** — disabled. Untouched.

Nothing else in §8 remains untested.

---

## 9. Suggested review order

1. **`bughunt/REPORT.md` §2** — the per-finding write-ups with diff hunks.
2. **The four blockers**, in this order — they are the ones with client-facing
   consequences: `e16e763` (F-001), `6fd3ad7` (F-017), `302f736` (F-020),
   `e956178` (F-003).
3. **The wording changes** — `e2c3749` (F-014) and `100dcad` (F-019). Read as
   prose. Ask whether "image creatives" is the right noun and whether *"read
   alongside 2 of La Capitol's own"* is the right disclosure.
4. **The two judgement calls I would most like overruled if I am wrong** —
   F-002's 0.5 confidence floor, and F-012's `qs` override.
5. **`bughunt/findings.json` → `newSuspicions`** — 8 things I did not chase.
   The three I would take first:
   - `lib/store.js:173` — `findPreviousRun()` **still does not gate on the
     window**. F-020 fixed `previousSnapshot()`, which feeds the board;
     `findPreviousRun()` feeds the run-diff strip and has the same defect.
   - `server.js:255` — the vision-read upper bound is very loose on a cold cache
     ("up to 380"). It never under-counts, but a quote a strategist learns to
     ignore has stopped working.
   - `lib/store.js:200` — `prune()` exists, is documented as "only ever called
     explicitly", and **nothing calls it**. F-006 bounded memory; disk is still
     unbounded.
6. **`bughunt/logs/99-commands.txt`** — every command in order with exit codes,
   including the three false starts on F-020 where my own test filter was
   silently passing everything.

### Reproduce

```bash
git checkout bughunt/phase-0
npm install            # playwright is the only devDependency; production stays clean
npm test               # 466 assertions + 142 corpus fields. No keys, no network.
npm run test:ui        # 88 browser assertions. Fails loudly if it cannot run.
npm run corpus:cost    # what a corpus read pass would cost
npm audit              # 0
```

---

## 10. Honest limits of this work

- **No live API call was made.** Every test runs against `test/mock-net.js`. This
  is real testing of the arithmetic, the plumbing and the UI — it is **not** a
  test of whether the model reads a real ad correctly. That gap is exactly what
  the Phase 1 read pass exists to close, and it is still open.
- **The corpus is 14 entries, not the ~60 §6 asks for.** Every *trap* is
  represented; the volume is not.
- **Severity ratings are mine.** I had no access to client impact history beyond
  what the work order records.
- **The fixture market now has exactly one row (`PEL3`) that distinguishes two
  windows.** That is thin for a dimension which interacts with product scope and
  the national tier.
- **I did not verify the fixes against a real capture**, because I could not run
  one. Every fix is verified against a failing-then-passing test.
