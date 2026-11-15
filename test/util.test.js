import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, normalizeUrl, isCrawlable, canonical, isEmail, sameSite } from "../src/util.js";

test("normalizeUrl adds https and rejects private hosts", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("http://shop.example.com/a#x"), "http://shop.example.com/a");
  assert.throws(() => normalizeUrl("localhost"));
  assert.throws(() => normalizeUrl("http://192.168.1.1"));
  assert.throws(() => normalizeUrl("ftp://example.com"));
  assert.throws(() => normalizeUrl(""));
});

test("sameSite ignores www", () => {
  assert.ok(sameSite("https://www.a.com/x", "https://a.com/"));
  assert.ok(!sameSite("https://b.com/", "https://a.com/"));
});

test("isCrawlable filters files, other sites and admin paths", () => {
  const root = "https://a.com/";
  assert.ok(isCrawlable("https://a.com/services", root));
  assert.ok(!isCrawlable("https://a.com/file.pdf", root));
  assert.ok(!isCrawlable("https://b.com/", root));
  assert.ok(!isCrawlable("https://a.com/wp-admin/x", root));
  assert.ok(!isCrawlable("mailto:x@a.com", root));
});

test("canonical drops query, hash and trailing slash", () => {
  assert.equal(canonical("https://a.com/p/?x=1#h"), "https://a.com/p");
  assert.equal(canonical("https://a.com/"), "https://a.com/");
});

test("chunkText splits long text into bounded chunks", () => {
  const text = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains a service detail.`).join(" ");
  const chunks = chunkText(text, 300, 50);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= 300 + 60, `chunk too long: ${c.length}`);
  assert.deepEqual(chunkText("short"), []);
});

test("isEmail", () => {
  assert.ok(isEmail("a.b@example.co.uk"));
  assert.ok(!isEmail("nope"));
  assert.ok(!isEmail("a@b"));
});

import { urlScore } from "../src/crawl.js";
test("urlScore prefers product pages over investor/news pages", () => {
  const good = urlScore("https://x.com/CVCFLBD/Products/DepositScheme");
  const bad = urlScore("https://x.com/CVCFLBD/Investor/AnnualReports");
  const news = urlScore("https://x.com/news/2024/05/agm-notice");
  assert.ok(good > bad, `${good} > ${bad}`);
  assert.ok(good > news);
  assert.ok(urlScore("https://x.com/contact") > urlScore("https://x.com/privacy-policy"));
});
