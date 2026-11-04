import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';

const HOST = '127.0.0.1';
const PORT = Number(process.env.HUD_PORT || 7788);
const ROOT = resolve(process.argv[2] || '.');
const STATIC_DIR = join(ROOT, 'haloflux');
const SESSIONS = join(homedir(), '.dsh', 'sessions');
const POLL_MS = 500;
const ACTIVE_WINDOW = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/* ---------------- workspace name decode ---------------- */
function decodeWs(enc) {
  const body = enc.replace(/^--/, '').replace(/--$/, '');
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '~') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
    else out += body[i];
  }
  return out.replace(/^-+|-+$/g, '').replace(/-/g, '\\') || enc;
}

/* ---------------- session discovery (cached 3s) ---------------- */
let dirCache = { at: 0, files: [] };
function listSessionFiles() {
  if (Date.now() - dirCache.at < 3000) return dirCache.files;
  const files = [];
  let wsDirs = [];
  try { wsDirs = readdirSync(SESSIONS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return files; }
  for (const ws of wsDirs) {
    const wsPath = join(SESSIONS, ws.name);
    let sDirs = [];
    try { sDirs = readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('session-')); } catch { continue; }
    for (const s of sDirs) {
      const sPath = join(wsPath, s.name);
      let gens = [];
      try { gens = readdirSync(sPath).filter(f => f.startsWith('session.') && f.endsWith('.jsonl.zstd')).sort(); } catch { continue; }
      const gen = gens[gens.length - 1];
      if (gen) files.push({ key: s.name, ws: decodeWs(ws.name), file: join(sPath, gen) });
    }
  }
  dirCache = { at: Date.now(), files };
  return files;
}

/* ---------------- zstd: split on frame magic ---------------- */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeFrom(buf, start) {
  const parts = [];
  let pos = start;
  while (pos < buf.length - 3) {
    if (buf[pos] !== 0x28 || buf[pos + 1] !== 0xb5 || buf[pos + 2] !== 0x2f || buf[pos + 3] !== 0xfd) return { parts, pos, bad: true };
    // find next magic after pos
    let next = buf.indexOf(MAGIC, pos + 4);
    let done = null, end = -1;
    while (next !== -1) {
      try { done = zlib.zstdDecompressSync(buf.subarray(pos, next)); end = next; break; } catch { next = buf.indexOf(MAGIC, next + 1); }
    }
    if (!done) {
      try { done = zlib.zstdDecompressSync(buf.subarray(pos)); end = buf.length; } catch { /* incomplete tail */ }
    }
    if (!done) break;
    parts.push(done);
    pos = end;
    if (pos >= buf.length) break;
  }
  return { parts, pos, bad: false };
}

/* ---------------- per-session state ---------------- */
const sessions = new Map(); // key -> state
const toolLog = [];         // global recent tool calls: {t,name,ms,ok,ws,sid}
function newSess(entry) {
  return {
    key: entry.key, ws: entry.ws, file: entry.file,
    consumed: 0, tail: '', ready: false,
    title: '', model: '', events: 0, tools: 0, errors: 0, turns: 0, steps: 0, jobs: 0,
    turn: 0, step: 0, lastType: '', lastTime: 0, startedAt: 0,
    pending: new Map(),      // callId -> {name, t0, args}
    feed: [],                // recent tool calls
    rateTimes: [],           // event timestamps within 60s
    newTools: 0, newTurns: 0, newErrors: 0,
    err: null,
  };
}

function summarizeArgs(name, args) {
  try {
    const a = typeof args === 'string' ? JSON.parse(args) : (args || {});
    const pick = a.description || a.command || a.path || a.file_path || a.pattern || a.query || a.url || a.prompt || a.title || '';
    return String(pick).replace(/\s+/g, ' ').trim().slice(0, 110);
  } catch { return ''; }
}

function onEvent(s, ev) {
  const t = ev.type, d = ev.data || {}, time = ev.time || Date.now();
  s.events++; s.lastType = t; s.lastTime = time;
  s.rateTimes.push(time);
  const cwd = ev.cwd || d.cwd;
  if (t === 'session' && cwd) { s.cwd = cwd; s.ws = String(cwd).split(/[\\/]/).filter(Boolean).pop() || s.ws; }
  if (t === 'session') s.startedAt = ev.createdAt || d.createdAt || s.startedAt || 0;
  if (t === 'session/title' && d.title) s.title = d.title;
  if (t === 'request/header') s.model = d?.header?.config?.model || s.model;
  if (t === 'turn/start') { s.newTurns++; s.turn = d.turn || s.turn; s.turns = Math.max(s.turns, s.turn); }
  if (t === 'step/start') { s.step = d.step || s.step; s.steps++; }
  if (t === 'job/registered') s.jobs++;
  if (t === 'job/settled') s.jobs = Math.max(0, s.jobs - 1);
  if (t === 'tool/call') {
    s.tools++; s.newTools++;
    const id = d.callId || `x${s.events}`;
    s.pending.set(id, { name: d.name || '?', t0: time, args: summarizeArgs(d.name, d.arguments), at: time });
  }
  if (t === 'tool/result') {
    const id = d.toolCallId || d?.message?.toolCallId;
    const p = id && s.pending.get(id);
    const isErr = !!(d.isError || d?.message?.isError);
    if (isErr) { s.errors++; s.newErrors++; }
    if (p) {
      const item = { t: p.t0, name: p.name, args: p.args, ms: Math.max(0, time - p.t0), ok: !isErr, ws: s.ws, sid: s.key.replace('session-', '').slice(0, 8) };
      s.feed.push(item);
      if (s.feed.length > 40) s.feed.splice(0, s.feed.length - 40);
      toolLog.push(item);
      if (toolLog.length > 500) toolLog.splice(0, toolLog.length - 500);
      s.pending.delete(id);
    }
  }
}

function updateSession(entry) {
  let st;
  try { st = statSync(entry.file); } catch { sessions.delete(entry.key); return null; }
  let s = sessions.get(entry.key);
  if (!s) { s = newSess(entry); sessions.set(entry.key, s); }
  else if (s.file !== entry.file) { s = newSess(entry); sessions.set(entry.key, s); }

  if (st.size < s.consumed) { s = newSess(entry); sessions.set(entry.key, s); }
  if (st.size === s.consumed) return s;

  let buf;
  try { buf = readFileSync(entry.file); } catch (e) { s.err = String(e.message || e); return s; }
  const { parts, pos, bad } = decodeFrom(buf, s.consumed);
  if (bad) { s = newSess(entry); sessions.set(entry.key, s); return s; }
  if (!parts.length) return s;
  s.consumed = pos;
  const text = Buffer.concat(parts).toString('utf8');
  s.tail += text;
  const lines = s.tail.split('\n');
  s.tail = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { onEvent(s, JSON.parse(line)); } catch { /* partial/corrupt line */ }
  }
  s.ready = true;
  return s;
}

/* ---------------- aggregate ---------------- */
let lastBursts = { tools: 0, turns: 0, errors: 0 };
const lastPushAt = { t: 0 };

function summarize(s) {
  const now = Date.now();
  s.rateTimes = s.rateTimes.filter(t => t > now - 60000);
  // a call that never got a result (interrupted / killed) must not pin the HUD in "working"
  for (const [id, p] of s.pending) if (now - p.t0 > 90000) s.pending.delete(id);
  const rate = s.rateTimes.length;
  const pending = s.pending.size;
  let status = 'idle';
  if (s.lastType === 'tool/call' || pending) status = 'tool';
  else if (['turn/start', 'step/start', 'assistant/message', 'tool/result'].includes(s.lastType)) status = 'thinking';
  let cur = null;
  for (const pp of s.pending.values()) if (!cur || pp.t0 > cur.t0) cur = pp;
  return {
    id: s.key.replace('session-', '').slice(0, 8),
    currentTool: cur ? { name: cur.name, args: cur.args, t0: cur.t0 } : null,
    jobsActive: s.jobs || 0,
    startedAt: s.startedAt || 0,
    ws: s.ws, title: s.title || '(untitled)', model: s.model,
    status, turn: s.turn, step: s.step, rate,
    events: s.events, tools: s.tools, errors: s.errors, steps: s.steps,
    lastType: s.lastType, lastTime: s.lastTime, age: now - s.lastTime,
    activeTools: pending,
    feed: s.feed.slice(-6).reverse(),
  };
}

function aggregate() {
  const now = Date.now();
  const list = [...sessions.values()].filter(s => s.ready && now - s.lastTime < ACTIVE_WINDOW);
  list.sort((a, b) => b.lastTime - a.lastTime);
  const sums = list.map(summarize);
  const burst = { ...lastBursts };
  lastBursts = { tools: 0, turns: 0, errors: 0 };

  const rate = sums.reduce((a, s) => a + s.rate, 0);
  const rateShort = list.reduce((a, s) => a + s.rateTimes.filter(t => t > now - 4000).length, 0);
  const feed = [];
  for (const s of list) for (const f of s.feed) feed.push({ ...f, ws: s.ws, sid: s.key.replace('session-', '').slice(0, 8), title: s.title });
  feed.sort((a, b) => b.t - a.t);

  return {
    at: now,
    active: list.length,
    rate,
    rateShort,
    totals: {
      events: list.reduce((a, s) => a + s.events, 0),
      tools: list.reduce((a, s) => a + s.tools, 0),
      errors: list.reduce((a, s) => a + s.errors, 0),
      activeTools: sums.reduce((a, s) => a + s.activeTools, 0),
    },
    sessions: sums.slice(0, 8),
    feed: feed.slice(0, 12),
    toolLog: toolLog.slice(-160),
    bursts: burst,
  };
}

/* ---------------- local media session (QQ Music / Spotify / etc.) ---------------- */
const MEDIA_PS = join(ROOT, 'dsh-hud', 'media.ps1');
const MEDIA_TMP = join(ROOT, 'dsh-hud', '.media.json');
let mediaCache = { at: 0, data: { ok: false, title: '', artist: '', album: '', app: '', status: 'none' } };
let mediaBusy = false;

function refreshMedia(action = 'status') {
  if (mediaBusy) return;
  mediaBusy = true;
  let child;
  try {
    child = execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_PS,
      '-Action', action, '-OutFile', MEDIA_TMP,
    ], { windowsHide: true, stdio: 'ignore', timeout: 8000 }, () => {
      mediaBusy = false;
      try {
        const raw = readFileSync(MEDIA_TMP, 'utf8');
        mediaCache = { at: Date.now(), data: JSON.parse(raw) };
      } catch { /* no media session / script unavailable */ }
    });
    child.on('error', () => { mediaBusy = false; mediaCache = { at: Date.now(), data: { ok: false, title: '', artist: '', album: '', app: '', status: 'unavailable' } }; });
  } catch {
    mediaBusy = false;
  }
}
// polled on demand by the page (no background PowerShell churn when nobody asks)


/* ---------------- external AI apps (ChatGPT via UIA, WorkBuddy via OCR) ---------------- */
const EXTERNAL_PS = join(ROOT, 'dsh-hud', 'external.ps1');
const EXTERNAL_TMP = join(ROOT, 'dsh-hud', '.external.json');
let externalCache = { at: 0, data: { apps: [] } };
let externalBusy = false;
let externalPrevSnip = '';
let externalBusyUntil = 0;

function refreshExternal() {
  if (externalBusy) return;
  externalBusy = true;
  let child;
  try {
    child = execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTERNAL_PS, '-OutFile', EXTERNAL_TMP,
    ], { windowsHide: true, stdio: 'ignore', timeout: 20000 }, () => {
      externalBusy = false;
      try {
        const next = JSON.parse(readFileSync(EXTERNAL_TMP, 'utf8'));
        const snip = (next.apps || []).map(a => a.snippet || '').join('|');
        // text changed since the last probe → the app is producing output right now
        const agent = (next.apps || []).some(a => a && a.agent === true);
        if (agent) externalBusyUntil = Date.now() + 6000;                 // agent / computer-use mode
        else if (externalPrevSnip && snip && snip !== externalPrevSnip) externalBusyUntil = Date.now() + 8000;
        externalPrevSnip = snip;
        externalCache = { at: Date.now(), data: next };
      } catch {}
    });
    child.on('error', () => { externalBusy = false; });
  } catch { externalBusy = false; }
}


/* ---------------- usage / cost (reads the dsh-cost-meter ledger) ---------------- */
const LEDGER = join(homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json');
let usageCache = { at: 0, data: null };

function buildUsage() {
  try {
    const d = JSON.parse(readFileSync(LEDGER, 'utf8'));
    const now = new Date();
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
    const day = (d.days || {})[today] || {};
    const tok = x => (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0);
    const hitOf = x => (x.cacheRead ? x.cacheRead / ((x.input || 0) + x.cacheRead) : 0);
    const sessions = (day.sessions || []).map(s2 => ({
      id: s2.id, at: s2.at || 0, costCny: s2.costCny || 0,
      input: s2.input || 0, output: s2.output || 0, cacheRead: s2.cacheRead || 0,
      hit: hitOf(s2), tokens: tok(s2),
    })).sort((a, b) => b.at - a.at);
    const cfg = d.config || {};
    const windows = cfg.peakWindows || [{ start: 1, end: 4 }, { start: 6, end: 10 }];
    const uh = now.getUTCHours() + now.getUTCMinutes() / 60;
    const active = windows.find(w => uh >= w.start && uh < w.end);
    let nextAt = null;
    if (active) {
      nextAt = new Date(now); nextAt.setUTCHours(active.end, 0, 0, 0);
    } else {
      for (let dd = 0; dd <= 2 && !nextAt; dd++) {
        for (const w of windows) {
          const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dd, 0, 0, 0));
          t.setUTCHours(w.start, 0, 0, 0);
          if (t > now && (!nextAt || t < nextAt)) nextAt = t;
        }
      }
    }
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const label = nextAt ? `${week[nextAt.getDay()]} ${String(nextAt.getHours()).padStart(2, '0')}:${String(nextAt.getMinutes()).padStart(2, '0')}` : '';
    return {
      today: { tokens: tok(day), costCny: day.costCny || 0, hit: hitOf(day), calls: day.calls || 0, date: today },
      sessions,
      balance: (d.balanceRef && d.balanceRef.total) || null,
      peak: { inPeak: !!active, remainMs: nextAt ? nextAt - now : 0, nextLabel: label },
      at: Date.now(),
    };
  } catch (e) { return { error: String(e.message || e) }; }
}

/* ---------------- http ---------------- */
const clients = new Set();
let lastClientAt = Date.now();   // 最后一次有壁纸页面连上的时间
let lastPagePollAt = Date.now(); // 最后一次页面主动轮询（/external）的时间

function sendJson(res, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': b.length });
  res.end(b);
}

let probeInfo = null;   // reported by the wallpaper WebView2: { dpr, w, h }

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');   // the wallpaper wrapper is loaded from file:// (Origin: null)
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = decodeURIComponent(url.pathname);

  if (p === '/stats') {
    const u = process.cpuUsage();
    return sendJson(res, {
      cpuMs: (u.user + u.system) / 1000,
      uptimeMs: Math.round(process.uptime() * 1000),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      sessions: sessions.size,
      toolLog: toolLog.length,
      clients: clients.size,
    });
  }
  if (p === '/external') {
    lastPagePollAt = Date.now();
    if (Date.now() - externalCache.at > 3000) refreshExternal();
    return sendJson(res, { ...externalCache.data, busy: Date.now() < externalBusyUntil, age: Date.now() - externalCache.at });
  }
  if (p === '/media') {
    if (Date.now() - mediaCache.at > 3000) refreshMedia('status');
    return sendJson(res, { ...mediaCache.data, age: Date.now() - mediaCache.at });
  }
  if (p === '/media/action') {
    const act = url.searchParams.get('do') || 'toggle';
    refreshMedia(['toggle', 'next', 'prev'].includes(act) ? act : 'toggle');
    return sendJson(res, { ok: true, action: act });
  }
  if (p === '/usage') {
    if (!usageCache.data || Date.now() - usageCache.at > 5000) usageCache = { at: Date.now(), data: buildUsage() };
    const use = usageCache.data || {};
    const sid = url.searchParams.get('session') || '';
    let session = null;
    if (use.sessions) session = use.sessions.find(x => sid && x.id && x.id.includes(sid)) || use.sessions[0] || null;
    return sendJson(res, { ...use, session });
  }
  if (p === '/state') {
    const b = Buffer.from(JSON.stringify(aggregate()));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': b.length });
    return res.end(b);
  }
  if (p === '/probe') {
    const dpr = parseFloat(url.searchParams.get('dpr') || '0');
    const w = parseInt(url.searchParams.get('w') || '0', 10);
    const h = parseInt(url.searchParams.get('h') || '0', 10);
    const vh = parseInt(url.searchParams.get('vh') || '0', 10);
    const avail = parseInt(url.searchParams.get('avail') || '0', 10);
    const safe = url.searchParams.get('safe') || '';
    const panelBottom = parseInt(url.searchParams.get('panelBottom') || '-1', 10);
    if (dpr > 0) probeInfo = { dpr, w, h, vh, avail, safe, panelBottom, at: Date.now() };
    return sendJson(res, probeInfo || {});
  }
  if (p === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    lastClientAt = Date.now();
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/' || p === '/index.html' || p === '/live' || p === '/live.html' || p === '/wall' || p === '/wall.html') {
    const base = await readFile(join(STATIC_DIR, 'lab.html'), 'utf8');
    const bridge = await readFile(join(ROOT, 'dsh-hud', 'bridge.js'), 'utf8');
    const html = base.replace('</body>', `<script>${bridge}</script>\n</body>`);
    const b = Buffer.from(html);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-length': b.length });
    return res.end(b);
  }
  if (p.startsWith('/haloflux/') || p.startsWith('/audio/')) {
    const rel = normalize(p.startsWith('/audio/') ? p.slice(1) : p.slice('/haloflux/'.length)).replace(/^(\.\.[/\\])+/, '');
    const fp = join(STATIC_DIR, rel);
    if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const b = await readFile(fp);
      res.writeHead(200, { 'content-type': MIME[extname(fp).toLowerCase()] || 'application/octet-stream', 'content-length': b.length, 'cache-control': 'no-cache' });
      return res.end(b);
    } catch { res.writeHead(404); return res.end('not found'); }
  }
  res.writeHead(404); res.end('not found');
});

/* ---------------- poll loop ---------------- */
function tick() {
  const files = listSessionFiles();
  const now = Date.now();
  for (const entry of files) {
    try {
      const st = statSync(entry.file);
      if (now - st.mtimeMs > ACTIVE_WINDOW) {
        // stale: only keep if already loaded (stop decoding)
        if (!sessions.has(entry.key)) continue;
        const s = sessions.get(entry.key);
        if (!s || s.consumed !== st.size) continue;
      }
      updateSession(entry);
    } catch { /* skip */ }
  }
  const payload = aggregate();
  const msg = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}

tick();
setInterval(tick, POLL_MS);

/* 看门狗：壁纸页面掉线时自动恢复
   第 1 步：3 分钟无页面连接 -> reload 壁纸
   第 2 步：再 2 分钟还是没连上 -> 重启 Lively（WebView 冻死时 reload 不一定救得回来） */
let wdPhase = 0;
setInterval(() => {
  const pageFresh = Date.now() - lastPagePollAt < 180000;
  if (clients.size > 0 && pageFresh) { lastClientAt = Date.now(); wdPhase = 0; return; }
  const idle = Date.now() - lastClientAt;
  const LIVELY = 'C:\\Program Files\\Lively Wallpaper\\Lively.exe';
  if (idle < 180000) return;
  if (wdPhase === 0) {
    wdPhase = 1; lastClientAt = Date.now(); lastPagePollAt = Date.now();
    try { execFile(LIVELY, ['setwp', '--file', 'reload'], { windowsHide: true, timeout: 20000 }, () => {}); } catch (e) {}
    console.log('[watchdog] no wallpaper client for 3min -> reload wallpaper');
  } else if (idle >= 120000) {
    wdPhase = 0; lastClientAt = Date.now(); lastPagePollAt = Date.now();
    try {
      execFile('taskkill', ['/IM', 'Lively.exe', '/F'], { windowsHide: true }, () => {
        setTimeout(() => { try { execFile(LIVELY, [], { windowsHide: true }, () => {}); } catch (e) {} }, 3000);
      });
    } catch (e) {}
    console.log('[watchdog] still no client -> restart Lively');
  }
}, 60000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`port ${PORT} already in use — HUD server is already running`); process.exit(0); }
  throw e;
});

process.on('uncaughtException', (e) => { console.error('[fatal] uncaught:', e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[warn] unhandled rejection:', e && e.stack || e); });

server.listen(PORT, HOST, () => {
  console.log(`HUD live   http://${HOST}:${PORT}/`);
  console.log(`sessions   ${SESSIONS}`);
  console.log(`static     ${STATIC_DIR}`);
});
