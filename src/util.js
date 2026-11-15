// Pure helpers (no Cloudflare bindings) so they can be unit-tested with node --test.

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extraHeaders },
  });

// The widget runs on customers' sites, so the public API allows any origin.
// Owner endpoints are protected by the bot key, not by origin.
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new HttpError(400, "Website URL is required.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid website URL.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "Only http(s) websites are supported.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || !host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    throw new HttpError(400, "Please use your public website domain.");
  }
  u.hash = "";
  return u.toString();
}

export function sameSite(a, b) {
  const strip = (h) => h.toLowerCase().replace(/^www\./, "");
  return strip(new URL(a).hostname) === strip(new URL(b).hostname);
}

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp4|mp3|wav|avi|mov|css|js|json|xml|woff2?|ttf|eot|docx?|xlsx?|pptx?)$/i;

export function isCrawlable(link, root) {
  try {
    const u = new URL(link);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (!sameSite(u.toString(), root)) return false;
    if (SKIP_EXT.test(u.pathname)) return false;
    if (/\/(wp-admin|wp-login|cart|checkout|my-account|login|signin|logout)\b/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function canonical(link) {
  const u = new URL(link);
  u.hash = "";
  u.search = "";
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

export function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/ /g, " ")
    .trim();
}

// Split text into ~maxLen-character chunks on sentence boundaries, with a small overlap.
export function chunkText(text, maxLen = 900, overlap = 120) {
  const clean = cleanText(text);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [clean];
  const chunks = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < s.length; i += maxLen - overlap) chunks.push(s.slice(i, i + maxLen));
      continue;
    }
    if ((cur + " " + s).trim().length > maxLen) {
      chunks.push(cur);
      const tail = cur.slice(-overlap);
      cur = (tail.includes(" ") ? tail.slice(tail.indexOf(" ") + 1) : "") + " " + s;
      cur = cur.trim();
    } else {
      cur = (cur + " " + s).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.length >= 40);
}

export function isEmail(s) {
  return /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i.test(String(s || "").trim());
}

export function clip(s, n) {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n) : s;
}

export function randomId(prefix = "", bytes = 9) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, bytes * 2);
}

export function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "msa_" + btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison for hex digests.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
