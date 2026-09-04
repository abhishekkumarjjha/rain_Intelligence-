# RAIN Intelligence — bug hunt

Branch `bughunt/phase-0`, off `benchmark-v4-truncation-and-set-shape` at **7010b4e**.
Node v22.22.2. Nothing was spent: no SerpApi call, no model call, no key.

---

## 1. Summary

| | before | after |
|---|---|---|
| API assertions (`npm test`) | 273 | **411** |
| Browser assertions (`npm run test:ui`) | 0 — *the suite exited 0 without running* | **88** |
| Corpus fields (`test/corpus-runner.js`) | 0 | **142** |
| `npm audit` | 3 moderate | **0** |
| failures | 0 | **0** |

**19 findings, 17 fixed, 2 already-correct-but-now-guarded**, plus 8 hypotheses
tested and found correct and 10 not attempted with reasons.

| severity | fixed | already correct |
|---|---|---|
| blocker | F-001, F-003, F-017 | H4, H16 |
| high | F-002, F-005, F-006, F-007, F-008, F-009, F-015, F-016, F-019, H5 | H3, H8, H18 |
| medium | F-004, F-010, F-011, F-013, F-014, F-018 | H2, H13, H17 |
| low | F-012 | — |

Everything the work order listed as Phase 0 (§5) is done. Phase 2 (§7) is done and
found three real bugs on its first run. Phase 3's cross-cutting sweeps (§8) are
done and found one blocker. Phase 1 (§6) is built and its cost quoted; the read
pass is blocked on approval **and on evidence that does not exist in a clone** —
see §6 below. Phase 4 is disabled and untouched.

### The three that were producing wrong client-facing output right now

1. **F-001** — a model could return a rate that appears nowhere in the ad and it
   became the brand's advertised position, was ranked against the client, and
   was printed in a report.
2. **F-017** — the primary read said *"Client CU holds the strongest advertised
   APY of the 4 comparable local competitors captured"* over a set where **no
   competitor printed an APY at all**, with the client counted as the fourth
   competitor. The card directly beneath it said *"Only Client CU shows APY in
   the captured set."* Same sentence also merged the national reference count
   into a clause headed "Where competitors differ".
3. **F-002** — a creative the reader itself scored at 0.15 confidence put
   "1.99% APR" into the offer snapshot as a competitor's advertised auto-loan
   rate.

All three are the same failure in different clothes: **a sentence stronger than
its evidence.**

---

## 2. Findings

Full structured records are in `findings.json`. Below: the diff hunk and the
reasoning for each. Every finding has a before-log and an after-log in
`bughunt/logs/`.

---

### F-001 · blocker · P2 · `lib/observations.js`
**A figure a model returned was never checked against the ad it read**

`observations.js` opens by describing itself as *"the gate between what a model
PROPOSED and what the findings engine is allowed to COUNT"*. It gated the metric
registry, the product profile, completeness and rankability. It never asked
whether the string was on screen.

```diff
+    // GROUNDED IN THIS AD, not in the brand and not in the run. A figure the
+    // transcription does not contain was not observed, whatever the model
+    // filed it as.
+    const grounded = isGrounded(f.raw, source);
     facts.push({
       ...
-      rankable: complete && Number.isFinite(value) && isRankableMetric(f.metric),
+      grounded,
+      rankable: grounded && complete && Number.isFinite(value) && isRankableMetric(f.metric),
```

Grounding is **per creative, never per brand**. One of Comp G's ads printing a
rate is not evidence that a second, rate-free ad printed it, and the brand rollup
counts ads — letting one ad vouch for another is how one real figure becomes two.

Ungrounded facts are **kept, marked and excluded**, following the file's own
idiom. They live in their own `ungrounded` map rather than in `partial`, because
`partial` renders as *"A figure was advertised here, but the ad text was clipped
before it could be read in full"* — a statement about the capture that would be
false. The two gates stay independent: `"Up To 5.5…"` **is** grounded and is
still refused, for being clipped, which is the refusal that carries the right
sentence to the snapshot cell.

Claims get the same treatment: the board prints the verbatim in quotation marks
next to the count, so an unquotable claim puts an invented sentence inside
quotation marks in a client's report. The display path is grounded in
`extract.js` by withholding `offer.numeric`, which is the single gate that
`strongestOffer()`, the wall's offer counts and the cluster key all read.

**Two fixtures in `benchmark.test.js` encoded reads that could not have
happened** — a 3.75% APY extracted from a description printing no rate, and an
`early_direct_deposit` claim quoting a sentence the description does not contain.
Corrected to transcribe what they extract. That is the work order's thesis in
miniature: the suite begins after a perfect model answer, so a fixture can
describe a read reality cannot produce and nothing notices.

`riskOfFix`: a genuine figure whose form differs could be refused. Mitigated by
normalising unicode, curly quotes, ellipsis and whitespace, plus a
whitespace-stripped second pass.

---

### F-017 · blocker · P1 · `lib/primary-read.js`
**The one sentence at the top contradicted the card beneath it**

Found by widening H4/H5 from the two findings they each covered to **all five
places a board carries a denominator**. Two defects:

```diff
-  const pressure = findings.filter((f) => f.outcome === "pressure" && f.metric !== rate);
+  const pressure = findings.filter((f) =>
+    f.outcome === "pressure" && f.metric !== rate && f.scope !== "national");
```

```diff
+  } else if (onRate.outcome === "lead" && onRate.sole) {
+    headline = `${client.label} advertised ${clientFigure?.raw || soften(rateLabel)}; `
+      + `${soften(rateLabel)} was not observed in ${nOf(D, "competitor")}' captured ads, `
+      + `so there is nothing to rank it against.`;
   } else if (onRate.outcome === "lead") {
```

**P1 exactly**: `denominator` means *comparable competitors* in the ranked branch
and *brands including the client* in the sole branch, and `primary-read.js` read
every finding as the first. `findings.js` now says `sole: true` rather than
leaving it to be inferred from arithmetic.

The national leak is worse than an arithmetic slip because **this same file
states the rule it broke**, twenty lines below the defect: *"The two must never
merge into one sentence… Kept in its own clause, always attributed."* It was
applied to `localVsNational` and not to `differences`, which then rendered
`cash bonus (3 of 3), no monthly fee (3 of 3) and cash bonus (2 of 2)` — the same
metric twice, one population national and unlabelled, with the national fact
restated correctly in the very next line.

The one exception is stated rather than swallowed: `participation` counts over
the **selected** set on purpose, and says "selected" in so many words.

---

### F-002 · high · P4 · `lib/analyze.js`
**The reader said it was unsure and the board counted it anyway**

```diff
+export const PRODUCT_CONFIDENCE_FLOOR = 0.5;
+export function confidentlyClassified(ad) {
+  const c = ad?.productConfidence;
+  return typeof c !== "number" || c >= PRODUCT_CONFIDENCE_FLOOR;
+}
-export function filterByProduct(ads, product, { includeAdjacent = false } = {}) {
+export function filterByProduct(ads, product, { includeAdjacent = false, confident = false } = {}) {
```

The floor is **chosen, not picked**: 0.5 is exactly where both shapers park a
read that returned no confidence at all, so the gate refuses only a read the
model *actively* marked as unsure and never one that merely omitted the field. A
higher floor would silently discard cached extractions written before the field
was populated — the cache-shape failure this repo has already paid for once.

`captureFunnel` grows a **fourth number** rather than shrinking its third. "On
the product in scope" stays every ad classified as this product at any
confidence; "counted in the comparison" is the subset firm enough to compare.
Folding them together would have reported an unsure creative as *"classified as
a different product"*, which is not what happened to it — **a funnel that
reconciles by misdescribing where the drop went is worse than one that does
not reconcile.**

`buildBenchmark` gets the same gate as `buildBoard`. Applying it to one and not
the other would rebuild the 4.84%-vs-6.74% bug from scratch.

---

### F-003 · blocker · P2 · `lib/rate-page.js`, `server.js`
**/api/rate-pages would fetch anything, including this machine**

```
BEFORE:  loopback hits: 1   text was read: YES — the internal page's contents were fetched
AFTER:   loopback hits: 0   reason: not_https
```

**The work order's instruction here does not survive contact with the code, and
that is worth recording.** §5 says *"Reuse the exact guard /api/img already
has."* It cannot be reused: the image proxy is safe because it holds a four-host
allowlist, and every URL it will ever see comes from one of two Google CDNs. A
competitor's rate page is by definition an arbitrary host on the public
internet, so an allowlist here is not an allowlist. What transfers is the image
proxy's **test cases**, and those are the ones added.

`redirect: "manual"` is the substance, not a detail: left to follow redirects
itself, `fetch()` checks the URL we vetted and then walks to 169.254.169.254
because a remote server told it to. One `AbortController` now covers headers
**and** body, and the body is read through a 3MB byte counter — a timeout that
stops at the headers is not a timeout.

**Known residual, recorded rather than pretended away:** DNS can change its
answer between the resolve and the fetch (rebinding). Closing that needs
connecting by address with an explicit `Host` header, which `fetch()` does not
offer.

---

### F-005 · high · P8 · `lib/store.js`
**A run could finish, be paid for, save nothing, and report success**

```diff
+function writeAtomic(target, text) {
+  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
+  try { writeFileSync(tmp, text, "utf8"); renameSync(tmp, target); return true; }
+  catch (e) { try { if (existsSync(tmp)) unlinkSync(tmp); } catch {} throw e; }
+}
```

`writeFileSync` truncates then writes. Interrupt it — a full disk, a killed
process, the Windows restart trap in the handover notes — and what is left is a
truncated file that stays valid JSON right up to the point where it stops.
`loadRun()` returns null and the run reads as if it never existed: **the most
expensive failure available here**, paid for, gone, and indistinguishable from a
capture nobody ran.

The test blocks the write by putting a **directory** where the run file wants to
be. That fails on every platform regardless of privilege, which a `chmod` does
not when the suite runs as root.

---

### F-007 · high · P8 · `server.js`
**Two scopes read at once, and one of them vanished from disk**

```
BEFORE: "all" was lost from disk; found ["checking"]
```

The fix is **not** to serialise the reads — the two scopes are independent
questions and should still run together. Only the merge is serialised, and it
re-reads the record **inside** the lock, because a copy loaded before the lock
was granted is already stale.

```diff
+function updateRun(runId, mutate) {
+  return withRunLock(runId, () => {
+    const current = getRun(runId);
+    if (!current) return { ok: false, run: null, persisted: false };
+    mutate(current);
+    remember(current);
+    return { ok: true, run: current, persisted: persist(current) };
+  });
+}
```

`.then(fn, fn)` on the queue tail is deliberate: a previous holder that threw
must not wedge every later write to that run. Single-flight keyed on run **and**
scope is added alongside, because the same race has a cheaper form — two
requests for the *same* scope were buying two model calls.

`test/harness.js` grows `dataDir`/`keepData`, which is how a test spells *restart
the process*. No existing test could reach the precondition.

---

### F-008 · high · `lib/claude.js`
**40 model calls could be in flight at once, and nothing said otherwise**

```
BEFORE: fired 40 · reached the API 40 · peak in flight 40
AFTER:  fired 40 · reached the API 40 · peak in flight 8
        (RI_MODEL_CONCURRENCY=3 → peak in flight 3)
```

Two details are the difference between a limit and a suggestion, and both are in
the code with their reasons:

- `release()` hands its slot **directly** to the next waiter. The gap between a
  decrement and a re-acquire is a window for a caller that has not queued yet.
- the retry loop **holds** its slot through backoff. Releasing between attempts
  drains the queue into the endpoint that just returned 429.

The run records `limit` and `observedPeakProcessWide` — named for what it is,
because two source runs execute at once and the panel and rate-page reads share
the pool. For one run it is an upper bound, not a measurement.

---

### F-009 · high · P3 · `server.js`, `public/app.js`
**The cost line quoted the smaller of the two bills**

Two caches, and the old line hid that they are not the same cache:

| cache | what a hit saves | does `force` bypass it? |
|---|---|---|
| capture | the SerpApi request **and** every vision call | **yes** |
| extraction | one vision call, even when the listing is refetched | **no** |

A button labelled *"force fresh capture"* implies otherwise, so the quote now
says it in words and carries it as two named booleans.

**Upper bounds always**, because the quote must never under-count: an advertiser
about to be fetched is quoted at its read cap, less transcriptions we can see are
already held. The UI renders *"up to N fresh creative reads"* and never a flat
number — quoting the midpoint would be a promise nobody can keep.

Key insights is quoted as `analysisCallsInThisCapture: 0` **and named**, rather
than omitted. "Not included in this quote" and "free" are different, and only one
is true.

---

### F-004 · medium · `server.js`
**A paid endpoint nobody could reach was still generating and billing**

Removed: the route, the import, `lib/strategies.js`, `wireGate()`/`strategyHtml()`
in the front end, and the `7-strategies` screenshot step that clicked a button
that is not on the page.

The three strategy tests went with the route. **Worth naming what they were:**
two of them *proved the generator ran and returned angles* — the suite's green
tick depended on the paid call still being wired up. In their place is one test
that POSTs the old path and requires a 404. Hidden and removed are different
things, and only one of them stops the spend.

`lib/industry-context.js` is **not** deleted, though §4 permits it: the doctrine
comment at `set-shape.js:26` points at it by name. Deleting it would leave that
comment pointing at nothing, which is the stale-prose failure this repo keeps
paying for. The orphan is cheaper than the lie.

---

### F-006 · high · P6 · `server.js`
**The ACTIVE map had three `.set` calls and no `.delete`**

LRU with a cap (`RI_ACTIVE_RUNS`, default 24). Never evicts an unfinished run
(memory is the only copy) or one that failed to persist (F-005 — there is nothing
to load it back from). `remember()` does delete-then-set because `Map.set` keeps
an existing key's position; without it the map is FIFO wearing an LRU label. A
disk read is deliberately **not** re-admitted, or any sequence of reads refills
what eviction just drained.

The test's real assertion is not that an evicted run is reachable — it always was
— but that its payload comes back **byte-identical**.

---

### F-010, F-015, F-016 · Phase 2 · `public/app.js`

`test/ui.test.js` had existed, been maintained, and **never once executed**: it
exited 0 when Playwright was missing, so every machine without a browser — a CI
runner included — recorded a pass for a file that ran nothing. The first real run
crashed, then failed six ways. Three were the app.

**F-015 (high)** — the client picker's dropdown covers the landing-page button,
and clicking it picks a client:

```diff
+  // AN EMPTY BOX HAS NO SUGGESTIONS.
+  if (!q.trim()) { closeMenu(); return; }
```

With nothing typed, `matchClients("")` returns the first eight rows of a
directory of forty and renders them **over** "Use a landing page instead" — the
only other way into the tool. The rows handle `mousedown` and `preventDefault()`
it, so the blur that would close the menu never fires: someone who clears the box
and reaches for the button **gets Bank of Missouri**, and the next screen is
scoped to a client they never chose.

**F-016 (high, = H1 confirmed)** — filters outlived their run:

```diff
+  S.filter = "all";
+  S.productFilter = null;
   S.bySource = {};
```

`productFilter` is re-adopted only `if (S.productFilter == null)` and the
advertiser filter was never cleared. *"New analysis"* hides this because it
reloads the page — but **"Add a competitor" returns to the capture screen and
captures again without one**, so the second run opened under the first's chips.
If the filtered advertiser is not in the new set, the wall renders zero cards and
reads as *a capture that found nothing*.

**F-010 (medium)** — `startCapture()` had no `try/catch`; the button was disabled
on the way in and re-enabled after the `await`, so anything that threw before
that line left the only button on the screen disabled forever with an unhandled
rejection and nothing on screen. Both awaits are now guarded separately, because
they fail differently and the user can act on the difference. An `ok:true`
response with zero runs is handled too.

**Three stale assertions**, none of which could have been caught without running:
the benchmark section waited on `table.bench` being *visible* (it moved behind a
`<details>` when the board became the deliverable) and drove `#genBtn`/`.gate`/
`.angle` (gone months ago, and gone from the server in F-004); a results-screen
heading assertion sat in the landing-screen section; and one demanded a "next
build" marker on a Proposal mode card that is not in `index.html`.

The suite now exits 1 when it cannot run, `RI_SKIP_UI=1` is the deliberate
opt-out that prints *nothing here was verified*, and `.github/workflows/test.yml`
runs both suites, installs Chromium, uploads artefacts on failure, and does not
set `RI_SKIP_UI` — a runner that cannot open a browser is a broken runner, not a
reason to report green.

Ten journeys added over one browser context, including: a second capture under
the first's filters, three products back to back, drawer-over-wall with Escape, a
double-clicked Capture button (**one POST, not two**), an unreachable server, and
both screen-share sizes.

---

### F-011 · medium · `server.js`, `lib/store.js`
**Health said the keys were set and called that ready**

`storageHealth()` does a **real write and delete**, not a permission-bit
inspection: a full disk and a read-only mount both pass an inspection and fail a
write, and a root process ignores the bits entirely. `ok` now means *"a capture
run today would survive"*, which is the only question anyone loads this endpoint
to answer. The test blocks the directory by pointing `RI_DATA_DIR` beneath a
regular file, which fails for root exactly as it fails for anyone else.

---

### F-013 · medium · P3 · `lib/store.js`, `server.js`
**A wrong reading was permanent until the whole cache was retired**

`POST /api/extraction/:creativeId/reread` forgets one creative's stored reading.
It costs nothing when called; the next capture pays for exactly one vision call.
The **evidence bundle is untouched, with a test that says so** — that archive
answers "prove they advertised this in August" and is never rewritten. Calling
twice is not an error: "there is no stored reading" is the state the caller asked
for, and a second click that reports failure looks broken.

---

### F-014 · medium · P5 · prose audit
**"Display ads" was a claim about a network, made out of a filter on artwork**

The evidence, both halves:

- SerpApi documents `creative_format` as a filter on the **type of creative** —
  *"text - Text, image - Image, video - Video"*, described as ads that primarily
  contain text / ads using visuals / video ads. Nothing about delivery.
- **There is no DISPLAY value in the provider's platform enum at all** — only
  PLAY, MAPS, SEARCH, SHOPPING, YOUTUBE. This repo already knew: the comment at
  `atc-provider.js:9` records it as the reason `platform` is omitted for image
  captures. It then went on calling the result display ads anyway.

Google's Transparency Center carries image creatives that ran on Discover, in
Gmail, as YouTube companions and on the Display Network, and the response does
not tell them apart. Every user-facing string now says **image creatives**.

**The source key `google_display` is unchanged.** It is in every cache filename,
every `run.source` and every stored snapshot, and comparability between runs is
decided by matching it. Renaming it would invalidate the cache and re-buy the
captures behind it: a spend decision, not a wording one. Model prompts are also
unchanged — they describe the picture to a reader, and touching one retires every
extraction.

---

### F-012 · low · `package.json`
**`npm audit fix` is a no-op here**

§4 records "fix available". The first half holds; the second does not:

```
$ npm audit fix
up to date, audited 93 packages in 546ms
# ...followed by the same three advisories.
```

`express 4.22.2` is the newest 4.x and both it and `body-parser` pin `qs` at
`~6.15.1` — entirely inside the vulnerable range. The patched release is 6.16.0,
which no range in the tree admits. Two real options: `--force` to express 5 (a
breaking major, in the one dependency the whole server is built on, for a
moderate), or pin `qs`. **Pinned**, via an override to `^6.16.0`.

The cost is stated because forcing a version outside a maintainer's range is not
free: if `body-parser` ever depends on 6.15-specific behaviour, this override is
where that breaks, and it is the first thing to remove when express ships a 4.x
pinning a patched `qs`. Express uses `qs` for query parsing on every request, so
the DoS advisory was reachable from any query string this server answers.

---

### F-018 · medium · P1 · `lib/observations.js`
**An add-on's price was marked rankable at the fact level**

Found by the corpus on its first run.

```diff
-      rankable: grounded && complete && Number.isFinite(value) && isRankableMetric(f.metric),
+      rankable: grounded && complete && !scopedToAddOn
+        && Number.isFinite(value) && isRankableMetric(f.metric),
```

`scopedToAddOn` was enforced in `rollUpBrand` and **not** in the fact's own flag.
Two places decide whether "$5.99/month with BaZing" can be compared to a
competitor's account fee, and only one knew. **No rendered number changes** — the
board was already safe — but the flag now means what it says for any future
reader.

---

### F-019 · high · P4 · `lib/themes.js` (= H15)
**The Key insights framing counted the client among the competitors**

```
BEFORE: framing says 18 designs · the panel's readOver.designs says 16
```

One panel, two numbers for the same noun, the larger presented as a competitor
figure. The client's designs go into the read on purpose — the cohort contrast
needs them — and `readThemes` counted everything it was given.

The doctrine is unambiguous: the client is a third population on the Wall, out of
every competitor tier, chip, cluster, denominator, funnel step and sampling note.
**A count is not the one place that rule gets to lapse.**

The fix does not stop showing the model the client's work. It names the
competitor figure and discloses the rest: *"across the 16 distinct competitor
image designs captured, read alongside 2 of La Capitol's own"*. Three numbers
that add up, instead of one that hides a population.

---

## 3. Negative results — hypotheses tested and found already correct

These are as valuable as the bugs. **Do not re-test them.**

| id | claim | verdict and where it is now pinned |
|---|---|---|
| **H1** (search half) | `SW.product`/`SW.brand` leak between runs | **Already correct.** Both are reset unconditionally on every `openSearchWall()`. Only the *display* wall leaked — that is F-016. |
| **H2** | modal stacking; Escape closes the wrong one | **Already correct.** The drawer's computed z-index is above the results screen; Escape closes the drawer and leaves the wall and screen intact. Now guarded by a browser journey. |
| **H3** | board vs table disagreement | **Already correct.** The offer rows read the board's own rollup rather than computing a second opinion. Asserted **cell-for-cell over six adversarial fixtures**: zero ads, one ad, duplicate creative ids across advertisers, a missing headline beside a 130-character one, unicode and RTL, and an absurd figure. F-002 kept it true by giving `buildBenchmark` the *same* confidence gate. |
| **H4** | an unreadable competitor counted as a "no" | **Already correct** in the findings, the set shape, the snapshot and coverage. The primary read was the exception → F-017. |
| **H5** | nationals in a local denominator | **Already correct** in the findings, set shape, snapshot and coverage. **Failed in the primary read's `differences`** → F-017. |
| **H8** | client column empty; client-gap findings must suppress | **Already correct.** `allowClientGapFindings` goes false, `board.empty.kind` is `no_client_ads`, and the product-fact sweep over three whole payloads found nothing. |
| **H13** | an empty product scope costs a model call to discover | **Already correct.** `designs < MIN_FAMILIES` returns *before* `readThemes()` is called, with a comment saying so. |
| **H16** | a shared cache entry carries client framing into a competitor's replay | **Already correct** by construction, and **nothing tested it**. Now does: run one captures `lacapfcu.org` as the client, run two captures it as EFCU's competitor from that same entry, and the test asserts the replay is genuinely a cache hit *before* asserting anything else. |
| **H17** | 30/60/90-day windows share a cache key | **Already correct.** `cacheKey` hashes source, domain **and** days. |
| **H18** | a search reader can consume a display extraction | **Already correct**, and already covered by a pre-existing regression test. The cache path carries the reader family and its version. |

### Cross-cutting sweeps (§8) — all clean

Run over **three whole run payloads** (creative + benchmark + a second product,
with and without nationals), walking every string with its path:

- no user-facing string contains `undefined`, `NaN` or `[object Object]`
- no user-facing string renders a bare `null`
- **no sentence asserts a product fact** anywhere in any payload
- every evidence id resolves to an ad in the same run
- every finding names the population it was counted over
- every counted figure carries a denominator or a unit
- F-001 and F-002 hold across the sweep, not just at their own tests

The verbatim exclusion is explicit: an advertiser's own transcribed copy may say
anything, and it is quoted, not written.

---

## 4. What I did not do, and why

- **§9 / Phase 4 (deployment)** — disabled. Untouched.
- **Pagination (H20)** — §4 says do not implement it without approval; it changes
  spend. **The exposure, audited:** every sentence leaning on national absence
  already reads as an observation about the capture. `channel-shape.js:179` says
  *"neither national advertiser had a … image creative listed"*; the snapshot's
  absent cells say *"Not observed in the captured ads. This is not a statement
  about the product."*; the national row carries *"shown for context, not as
  evidence of this local market."* The exposure is real — one page of `num:100`
  against ~4,000 listed for Chase — but it is **phrased correctly everywhere I
  looked**, and the sweep in §3 checks that automatically now.
- **H6, H7, H9, H10, H11, H12, H19** — listed in `findings.json` under
  `notAttempted`, each with what specifically is missing. The two I would do
  first: **H12** (an old `run.themes` migrating into the right scope slot — the
  code reads correctly, but a saved general fallback is exactly the case a code
  reading is least trustworthy on) and **H6** (a comparability refusal whose
  failure mode is a *silently blank cell*, which looks identical to "not
  observed" and means something completely different).
- **The Phase 1 read pass** — see §6.
- **`lib/industry-context.js`** — kept, not deleted. Reasoning under F-004.
- **The source key `google_display`** — kept. Reasoning under F-014.

---

## 5. Where this document was wrong

The work order was written from one session's understanding, and §11 asks for
this. Four things did not hold.

1. **§5 F-003: "Reuse the exact guard /api/img already has."** You cannot. The
   image proxy is a four-host allowlist and a rate page is an arbitrary public
   host. The *test cases* transfer; the guard does not. A different guard was
   built and is documented in the file.

2. **§4: "npm audit: 3 moderate … fix available — confirmed."** The advisories
   are real; the fix is not reachable. `npm audit fix` exits 0 having changed
   nothing, because `express` and `body-parser` both pin `qs` at `~6.15.1` and
   the patched release is 6.16.0. See F-012.

3. **§6: "runs/_evidence already holds real creatives as base64 — no network, no
   SerpApi, no re-capture needed to assemble."** True on the owner's machine.
   **False in a clone**: `runs/` is gitignored, so `_evidence` and `_extractions`
   are empty directories. This is the single biggest blocker on Phase 1 and it is
   not fixable from here. See §6.

4. **§7: "test/ui.test.js is written, kept current, and has never run."** Written
   and never run, yes. **Not kept current** — and it could not have been, because
   a suite that cannot fail cannot go stale loudly. It drove `#genBtn`, `.gate`
   and `.angle` (removed from the UI months ago), waited on `table.bench` being
   visible (it moved behind a disclosure), asked after a Proposal mode card that
   is not in the HTML, and carried a results-screen assertion inside the
   landing-screen section.

Two smaller notes: §4 says `/api/health` "reports key presence only" — correct,
and it also reported `ok: true` unconditionally, which is the part that made it a
lie rather than merely incomplete. And §4's `saveRun()` item understates it:
`saveRun` had **four** call sites, none of which read the return value.

---

## 6. Phase 1 — the corpus, and the cost of running it

Built: `test/corpus/` (14 entries + README), `test/corpus-runner.js`.

**Every trap named in §6 is represented**: rate discount vs APR, loan amount vs
cash bonus, financing percent vs down payment, add-on price vs account fee, a
clipped figure, an adjective as a figure, institution identity as strategy, one
mechanic under two names, two offers in one ad, a cross-product figure, a
multi-product ad, a generic ad, an ungrounded figure (F-001), and the
Transparency Center's own page furniture.

Two passes, priced separately:

- **`--gate`** — `modelAnswer → shape → observations.js` diffed against the
  expected **counted** facts. Free, no key, no network, and **now part of
  `npm test`**. It is not a lesser test: **nine of the fourteen** are cases where
  the model's answer is *correct* and the engine must do something other than
  count it — retype it, refuse it, or keep it uncounted. Those are the ones that
  reached clients. It already caught F-018.
- **`--read`** — the image through the real vision prompt. One Haiku call per
  creative. It **refuses to run** without `RI_CORPUS_APPROVED=1`, and `--dry-run`
  prints the exact count first.

### The quoted cost is **0 vision calls**, and that is the finding

```
    corpus entries                  14
    with a creative attached        0
    entries awaiting evidence       14

    VISION CALLS A FULL REPLAY WOULD MAKE:  0
```

`runs/` is gitignored; in this clone `_evidence` is empty. Every entry ships
`needsEvidence: true` and `--attach` is the one command from this repo to a
replayable corpus **on a machine that has the creatives**.

**What the owner needs to do, and what it will then cost.** Run
`node test/corpus-runner.js --attach` on the machine whose `runs/_evidence` holds
the creatives, renaming each entry's `creativeId` to the provider id of the
creative that actually shows that trap. Then `--dry-run` will print a real
number. At the §6 target of ~60 creatives that is **60 Haiku vision calls per
full replay** — at the ~⅓ ¢ per creative recorded in `atc-provider.js`, roughly
**$0.20 a pass**. I am not running it, and not asking for approval to, because
there is nothing here to run it against.

---

## 7. New suspicions I did not chase

Full text in `findings.json` → `newSuspicions`. The three worth a look first:

1. **`server.js:255` — the fresh-vision-read upper bound is very loose on a cold
   cache.** It quotes each fetching advertiser at its full read cap, which with
   nationals on reads *"up to 380 fresh creative reads"* where a real run does a
   fraction. It never under-counts, which is the rule — but **a quote a
   strategist learns to ignore is a quote that has stopped working.** A
   median-from-history figure shown *beside* the upper bound would fix it without
   weakening the guarantee.
2. **`public/index.html:228` — the findings board sits below the fold at
   1366×768.** Measured, not guessed: the first `.fcard` is at y=794 on a 768px
   screen. That is the screen-share size in §7. Whether the ordering is right is a
   design call I have no mandate to make, so the browser test asserts only that
   the board is laid out and reachable, and records the number.
3. **`lib/store.js:200` — the extraction cache grows without bound.** `prune()`
   exists and is documented as *"only ever called explicitly"* — and nothing calls
   it. F-006 bounded memory; disk is still unbounded, and the extraction cache
   grows fastest. F-011 at least makes free space visible before it becomes a
   failure.

---

## 8. Hand-back

```
$ git log --oneline 7010b4e..HEAD
1a6bc18 H16: a cached advertiser carries no client framing into its next role — verified
100dcad F-019 (H15): the Key insights framing counted the client among the competitors
b0bb18d Phase 1 + F-018: the corpus, the runner, and the first thing it caught
6fd3ad7 F-017: the one sentence at the top contradicted the card beneath it
e2c3749 F-014: "display ads" was a claim about a network, made out of a filter on artwork
2b05458 F-013: a wrong reading was permanent until the whole cache was retired
00727ec F-009: the browser suite's cost assertions follow the line that changed
3c46e4a F-009: the cost line quoted the smaller of the two bills
0afbb46 F-008: 40 model calls could be in flight at once, and nothing said otherwise
9ee0121 F-012: npm audit fix is a no-op here, so the fix is pinned explicitly
8e338cf F-010, F-015, F-016 + Phase 2: the browser suite runs, and immediately finds things
55d091a F-011: health said the keys were set and called that ready
7751e59 F-006: the ACTIVE map had three .set calls and no .delete
ad581d1 F-005: a run could finish, be paid for, save nothing, and report success
d85b3f7 F-002: the reader said it was unsure and the board counted it anyway
01e4868 F-004: a paid endpoint nobody could reach was still generating and billing
e956178 F-003: /api/rate-pages would fetch anything, including this machine
099a0d9 F-007: two scopes read at once, and one of them vanished from disk
e16e763 F-001: a figure a model returned was never checked against the ad it read
```

One commit per finding, as asked, with two exceptions stated plainly: Phase 2
carries F-010, F-015 and F-016 together because they were found by the same first
run of the same suite and the suite had to be made runnable before any of them
could be seen; and F-009 has a follow-up commit for the browser assertions that
matched its old wording.

`npm test` passes at **every** commit.

```
$ git diff --stat 7010b4e..HEAD | tail -1
 95 files changed, 6571 insertions(+), 442 deletions(-)
```

Application code changed: `lib/observations.js`, `lib/analyze.js`,
`lib/benchmark.js`, `lib/findings.js`, `lib/primary-read.js`, `lib/themes.js`,
`lib/extract.js`, `lib/rate-page.js`, `lib/store.js`, `lib/claude.js`,
`lib/sources.js`, `lib/channel-shape.js`, `server.js`, `public/app.js`,
`public/index.html`. Deleted: `lib/strategies.js`. Added:
`.github/workflows/test.yml`, `test/corpus-runner.js`, `test/corpus/`.

Not merged to `main` or to `benchmark-v4-truncation-and-set-shape`.

### Reproducing any of this

```bash
npm install            # playwright is the only devDependency
npm test               # 411 assertions + 142 corpus fields. No keys, no network.
npm run test:ui        # 88 browser assertions. Fails loudly if it cannot run.
npm run corpus:cost    # what a corpus read pass would cost
npm audit              # 0
```
