// whatsapp-claude-bridge — drive Claude Code (or a shell) on your own machine over WhatsApp.
// Config via env vars (see .env.example). SECURITY: read the README before running.
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode");
const { exec, spawn } = require("child_process");

// ---------- config ----------
const ALLOWED = new Set((process.env.WA_ALLOWED || "").split(",").map(s => s.trim()).filter(Boolean));
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const WORK_DIR = process.env.WORK_DIR || process.env.HOME || process.cwd();
const TURN_TIMEOUT = Number(process.env.TURN_TIMEOUT_MS || 240000);
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT_MS || 300000);
let model = process.env.CLAUDE_MODEL || "sonnet";
const AUTH = __dirname + "/auth";
const QRPNG = __dirname + "/qr.png";
const STARTED = Math.floor(Date.now() / 1000);
if (!ALLOWED.size) console.warn("⚠️  WA_ALLOWED is empty — the bot will ignore ALL messages. Set it (see README) before use.");

// destructive shell commands require an explicit CONFIRM reply
const DANGER = /(\brm\s+-rf?\b|\bmkfs|\bdd\s+if=|\b(shutdown|reboot|halt|poweroff)\b|>\s*\/dev\/[sn]|\buserdel\b|\bfdisk\b|:\(\)\s*\{|\bkill\s+-9\s+-1\b)/i;

// exact-match shell shortcuts (instant, skip Claude). Edit freely for your box.
const SHORTCUTS = {
  gpu: 'nvidia-smi --query-gpu=temperature.gpu,power.draw,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "no nvidia-smi"',
  disk: 'df -h -x tmpfs -x devtmpfs 2>/dev/null | head -20',
  mem: 'free -h',
  uptime: 'uptime',
};

let pending = null, pendingAt = 0;
const sentIds = new Set();
const HELP = () => [
  "🤖 Remote Claude (warm session)",
  "Talk in plain English — I run commands, build, research, report back, with memory.",
  "",
  "Instant (skip Claude): " + Object.keys(SHORTCUTS).join(" · ") + " · sh <cmd>",
  "Control:",
  "• use haiku | sonnet | opus  (now: " + model + ")",
  "• reset — fresh conversation",
  "• help",
].join("\n");

// ---------- persistent Claude session (stream-json over stdin/stdout) ----------
let cp = null, buf = "", turnResolve = null, turnText = "", turnTimer = null;
function spawnClaude(){
  cp = spawn(CLAUDE, ["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model", model],
    { cwd: WORK_DIR, env: { ...process.env } });
  buf = "";
  cp.stdout.on("data", d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch(e){ continue; }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)){
        for (const c of ev.message.content){ if (c.type === "text" && c.text) turnText += c.text; }
      } else if (ev.type === "result"){
        const final = (typeof ev.result === "string" && ev.result.trim()) ? ev.result : turnText;
        finishTurn(final || "(no output)");
      }
    }
  });
  cp.stderr.on("data", () => {});
  cp.on("exit", (code) => { console.log("claude session exited " + code); cp = null; if (turnResolve) finishTurn("⚠️ session ended — resend to restart it."); });
  console.log("claude session spawned (model=" + model + ")");
}
function finishTurn(text){ if (turnTimer){ clearTimeout(turnTimer); turnTimer = null; } const r = turnResolve; turnResolve = null; turnText = ""; if (r) r(text); }
function ask(msg){
  return new Promise((resolve) => {
    if (!cp){ spawnClaude(); }
    turnText = ""; turnResolve = resolve;
    turnTimer = setTimeout(() => { if (turnResolve){ finishTurn("⏱️ that took too long — I restarted the session. Please resend."); restartSession(); } }, TURN_TIMEOUT);
    try { cp.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: msg }] } }) + "\n"); }
    catch(e){ finishTurn("⚠️ couldn't reach the session: " + e.message); }
  });
}
function restartSession(){ if (cp){ try { cp.kill("SIGTERM"); } catch(e){} cp = null; } }
// serialize turns (one conversation)
let chain = Promise.resolve();
function enqueue(fn){ chain = chain.then(fn).catch(e => console.error("turn err", e?.message)); return chain; }

// ---------- helpers ----------
async function reply(sock, jid, text){
  const t = (text||"").length > 3800 ? text.slice(0,3800) + "\n…[truncated]" : (text||"(no output)");
  try { const r = await sock.sendMessage(jid, { text: t }); if (r?.key?.id){ sentIds.add(r.key.id); if (sentIds.size>200) sentIds.clear(); } } catch(e){ console.error("send err", e?.message); }
}
function shell(cmd, cb){
  exec("bash -lc " + JSON.stringify(cmd), { timeout: SHELL_TIMEOUT, maxBuffer: 1024*1024*16, env: { ...process.env }, cwd: WORK_DIR },
    (err, so, se) => { let out = (so||""); if (se) out += (out?"\n":"") + "[stderr] " + se; if (err && !out) out = "ERROR: " + err.message; else if (err) out += "\n[exit " + (err.code||"?") + "]"; cb((out||"(no output)").trim()); });
}
async function start(){
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), printQRInTerminal: false, browser: ["ClaudeBridge","Chrome","1.0"], qrTimeout: 120000 });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr){ try { await qrcode.toFile(QRPNG, qr, { width: 560, margin: 2 }); console.log("QR updated -> " + QRPNG + " (scan it with the bot's WhatsApp: Linked Devices)"); } catch(e){} }
    if (connection === "open"){ console.log("CONNECTED"); if (!cp) spawnClaude(); }
    if (connection === "close"){
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
      console.log("closed code=" + code);
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000); else console.log("LOGGED_OUT — delete ./auth and re-link");
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages){
      const jid = m.key.remoteJid;
      if (m.key.fromMe || sentIds.has(m.key.id)) continue;
      if (!ALLOWED.has(jid)){ if (!m.key.fromMe) console.log("ignored msg from " + jid + " (add to WA_ALLOWED to authorize)"); continue; }
      if (Number(m.messageTimestamp||0) < STARTED - 30) continue;
      const msg = ((m.message?.conversation) || (m.message?.extendedTextMessage?.text) || "").trim();
      if (!msg) continue;
      console.log("MSG " + JSON.stringify(msg));
      if (/^(help|commands)$/i.test(msg)){ await reply(sock, jid, HELP()); continue; }
      if (/^(reset|new|clear)$/i.test(msg)){ restartSession(); await reply(sock, jid, "🔄 Fresh conversation (session restarted)."); continue; }
      const mm = msg.match(/^use\s+(haiku|sonnet|opus)$/i);
      if (mm){ model = mm[1].toLowerCase(); restartSession(); await reply(sock, jid, "✅ Model → " + model + " (session restarted)."); continue; }
      if (/^confirm$/i.test(msg)){
        if (pending && (Date.now()-pendingAt) < 120000){ const c = pending; pending = null; await reply(sock, jid, "▶ " + c); shell(c, o => reply(sock, jid, o)); }
        else await reply(sock, jid, "nothing pending"); continue;
      }
      if (/^sh\s+/i.test(msg)){
        const cmd = msg.replace(/^sh\s+/i, "");
        if (DANGER.test(cmd)){ pending = cmd; pendingAt = Date.now(); await reply(sock, jid, "⚠️ destructive:\n" + cmd + "\n\nreply CONFIRM within 2 min"); continue; }
        shell(cmd, o => reply(sock, jid, o)); continue;
      }
      if (SHORTCUTS[msg.toLowerCase().trim()]){ shell(SHORTCUTS[msg.toLowerCase().trim()], o => reply(sock, jid, o)); continue; }
      // warm Claude session, serialized (instant ack so you always get feedback)
      await reply(sock, jid, "🤖 on it… (" + model + ")");
      enqueue(async () => { const out = await ask(msg); await reply(sock, jid, out); });
    }
  });
}
start();
