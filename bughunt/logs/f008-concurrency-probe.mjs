// Paths are resolved from this file, not from the container that wrote it.
// The handover offers these as runnable evidence; hardcoded absolute paths
// made them runnable in exactly one place, which is the opposite of evidence.
const ROOT = new URL("../../", import.meta.url).href;
const load = (m) => import(ROOT + "lib/" + m);
// How many model calls does this process allow in flight at once?
// A local server counts concurrent requests and answers slowly enough that
// overlap is unmissable.
import http from "node:http";
process.env.ANTHROPIC_API_KEY = "test";

let live = 0, peak = 0, total = 0;
const srv = http.createServer((req, res) => {
  live++; total++; if (live > peak) peak = live;
  setTimeout(() => {
    live--;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));
  }, 120);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const { createWithRetry } = await load("claude.js");

// 40 calls fired at once — roughly what ten competitors × the per-advertiser
// cap of 6 produces, plus the analysis calls nothing was counting.
const N = 40;
await Promise.all(Array.from({ length: N }, () =>
  createWithRetry({ model: "x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    .catch(() => {})));

console.log(`fired            : ${N}`);
console.log(`reached the API  : ${total}`);
console.log(`peak in flight   : ${peak}`);
console.log(`RI_MODEL_CONCURRENCY: ${process.env.RI_MODEL_CONCURRENCY ?? "(unset — default applies if a limit exists)"}`);
srv.close();
