// =============================================================================
// test/mock-net.js — preload that puts a fake market underneath the real app.
//
// Loaded with `node --import ./test/mock-net.js server.js`, so the REAL server,
// the REAL provider adapter and the REAL Anthropic SDK all run unchanged. A
// test that stubs lib/ modules proves the stubs work; this proves the app does.
//
// Two different interception points, because the two clients differ:
//   · the provider adapter calls global fetch  -> stubbed in-process
//   · the Anthropic SDK binds node-fetch directly and never looks at global
//     fetch, so it cannot be stubbed. It is pointed at a real loopback server
//     via ANTHROPIC_BASE_URL instead, which also exercises the real HTTP path.
// =============================================================================

import http from "node:http";
import { listingFor, extractionFor, searchExtractionFor, PNG_BY_ID, ID_BY_B64, MARKET } from "./fixture-lab.js";
import { pageSearchResponse, adsResponse, jpegish, PAGE_BY_DOMAIN } from "./meta-fixture.js";

process.env.SERPAPI_API_KEY ||= "test-serpapi-key";
process.env.SEARCHAPI_API_KEY ||= "test-searchapi-key";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

// Failure injection, so the unhappy paths are testable without editing code.
//   RI_MOCK_FAIL=quota|auth       provider fails that way for every domain
//   RI_MOCK_FAIL_DOMAIN=x.com     that one domain times out
//   RI_MOCK_VISION_FAIL=1         every vision call returns unparseable prose
//   RI_MOCK_IMG_403=1             the image CDN hotlink-blocks every request
//   RI_MOCK_META_FAIL=quota|auth  SearchApi fails that way
//   RI_MOCK_META_MEDIA_403=1      the Meta CDN refuses the media download
const FAIL = process.env.RI_MOCK_FAIL || "";
const FAIL_DOMAIN = process.env.RI_MOCK_FAIL_DOMAIN || "";
const VISION_FAIL = process.env.RI_MOCK_VISION_FAIL === "1";
const IMG_403 = process.env.RI_MOCK_IMG_403 === "1";
const META_FAIL = process.env.RI_MOCK_META_FAIL || "";
const META_MEDIA_403 = process.env.RI_MOCK_META_MEDIA_403 === "1";

// ---------------------------------------------------------------------------
// 1. Provider + image CDN, over global fetch.
// ---------------------------------------------------------------------------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

globalThis.fetch = async function mockFetch(input, init = {}) {
  const url = String(input instanceof Request ? input.url : input);

  if (url.includes("serpapi.com")) {
    const q = new URL(url).searchParams;
    const domain = q.get("text");
    const format = q.get("creative_format");

    if (FAIL === "quota") return json({ error: "You have run out of searches." }, 429);
    if (FAIL === "auth") return json({ error: "Invalid API key." }, 401);
    if (domain === FAIL_DOMAIN) throw Object.assign(new Error("aborted"), { name: "AbortError" });

    return json(listingFor(domain in MARKET ? domain : "__unknown__", { format }));
  }

  // ---- SearchApi: Meta Ad Library -----------------------------------------
  if (url.includes("searchapi.io")) {
    const q = new URL(url).searchParams;
    const engine = q.get("engine");

    if (META_FAIL === "quota") return json({ error: "Plan limit exceeded." }, 429);
    if (META_FAIL === "auth") return json({ error: "Invalid api key." }, 401);

    if (engine === "meta_ad_library_page_search") {
      return json(pageSearchResponse(q.get("q")));
    }
    if (engine === "meta_ad_library") {
      // The union question is settled: `all` is a superset. A credit_ads call
      // is a doubled bill for no new records, so it is an outright failure here
      // rather than something a test has to remember to look for.
      if (q.get("ad_type") !== "all") return json({ error: "test: ad_type must be all" }, 400);
      return json(adsResponse(q.get("page_id"), q.get("next_page_token")));
    }
    return json({ error: "unknown engine" }, 400);
  }

  // ---- Meta CDN: signed, expiring media ------------------------------------
  if (url.includes("fbcdn.net")) {
    if (META_MEDIA_403) return new Response("forbidden", { status: 403 });
    const m = url.match(/\/([0-9]+)_n\.jpg/);
    const png = jpegish(m ? Number(m[1]) : 1);
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  }

  if (url.includes("tpc.googlesyndication.com")) {
    if (IMG_403) return new Response("forbidden", { status: 403 });
    const png = PNG_BY_ID.get(url.split("/").pop());
    if (!png) return new Response("not found", { status: 404 });
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  }

  return realFetch(input, init);
};

// ---------------------------------------------------------------------------
// 2. The model, as a real loopback HTTP server.
//
// The vision reply is looked up from the base64 the model was actually handed,
// so it is deterministic AND proves the right pixels reached the right record.
// A benchmark count that changes between identical runs is untestable.
// ---------------------------------------------------------------------------
const anthropic = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* answered below */ }

    const blocks = body.messages?.[0]?.content;
    const img = Array.isArray(blocks) ? blocks.find((b) => b.type === "image") : null;

    let text;
    if (img) {
      if (VISION_FAIL) {
        text = "I'm sorry, I cannot read this creative.";
      } else {
        const id = ID_BY_B64.get(img.source.data);
        // WHICH READER IS ASKING. The search prompt and the banner prompt want
        // different shapes; answering both with the banner shape would leave
        // the search reader — and everything the benchmark board counts —
        // untested while still reporting green.
        const isSearch = String(body.system || "").includes("THE DESCRIPTION IS NOT DECORATION");
        const rec = id ? (isSearch ? searchExtractionFor(id) : extractionFor(id)) : null;
        if (rec) {
          text = JSON.stringify(rec);
        } else if (String(body.system || "").includes("Facebook or Instagram")) {
          // The Meta fallback prompt. Answers ONLY what the free tiers could not
          // resolve — and deliberately answers with a LOW-confidence "other",
          // because the fixture routes to vision exactly the creatives that
          // carry no product signal. A confident product here would hide the
          // fact that the deterministic tiers are what do the real work.
          text = JSON.stringify({
            headlineInArt: "Built by the community",
            offer: { present: false, type: "none", value: "", unit: "none", term: "", minimum: "", qualifier: "" },
            product: "other",
            productConfidence: 0.3,
            visualStyle: "photo",
            hasPeople: true,
            tone: "warm local",
            legible: true,
          });
        } else {
          text = "{}";
        }
      }
    } else {
      // The gated strategy pass. Digit-free on purpose: the contract is that
      // this model is handed pre-counted facts and never emits a number.
      text = JSON.stringify({
        angles: [{
          title: "Lead with the switching moment",
          evidence: "Competitors in this capture advertised a cash bonus; the client's captured ads did not.",
          opening: "A switch-focused message tested against the current creative.",
          question: "Does the client currently fund a switching incentive?",
        }],
        cautions: ["These are advertised offers, not confirmed product terms."],
      });
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_mock", type: "message", role: "assistant", model: "mock",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});

await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
anthropic.unref();
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;
// node-fetch honours NO_PROXY; loopback must never go through a proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
