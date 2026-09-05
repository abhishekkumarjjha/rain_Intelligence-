# The golden corpus

## Why it exists

`npm test` proves that **if the read is right, the arithmetic is right**. Every
fixture in it decides what the model returned, so the suite begins after the
model has already answered perfectly. It cannot catch a wrong read, and a wrong
read is what the owner sees on every live run.

This corpus is the other half: a fixed set of creatives with **human-verified**
expected labels, replayed through the real extractor to measure how often the
read is actually right.

## Two things to replay, and they cost differently

| pass | what it exercises | cost |
|---|---|---|
| **gate** | `modelAnswer` → `shapeSearch`/`shape` → `observations.js` → expected counted facts | free, no key, no network |
| **read** | the creative's **image** → the real vision prompt → the label | **one Haiku vision call per creative** |

The gate pass runs today and runs in CI. The read pass costs money and must not
be run without the approval described in §10 of the bug-hunt work order.

## The state of this directory

Every entry here carries `"needsEvidence": true`. That is not a placeholder for
missing work — it is the accurate state of a **fresh clone**:

> `runs/` is gitignored. In a clone, `runs/_evidence` and `runs/_extractions`
> are empty directories. The work order's §6 says "runs/_evidence already holds
> real creatives as base64 — no network, no SerpApi, no re-capture needed to
> assemble". That is true **on the owner's machine**, and false anywhere the
> repo has merely been cloned.

So the entries below are complete except for the one field only the owner's disk
can supply: the creative itself. Each states the ad text a human transcribed,
the label a human says is correct, and why. Attaching evidence is mechanical:

```bash
node test/corpus-runner.js --attach   # fills evidenceRef from runs/_evidence
node test/corpus-runner.js --dry-run  # says exactly what a read pass would cost
node test/corpus-runner.js --gate     # free; runs today
node test/corpus-runner.js --read     # SPENDS MONEY. Needs approval.
```

## Schema

```json
{
  "creativeId": "CR...",              // provider id, or CORPUS_* until evidence is attached
  "source": "google_search|google_display",
  "advertiser": "chase.com",
  "needsEvidence": true,              // no image on disk yet; the read pass skips it
  "evidenceRef": null,                // set by --attach: runs/_evidence/<id>.json
  "adText": {                         // what a human reads on the creative
    "headlines": [], "description": "", "sitelinks": [], "callouts": []
  },
  "modelAnswer": { },                 // a legal extractor answer, for the gate pass
  "expect": {
    "product": "checking",
    "productConfidenceAtLeast": 0.6,
    "facts": [{ "metric": "apy", "raw": "5.55% APY", "value": 5.55,
                "qualifiers": { "term_months": 12 },
                "complete": true, "rankable": true, "grounded": true }],
    "claims": ["no_monthly_fee"],
    "truncated": false,
    "legible": true
  },
  "notes": "why a human says so"
}
```

`expect.facts` is what must survive **observations.js**, not what the model said.
A fact the model proposed and the gate correctly refuses is expressed by leaving
it out of `expect.facts` and saying so in `notes`.

## The trap cases

Every trap named in §6 of the work order is represented, and each has scar
tissue somewhere in `lib/observations.js`. They are the cases a new prompt, a new
model or a new reader version must be re-checked against before it ships.
