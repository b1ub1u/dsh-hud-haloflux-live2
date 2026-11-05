import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { join, extname, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';
import { createMiniMaxSource } from './minimax-source.mjs';
import { createWorkBuddySource } from './workbuddy-source.mjs';
import { createClaudeSource } from './claude-source.mjs';
import { createDoubaoSource } from './doubao-source.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.HUD_PORT || 7788);
const ROOT = resolve(process.argv[2] || '.');
const STATIC_DIR = join(ROOT, 'haloflux');
const SESSIONS = join(homedir(), '.dsh', 'sessions');
const POLL_MS = 500;
const ACTIVE_WINDOW = 15 * 60 * 1000;

/* second data source: MiniMax Code (local runtime store) */
const mmSource = createMiniMaxSource();

/* third data source: WorkBuddy (append-only session JSONL + sqlite metadata) */
const wbSource = createWorkBuddySource();

/* fourth data source: Claude Code (append-only transcript JSONL, no metadata store) */
const ccSource = createClaudeSource();

/* fifth data source: Doubao PC (closed client; inferred from external.ps1 UIA snapshot) */
const dbSource = createDoubaoSource();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/* ---------------- workspace name decode ---------------- */
/* The DSH session dir encodes an absolute path ("--D-56587-Documents-...--"), but the
   encoding is LOSSY: the same "-" is used for a path separator AND for hyphens that are
   part of folder names ("deepseek-harness" -> "deepseek-harness", "default-workspace" ->
   "default-workspace"). Rebuilding a path from it is therefore guesswork, which is how
   the HUD used to display "D\56587\Documents\deepseek\harness\default\workspace" instead
   of "default-workspace".
   We now return the raw token only as a placeholder; onEvent() replaces it with the
   trailing segment of the REAL cwd that the session's first record carries. */
function decodeWs(enc) {
  const body = enc.replace(/^--/, '').replace(/--$/, '');
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '~') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
    else out += body[i];
  }
  return out || enc;
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
    id: entry.id || entry.key.replace('session-', '').slice(0, 8),
    source: entry.source || 'dsh',
    agent: entry.agent || 'DeepSeek Harness',
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

/* Privacy scrub applied at the SOURCE, so every consumer (panels, ring cards, SSE,
   /state, /sources) gets the safe form without each of them having to remember.
   Absolute paths leak the account name and the project layout to anyone looking at
   the wallpaper or a shared screenshot; keep only the last two segments. */
function scrubPath(s) {
  let t = String(s);
  t = t.replace(/["']?[A-Za-z]:\\(?:[^\\\/"'|]+\\?){1,}/g, (m0) => {
    const segs = m0.replace(/["']/g, '').split(/[\\\/]+/).filter(Boolean);
    return '…\\' + segs.slice(-2).join('\\');
  });
  t = t.replace(/["']?\/?(?:[\w.\-]+\/){2,}[\w.\-]+/g, (m0) => {
    const segs = m0.replace(/["']/g, '').split('/').filter(Boolean);
    if (segs.length < 3) return m0;
    return '…/' + segs.slice(-2).join('/');
  });
  t = t.replace(/\/home\/[A-Za-z0-9._-]+\//g, '/home/…/');
  t = t.replace(/\/Users\/[A-Za-z0-9._-]+\//g, '/Users/…/');
  return t;
}

function summarizeArgs(name, args) {
  try {
    const a = typeof args === 'string' ? JSON.parse(args) : (args || {});
    const pick = a.description || a.command || a.path || a.file_path || a.pattern || a.query || a.url || a.prompt || a.title || '';
    return scrubPath(String(pick).replace(/\s+/g, ' ').trim()).slice(0, 110);
  } catch { return ''; }
}

function onEvent(s, ev) {
  const t = ev.type, d = ev.data || {}, time = ev.time || Date.now();
  s.events++; s.lastType = t; s.lastTime = time;
  s.rateTimes.push(time);
  const cwd = ev.cwd || d.cwd;
  // Workspace label policy:
  //  - adapter sources (minimax/workbuddy/claude) pass a friendly label up front -> keep it
  //  - DSH passes a lossy decoded token -> replace it with the real cwd's trailing segment
  if (t === 'session' && cwd) {
    s.cwd = cwd;
    const seg = String(cwd).split(/[\\/]+/).filter(Boolean).pop();
    if (seg && s.source === 'dsh') s.ws = seg;        // real path wins for DSH
    else if (!s.ws) s.ws = seg || s.ws;              // others: only fill an empty label
  }
  if (t === 'session') s.startedAt = ev.createdAt || d.createdAt || s.startedAt || 0;
  if (t === 'session/title' && d.title) s.title = d.title;
  if (t === 'request/header') s.model = d?.header?.config?.model || s.model;
  if (t === 'assistant/message' && d.model) s.model = d.model;
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
      const item = { t: p.t0, name: p.name, args: p.args, ms: Math.max(0, time - p.t0), ok: !isErr, ws: s.ws, sid: s.id, source: s.source, agent: s.agent };
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
const lastPushAt = { t: 0 };
let lastBursts = { tools: 0, turns: 0, errors: 0 };

/** Move the per-session deltas into the burst accumulator.
 *  Only ever called from the poll loop, so an extra /state request can never
 *  swallow a burst before it reaches the page. */
function drainBursts() {
  const b = { tools: 0, turns: 0, errors: 0 };
  for (const s of sessions.values()) {
    b.tools += s.newTools || 0; s.newTools = 0;
    b.turns += s.newTurns || 0; s.newTurns = 0;
    b.errors += s.newErrors || 0; s.newErrors = 0;
  }
  lastBursts = b;
}

function summarize(s) {
  const now = Date.now();
  s.rateTimes = s.rateTimes.filter(t => t > now - 60000);
  // a call that never got a result (interrupted / killed) must not pin the HUD in "working"
  for (const [id, p] of s.pending) if (now - p.t0 > 90000) s.pending.delete(id);
  const rate = s.rateTimes.length;
  const pending = s.pending.size;
  let status = 'idle';
  if (s.lastType === 'tool/call' || pending) status = 'tool';
  else if (['turn/start', 'step/start', 'assistant/message', 'tool/result', 'user/message'].includes(s.lastType)) {
    // a finished turn leaves the last event on 'assistant/message' forever; after 3 quiet
    // minutes the session is really waiting for input, not thinking
    status = now - s.lastTime < 180000 ? 'thinking' : 'idle';
  }
  let cur = null;
  for (const pp of s.pending.values()) if (!cur || pp.t0 > cur.t0) cur = pp;
  return {
    id: s.id,
    source: s.source || 'dsh',
    agent: s.agent || 'DeepSeek Harness',
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

  // bursts: drained once per poll cycle, never by a plain /state read
  const burst = { ...lastBursts };

  const rate = sums.reduce((a, s) => a + s.rate, 0);
  const rateShort = list.reduce((a, s) => a + s.rateTimes.filter(t => t > now - 4000).length, 0);
  const feed = [];
  for (const s of list) for (const f of s.feed) feed.push({ ...f, ws: s.ws, sid: s.id, title: s.title, source: s.source, agent: s.agent });
  feed.sort((a, b) => b.t - a.t);

  // per-source breakdown.
  // An adapter that just connected usually has no event in the last 15 min (its session
  // history is already on disk), so counting only the ACTIVE list used to make a perfectly
  // healthy MiniMax / WorkBuddy source look "not connected". We therefore count EVERY known
  // session per source, and expose `active` separately.
  const bySource = {};
  const ensureB = (k) => bySource[k] || (bySource[k] = {
    rate: 0, rateShort: 0, sessions: 0, active: 0, tools: 0, events: 0, errors: 0, lastAt: 0,
  });
  for (const s of sessions.values()) {
    if (!s.ready) continue;
    const b = ensureB(s.source || 'dsh');
    b.sessions += 1;
    b.tools += s.tools; b.events += s.events; b.errors += s.errors;
    b.lastAt = Math.max(b.lastAt, s.lastTime || 0);
    if (now - (s.lastTime || 0) < ACTIVE_WINDOW) b.active += 1;
    b.rate += s.rateTimes.filter(t => t > now - 60000).length;
    b.rateShort += s.rateTimes.filter(t => t > now - 4000).length;
  }

  // keep both sources on screen: top N of each, then re-sorted by recency
  const bySrc = new Map();
  for (const v of sums) {
    const k = v.source || 'dsh';
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k).push(v);
  }
  const picked = [];
  for (const arr of bySrc.values()) picked.push(...arr.slice(0, 5));
  picked.sort((a, b) => b.lastTime - a.lastTime);

  return {
    at: now,
    active: list.length,
    rate,
    rateShort,
    bySource,
    totals: {
      events: list.reduce((a, s) => a + s.events, 0),
      tools: list.reduce((a, s) => a + s.tools, 0),
      errors: list.reduce((a, s) => a + s.errors, 0),
      activeTools: sums.reduce((a, s) => a + s.activeTools, 0),
    },
    sessions: picked.slice(0, 10),
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
dbSource.setSnapshotPath(EXTERNAL_TMP);
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
      today: {
        tokens: tok(day), costCny: day.costCny || 0, hit: hitOf(day), calls: day.calls || 0, date: today,
        input: day.input || 0, output: day.output || 0, cacheRead: day.cacheRead || 0, cacheWrite: day.cacheWrite || 0,
      },
      sessions,
      balance: (d.balanceRef && d.balanceRef.total) || null,
      peak: { inPeak: !!active, remainMs: nextAt ? nextAt - now : 0, nextLabel: label },
      at: Date.now(),
    };
  } catch (e) { return { error: String(e.message || e) }; }
}

/* ---------------- MiniMax Code source ----------------
   The MiniMax Code runtime appends to ~/.minimax/v2/sessions/**\/messages.jsonl while
   a turn is running. We tail those logs and push the events into the same state
   machine the DSH sessions use, so both harnesses drive one picture. */
let mmBusy = false;
let mmSeen = new Set();

async function pollMiniMax() {
  if (mmBusy) return;
  mmBusy = true;
  try {
    const res = await mmSource.poll();
    const seen = new Set();
    for (const [key, entry] of res.sessions) {
      seen.add(key);
      let s = sessions.get(key);
      if (!s) {
        s = newSess({
          key, ws: entry.meta.ws, file: entry.meta.file,
          id: entry.meta.shortId, source: 'minimax', agent: entry.meta.agent,
        });
        s.ready = true;
        sessions.set(key, s);
      }
      s.title = entry.meta.title || s.title;
      s.model = entry.meta.model || s.model;
      s.agent = entry.meta.agent || s.agent;
      s.status = entry.meta.status || s.status;
      if (entry.meta.createdAt) s.startedAt = entry.meta.createdAt;
      for (const ev of entry.events) onEvent(s, ev);
    }
    // drop sessions whose folder disappeared
    for (const k of mmSeen) if (!seen.has(k)) sessions.delete(k);
    mmSeen = seen;
  } catch (e) {
    /* the MiniMax store is optional - never let it take the HUD down */
  }
  mmBusy = false;
}

/* ---------------- WorkBuddy source ----------------
   WorkBuddy appends one JSON object per line to
   ~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl while a turn is running, and keeps
   title / status / model in ~/.workbuddy/workbuddy.db. The source normalizes both into the
   same event vocabulary as DSH + MiniMax Code, so the three harnesses share this state machine. */
let wbBusy = false;
let wbSeen = new Set();

async function pollWorkBuddy() {
  if (wbBusy) return;
  wbBusy = true;
  try {
    const res = await wbSource.poll();
    const seen = new Set();
    for (const [key, entry] of res.sessions) {
      seen.add(key);
      let s = sessions.get(key);
      if (!s) {
        s = newSess({
          key, ws: entry.meta.ws, file: entry.meta.file,
          id: entry.meta.shortId, source: 'workbuddy', agent: entry.meta.agent,
        });
        s.ready = true;
        sessions.set(key, s);
      }
      s.title = entry.meta.title || s.title;
      s.model = entry.meta.model || s.model;
      s.agent = entry.meta.agent || s.agent;
      if (entry.meta.createdAt) s.startedAt = entry.meta.createdAt;
      for (const ev of entry.events) onEvent(s, ev);
    }
    // drop sessions whose log rotated out of the lookback window
    for (const k of wbSeen) if (!seen.has(k)) {
      const s = sessions.get(k);
      if (s && (!s.lastTime || Date.now() - s.lastTime > ACTIVE_WINDOW)) sessions.delete(k);
    }
    wbSeen = seen;
  } catch (e) {
    /* WorkBuddy store is optional - never let it take the HUD down */
  }
  wbBusy = false;
}

/* ---------------- Claude Code source ----------------
   Claude Code appends one JSON object per line to
   <CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/<session-uuid>.jsonl.
   No sqlite, no index: the transcript is the only truth (title = summary record or first prompt). */
let ccBusy = false;
let ccSeen = new Set();

async function pollClaude() {
  if (ccBusy) return;
  ccBusy = true;
  try {
    const res = await ccSource.poll();
    const seen = new Set();
    for (const [key, entry] of res.sessions) {
      seen.add(key);
      let s = sessions.get(key);
      if (!s) {
        s = newSess({
          key, ws: entry.meta.ws, file: entry.meta.file,
          id: entry.meta.shortId, source: 'claude', agent: entry.meta.agent,
        });
        s.ready = true;
        sessions.set(key, s);
      }
      s.title = entry.meta.title || s.title;
      s.model = entry.meta.model || s.model;
      s.agent = entry.meta.agent || s.agent;
      for (const ev of entry.events) onEvent(s, ev);
    }
    for (const k of ccSeen) if (!seen.has(k)) {
      const s = sessions.get(k);
      if (s && (!s.lastTime || Date.now() - s.lastTime > ACTIVE_WINDOW)) sessions.delete(k);
    }
    ccSeen = seen;
  } catch (e) {
    /* Claude Code is optional (and probably not even installed) - never take the HUD down */
  }
  ccBusy = false;
}

/* ---------------- Doubao source ----------------
   Doubao PC is a closed Electron chat client with no local transcript. We reuse
   the UIA snapshot that external.ps1 already writes to .external.json and turn
   window-state transitions (running / 执行中 / title-snippet changes) into the
   same event vocabulary, so Doubao appears on the ring and event-rate chart
   alongside DSH / MiniMax / WorkBuddy / Claude Code. */
let dbBusy = false;
let dbSeen = new Set();

async function pollDoubao() {
  if (dbBusy) return;
  dbBusy = true;
  try {
    const res = await dbSource.poll();
    const seen = new Set();
    for (const [key, entry] of res.sessions) {
      seen.add(key);
      let s = sessions.get(key);
      if (!s) {
        s = newSess({
          key, ws: entry.meta.ws, file: entry.meta.file,
          id: entry.meta.shortId, source: 'doubao', agent: entry.meta.agent,
        });
        s.ready = true;
        sessions.set(key, s);
      }
      s.title = entry.meta.title || s.title;
      s.model = entry.meta.model || s.model;
      s.agent = entry.meta.agent || s.agent;
      if (entry.meta.createdAt) s.startedAt = entry.meta.createdAt;
      for (const ev of entry.events) onEvent(s, ev);
    }
    for (const k of dbSeen) if (!seen.has(k)) {
      const s = sessions.get(k);
      if (s && (!s.lastTime || Date.now() - s.lastTime > ACTIVE_WINDOW)) sessions.delete(k);
    }
    dbSeen = seen;
  } catch (e) {
    /* Doubao is optional - never let it take the HUD down */
  }
  dbBusy = false;
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
    let mm = 0, wb = 0, cc = 0, db = 0;
    for (const k of sessions.keys()) {
      if (k.startsWith('mm:')) mm++;
      else if (k.startsWith('wb:')) wb++;
      else if (k.startsWith('cc:')) cc++;
      else if (k.startsWith('db:')) db++;
    }
    return sendJson(res, {
      cpuMs: (u.user + u.system) / 1000,
      uptimeMs: Math.round(process.uptime() * 1000),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      sessions: sessions.size,
      minimaxSessions: mm,
      workbuddySessions: wb,
      claudeSessions: cc,
      doubaoSessions: db,
      dshSessions: sessions.size - mm - wb - cc - db,
      claudeRoot: ccSource.root(),
      claudeStore: ccSource.onDisk(),
      toolLog: toolLog.length,
      clients: clients.size,
    });
  }
  if (p === '/sources') {
    /* one row per harness: who is plugged in right now, and how busy */
    const now = Date.now();
    const out = {};
    for (const s of sessions.values()) {
      const k = s.source || 'dsh';
      const o = out[k] || (out[k] = {
        source: k, agent: s.agent || k, sessions: 0, active: 0,
        rate: 0, events: 0, tools: 0, errors: 0, lastAt: 0,
      });
      o.sessions += 1;
      o.events += s.events; o.tools += s.tools; o.errors += s.errors;
      o.lastAt = Math.max(o.lastAt, s.lastTime || 0);
      if (now - (s.lastTime || 0) < ACTIVE_WINDOW) o.active += 1;
      o.rate += s.rateTimes.filter(t => t > now - 60000).length;
    }
    return sendJson(res, { at: now, activeWindowMs: ACTIVE_WINDOW, sources: Object.values(out) });
  }
  if (p === '/external') {
    lastPagePollAt = Date.now();
    const stale = Date.now() - externalCache.at > 3000;
    if (stale && !externalBusy) refreshExternal();
    // First request after boot: the probe is async, so returning the empty cache here
    // made a freshly started HUD show "no external AI". Wait (max 3.5 s) for the very
    // first snapshot so the panel is populated on the first paint.
    if (!externalCache.at && externalBusy) {
      const deadline = Date.now() + 3500;
      while (!externalCache.at && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return sendJson(res, {
      ...externalCache.data,
      busy: Date.now() < externalBusyUntil,
      age: externalCache.at ? (Date.now() - externalCache.at) : 0,   // never a bogus absolute epoch
    });
  }
  if (p === '/media') {
    const stale = Date.now() - mediaCache.at > 3000;
    if (stale && !mediaBusy) refreshMedia('status');
    // same first-paint fix as /external: wait for the very first media snapshot
    if (!mediaCache.at && mediaBusy) {
      const deadline = Date.now() + 3000;
      while (!mediaCache.at && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return sendJson(res, {
      ...mediaCache.data,
      age: mediaCache.at ? (Date.now() - mediaCache.at) : 0,
    });
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
    let mm = null, wb = null, cc = null, db = null;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    try { mm = await mmSource.usageSince(midnight.getTime()); } catch { /* the MiniMax store is optional */ }
    try { wb = wbSource.usageSince(midnight.getTime()); } catch { /* the WorkBuddy store is optional */ }
    try { cc = ccSource.usageSince(midnight.getTime()); } catch { /* the Claude Code store is optional */ }
    try { db = await dbSource.usageSince(midnight.getTime()); } catch { /* Doubao has no local ledger */ }
    return sendJson(res, { ...use, session, minimax: mm, workbuddy: wb, claude: cc, doubao: db });
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
    // IMPORTANT: replace() with a STRING replacement expands $-patterns ($&, $`, $', $1…).
    // bridge.js contains the literal '$' (currency tag), so a string replacement turned
    // "$'" into "everything after the match" and corrupted the whole injected script
    // (SyntaxError: Invalid or unexpected token -> the bridge never ran). Use a
    // replacer FUNCTION so the injected text is taken literally.
    const html = base.replace('</body>', () => `<script>${bridge}</script>\n</body>`);
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
  pollMiniMax();                       // MiniMax Code sessions (async, never blocks the loop)
  pollWorkBuddy();                     // WorkBuddy sessions (async, never blocks the loop)
  pollClaude();                        // Claude Code transcripts (async, never blocks the loop)
  pollDoubao();                        // Doubao PC window-state (async, never blocks the loop)
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
  drainBursts();
  const payload = aggregate();
  const msg = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}

tick();
pollMiniMax();
pollWorkBuddy();
pollClaude();
pollDoubao();
setInterval(tick, POLL_MS);

/* 看门狗：壁纸页面掉线时自动恢复
   第 1 步：3 分钟无页面连接 -> reload 壁纸
   第 2 步：再 2 分钟还是没连上 -> 重启 Lively（WebView 冻死时 reload 不一定救得回来） */
/* Wallpaper watchdog — CONSERVATIVE MODE.
   The old version looped forever: "no client for 3 min -> setwp reload", "still none
   after 2 min -> taskkill Lively + relaunch". When the wallpaper merely wasn't
   connected yet (service restarted, Lively still booting), it kept rewriting the
   Lively layout, which replaced dshhaloflux.001 with other wallpapers and left the
   desktop with no HUD at all. It could also fight a legitimately different wallpaper.
   New policy:
     - Lively not running  -> do nothing (user may have closed it on purpose)
     - one reload attempt  -> then STOP re-reloading and just log
     - never taskkill Lively automatically
     - any client connect  -> reset the counter and arm one fresh attempt */
const LIVELY_EXE = 'C:\\Program Files\\Lively Wallpaper\\Lively.exe';
const WD_IDLE_MS = 180000;       // 3 min without a wallpaper client before acting
const WD_MAX_RELOADS = 1;        // one automatic reload per outage, then stay quiet
let wdPhase = 0;
let wdReloadsThisOutage = 0;

setInterval(() => {
  const pageFresh = Date.now() - lastPagePollAt < 180000;
  if (clients.size > 0 && pageFresh) {
    // healthy again: re-arm exactly one automatic reload for the next outage
    lastClientAt = Date.now();
    wdPhase = 0;
    wdReloadsThisOutage = 0;
    return;
  }
  const idle = Date.now() - lastClientAt;
  if (idle < WD_IDLE_MS) return;

  // Lively is not running: silently give up. Relaunching it is the user's call.
  let livelyUp = false;
  try { livelyUp = !!GetLivelyRunning(); } catch (e) { livelyUp = false; }
  if (!livelyUp) {
    if (wdPhase !== 2) { wdPhase = 2; console.log('[watchdog] no client and Lively is not running -> idle (not relaunching)'); }
    return;
  }

  if (wdReloadsThisOutage >= WD_MAX_RELOADS) {
    if (wdPhase !== 2) { wdPhase = 2; console.log('[watchdog] still no client after the single reload -> giving up (manual fix needed)'); }
    return;
  }

  // one (and only one) reload attempt
  wdReloadsThisOutage += 1;
  wdPhase = 1;
  lastClientAt = Date.now();
  lastPagePollAt = Date.now();
  try { execFile(LIVELY_EXE, ['setwp', '--file', 'reload'], { windowsHide: true, timeout: 20000 }, () => {}); } catch (e) {}
  console.log('[watchdog] no wallpaper client for 3min -> single reload attempt (no taskkill)');
}, 60000);

/* Is Lively running? Use tasklist (cheap, no window) instead of reloading blindly. */
let livelyCheck = { at: 0, running: false };
function GetLivelyRunning() {
  if (Date.now() - livelyCheck.at < 15000) return livelyCheck.running;
  let running = false;
  try {
    // synchronous on purpose: it runs once a minute, and cost is ~10 ms
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Lively.exe', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    running = /Lively\.exe/i.test(String(out || ''));
  } catch (e) { running = false; }
  livelyCheck = { at: Date.now(), running };
  return running;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`port ${PORT} already in use — HUD server is already running`); process.exit(0); }
  throw e;
});

process.on('uncaughtException', (e) => { console.error('[fatal] uncaught:', e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[warn] unhandled rejection:', e && e.stack || e); });

server.listen(PORT, HOST, () => {
  console.log(`HUD live   http://${HOST}:${PORT}/`);
  console.log(`sessions   ${SESSIONS}`);
  console.log(`claude     ${ccSource.root()} ${ccSource.onDisk() ? '(store found)' : '(no store yet - idle until Claude Code runs)'}`);
  console.log(`doubao     UIA snapshot ${EXTERNAL_TMP} ${dbSource.onDisk() ? '(found)' : '(waiting for external.ps1)'}`);
  console.log(`static     ${STATIC_DIR}`);
});
