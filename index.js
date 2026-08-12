// whatsapp-claude-bridge — drive Claude Code on your own machine over WhatsApp.
// Multi-agent: named concurrent warm sessions (@build, @research…) + a broadcast coordinator.
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
let defaultModel = process.env.CLAUDE_MODEL || "sonnet";
const MAIN_MODEL = process.env.MAIN_MODEL || "opus"; // the @main orchestrator defaults to the strongest model
let MODE = (process.env.BRIDGE_MODE || "multi").toLowerCase(); // "multi" (agent pool) | "single" (classic one warm session)
const DEFAULT = "main";
const AUTH = __dirname + "/auth";
const QRPNG = __dirname + "/qr.png";
const STARTED = Math.floor(Date.now() / 1000);
if (!ALLOWED.size) console.warn("⚠️  WA_ALLOWED is empty — the bot will ignore ALL messages. Set it (see README) before use.");

const DANGER = /(\brm\s+-rf?\b|\bmkfs|\bdd\s+if=|\b(shutdown|reboot|halt|poweroff)\b|>\s*\/dev\/[sn]|\buserdel\b|\bfdisk\b|:\(\)\s*\{|\bkill\s+-9\s+-1\b)/i;
const SHORTCUTS = {
  gpu: 'nvidia-smi --query-gpu=temperature.gpu,power.draw,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "no nvidia-smi"',
  disk: 'df -h -x tmpfs -x devtmpfs 2>/dev/null | head -20',
  mem: 'free -h',
  uptime: 'uptime',
};
let pending = null, pendingAt = 0;
const sentIds = new Set();

// ---------- session pool: name -> independent warm Claude process ----------
const sessions = new Map();
function getSession(name){
  let s = sessions.get(name);
  if (!s){ const im = (name === DEFAULT) ? (MODE === "multi" ? MAIN_MODEL : defaultModel) : defaultModel; s = { name, model: im, cp: null, buf: "", turnResolve: null, turnText: "", turnTimer: null, chain: Promise.resolve() }; sessions.set(name, s); }
  return s;
}
function finishTurn(s, text){ if (s.turnTimer){ clearTimeout(s.turnTimer); s.turnTimer = null; } const r = s.turnResolve; s.turnResolve = null; s.turnText = ""; if (r) r(text); }
function restartSession(s){ if (s && s.cp){ try { s.cp.kill("SIGTERM"); } catch(e){} s.cp = null; } }
function spawnSession(s){
  s.cp = spawn(CLAUDE, ["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model", s.model],
    { cwd: WORK_DIR, env: { ...process.env } });
  s.buf = "";
  s.cp.stdout.on("data", d => {
    s.buf += d.toString(); let i;
    while ((i = s.buf.indexOf("\n")) >= 0){
      const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch(e){ continue; }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)){
        for (const c of ev.message.content){ if (c.type === "text" && c.text) s.turnText += c.text; }
      } else if (ev.type === "result"){
        finishTurn(s, (typeof ev.result === "string" && ev.result.trim()) ? ev.result : (s.turnText || "(no output)"));
      }
    }
  });
  s.cp.stderr.on("data", () => {});
  s.cp.on("exit", (code) => { console.log("[" + s.name + "] session exited " + code); s.cp = null; if (s.turnResolve) finishTurn(s, "⚠️ session ended — resend to restart it."); });
  console.log("[" + s.name + "] session spawned (model=" + s.model + ")");
}
function askRaw(s, msg){
  return new Promise((resolve) => {
    if (!s.cp) spawnSession(s);
    s.turnText = ""; s.turnResolve = resolve;
    s.turnTimer = setTimeout(() => { if (s.turnResolve){ finishTurn(s, "⏱️ [" + s.name + "] timed out — session restarted, resend."); restartSession(s); } }, TURN_TIMEOUT);
    try { s.cp.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: msg }] } }) + "\n"); }
    catch(e){ finishTurn(s, "⚠️ [" + s.name + "] couldn't reach session: " + e.message); }
  });
}
// per-session serialization; different sessions run in PARALLEL. Returns this turn's result.
function ask(name, msg){
  const s = getSession(name);
  const run = () => askRaw(s, msg);
  const p = s.chain.then(run, run);
  s.chain = p.then(() => {}, () => {});
  return p;
}

// ---------- helpers ----------
async function reply(sock, jid, text){
  const t = (text||"").length > 3800 ? text.slice(0,3800) + "\n…[truncated]" : (text||"(no output)");
  try { const r = await sock.sendMessage(jid, { text: t }); if (r?.key?.id){ sentIds.add(r.key.id); if (sentIds.size>200) sentIds.clear(); } } catch(e){ console.error("send err", e?.message); }
}
function shell(cmd, cb){
  exec("bash -lc " + JSON.stringify(cmd), { timeout: SHELL_TIMEOUT, maxBuffer: 1024*1024*16, env: { ...process.env }, cwd: WORK_DIR },
    (err, so, se) => { let out = (so||""); if (se) out += (out?"\n":"") + "[stderr] " + se; if (err && !out) out = "ERROR: " + err.message; else if (err) out += "\n[exit " + (err.code||"?") + "]"; cb((out||"(no output)").trim()); });
}
function listAgents(){
  if (!sessions.size) return "no agents yet — start one with `@build <task>`";
  return "agents:\n" + [...sessions.values()].map(s => "• @" + s.name + " (" + s.model + ") " + (s.cp ? (s.turnResolve ? "working" : "idle") : "stopped")).join("\n");
}
const HELP = () => {
  const base = [
    "Instant (skip Claude): " + Object.keys(SHORTCUTS).join(" · ") + " · sh <cmd>",
    "reset · mode (single|multi) · help",
  ];
  if (MODE !== "multi") return ["🤖 Remote Claude — single-session (classic)",
    "Talk in plain English → one warm agent with memory.",
    "Model: use haiku|sonnet|opus (now " + defaultModel + ")", "", ...base].join("\n");
  return ["🤖 Remote Claude — multi-agent",
    "Plain English → the `main` orchestrator (runs tools, delegates sub-agents, remembers context).",
    "",
    "Agents (parallel):",
    "• @<name> <task> — a named agent (created on first use)",
    "• @all <task> / broadcast <task> — fan across all agents, then merge",
    "• agents · stop <name> · @<name> reset",
    "Model: @main=" + MAIN_MODEL + " · new agents=" + defaultModel + " · use <model> / @<name> use <model>",
    "", ...base].join("\n");
};

async function broadcast(sock, jid, instruction){
  const names = [...sessions.keys()].filter(n => n !== "coordinator" && sessions.get(n).cp);
  if (!names.length){ await reply(sock, jid, "no active agents to broadcast to — start some with `@name <task>`"); return; }
  await reply(sock, jid, "📡 dispatching to " + names.length + " agent(s): " + names.map(n=>"@"+n).join(", "));
  const results = await Promise.all(names.map(n => ask(n, instruction).then(r => ({ n, r })).catch(e => ({ n, r: "(error) " + (e?.message||e) }))));
  const merged = await ask("coordinator",
    "You are a coordinator merging parallel agents' outputs. Instruction was:\n\"" + instruction + "\"\n\n" +
    results.map(x => "### agent @" + x.n + "\n" + x.r).join("\n\n") +
    "\n\nSynthesize ONE concise, reconciled answer. Call out any disagreements or gaps.");
  await reply(sock, jid, "🧩 merged (" + names.length + " agents):\n" + merged);
}

async function handle(sock, jid, msg){
  if (/^(help|commands)$/i.test(msg)) return reply(sock, jid, HELP());
  const mo = msg.match(/^mode(?:\s+(single|multi))?$/i);
  if (mo){
    if (!mo[1]) return reply(sock, jid, "architecture: " + MODE + "  (send `mode single` or `mode multi`)");
    MODE = mo[1].toLowerCase();
    for (const s of sessions.values()) restartSession(s);
    if (MODE === "single") for (const k of [...sessions.keys()]) if (k !== DEFAULT) sessions.delete(k);
    return reply(sock, jid, "✅ architecture → " + (MODE === "single" ? "single-session (classic)" : "multi-agent") + " — sessions reset.");
  }
  const multi = (MODE === "multi");
  if (multi && /^agents$|^sessions$/i.test(msg)) return reply(sock, jid, listAgents());
  let mm = multi && msg.match(/^stop\s+@?([a-z0-9_-]{1,24})$/i);
  if (mm){ const s = sessions.get(mm[1].toLowerCase()); if (s){ restartSession(s); sessions.delete(mm[1].toLowerCase()); return reply(sock, jid, "🛑 stopped @" + mm[1].toLowerCase()); } return reply(sock, jid, "no such agent"); }
  let bc = multi && msg.match(/^(?:@all|broadcast)\s+([\s\S]+)$/i);
  if (bc) return broadcast(sock, jid, bc[1].trim());
  // global model default
  mm = msg.match(/^use\s+(haiku|sonnet|opus)$/i);
  if (mm){ defaultModel = mm[1].toLowerCase(); return reply(sock, jid, "✅ default model → " + defaultModel + " (applies to new agents; use `@name use " + defaultModel + "` for an existing one)"); }
  if (/^(reset|new|clear)$/i.test(msg)){ restartSession(getSession(DEFAULT)); return reply(sock, jid, "🔄 @main reset."); }
  if (/^confirm$/i.test(msg)){
    if (pending && (Date.now()-pendingAt) < 120000){ const c = pending; pending = null; await reply(sock, jid, "▶ " + c); return shell(c, o => reply(sock, jid, o)); }
    return reply(sock, jid, "nothing pending");
  }
  if (/^sh\s+/i.test(msg)){
    const cmd = msg.replace(/^sh\s+/i, "");
    if (DANGER.test(cmd)){ pending = cmd; pendingAt = Date.now(); return reply(sock, jid, "⚠️ destructive:\n" + cmd + "\n\nreply CONFIRM within 2 min"); }
    return shell(cmd, o => reply(sock, jid, o));
  }
  if (SHORTCUTS[msg.toLowerCase().trim()]) return shell(SHORTCUTS[msg.toLowerCase().trim()], o => reply(sock, jid, o));
  // targeted agent?  "@name <body>"  (multi mode only)
  let target = DEFAULT, body = msg;
  if (multi){ const at = msg.match(/^@([a-z0-9_-]{1,24})\s+([\s\S]+)$/i); if (at){ target = at[1].toLowerCase(); body = at[2].trim(); } }
  // per-agent control words
  if (/^reset$/i.test(body)){ restartSession(getSession(target)); return reply(sock, jid, "🔄 @" + target + " reset."); }
  const um = body.match(/^use\s+(haiku|sonnet|opus)$/i);
  if (um){ const s = getSession(target); s.model = um[1].toLowerCase(); restartSession(s); return reply(sock, jid, "✅ @" + target + " → " + s.model); }
  // dispatch (non-blocking so other agents run in parallel)
  await reply(sock, jid, "🤖 @" + target + " on it… (" + getSession(target).model + ")");
  ask(target, body).then(out => reply(sock, jid, (target === DEFAULT ? "" : "@" + target + ":\n") + out));
}

async function start(){
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), printQRInTerminal: false, browser: ["ClaudeBridge","Chrome","1.0"], qrTimeout: 120000 });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr){ try { await qrcode.toFile(QRPNG, qr, { width: 560, margin: 2 }); console.log("QR updated -> " + QRPNG + " (scan with the bot's WhatsApp: Linked Devices)"); } catch(e){} }
    if (connection === "open"){ console.log("CONNECTED"); const m = getSession(DEFAULT); if (!m.cp) spawnSession(m); }
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
      if (!ALLOWED.has(jid)){ console.log("ignored msg from " + jid + " (add to WA_ALLOWED to authorize)"); continue; }
      if (Number(m.messageTimestamp||0) < STARTED - 30) continue;
      const msg = ((m.message?.conversation) || (m.message?.extendedTextMessage?.text) || "").trim();
      if (!msg) continue;
      console.log("MSG " + JSON.stringify(msg));
      handle(sock, jid, msg).catch(e => console.error("handle err", e?.message));
    }
  });
}
start();
