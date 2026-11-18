// Minimal SMTP client for Workers (cloudflare:sockets), used with Zoho Mail SMTP.
// Configure: SMTP_USER (mailbox address), secret SMTP_PASSWORD (Zoho app password),
// optional SMTP_HOST (default smtp.zoho.com), SMTP_PORT (default 465), SMTP_FROM.
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const cleanAddr = (a) => String(a || "").replace(/[\r\n<>]/g, "").trim();

export function buildMessage({ from, fromName, to, subject, html, text, replyTo, domain }) {
  const boundary = "msa_" + crypto.randomUUID().replace(/-/g, "");
  const headers = [
    `From: ${encodeHeader(fromName || "MSPoint Assist")} <${cleanAddr(from)}>`,
    `To: <${cleanAddr(to)}>`,
    `Subject: ${encodeHeader(String(subject || "").replace(/[\r\n]+/g, " "))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo) headers.push(`Reply-To: <${cleanAddr(replyTo)}>`);
  const part = (type, body) => [
    `--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body || "")),
  ].join("\r\n");
  return [headers.join("\r\n"), "", part("text/plain", text), part("text/html", html), `--${boundary}--`, ""].join("\r\n");
}

export async function smtpSend(env, { to, subject, html, text, replyTo }) {
  const user = env.SMTP_USER;
  const from = env.SMTP_FROM || user;
  const host = env.SMTP_HOST || "smtp.zoho.com";
  const port = Number(env.SMTP_PORT || 465);
  const secure = env.SMTP_SECURE === "off" ? "off" : "on"; // "off" only for local testing
  const domain = (from.split("@")[1] || "localhost").toLowerCase();

  const socket = connect({ hostname: host, port }, { secureTransport: secure, allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buf = "";

  async function reply() {
    const deadline = Date.now() + 15000;
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const text = lines.slice(0, i + 1).join("\n");
          buf = lines.slice(i + 1).join("\r\n");
          return { code: Number(lines[i].slice(0, 3)), text };
        }
      }
      if (Date.now() > deadline) throw new Error("SMTP timeout");
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP connection closed");
      buf += dec.decode(value, { stream: true });
    }
  }
  async function cmd(line, expect, label = line.split(" ")[0]) {
    await writer.write(enc.encode(line + "\r\n"));
    const r = await reply();
    if (!String(r.code).startsWith(String(expect))) throw new Error(`SMTP ${label} failed: ${r.text.slice(0, 200)}`);
    return r;
  }

  try {
    const greet = await reply();
    if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.text.slice(0, 200)}`);
    await cmd(`EHLO ${domain}`, 250);
    await cmd("AUTH LOGIN", 334);
    await cmd(b64(user), 334, "AUTH user");
    await cmd(b64(env.SMTP_PASSWORD), 235, "AUTH password");
    await cmd(`MAIL FROM:<${cleanAddr(from)}>`, 250, "MAIL FROM");
    await cmd(`RCPT TO:<${cleanAddr(to)}>`, 25, "RCPT TO");
    await cmd("DATA", 354);
    const msg = buildMessage({ from, fromName: env.MAIL_FROM_NAME, to, subject, html, text, replyTo, domain })
      .replace(/\r\n\./g, "\r\n.."); // dot-stuffing
    await cmd(msg + "\r\n.", 250, "message");
    try { await cmd("QUIT", 221); } catch { /* server may close first */ }
  } finally {
    try { await writer.close(); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
  }
  return { ok: true };
}
