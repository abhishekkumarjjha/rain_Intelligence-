// =============================================================================
// lib/media-store.js — durable local copies of Meta creative media.
//
// Google's `simgad` URLs are archival: they are still serving creatives first
// shown in 2023, which is why the Google path can hotlink them through a proxy
// and keep nothing.
//
// Meta's are not. Every media URL the probe returned was a signed
// `fbcdn.net` link carrying an `oe=` expiry token and a per-request `_nc_gid`.
// They are fetch-now values. An evidence store that keeps only the URL is
// keeping a receipt, not the artifact — and the wall will render broken tiles
// the first time somebody reopens a run a week later.
//
// So Meta media is downloaded during capture, while the URL is still valid, and
// served from here afterwards. Content-addressed, so the same asset appearing
// under two ads is stored once.
// =============================================================================

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RI_DATA_DIR || path.join(__dirname, "..", "runs");
const MEDIA_DIR = path.join(DATA_DIR, "_media");

const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = Number(process.env.RI_MEDIA_TIMEOUT_MS || 12000);
const CONCURRENCY = 6;

// Same discipline as the Google image proxy: an allowlist, not "whatever URL a
// field contained". A downloader that will fetch any host is an SSRF hole
// pointed at everything else reachable from this box.
const META_HOSTS = /(^|\.)(fbcdn\.net|facebook\.com|xx\.fbcdn\.net)$/i;

try { mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* best effort */ }

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function hashOf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

function pathFor(hash, ext) {
  return path.join(MEDIA_DIR, `${hash}.${ext}`);
}

export function findMedia(hash) {
  const safe = String(hash || "").replace(/[^a-f0-9]/gi, "").slice(0, 24);
  if (!safe) return null;
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const p = pathFor(safe, ext);
    if (existsSync(p)) {
      return { path: p, contentType: Object.keys(EXT).find((k) => EXT[k] === ext), size: statSync(p).size };
    }
  }
  return null;
}

export function readMedia(hash) {
  const found = findMedia(hash);
  if (!found) return null;
  try { return { ...found, buffer: readFileSync(found.path) }; } catch { return null; }
}

/**
 * Download one asset and store it by content hash.
 * Returns `{ hash, contentType, bytes }` or null. A failed asset is never fatal:
 * one broken image is not a broken capture.
 */
export async function storeRemote(url) {
  const u = String(url || "");
  if (!/^https:\/\//i.test(u)) return null;
  let host;
  try { host = new URL(u).hostname; } catch { return null; }
  if (!META_HOSTS.test(host)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const ct = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = EXT[ct === "image/jpg" ? "image/jpeg" : ct];
    if (!ext) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;

    const hash = hashOf(buf);
    const p = pathFor(hash, ext);
    if (!existsSync(p)) writeFileSync(p, buf);
    return { hash, contentType: ct === "image/jpg" ? "image/jpeg" : ct, bytes: buf.length, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Store the representative asset for each message, bounded concurrency.
 * Mutates each message with `mediaHash` / `mediaStored`.
 *
 * For video units the PREVIEW FRAME is what gets stored. Full video is not
 * downloaded in v1 — nothing in the product reads motion or audio, so fetching
 * megabytes to show a thumbnail would be cost without a consumer. The unit keeps
 * `isVideo` so the card can say so honestly rather than implying the still is
 * the whole creative.
 */
export async function storeMessageMedia(messages = []) {
  let stored = 0, failed = 0;
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const batch = messages.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (m) => {
      const url = m.imageUrl || m.videoPreviewUrl;
      if (!url) { failed++; m.mediaStored = false; return; }
      const r = await storeRemote(url);
      if (r) { m.mediaHash = r.hash; m.mediaContentType = r.contentType; m.mediaStored = true; stored++; }
      else { m.mediaStored = false; failed++; }
    }));
  }
  return { stored, failed };
}
