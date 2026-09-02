# RAIN Intelligence — handover

For a fresh Claude Code session in `C:\Users\Vicky\rain-intelligence`.
Enough to start working. Not a changelog — `git log` is the changelog, and the
commit messages carry the reasoning.

---

## What this is

A competitive advertising analysis tool for RAIN, an agency serving banks and
credit unions. Node + Express, ES modules, **zero devDependencies**, flat-file
persistence. Runs locally for demos.

Two products, one capture pipeline:

| | source | question |
|---|---|---|
| **Competitive Intelligence** | Google **search** ads | "How did our ads compare?" — the findings board + benchmark table |
| **The Wall of Creatives** | Google **display** ads | "What are competitors making?" — display only |

There was a third use case (Proposal Evidence). It was dropped. Meta was
removed permanently — not part of the strategy.

## Running it

```bash
npm run dev
```

`node --env-file=.env server.js` on port 3000. `.env` holds `ANTHROPIC_API_KEY`
and `SERPAPI_API_KEY` and is gitignored.

**On Windows, `pkill -f "node server.js"` does not kill the process.** It exits
0, the old server keeps the port, your new one fails to bind silently, and you
test stale code for twenty minutes. Use PowerShell:

```powershell
Get-Process node | Stop-Process -Force
```

```bash
npm test
```

251 tests, six suites, plain `node`. `test/ui.test.js` and `test/shots.js` are
Playwright and are **skipped** — Playwright is not installed. They are kept
current anyway; if you change the landing page or the board, update them.

## The one idea to hold on to

**Every number on the board is a count of what was captured, never a claim
about a product.** "Not observed in 3 competitors' captured ads" is true;
"they don't offer it" is not, and would be RAIN telling a client something
false in front of their own competitors. Most bugs in this repo have been one
sentence quietly crossing that line.

Two corollaries that keep biting:

- **A sentence that was accurate can stop being accurate.** A caveat said
  nationals are "not counted in any finding". True until national findings
  existed. When you change what something counts, grep the prose.
- **Fail closed.** A benchmark without a resolved product is refused
  (`product_required`), not analysed as "other". Every count is product-scoped,
  so a wrong scope quietly wrecks all of them.

## Layout

```
lib/findings.js      the deterministic findings engine — this file is the product
lib/observations.js  the gate between model proposals and counted facts
lib/benchmark.js     the snapshot table
lib/primary-read.js  the one sentence at the top (no model)
lib/set-shape.js     "what this set is competing on" (no model)
lib/atc-provider.js  SerpApi Google Ads Transparency Center
lib/national-tier.js Chase + Capital One, the standing national reference
lib/store.js         caches; cache paths carry a reader VERSION
lib/directory.js     40 clients, their markets and curated competitors
public/app.js        the whole front end, one file
public/client-search.js  landing-page client matching (has its own test)
```

`lib/strategies.js` and `lib/industry-context.js` are orphaned. Not deleted,
not referenced. Delete them if you touch that area.

### Model use is deliberately narrow

Vision reads creatives (Haiku 4.5). Sonnet writes Wall themes and reads
branded URL paths. **Findings are never model-written** — a model proposes,
`observations.js` decides what counts.

**Prompt caching does not work here.** Haiku 4.5's minimum cacheable prefix is
4,096 tokens; the search system prompt is 1,830. Verified empirically
(`cache_creation_input_tokens: 0`). Don't re-derive this.

## Caches — how they are keyed, and the trap

Everything lives under `./runs` (`RI_DATA_DIR`), gitignored, and is portable:
copy the folder and the cache comes with it.

| cache | key |
|---|---|
| `_captures` | source + domain + window |
| `_extractions` | creativeId + **reader version** |
| `_snapshots` | for month-over-month deltas |
| `_evidence` | creative images |

**The trap, and it has caused two separate bugs:** a `_captures` entry stores
the ads it **read**, not the listing it read them from. So raising a read cap
was invisible — the entry replayed its old count forever. `server.js` now
treats an entry as a miss when the provider had more renderable creatives than
the entry holds *and* the current cap has room. If you add another dial that
affects *how much* gets read, check it against this.

Caps today: local `RI_MAX_READ=60`, national `RI_NATIONAL_READ=100` (= `num`
in the listing request, so nothing fetched goes unread).

## State of the nationals

Chase and Capital One are captured once per 30 days and **shared by all 40
clients**, so their read cost amortises to nothing. They are excluded from
every local denominator — we cannot tell from the Transparency Center whether
their ads served in a given market — but they do produce findings via
`national_gap`, which fires only when **every** captured national advertises
something the client does not.

Current cached read: Chase 70, Capital One 97, across all products
(Chase: 30 credit-card, 21 checking, 6 auto-loan; Capital One: 78 credit-card).

**Not done: pagination.** The listing request is `num: 100` with no use of
`serpapi_pagination.next_page_token`, against ~4,000 listed for Chase. One page
is all we can currently see. This is the next real piece of work if national
coverage matters.

## Where things stand

Branch `benchmark-v4-truncation-and-set-shape`. **Nothing merged to `main`.**
No GitHub remote of consequence — this is local.

Recent work, newest first: full national reads + the cache-cap fix; client
sole-advantages no longer demoted out of "Where you lead"; landing page
rebuilt around a client picker + product select; regional/national scope tags.

Known and deliberate:

- **The Wall has had far less attention than the board.** It has never been
  captured on this install — zero `banner` extractions — so any Wall work needs
  a display capture first.
- OCR triage (tesseract.js) not built.
- Playwright not installed, so the UI suite never runs.

## Working with Avi

Testing is done live against real La Capitol runs (checking, auto-loan,
credit-card), and feedback arrives as screenshots. Corrections are usually
about a sentence saying more than the data supports — take them literally and
find the line, because there is almost always a real one.

**Do not spend money without the word.** Standing instruction: *"confirm the
costs and when I say build, only then build."* SerpApi credits and vision calls
both count. Confirm the number first, then wait.

Colour: amber/yellow means caution and nothing else. Periwinkle `--accent:
#B9A7F5` is for emphasis. A metric label in amber reads as a problem.
