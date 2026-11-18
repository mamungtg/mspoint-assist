// MSPoint Assist — Worker entry point (API under /api/*, everything else is static assets).
import { crawlSite } from "./crawl.js";
import { MAX_INSTRUCTIONS, answer, deleteBotVectors, indexBot, qualifyLead, retrieve } from "./rag.js";
import { DEMO_BOT, DEMO_KNOWLEDGE } from "./demo.js";
import {
  CORS, HttpError, clip, hourKey, isEmail, json, normalizeUrl, parsePriorityUrls, randomId, randomKey, safeEqual, sha256, today,
} from "./util.js";

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 32_000) throw new HttpError(413, "Request too large.");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

async function getBot(env, id) {
  if (id === DEMO_BOT.id) return { ...DEMO_BOT, status: "ready" };
  if (!/^[a-z0-9_]{6,40}$/.test(id || "")) return null;
  return env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first();
}

function bearer(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

// The built-in demo assistant is owned by MSPoint: its leads open with the ADMIN_KEY secret.
async function requireOwner(env, request, id, { allowDemo = false } = {}) {
  const key = bearer(request);
  if (id === DEMO_BOT.id) {
    if (!allowDemo) throw new HttpError(403, "The demo assistant cannot be changed.");
    if (!env.ADMIN_KEY || !key || !safeEqual(await sha256(key), await sha256(env.ADMIN_KEY))) {
      throw new HttpError(401, "Invalid owner key.");
    }
    return {
      ...DEMO_BOT, status: "ready", owner_email: "support@mspointbd.com", plan: "internal",
      status_detail: null, pages_indexed: 0, chunks: 0, created_at: null, updated_at: null, instructions: "",
    };
  }
  const bot = await getBot(env, id);
  if (!bot) throw new HttpError(404, "Assistant not found.");
  if (!key || !safeEqual(await sha256(key), bot.key_hash)) throw new HttpError(401, "Invalid owner key.");
  return bot;
}

function publicBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    site_url: bot.site_url,
    status: bot.status,
    greeting: bot.greeting || `Hi! Ask me anything about ${bot.name}.`,
  };
}

// Crawl + index, then record the result in D1.
async function runIndexing(env, bot, maxPages) {
  try {
    let priority = [];
    try { priority = JSON.parse(bot.priority_urls || "[]"); } catch { priority = []; }
    const pages = await crawlSite(bot.site_url, maxPages, priority);
    if (!pages.length) {
      await env.DB.prepare(
        "UPDATE bots SET status='error', status_detail=?, updated_at=datetime('now') WHERE id=?",
      ).bind("No readable pages were found on this website.", bot.id).run();
      return;
    }
    const chunks = await indexBot(env, bot.id, pages, bot.chunks || 0);
    await env.DB.prepare(
      "UPDATE bots SET status='ready', status_detail=NULL, pages_indexed=?, chunks=?, updated_at=datetime('now') WHERE id=?",
    ).bind(pages.length, chunks, bot.id).run();
  } catch (err) {
    console.error("indexing failed", bot.id, err);
    await env.DB.prepare(
      "UPDATE bots SET status='error', status_detail=?, updated_at=datetime('now') WHERE id=?",
    ).bind(clip(String(err?.message || err), 300), bot.id).run();
  }
}

// Cloudflare Turnstile check. Enforced only when TURNSTILE_SECRET is configured.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw new HttpError(400, "Please complete the security check.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(token).slice(0, 2048));
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const codes = Array.isArray(j["error-codes"]) ? j["error-codes"] : [];
    console.error("turnstile siteverify failed", JSON.stringify(codes));
    if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) {
      // Our configuration is wrong, not the visitor: say so instead of blaming them.
      throw new HttpError(503, "Signup is temporarily unavailable (security check misconfigured). Please contact support@mspointbd.com.");
    }
    throw new HttpError(400, "Security check failed. Please try again.");
  }
}

// ---- Handlers ---------------------------------------------------------------

async function createBot(request, env) {
  const body = await readJson(request);
  const name = clip(body.name, 80);
  const email = clip(body.email, 200).toLowerCase();
  if (!name) throw new HttpError(400, "Business name is required.");
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid mail address.");
  const siteUrl = normalizeUrl(body.website);
  await verifyTurnstile(env, body.turnstile, request.headers.get("cf-connecting-ip"));

  // Free beta: one assistant per owner mail address.
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM bots WHERE owner_email = ?").bind(email).first();
  if ((existing?.n || 0) >= 1) {
    throw new HttpError(409, "This mail address already has an assistant on the free beta. Open the dashboard with your owner key, or contact support@mspointbd.com.");
  }

  const id = randomId("b", 8);
  const key = randomKey();
  const greeting = `Hi! I'm the ${name} assistant. How can I help you today?`;
  await env.DB.prepare(
    "INSERT INTO bots (id, name, site_url, owner_email, key_hash, greeting) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, name, siteUrl, email, await sha256(key), greeting).run();

  // Index while the client waits (usually 15-60 s). Running inside the request
  // avoids the 30 s limit that applies to background work after a response.
  await runIndexing(env, { id, site_url: siteUrl, chunks: 0 }, Number(env.MAX_CRAWL_PAGES || 12));
  const done = await getBot(env, id);

  const origin = new URL(request.url).origin;
  return json({
    id,
    owner_key: key,
    status: done.status,
    status_detail: done.status_detail,
    pages_indexed: done.pages_indexed,
    embed_code: `<script src="${origin}/widget.js" data-bot="${id}" async></script>`,
    dashboard_url: `${origin}/dashboard#${id}`,
  }, 201);
}

async function botInfo(env, id) {
  const bot = await getBot(env, id);
  if (!bot) throw new HttpError(404, "Assistant not found.");
  return json(publicBot(bot), 200, { "cache-control": "public, max-age=30" });
}

async function chat(request, env, ctx) {
  const body = await readJson(request);
  const bot = await getBot(env, String(body.bot || ""));
  if (!bot) throw new HttpError(404, "Assistant not found.");
  if (bot.status !== "ready") {
    return json({ reply: "I'm still learning this website. Please try again in a minute, or leave your details and the team will get back to you.", lead_prompt: true });
  }
  const question = clip(body.message, 600);
  if (!question) throw new HttpError(400, "Message is empty.");
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  // Per-visitor limit: one person cannot use up the assistant's daily quota.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const visitor = (await sha256(ip + "|" + bot.id)).slice(0, 32);
  const hour = hourKey();
  const v = await env.DB.prepare(
    `INSERT INTO visitor_usage (bot_id, visitor, hour, messages) VALUES (?, ?, ?, 1)
     ON CONFLICT (bot_id, visitor, hour) DO UPDATE SET messages = messages + 1
     RETURNING messages`,
  ).bind(bot.id, visitor, hour).first();
  if ((v?.messages || 0) > Number(env.VISITOR_HOURLY_MESSAGES || 30)) {
    return json({ reply: "You've sent a lot of messages in a short time. Please wait a little, or leave your details and the team will reply to you directly.", lead_prompt: true });
  }
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM visitor_usage WHERE hour < ?").bind(hourKey(new Date(Date.now() - 2 * 86400_000))).run());
  }

  // Daily quota per assistant (free beta).
  const limit = Number(env.FREE_DAILY_MESSAGES || 100) * (bot.id === DEMO_BOT.id ? 10 : 1);
  const day = today();
  const row = await env.DB.prepare(
    `INSERT INTO usage (bot_id, day, messages) VALUES (?, ?, 1)
     ON CONFLICT (bot_id, day) DO UPDATE SET messages = messages + 1
     RETURNING messages`,
  ).bind(bot.id, day).first();
  if ((row?.messages || 0) > limit) {
    return json({ reply: "The assistant has reached today's message limit. Please leave your details and the team will reply to you directly.", lead_prompt: true });
  }

  let context;
  let sources = [];
  if (bot.id === DEMO_BOT.id) {
    context = DEMO_KNOWLEDGE.trim();
  } else {
    const hits = await retrieve(env, bot.id, question);
    context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");
    sources = [...new Set(hits.map((h) => h.url))].slice(0, 3);
  }

  const reply = await answer(env, {
    businessName: bot.name, siteUrl: bot.site_url, context, history, question, instructions: bot.instructions,
  });
  const unsure = /not sure|don't have|do not have|couldn't find|pass (your|the) question|leave your/i.test(reply);
  return json({ reply, sources, lead_prompt: unsure || !context });
}

async function createLead(request, env) {
  const body = await readJson(request);
  const bot = await getBot(env, String(body.bot || ""));
  if (!bot) throw new HttpError(404, "Assistant not found.");
  const email = clip(body.email, 200);
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid mail address.");

  // At most 20 leads per assistant per hour (spam guard).
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE bot_id = ? AND created_at > datetime('now', '-1 hour')",
  ).bind(bot.id).first();
  if ((recent?.n || 0) >= 20) throw new HttpError(429, "Too many submissions. Please try again later.");

  const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: clip(m.content, 1000) }));
  const lead = {
    name: clip(body.name, 120), company: clip(body.company, 120), phone: clip(body.phone, 40),
    message: clip(body.message, 2000), page_url: clip(body.page_url, 500),
  };
  const { priority, summary } = await qualifyLead(env, { businessName: bot.name, lead, transcript });

  await env.DB.prepare(
    `INSERT INTO leads (bot_id, name, email, phone, message, page_url, company, priority, summary, transcript)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    bot.id, lead.name, email, lead.phone, lead.message, lead.page_url,
    lead.company, priority, summary, transcript.length ? JSON.stringify(transcript) : null,
  ).run();
  return json({ ok: true }, 201);
}

async function ownerBot(request, env, id) {
  const bot = await requireOwner(env, request, id, { allowDemo: true });
  const usage = await env.DB.prepare(
    "SELECT day, messages FROM usage WHERE bot_id = ? ORDER BY day DESC LIMIT 30",
  ).bind(id).all();
  const leadCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE bot_id = ?").bind(id).first();
  const origin = new URL(request.url).origin;
  return json({
    id: bot.id, name: bot.name, site_url: bot.site_url, owner_email: bot.owner_email, plan: bot.plan,
    status: bot.status, status_detail: bot.status_detail, pages_indexed: bot.pages_indexed, chunks: bot.chunks,
    created_at: bot.created_at, updated_at: bot.updated_at, leads: leadCount?.n || 0,
    usage: usage.results || [],
    instructions: bot.instructions || "", greeting: bot.greeting || "",
    priority_urls: (() => { try { return JSON.parse(bot.priority_urls || "[]"); } catch { return []; } })(),
    is_demo: bot.id === DEMO_BOT.id,
    embed_code: `<script src="${origin}/widget.js" data-bot="${bot.id}" async></script>`,
  });
}

async function updateSettings(request, env, id) {
  await requireOwner(env, request, id);
  const body = await readJson(request);
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : null;
  const greeting = typeof body.greeting === "string" ? clip(body.greeting, 300) : null;
  const name = typeof body.name === "string" ? clip(body.name, 80) : null;
  const bot = await getBot(env, id);
  const priority = body.priority_urls !== undefined ? JSON.stringify(parsePriorityUrls(body.priority_urls, bot.site_url)) : null;
  if (instructions && instructions.length > MAX_INSTRUCTIONS) {
    throw new HttpError(400, `Instructions are too long (max ${MAX_INSTRUCTIONS} characters).`);
  }
  await env.DB.prepare(
    `UPDATE bots SET
       instructions = COALESCE(?, instructions),
       greeting = COALESCE(NULLIF(?, ''), greeting),
       name = COALESCE(NULLIF(?, ''), name),
       priority_urls = COALESCE(?, priority_urls),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(instructions, greeting, name, priority, id).run();
  return json({ ok: true });
}

async function ownerLeads(request, env, id) {
  await requireOwner(env, request, id, { allowDemo: true });
  const rows = await env.DB.prepare(
    "SELECT id, name, company, email, phone, message, priority, summary, transcript, page_url, created_at FROM leads WHERE bot_id = ? ORDER BY created_at DESC LIMIT 500",
  ).bind(id).all();
  return json({ leads: rows.results || [] });
}

async function reindex(request, env, id) {
  const bot = await requireOwner(env, request, id);
  if (bot.status === "indexing" && Date.parse(bot.updated_at + "Z") > Date.now() - 5 * 60_000) {
    throw new HttpError(409, "Indexing is already running. Please wait a few minutes.");
  }
  await env.DB.prepare("UPDATE bots SET status='indexing', updated_at=datetime('now') WHERE id=?").bind(id).run();
  await runIndexing(env, bot, Number(env.MAX_CRAWL_PAGES || 12));
  const done = await getBot(env, id);
  return json({ ok: true, status: done.status, status_detail: done.status_detail, pages_indexed: done.pages_indexed });
}

async function deleteBot(request, env, id) {
  const bot = await requireOwner(env, request, id);
  const vectorError = await deleteBotVectors(env, id, bot.chunks || 0);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM leads WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM usage WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM bots WHERE id = ?").bind(id),
    ]);
  } catch (err) {
    console.error("db delete failed", id, err);
    throw new HttpError(500, "Could not delete the assistant: " + clip(String(err?.message || err), 200));
  }
  return json({ ok: true, vector_cleanup: vectorError ? "pending" : "done" });
}

// ---- Router -----------------------------------------------------------------

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const m = request.method;

  if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (pathname === "/api/health") return json({ ok: true, service: env.PRODUCT_NAME || "MSPoint Assist" });
  if (pathname === "/api/config" && m === "GET") {
    return json({ turnstile_site_key: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY || null) : null }, 200, { "cache-control": "public, max-age=300" });
  }
  if (pathname === "/api/bots" && m === "POST") return createBot(request, env);
  if (pathname === "/api/chat" && m === "POST") return chat(request, env, ctx);
  if (pathname === "/api/leads" && m === "POST") return createLead(request, env);

  let p;
  if ((p = pathname.match(/^\/api\/bots\/([a-z0-9_]+)\/public$/)) && m === "GET") return botInfo(env, p[1]);
  if ((p = pathname.match(/^\/api\/bots\/([a-z0-9_]+)\/leads$/)) && m === "GET") return ownerLeads(request, env, p[1]);
  if ((p = pathname.match(/^\/api\/bots\/([a-z0-9_]+)\/reindex$/)) && m === "POST") return reindex(request, env, p[1]);
  if ((p = pathname.match(/^\/api\/bots\/([a-z0-9_]+)\/settings$/)) && m === "POST") return updateSettings(request, env, p[1]);
  if ((p = pathname.match(/^\/api\/bots\/([a-z0-9_]+)$/))) {
    if (m === "GET") return ownerBot(request, env, p[1]);
    if (m === "DELETE") return deleteBot(request, env, p[1]);
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("unhandled", err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};
