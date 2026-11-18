// MSPoint Assist — Worker entry point (API under /api/*, everything else is static assets).
import { crawlSite } from "./crawl.js";
import { MAX_INSTRUCTIONS, REFUSAL, answer, deleteBotVectors, indexBot, looksLikeInjection, qualifyLead, retrieve } from "./rag.js";
import { DEMO_BOT, DEMO_KNOWLEDGE } from "./demo.js";
import { leadAlertMail, loginMail, mailEnabled, sendMail, welcomeMail } from "./mail.js";
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

// Public endpoints (widget, chat, leads) ignore suspended assistants.
async function getActiveBot(env, id) {
  const bot = await getBot(env, id);
  return bot && !bot.suspended ? bot : null;
}

const maxPagesFor = (env, bot) => Number(bot?.max_pages || env.MAX_CRAWL_PAGES || 12);
const dailyLimitFor = (env, bot) =>
  bot?.daily_limit != null ? Number(bot.daily_limit) : Number(env.FREE_DAILY_MESSAGES || 100) * (bot?.id === DEMO_BOT.id ? 10 : 1);

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

async function createBot(request, env, ctx) {
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
  await runIndexing(env, { id, site_url: siteUrl, chunks: 0 }, maxPagesFor(env, null));
  const done = await getBot(env, id);

  const origin = new URL(request.url).origin;
  const w = welcomeMail({ botName: name, botId: id, dashboardUrl: `${origin}/dashboard#${id}`, previewUrl: `${origin}/try#${id}` });
  ctx.waitUntil(sendMail(env, { to: email, toName: name, ...w }).catch((e) => console.error("welcome mail", e)));
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
  const bot = await getActiveBot(env, id);
  if (!bot) throw new HttpError(404, "Assistant not found.");
  return json(publicBot(bot), 200, { "cache-control": "public, max-age=30" });
}

async function chat(request, env, ctx) {
  const body = await readJson(request);
  const bot = await getActiveBot(env, String(body.bot || ""));
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
  const limit = dailyLimitFor(env, bot);
  const day = today();
  const row = await env.DB.prepare(
    `INSERT INTO usage (bot_id, day, messages) VALUES (?, ?, 1)
     ON CONFLICT (bot_id, day) DO UPDATE SET messages = messages + 1
     RETURNING messages`,
  ).bind(bot.id, day).first();
  if ((row?.messages || 0) > limit) {
    return json({ reply: "The assistant has reached today's message limit. Please leave your details and the team will reply to you directly.", lead_prompt: true });
  }

  // Obvious prompt-injection attempts get a fixed reply without calling the model.
  if (looksLikeInjection(question)) return json({ reply: REFUSAL, sources: [], lead_prompt: false });

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
  const unsure = /not sure|couldn't find|could not find|don't have|do not have|contact the team|pass (your|the) question|leave your|name and (e-?mail|mail)|follow up with you/i.test(reply);
  return json({ reply, sources, lead_prompt: unsure || !context });
}

async function createLead(request, env, ctx) {
  const body = await readJson(request);
  const bot = await getActiveBot(env, String(body.bot || ""));
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

  const ownerMail = bot.id === DEMO_BOT.id ? (env.DEMO_LEAD_MAIL || "support@mspointbd.com") : bot.owner_email;
  if (ownerMail) {
    const origin = new URL(request.url).origin;
    const m = leadAlertMail({ botName: bot.name, lead: { ...lead, email }, priority, summary, dashboardUrl: `${origin}/dashboard#${bot.id}` });
    ctx.waitUntil(sendMail(env, { to: ownerMail, ...m, replyTo: email }).catch((e) => console.error("lead alert", e)));
  }
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
    suspended: Boolean(bot.suspended),
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
  await runIndexing(env, bot, maxPagesFor(env, bot));
  const done = await getBot(env, id);
  return json({ ok: true, status: done.status, status_detail: done.status_detail, pages_indexed: done.pages_indexed });
}

async function deleteBotData(env, bot) {
  const id = bot.id;
  const vectorError = await deleteBotVectors(env, id, bot.chunks || 0);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM leads WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM usage WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM visitor_usage WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM login_tokens WHERE bot_id = ?").bind(id),
      env.DB.prepare("DELETE FROM bots WHERE id = ?").bind(id),
    ]);
  } catch (err) {
    console.error("db delete failed", id, err);
    throw new HttpError(500, "Could not delete the assistant: " + clip(String(err?.message || err), 200));
  }
  return json({ ok: true, vector_cleanup: vectorError ? "pending" : "done" });
}

async function deleteBot(request, env, id) {
  const bot = await requireOwner(env, request, id);
  return deleteBotData(env, bot);
}

// ---- Mail sign-in (owner key recovery) ----------------------------------------

async function requestLogin(request, env) {
  if (!mailEnabled(env)) throw new HttpError(503, "Sign-in by mail is not available yet. Please contact support@mspointbd.com.");
  const body = await readJson(request);
  const email = clip(body.email, 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid mail address.");
  const generic = json({ ok: true, message: "If this address has an assistant, a sign-in link is on its way. Check your inbox and spam folder." });

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > datetime('now', '-2 minutes')",
  ).bind(email).first();
  if ((recent?.n || 0) > 0) return generic;

  const bots = await env.DB.prepare("SELECT id, name FROM bots WHERE owner_email = ? LIMIT 10").bind(email).all();
  const list = bots.results || [];
  if (!list.length) return generic;

  await mailLoginLinks(env, new URL(request.url).origin, email, list);
  return generic;
}

async function mailLoginLinks(env, origin, email, bots) {
  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  const links = [];
  for (const b of bots) {
    const token = randomKey().replace(/^msa_/, "");
    await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, bot_id, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), email, b.id, expires).run();
    links.push({ name: b.name, url: `${origin}/dashboard#login=${token}` });
  }
  try {
    await sendMail(env, { to: email, ...loginMail({ links }) });
  } catch (err) {
    console.error("login mail failed", err);
    throw new HttpError(502, "Could not send the sign-in mail right now: " + clip(String(err?.message || err), 160));
  }
  await env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(new Date(Date.now() - 86400_000).toISOString()).run();
}

async function verifyLogin(request, env) {
  const body = await readJson(request);
  const token = String(body.token || "").trim();
  if (!token || token.length > 200) throw new HttpError(400, "Invalid sign-in link.");
  const row = await env.DB.prepare(
    "UPDATE login_tokens SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > ? RETURNING bot_id",
  ).bind(await sha256(token), new Date().toISOString()).first();
  if (!row) throw new HttpError(400, "This sign-in link has expired or was already used. Please request a new one.");
  const key = randomKey();
  await env.DB.prepare("UPDATE bots SET key_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(await sha256(key), row.bot_id).run();
  return json({ bot_id: row.bot_id, owner_key: key });
}

// ---- Admin (ADMIN_KEY) --------------------------------------------------------

async function requireAdmin(env, request) {
  if (!env.ADMIN_KEY) throw new HttpError(503, "Admin access is not configured (ADMIN_KEY secret missing).");
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const visitor = (await sha256("admin-fail|" + ip)).slice(0, 32);
  const hour = hourKey();
  const fails = await env.DB.prepare(
    "SELECT messages FROM visitor_usage WHERE bot_id = '__admin__' AND visitor = ? AND hour = ?",
  ).bind(visitor, hour).first();
  if ((fails?.messages || 0) >= 20) throw new HttpError(429, "Too many failed attempts. Try again in an hour.");
  const key = bearer(request);
  if (!key || !safeEqual(await sha256(key), await sha256(env.ADMIN_KEY))) {
    await env.DB.prepare(
      `INSERT INTO visitor_usage (bot_id, visitor, hour, messages) VALUES ('__admin__', ?, ?, 1)
       ON CONFLICT (bot_id, visitor, hour) DO UPDATE SET messages = messages + 1`,
    ).bind(visitor, hour).run();
    throw new HttpError(401, "Invalid admin key.");
  }
}

async function adminOverview(env) {
  const bots = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'ready'), 0) AS ready, COALESCE(SUM(status = 'error'), 0) AS errors,
       COALESCE(SUM(status = 'indexing'), 0) AS indexing, COALESCE(SUM(suspended), 0) AS suspended,
       COALESCE(SUM(created_at > datetime('now', '-7 days')), 0) AS new7
     FROM bots`,
  ).first();
  const leads = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(created_at > datetime('now', '-7 days')), 0) AS last7,
       COALESCE(SUM(priority = 'high' AND created_at > datetime('now', '-7 days')), 0) AS high7
     FROM leads`,
  ).first();
  const msgs = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN day = ? THEN messages END), 0) AS today,
       COALESCE(SUM(CASE WHEN day >= date('now', '-30 days') THEN messages END), 0) AS last30
     FROM usage`,
  ).bind(today()).first();
  const series = await env.DB.prepare(
    "SELECT day, SUM(messages) AS messages FROM usage WHERE day >= date('now', '-13 days') GROUP BY day ORDER BY day",
  ).all();
  const signups = await env.DB.prepare(
    "SELECT date(created_at) AS day, COUNT(*) AS n FROM bots WHERE created_at >= date('now', '-13 days') GROUP BY day ORDER BY day",
  ).all();
  return json({
    bots, leads, messages: msgs, series: series.results || [], signups: signups.results || [],
    config: {
      mail: mailEnabled(env) ? (env.ZEPTOMAIL_TOKEN ? "ZeptoMail" : "Zoho SMTP") : "off",
      turnstile: Boolean(env.TURNSTILE_SECRET), free_daily_messages: Number(env.FREE_DAILY_MESSAGES || 100),
      max_crawl_pages: Number(env.MAX_CRAWL_PAGES || 12), visitor_hourly_messages: Number(env.VISITOR_HOURLY_MESSAGES || 30),
    },
  });
}

async function adminBots(env) {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.name, b.site_url, b.owner_email, b.plan, b.status, b.status_detail, b.pages_indexed, b.chunks,
       b.suspended, b.daily_limit, b.max_pages, b.admin_note, b.created_at, b.updated_at,
       (SELECT COUNT(*) FROM leads l WHERE l.bot_id = b.id) AS leads,
       (SELECT COALESCE(SUM(messages), 0) FROM usage u WHERE u.bot_id = b.id AND u.day >= date('now', '-30 days')) AS msgs30,
       (SELECT COALESCE(SUM(messages), 0) FROM usage u WHERE u.bot_id = b.id AND u.day = ?) AS msgs_today
     FROM bots b ORDER BY b.created_at DESC LIMIT 2000`,
  ).bind(today()).all();
  const demo = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM leads WHERE bot_id = 'demo') AS leads,
       (SELECT COALESCE(SUM(messages), 0) FROM usage WHERE bot_id = 'demo' AND day >= date('now', '-30 days')) AS msgs30`,
  ).first();
  return json({ bots: rows.results || [], demo });
}

async function adminBotDetail(env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  const { key_hash, ...safe } = bot;
  const leads = await env.DB.prepare(
    "SELECT id, name, company, email, phone, message, priority, summary, transcript, page_url, created_at FROM leads WHERE bot_id = ? ORDER BY created_at DESC LIMIT 300",
  ).bind(id).all();
  const usage = await env.DB.prepare("SELECT day, messages FROM usage WHERE bot_id = ? ORDER BY day DESC LIMIT 30").bind(id).all();
  let priority = [];
  try { priority = JSON.parse(bot.priority_urls || "[]"); } catch { priority = []; }
  return json({
    ...safe, priority_urls: priority, suspended: Boolean(bot.suspended),
    effective_daily_limit: dailyLimitFor(env, bot), effective_max_pages: maxPagesFor(env, bot),
    leads: leads.results || [], usage: usage.results || [],
  });
}

const PLANS = ["free", "starter", "pro", "internal"];

async function adminUpdateBot(request, env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  const b = await readJson(request);
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  const intOrNull = (v, min, max, label) => {
    if (v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  if (b.suspended !== undefined) set("suspended", b.suspended ? 1 : 0);
  if (b.plan !== undefined) {
    if (!PLANS.includes(b.plan)) throw new HttpError(400, "Unknown plan.");
    set("plan", b.plan);
  }
  if (b.daily_limit !== undefined) set("daily_limit", intOrNull(b.daily_limit, 0, 1_000_000, "Daily message limit"));
  if (b.max_pages !== undefined) set("max_pages", intOrNull(b.max_pages, 1, 200, "Max pages"));
  if (b.admin_note !== undefined) set("admin_note", clip(b.admin_note, 2000));
  if (typeof b.name === "string" && b.name.trim()) set("name", clip(b.name, 80));
  if (typeof b.greeting === "string" && b.greeting.trim()) set("greeting", clip(b.greeting, 300));
  if (typeof b.instructions === "string") {
    if (b.instructions.length > MAX_INSTRUCTIONS) throw new HttpError(400, `Instructions are too long (max ${MAX_INSTRUCTIONS}).`);
    set("instructions", b.instructions.trim());
  }
  if (b.priority_urls !== undefined) set("priority_urls", JSON.stringify(parsePriorityUrls(b.priority_urls, bot.site_url)));
  if (typeof b.owner_email === "string") {
    const e = clip(b.owner_email, 200).toLowerCase();
    if (!isEmail(e)) throw new HttpError(400, "Owner mail is not valid.");
    set("owner_email", e);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update.");
  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return json({ ok: true });
}

async function adminReindex(env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  await env.DB.prepare("UPDATE bots SET status='indexing', updated_at=datetime('now') WHERE id=?").bind(id).run();
  await runIndexing(env, bot, maxPagesFor(env, bot));
  const done = await getBot(env, id);
  return json({ ok: true, status: done.status, status_detail: done.status_detail, pages_indexed: done.pages_indexed });
}

async function adminResetKey(env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  const key = randomKey();
  await env.DB.prepare("UPDATE bots SET key_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(await sha256(key), id).run();
  return json({ ok: true, owner_key: key });
}

async function adminSendLogin(request, env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  if (!mailEnabled(env)) throw new HttpError(503, "Mail is not configured.");
  await mailLoginLinks(env, new URL(request.url).origin, bot.owner_email, [bot]);
  return json({ ok: true, sent_to: bot.owner_email });
}

async function adminDeleteBot(env, id) {
  const bot = await getBot(env, id);
  if (!bot || id === DEMO_BOT.id) throw new HttpError(404, "Assistant not found.");
  return deleteBotData(env, bot);
}

async function adminLeads(env, url) {
  const priority = url.searchParams.get("priority");
  const where = ["high", "medium", "low"].includes(priority) ? "WHERE l.priority = ?" : "";
  const stmt = env.DB.prepare(
    `SELECT l.id, l.bot_id, COALESCE(b.name, CASE WHEN l.bot_id = 'demo' THEN 'Demo (landing page)' END) AS bot_name,
       l.name, l.company, l.email, l.phone, l.message, l.priority, l.summary, l.page_url, l.created_at
     FROM leads l LEFT JOIN bots b ON b.id = l.bot_id ${where}
     ORDER BY l.created_at DESC LIMIT 1000`,
  );
  const rows = await (where ? stmt.bind(priority) : stmt).all();
  return json({ leads: rows.results || [] });
}

async function adminDeleteLead(env, leadId) {
  await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(Number(leadId)).run();
  return json({ ok: true });
}

async function adminRoute(request, env, url, m) {
  await requireAdmin(env, request);
  const { pathname } = url;
  let p;
  if (pathname === "/api/admin/overview" && m === "GET") return adminOverview(env);
  if (pathname === "/api/admin/bots" && m === "GET") return adminBots(env);
  if (pathname === "/api/admin/leads" && m === "GET") return adminLeads(env, url);
  if ((p = pathname.match(/^\/api\/admin\/leads\/(\d+)$/)) && m === "DELETE") return adminDeleteLead(env, p[1]);
  if ((p = pathname.match(/^\/api\/admin\/bots\/([a-z0-9_]+)\/reindex$/)) && m === "POST") return adminReindex(env, p[1]);
  if ((p = pathname.match(/^\/api\/admin\/bots\/([a-z0-9_]+)\/reset-key$/)) && m === "POST") return adminResetKey(env, p[1]);
  if ((p = pathname.match(/^\/api\/admin\/bots\/([a-z0-9_]+)\/send-login$/)) && m === "POST") return adminSendLogin(request, env, p[1]);
  if ((p = pathname.match(/^\/api\/admin\/bots\/([a-z0-9_]+)$/))) {
    if (m === "GET") return adminBotDetail(env, p[1]);
    if (m === "POST") return adminUpdateBot(request, env, p[1]);
    if (m === "DELETE") return adminDeleteBot(env, p[1]);
  }
  throw new HttpError(404, "Not found.");
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
  if (pathname === "/api/bots" && m === "POST") return createBot(request, env, ctx);
  if (pathname === "/api/chat" && m === "POST") return chat(request, env, ctx);
  if (pathname === "/api/leads" && m === "POST") return createLead(request, env, ctx);
  if (pathname === "/api/auth/request" && m === "POST") return requestLogin(request, env);
  if (pathname === "/api/auth/verify" && m === "POST") return verifyLogin(request, env);
  if (pathname.startsWith("/api/admin/")) return adminRoute(request, env, url, m);

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
