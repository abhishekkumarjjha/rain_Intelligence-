# RAIN Intelligence — full UI specification

**Purpose of this document:** hand it to a reviewer (human or model) and ask for
a critique of the interface, the copy, and the claims the product makes. It
describes the app **as currently built**, not as wished for. Everything below is
implemented and covered by tests unless a line says otherwise.

---

## 0. How to review this

You are reviewing a **competitive advertising intelligence tool** used by a
marketing agency (RAIN) whose clients are US **banks and credit unions**. The
output is shown to those clients in monthly reports and pitch meetings.

Please give specific, actionable feedback on:

1. **Copy** — is every sentence true, clear, and free of marketing mush? Flag
   any sentence that overclaims what the data supports (see §7, the claim rules).
2. **Information architecture** — is the five-screen flow right? Is anything
   in the wrong place, missing, or redundant?
3. **The results screens** — a strategist has 90 seconds before a client call.
   Do they get the answer? What is buried?
4. **Naming** — screen names, mode names, button labels, stat labels, column
   headers.
5. **What is missing** that a competitive-intelligence tool of this kind should
   obviously have.

Do **not** suggest adding AI-generated commentary to the evidence screens.
Read §7 first — that constraint is deliberate and load-bearing.

---

## 1. What the product does

The user enters a **product landing page URL** for a bank or credit union.
The app looks that institution up in a curated 40-client directory, suggests
competitors, and then captures the **real ads those competitors are running** on
Google, from the **Google Ads Transparency Center** (via SerpApi).

Captured creatives are images. A vision model **transcribes** each one — the
headline, the offer figure, any visible term or minimum — and **classifies** it
into one of 12 product codes. Everything after that is arithmetic.

There are two modes over the same capture pipeline, plus one that is stubbed.

| Mode | Question it answers | Captures |
| --- | --- | --- |
| **Creative Inspiration** | "What are competitors making?" | `creative_format=image` — display banners, competitors only |
| **Campaign Benchmark** | "How did our ads compare to theirs?" | `creative_format=text` — search ads, **client and competitors** |
| **Proposal Evidence** | "Which ads go in the pitch?" | Not built. Visible in the UI, disabled, marked "Next build" |

---

## 2. Design system

### Palette

The canvas is a **vivid royal blue**. Panels are lighter blues laid on it, so
depth comes from blue rather than from black.

**Three colours, three jobs.** An earlier version was blue-on-blue, which meant
nothing could be emphasised — everything that mattered shouted in the same
colour as everything that did not.

| Colour | Job | Never used for |
| --- | --- | --- |
| **Blue** | the surface, and the primary action | emphasis |
| **Orange** | the number or offer the eye should land on first; the secondary action | warnings |
| **Green** | confirmed / complete / included — good-news outcomes | emphasis |
| **Red** | failure only | anything else |

Orange carries emphasis, which is *why* warnings are red: one colour cannot mean
"look here" and "be careful" on the same screen.

```
surfaces   --bg #0E2A6B   --panel #153A90   --panel-2 #1B44A2   --panel-3 #1F4CAE
lines      --line #2A57B4                   --line-2 #4076D8
text       --ink #FFFFFF  --ink-2 #D4E3FF   --ink-3 #AFC6F5
accents    --blue #A8CDFF --amber #FFB94D   --green #57E3A8     --red #FFB3BC     (as TEXT)
fills      --blue-fill #1746B0  --amber-fill #FF9F1A  --green-fill #2FCB8B        (as FILL)
on-fills   --on-blue #FFFFFF    --on-amber #2A1500    --on-green #04231A
```

Text colours and fill colours are **separate tokens on purpose**: a blue light
enough to read on the canvas is far too light to put white text on.

All 28 text/surface combinations clear **WCAG AA (4.5:1)**; the worst is 4.52.
There is a contrast check in the repo — any palette change must keep this true.

### Type and shape

Inter (400/500/600/700/800), system-ui fallback. Hero 52px/800. Section headings
~24px/700. Body 13–15.5px. Radius 16px panels, 10px controls, 999px pills.
Max content width 1180px. Dark only — there is no light theme.

---

## 3. Screen by screen

### Screen 1 — Landing

- Top bar: blue dot mark, **RAIN** (800) + **Intelligence** (500, muted). Right
  side is empty here.
- H1: **RAIN Intelligence** — "Intelligence" in an orange gradient.
- Tagline (19px, semibold, white): *AI-powered competitive intelligence — see
  what your competitors are doing*
- Lede (15.5px, muted): *Start with a product landing page. We pull the real ads
  their competitors are running — the creative, the offers, and how long each
  has been live.*
- **Search bar**: white pill, magnifier icon, placeholder `yourbank.com/checking`,
  blue **Analyze** button. Enter submits.
- Hint: *Use the product page, not the homepage — it tells us which product to
  scope to.*
- Status line: *40 clients in directory · reads up to 18 creatives per advertiser*
  — or, if a key is missing, *Not configured: SERPAPI_API_KEY* in red.

**States.** A bad URL replaces the hint with *That does not look like a URL. Try
**yourbank.com/checking**.* and stays on the screen. Errors never use `alert()`;
there is an inline error bar at the top of the page.

*(A row of quick-pick client chips was removed at the client's request.)*

### Screen 2 — Purpose

Eyebrow: the resolved client name, uppercased. H2: **What are you using this for?**

Three cards. Each: icon, title, the question in italic blue, a description, tags.

- **Creative Inspiration** — orange icon — *"What are competitors making?"* —
  "Real display creatives from competitors, grouped by idea and filtered to your
  product. Sorted by what is running now, with longevity shown." — `Google display`
  `Image creatives`
- **Campaign Benchmark** — green icon — *"How did our ads compare to theirs?"* —
  "Your ads against their ads over the same window — offers, longevity and volume
  side by side. Facts first; strategies only when you ask." — `Google search`
  `Ads vs ads`
- **Proposal Evidence** — grey icon, 42% opacity, not clickable — *"Which ads go
  in the pitch?"* — `Next build`

### Screen 3 — Confirm competitors

Eyebrow: client name. H2: **Confirm competitors**. Sub: market · institution type,
e.g. *Louisiana — Baton Rouge core, statewide targeting · Regional CU*.

Right: **Product scope** (12 codes), **Sources**, and one or two **Window**
selectors. Changing the product **re-asks the directory**, because competitor
ranking is product-dependent.

**Sources** — `Google display` / `Meta` / `Both`. Chosen here, before anything is
spent, because a creative team working on display does not need Meta requests and
should not pay for them. Hidden entirely in Benchmark mode, which has exactly one
legal source, so offering a chooser would imply a decision that does not exist.

**Two windows, labelled differently on purpose.**

| | Control | Options | Default |
|---|---|---|---|
| Google | *served in* | 30 / 90 days | 30 |
| Meta | *started in* | 30 days / 3 months / 6 months | 3 months |

Same number, different question. Google's filter asks whether a creative was
*shown* in the window. SearchApi's `start_date` asks whether the ad *began* on or
after that date — so an ad that started two years ago and is still running today
is **excluded** by a 30-day Meta window and **included** by a 30-day Google one.
Giving them one shared control reading "Last 30 days" would be a lie of symmetry.
Meta defaults wider because Meta flights are short and 30 days comes back thin.

Rows are toggleable. Each shows a green tick when on, name, domain, the curated
reason ("Baton Rouge CU serving the same nine-parish core"), a type tag, and a
`Product match` tag when curated for this specific product. First three default on.

In **Benchmark** mode a fixed non-toggleable row sits at the top for the client:
*Their own ads are captured the same way, over the same window — so the comparison
is ads against ads.*

Below: a manual add row (name + domain). Then the cost line, a **Force fresh
capture** checkbox, and **Capture ads**.

**The cost line reads the cache live**, so it states what will actually be spent
rather than the theoretical maximum:

```
Google display · 1 request · 3 from cache
Meta · 2 requests
Captures are reused for 7 days. Tick "Force fresh capture" to ignore them.
```

**The cost is always stated before anything is spent.** A capture the team
already paid for this week costs nothing and says so.

**States.** No curated competitors → *No curated competitors for this client yet.
Add them below.* Homepage URL → an amber note that no product was detected.

### Screen 4 — Capturing

H2: **Capturing**. Sub: *All advertisers are fetched at once.*

With **Both** selected, rows are grouped under a source heading — the same
competitor appears once per source, and two rows with the same name and different
numbers is unreadable otherwise.

**Meta status lines** use Meta's own vocabulary, never Google's:

```
resolving the Meta Page…
14 messages · from 42 cards · of 153 ads · 3 read by vision · 9 RAIN-managed
Page resolved · no Meta ads in this window
several Pages share this name — needs confirmation
```

**A cache hit says so, with its age**, because "this is fast" and "this is stale"
must not look identical:

```
14 messages · captured 2 days ago, no request spent
```

**Three page states that must never collapse into one sentence:**

| State | Copy | Meaning |
|---|---|---|
| resolved, ads found | the counts line | working |
| resolved, zero ads | *Page resolved · no Meta ads in this window* | a fact about the competitor |
| ambiguous | *several Pages share this name — needs confirmation* | a failure of ours |

The third renders a candidate list on the results screen. Confirming one persists
the mapping and nobody is asked again. Nothing is fetched from a guessed Page —
the live probe found a national brand scoring 1.0 with a 0.0033 margin over the
runner-up, which means many Pages share that name, and picking the first would
put an unrelated company's ads under a competitor's name.

One row per advertiser: status lamp (pulsing blue → green done / red failed),
name (+ `Your client` tag), and a live status line that must always reconcile:

```
queued → fetching creatives… → reading 12 creatives… →
7 read · of 48 found · 5 preview-only · 3 cached
```

Failures are specific, never "error": `provider quota exhausted`, `provider key
rejected`, `provider timed out`, `no ads in this window`, `creatives are
preview-only`, `creatives found but none could be read`. An advertiser returning
nothing **never** takes down the run for the others.

If a domain returns multiple verified advertiser accounts, the row says so in
amber. They are never silently merged.

### Screen 5 — Results

Header: mode eyebrow, `Client · Product`, and three stats on the right.

Then, in order:

1. **Sampling bar.** Green when the capture was complete, orange when not.
   *All 55 creatives listed for this window were retrieved; 18 were selected to read.*
   or *18 of about 2,000 creatives listed in this window were read. Findings
   describe the ads captured, not the whole market.*

2. **The capture funnel** — `WHERE THE CREATIVES WENT`. A row of counts:

   ```
   listed by Google → retrieved → have a readable image → selected to read → read → on the product in scope
   ```

   The last step is orange. A **"Why the drop?"** link expands the reasons:
   *43 beyond the provider's 100-per-request ceiling · 5 preview-only links,
   which carry no image to read · 12 over the read cap of 30 per advertiser ·
   3 duplicate artwork collapsed, failed downloads, or unreadable creatives*.

   **This strip exists because "55 found" above a wall of 2 is the single most
   damaging thing this UI can show.** There are five legitimate reasons for the
   gap and the user could previously see none of them.

3. **Change since the previous capture** (green, only when a comparable earlier
   run exists): *SINCE 2026-08-12 · **4** we had not captured before · **11** seen
   in both captures · **2** no longer observed.* Followed by: *Each capture is a
   sample — an ad missing here may simply not have been sampled this time, not
   stopped.* See §6.

4. **Scope bar** — which slice is on screen and how to leave it.

5. **Filters** — two independent chip rows: product, then advertiser. **Both
   count over everything captured**, so a chip can always be used to escape the
   current slice.

#### 5a. Creative Inspiration — the wall

Stats: **Ideas shown · Executions · With an offer** — these describe *what is on
screen*; the funnel above carries the capture totals.

Card grid. Each card: the creative image (served same-origin through a proxy),
then advertiser name (small caps, blue), headline, subhead, the **offer in
orange**, and a footer: `2 variations` badge, sizes (`728x90, 300x250`), and
*shown on 412 days since Apr 2025*.

Cards are **ideas, not executions** — creatives sharing a headline, offer and
product collapse into one card carrying its variation count. Clicking opens
every execution behind it.

The wall **opens on the scoped product** but never hides the rest: if scoping to
Checking leaves 4 of 7, the bar says *Showing **Checking** only. **Show all 7
creatives captured***. If the scope matches nothing at all: *No creative in this
capture classified as **Checking** — most display banners carry no product signal
at all, so they read as **Other**. Showing all 12 creatives captured.*

#### 5a-ii. Source tabs

When more than one source was captured, tabs sit above the filters:

```
Google display  12      Meta  14 ●
```

**These switch the entire dataset, not a filter over a combined one.** Each tab
is its own run, its own counts, its own funnel, its own filters and its own date
vocabulary. A pulsing dot means that source is still capturing — results appear
as soon as the *first* source lands rather than waiting for both, because Google
typically finishes well before Meta paginates and making someone stare at a
finished wall they cannot see is worse than a tab that fills in.

Switching tabs restores that source's own filter selection. A product chip chosen
on the Google wall must not silently apply to the Meta wall, where the counts
behind it are different.

**No number ever crosses a tab.**

#### 5a-iii. Creative Inspiration — the Meta wall

Same card styling as Google, deliberately: a creative person should not have to
relearn the screen. What differs is the semantics.

Stats: **Messages · Ad records · With an offer**.

Cards are **messages, not creatives**. A Meta ad can carry seven cards and eight
assets; cards sharing copy and destination collapse into one message. Two counts
appear as separate badges because they mean different things:

- `3 ad records` — Meta served this message under three ad objects
- `6 assets` — one message rendered six ways

Calling both "variations" would make the wall unreadable.

**Footer differences from Google:**

| | Google | Meta |
|---|---|---|
| timing | *shown on 412 days since Apr 2025* | *Active · started Aug 18* |
| placement | sizes (`728x90`) | platforms (`FACEBOOK · INSTAGRAM`) |
| provenance | — | `from link` / `from copy` / `read from artwork` |

**Meta never renders a day count and never renders a closed date range for a live
ad.** Every ad in the live probe was `is_active: true` while carrying an
`end_date` already in the past, so that field is a rolling last-observed stamp,
not a stop date. `end − start` is not the days-served measurement Google's column
means, and displaying it as one would put two different measurements in the same
sentence.

A `provider end date (metadata, not a stop date)` line appears in the evidence
drawer only, clearly labelled.

**RAIN-managed.** A purple badge on any message whose destination carries RAIN
campaign tracking, plus a line above the wall:

> **9** of these are RAIN-managed — the destination carries RAIN campaign
> tracking, so they are work RAIN runs rather than independent competitor
> activity. Badged below, and never counted as a competitor's own strategy.

They are **flagged, not hidden**. The creative team gains from seeing prior work,
and most RAIN clients compete in different markets so the overlap is rare. The
wording says *managed*, never *authored* — a tracking parameter proves whose
campaign it is, not who designed the creative.

#### 5b. Campaign Benchmark — the table

Stats: **Your ads · Their ads · Competitors**.

**Counted findings** first, as cards. A gap has an orange left border:
*2 of 2 competitors advertised a cash bonus in the ads captured. La Capitol
Federal Credit Union did not.* — with a `4 ads` evidence chip. Every finding
carries its **denominator** and its evidence.

Then the table. Client column first, green header, faintly tinted. Rows:

| Row | Cell content |
| --- | --- |
| On-product ads captured | count + *of 4 captured* + evidence link |
| Advertised rate / cash bonus / discount / fee waiver | strongest advertised value in **orange**, qualifier beneath, `3 ads`, evidence. Offer rows only appear if someone advertised one; an **absent cell is an em-dash and is the finding** |
| Longest-running on-product ad | *1,169 days* + *shown on 1,169 days since Jun 2023* |
| Distinct creative ideas | cluster count + *3 executions* |
| Most recently observed | a date |

A **comparability caveat rides with its row**, not in a footnote: *1 of 2
creatives did not print a term or minimum. Compare as advertised offers, not as
product terms.*

#### 5c. The strategy gate

Below the table, always closed by default:

> ### Strategies are not generated by default
> The table above is evidence — what was advertised, by whom, over the same
> window. Recommendations are a separate, optional read that a strategist chooses
> to open.
>
> **[ Generate recommended strategies ]** *(orange — a deliberate optional step)*

Pressing it produces angles, each with: title, **What the captured ads show**,
**What it opens up**, and a bolded **Confirm first:** question. Then Cautions.

The gate exists because the brief was explicit: show the client the facts and let
them draw the conclusion, because *"it's kind of hard to state your product is
inferior."*

### The evidence drawer

Slides from the right on any evidence click. Per ad: the creative, the
institution, the **verified advertiser in amber when it differs** (*verified
advertiser: Fogarty and Klein, Inc.*), headline, offer with its qualifier or
*— no term or minimum printed on this creative*, *Shown on N days since Mon YYYY ·
last observed YYYY-MM-DD*, and a link to the Transparency Center. Escape closes.

---

## 4. Empty and failure states

| Situation | What the user sees |
| --- | --- |
| Nothing captured at all | **No creatives were read in this capture** · "Nothing was invented to fill the gap. Here is what each advertiser returned:" · a per-advertiser list with reasons · a hint to widen the window |
| Filters exclude everything | *Nothing matches both filters.* + **Clear filters** |
| Product scope matched nothing | wall widens to everything, and says so |
| Image will not load | proxy → direct URL → *Creative could not be loaded* |
| Server unreachable mid-capture | retries five times with backoff, then *Lost contact with the server while capturing. The run may still be going — reload and it will be in the run list.* |
| A creative was only partly legible | amber `partly legible` tag on the card |

---

## 5. Cost model (shown to the user before spending)

- **1 SerpApi credit per advertiser per capture.** Benchmark adds one for the
  client. Free tier is 250/month.
- **1 vision call per creative**, capped at 30 per advertiser (`RI_MAX_READ`).
- Extractions **cache forever on creative ID** — a creative's pixels never
  change, so its transcription is bought once for the lifetime of the system.
- **Byte-identical creatives collapse before extraction.**

---

## 6. The provider returns a rotating sample

The Transparency Center is **not a stable list**. The same query issued twice
returns overlapping but different creatives, and one domain returned ~2,000 image
creatives against a retrieval ceiling of 100.

Consequences the UI is built around:

- A capture is a **sample at a moment**, never an inventory.
- Superlatives are gated: *"the longest-running ad we captured"* is allowed;
  *"their longest-running ad"* is not.
- Runs are snapshotted and **diffed on creative ID** against the most recent
  comparable earlier run (same client, mode and product scope).
- An ad missing from a later capture is **"no longer observed"**, never
  **"stopped running"**.

**Open question for the reviewer:** should the app show a **union across the last
N captures** rather than only the latest one? That would build a fuller picture
of a competitor over time at zero extra provider cost, but it complicates every
"as of" date on the screen. Argue both sides.

---

## 7. Claim rules — read before critiquing the copy

These are enforced in code, not in prompts, and are the product's whole premise.

1. **Every number is computed in `lib/analyze.js`.** No model counts anything,
   ever. The strategy model is handed pre-counted facts and instructed never to
   emit a digit.
2. **`totalDaysShown` is days served, not a contiguous run.** The phrasing is
   fixed in code: *shown on 1,169 days since Jun 2023*. Never *running
   continuously for 3 years*.
3. **There is no performance data in this dataset at all.** Never *their
   best-performing ad*. A long-running ad is one an advertiser kept paying for.
4. **Sampling is always stated**, and decides whether the UI may say *"the
   longest-running ad we captured"* or *"their longest-running ad"*.
5. **Institution ≠ advertiser.** The entered domain owns the ad; the verified
   advertiser is a separate field (frequently an agency).
6. **Absence is a first-class finding, scoped to the capture**, always with its
   denominator and its evidence one click away.
7. The supported claim is deliberately narrow: *"over this window, in the ads we
   captured, competitors advertised X and the client advertised Y."* **Not**
   "competitors offer X" — their live product may differ from their ad. **Not**
   "the client's product is worse" — that is the client's inference to draw.
8. The strategy pass may not assert anything about the client's actual products.
   It saw their **ads**, not their product sheet. Anything depending on the
   client having something must come back as a **question**, not an assertion.

---

## 8. Known gaps

- **Proposal Evidence is not built.** It needs live competitor discovery for
  prospects not in the directory — a genuinely different problem.
- **`creative_format=image` with `platform` unset is not yet confirmed against
  the live API.** The recorded fixture is text creatives.
- No light theme, no mobile layout below 900px beyond basic reflow, no export
  (PDF/deck), no auth, no multi-user state.
- The directory is 40 hand-curated clients. A client not in it gets a manual
  competitor entry field, never a fabricated list.

---

## 9. What good feedback looks like

Specific and anchored. *"The stat labelled 'Executions' on the wall will read as
'impressions' to a media buyer — call it 'Creatives' and put the idea count
first"* is useful. *"Consider improving the visual hierarchy"* is not.
