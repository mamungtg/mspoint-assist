// Small same-site crawler built on HTMLRewriter (streaming, low CPU).
import { canonical, cleanText, isCrawlable } from "./util.js";

const UA = "MSPointAssistBot/0.1 (+https://app.mspointbd.com)";
const MAX_HTML_BYTES = 1_500_000;

async function extractPage(res, pageUrl) {
  const links = new Set();
  let title = "";
  let description = "";
  const parts = [];
  let skipDepth = 0;

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, svg, iframe, template", {
      element(el) {
        skipDepth++;
        el.onEndTag(() => { skipDepth--; });
      },
    })
    .on("title", { text(t) { title += t.text; } })
    .on('meta[name="description"]', {
      element(el) { description = el.getAttribute("content") || ""; },
    })
    .on("a[href]", {
      element(el) {
        try { links.add(new URL(el.getAttribute("href"), pageUrl).toString()); } catch { /* ignore */ }
      },
    })
    .on("body *", {
      text(t) {
        if (skipDepth === 0 && t.text) parts.push(t.text);
        if (t.lastInTextNode) parts.push(" ");
      },
    });

  await rewriter.transform(res).arrayBuffer();
  const text = cleanText(parts.join(""));
  return { title: cleanText(title), description: cleanText(description), text, links: [...links] };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html")) return null;
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_HTML_BYTES) return null;
  return res;
}

// Breadth-first crawl starting at rootUrl, staying on the same site.
export async function crawlSite(rootUrl, maxPages = 12) {
  const queue = [canonical(rootUrl)];
  const seen = new Set(queue);
  const pages = [];

  // Pull in sitemap URLs when available (cheap way to find key pages).
  try {
    const sm = await fetch(new URL("/sitemap.xml", rootUrl), { headers: { "user-agent": UA } });
    if (sm.ok && (sm.headers.get("content-type") || "").includes("xml")) {
      const xml = (await sm.text()).slice(0, 300_000);
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const u = m[1];
        if (isCrawlable(u, rootUrl) && !u.endsWith(".xml")) {
          const c = canonical(u);
          if (!seen.has(c)) { seen.add(c); queue.push(c); }
        }
        if (queue.length > maxPages * 3) break;
      }
    }
  } catch { /* sitemap is optional */ }

  // Fetch in small parallel batches to keep total time low.
  const CONCURRENCY = 4;
  let attempts = 0;
  while (queue.length && pages.length < maxPages && attempts < maxPages * 3) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxPages - pages.length));
    attempts += batch.length;
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const res = await fetchHtml(url);
        return res ? { url, page: await extractPage(res, url) } : null;
      } catch {
        return null;
      }
    }));
    for (const r of results) {
      if (!r) continue;
      const { url, page } = r;
      if (page.text.length > 80 && pages.length < maxPages) {
        pages.push({ url, title: page.title, description: page.description, text: page.text });
      }
      for (const l of page.links) {
        if (!isCrawlable(l, rootUrl)) continue;
        const c = canonical(l);
        if (!seen.has(c)) { seen.add(c); queue.push(c); }
      }
    }
  }
  return pages;
}
