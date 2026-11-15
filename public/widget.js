/*! MSPoint Assist chat widget — https://app.mspointbd.com
 * Usage: <script src="https://app.mspointbd.com/widget.js" data-bot="YOUR_BOT_ID" async></script>
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector('script[src*="widget.js"][data-bot]');
  if (!script || window.__msaLoaded) return;
  window.__msaLoaded = true;

  var BOT = script.getAttribute("data-bot");
  var API = new URL(script.src).origin;
  var COLOR = script.getAttribute("data-color") || "#14508f";
  var OPEN = script.getAttribute("data-open") === "true";
  var history = [];
  var leadShown = false;

  var host = document.createElement("div");
  host.id = "mspoint-assist";
  host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483000;";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  root.innerHTML =
    "<style>" +
    ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".btn{width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:" + COLOR + ";color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;margin-left:auto}" +
    ".btn svg{width:28px;height:28px}" +
    ".panel{display:none;flex-direction:column;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.22);overflow:hidden;margin-bottom:12px}" +
    ".panel.open{display:flex}" +
    ".head{background:" + COLOR + ";color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}" +
    ".head b{font-size:15px}.head small{display:block;opacity:.85;font-size:12px}" +
    ".x{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}" +
    ".log{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}" +
    ".m{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}" +
    ".bot{background:#fff;color:#111;border:1px solid #e5e7eb;align-self:flex-start;border-bottom-left-radius:4px}" +
    ".me{background:" + COLOR + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}" +
    ".src{font-size:11px;color:#6b7280;align-self:flex-start;margin-top:-4px}.src a{color:#6b7280}" +
    ".typing{font-size:13px;color:#6b7280;align-self:flex-start}" +
    ".lead{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:6px;align-self:stretch}" +
    ".lead p{margin:0;font-size:13px;color:#374151}" +
    ".lead input,.lead textarea{border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font-size:13px;width:100%}" +
    ".lead button{background:" + COLOR + ";color:#fff;border:0;border-radius:8px;padding:8px;font-size:13px;cursor:pointer}" +
    ".bar{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}" +
    ".bar input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}" +
    ".bar input:focus{border-color:" + COLOR + "}" +
    ".bar button{background:" + COLOR + ";color:#fff;border:0;border-radius:10px;padding:0 14px;cursor:pointer;font-size:14px}" +
    ".foot{font-size:11px;text-align:center;color:#9ca3af;padding:0 0 8px;background:#fff}.foot a{color:#9ca3af}" +
    ".link{background:none;border:0;color:" + COLOR + ";font-size:12px;cursor:pointer;padding:0 14px 6px;text-align:left;background:#fff}" +
    "</style>" +
    '<div class="panel" role="dialog" aria-label="Chat">' +
    '<div class="head"><div><b class="t">Chat</b><small>Usually replies instantly</small></div><button class="x" aria-label="Close chat">&times;</button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<button class="link" type="button">Talk to a person → leave your details</button>' +
    '<form class="bar"><input name="q" autocomplete="off" maxlength="600" placeholder="Type your question…" aria-label="Your message"><button type="submit">Send</button></form>' +
    '<div class="foot">Powered by <a href="' + API + '" target="_blank" rel="noopener">MSPoint Assist</a></div>' +
    "</div>" +
    '<button class="btn" aria-label="Open chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>';

  var $ = function (s) { return root.querySelector(s); };
  var panel = $(".panel"), log = $(".log"), form = $(".bar"), input = form.elements.namedItem("q");

  function add(text, who) {
    var d = document.createElement("div");
    d.className = "m " + who;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function addSources(urls) {
    if (!urls || !urls.length) return;
    var d = document.createElement("div");
    d.className = "src";
    d.appendChild(document.createTextNode("Source: "));
    urls.forEach(function (u, i) {
      var a = document.createElement("a");
      a.href = u; a.target = "_blank"; a.rel = "noopener";
      try { a.textContent = new URL(u).pathname || "/"; } catch (e) { a.textContent = u; }
      if (i) d.appendChild(document.createTextNode(" · "));
      d.appendChild(a);
    });
    log.appendChild(d);
  }

  function post(path, body) {
    return fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || "Request failed");
        return j;
      });
    });
  }

  function showLead(prefillEmail) {
    if (leadShown) {
      var existing = log.querySelector(".lead");
      if (existing && prefillEmail && !existing.elements.namedItem("email").value) existing.elements.namedItem("email").value = prefillEmail;
      return;
    }
    leadShown = true;
    var f = document.createElement("form");
    f.className = "lead";
    f.innerHTML =
      "<p>Leave your details and the team will get back to you.</p>" +
      '<input name="name" maxlength="120" placeholder="Your name">' +
      '<input name="email" type="email" required maxlength="200" placeholder="Mail address *">' +
      '<input name="company" maxlength="120" placeholder="Company (optional)">' +
      '<input name="phone" maxlength="40" placeholder="Phone (optional)">' +
      '<textarea name="message" rows="2" maxlength="2000" placeholder="How can we help?"></textarea>' +
      '<button type="submit">Send details</button>';
    if (prefillEmail) f.elements.namedItem("email").value = prefillEmail;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = f.querySelector("button");
      btn.disabled = true; btn.textContent = "Sending\u2026";
      var last = history.filter(function (h) { return h.role === "user"; }).slice(-1)[0];
      var val = function (n) { return f.elements.namedItem(n).value; };
      post("/api/leads", {
        bot: BOT,
        name: val("name"),
        email: val("email"),
        company: val("company"),
        phone: val("phone"),
        message: val("message") || (last ? last.content : ""),
        page_url: location.href,
        transcript: history.slice(-10),
      }).then(function () {
        f.remove();
        add("Thanks! Your details were sent. The team will contact you soon.", "bot");
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = "Send details";
        add(err.message, "bot");
      });
    });
    log.appendChild(f);
    log.scrollTop = log.scrollHeight;
  }

  function toggle(open) {
    panel.classList.toggle("open", open);
    if (open) setTimeout(function () { input.focus(); }, 50);
  }

  $(".btn").addEventListener("click", function () { toggle(!panel.classList.contains("open")); });
  $(".x").addEventListener("click", function () { toggle(false); });
  $(".link").addEventListener("click", function () { showLead(); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    input.value = "";
    add(q, "me");
    var t = document.createElement("div");
    t.className = "typing"; t.textContent = "Typing…";
    log.appendChild(t);
    post("/api/chat", { bot: BOT, message: q, history: history.slice(-6) }).then(function (r) {
      t.remove();
      add(r.reply, "bot");
      addSources(r.sources);
      history.push({ role: "user", content: q }, { role: "assistant", content: r.reply });
      history = history.slice(-10);
      var mail = q.match(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i);
      if (r.lead_prompt || mail) showLead(mail ? mail[0] : undefined);
    }).catch(function (err) {
      t.remove();
      add(err.message || "Connection problem. Please try again.", "bot");
    });
  });

  fetch(API + "/api/bots/" + encodeURIComponent(BOT) + "/public")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) {
      if (!b) { host.remove(); return; }
      $(".t").textContent = b.name;
      add(b.greeting, "bot");
    })
    .catch(function () { host.remove(); });

  (document.body || document.documentElement).appendChild(host);
  if (OPEN) toggle(true);
})();
