// Transactional mail. Uses Zoho ZeptoMail's HTTP API when ZEPTOMAIL_TOKEN is set,
// otherwise Zoho Mail SMTP when SMTP_USER + SMTP_PASSWORD are set.
import { smtpSend } from "./smtp.js";

// Configure: secret ZEPTOMAIL_TOKEN (the "Send Mail token" of a ZeptoMail Mail Agent),
// var MAIL_FROM (an address on the verified sending domain), optional ZEPTOMAIL_API_URL.
// Without a token, mail is skipped (logged), so the app keeps working.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function useZepto(env) { return Boolean(env.ZEPTOMAIL_TOKEN && env.MAIL_FROM); }
function useSmtp(env) { return Boolean(env.SMTP_USER && env.SMTP_PASSWORD); }

export function mailEnabled(env) {
  return useZepto(env) || useSmtp(env);
}

export async function sendMail(env, { to, toName, subject, html, text, replyTo }) {
  if (!mailEnabled(env)) {
    console.log("mail skipped (no mail provider configured)", subject);
    return { skipped: true };
  }
  if (!useZepto(env)) return smtpSend(env, { to, subject, html, text, replyTo });
  const token = String(env.ZEPTOMAIL_TOKEN).replace(/^Zoho-enczapikey\s+/i, "");
  const body = {
    from: { address: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "MSPoint Assist" },
    to: [{ email_address: { address: to, name: toName || to } }],
    subject,
    htmlbody: html,
    textbody: text,
  };
  if (replyTo) body.reply_to = [{ address: replyTo }];
  const r = await fetch(env.ZEPTOMAIL_API_URL || "https://api.zeptomail.com/v1.1/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Zoho-enczapikey ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    console.error("ZeptoMail send failed", r.status, detail);
    throw new Error(`Mail send failed (${r.status})`);
  }
  return { ok: true };
}

function layout(title, inner) {
  return `<!doctype html><html><body style="margin:0;background:#f4f8fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1b2733">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#14508f;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:17px">MSPoint Assist</div>
<div style="background:#fff;padding:22px 20px;border:1px solid #e2e8ef;border-top:0;border-radius:0 0 12px 12px">
<h2 style="margin:0 0 14px;font-size:19px">${esc(title)}</h2>${inner}</div>
<p style="font-size:12px;color:#6b7a89;text-align:center;margin-top:14px">MSPoint Assist · a product of MSPoint LLC (USA) · <a href="https://app.mspointbd.com/privacy" style="color:#6b7a89">Privacy</a></p>
</div></body></html>`;
}

const btn = (href, label) =>
  `<p style="margin:20px 0"><a href="${esc(href)}" style="background:#f5a623;color:#0b2c4d;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;

export function leadAlertMail({ botName, lead, priority, summary, dashboardUrl }) {
  const rows = [
    ["Priority", (priority || "medium").toUpperCase()],
    ["Name", lead.name], ["Mail", lead.email], ["Company", lead.company], ["Phone", lead.phone],
    ["Summary", summary], ["Message", lead.message], ["Page", lead.page_url],
  ].filter(([, v]) => v);
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows
    .map(([k, v]) => `<tr><td style="padding:7px 0;color:#6b7a89;width:110px;vertical-align:top">${esc(k)}</td><td style="padding:7px 0">${esc(v)}</td></tr>`)
    .join("")}</table>`;
  const subject = `New ${priority === "high" ? "high-priority " : ""}lead from ${botName}${lead.name ? `: ${lead.name}` : ""}`;
  const html = layout(`New lead for ${botName}`, `${table}${btn(dashboardUrl, "Open dashboard")}
<p style="font-size:13px;color:#6b7a89">Reply to this mail to answer the visitor directly.</p>`);
  const text = `New lead for ${botName}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nDashboard: ${dashboardUrl}`;
  return { subject, html, text };
}

export function welcomeMail({ botName, botId, dashboardUrl, previewUrl }) {
  const subject = `Your assistant for ${botName} is ready`;
  const html = layout("Your assistant is ready", `<p>Your MSPoint Assist assistant for <b>${esc(botName)}</b> has been created.</p>
<p>Assistant ID: <b>${esc(botId)}</b></p>
<p>Keep your owner key safe — it was shown once on the setup page. If you lose it, use “Forgot your key?” on the dashboard and we will send a sign-in link to this address.</p>
${btn(previewUrl, "Try your assistant")}<p><a href="${esc(dashboardUrl)}">Open dashboard</a></p>`);
  const text = `Your assistant for ${botName} is ready.\nAssistant ID: ${botId}\nTry it: ${previewUrl}\nDashboard: ${dashboardUrl}\nLost your owner key? Use "Forgot your key?" on the dashboard.`;
  return { subject, html, text };
}

export function loginMail({ links }) {
  const subject = "Your MSPoint Assist sign-in link";
  const list = links.map((l) => `<li style="margin:8px 0"><b>${esc(l.name)}</b><br><a href="${esc(l.url)}">Sign in to this assistant</a></li>`).join("");
  const html = layout("Sign in to your dashboard", `<p>Use the link below to sign in. It works once and expires in 30 minutes. Signing in creates a new owner key, so any old key stops working.</p>
<ul style="padding-left:18px">${list}</ul>
<p style="font-size:13px;color:#6b7a89">If you did not ask for this, you can ignore this mail.</p>`);
  const text = `Sign in to MSPoint Assist (link works once, expires in 30 minutes):\n\n${links.map((l) => `${l.name}: ${l.url}`).join("\n")}\n\nIf you did not ask for this, ignore this mail.`;
  return { subject, html, text };
}
