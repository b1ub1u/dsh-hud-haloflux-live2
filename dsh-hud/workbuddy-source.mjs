/* WorkBuddy data source for the HUD.
 *
 * Reads the local WorkBuddy (CodeBuddy desktop) session store:
 *   ~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl   append-only event log
 *   ~/.workbuddy/workbuddy.db                               sqlite: session metadata
 *
 * Record types in the JSONL log:
 *   session-meta            { sessionId, meta }
 *   message                 { role: user|assistant, content:[{type:'input_text'|'output_text',text}] }
 *   reasoning               { providerData:{stepSeq, model, conversationRequestId}, rawContent:[...] }
 *   function_call           { callId, name, arguments(JSON string), providerData:{...} }
 *   function_call_result    { callId, name, status:'completed'|'incomplete', output:{text} }
 *   credit-usage            { providerData:{credit} }
 *   ai-title                { aiTitle }
 *
 * It emits the SAME normalized event vocabulary the DeepSeek Harness / MiniMax Code
 * sources use (session / request-header / turn-start / step-start / tool-call /
 * tool-result / assistant-message / user-message), so server.mjs pushes all three
 * harnesses into one state machine and one SSE stream with zero extra glue.
 *
 * Everything here is best-effort: if sqlite is locked/missing the JSONL log alone is
 * enough, and any failure degrades to "no WorkBuddy sessions" instead of hurting the HUD.
 */

import { statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const WB_ROOT = join(homedir(), '.workbuddy');
const PROJECTS = join(WB_ROOT, 'projects');
const DB_PATH = join(WB_ROOT, 'workbuddy.db');

const TAIL_BYTES = 8 * 1024 * 1024;    // first read: whole file if small, else the last 8 MB
const LOOKBACK = 12 * 3600 * 1000;     // only sessions touched in the last 12 h are tailed
const MAX_FILES = 24;                  // hard cap: never parse the whole archive on startup
const META_TTL = 15000;                // sqlite metadata cache (title/status barely change)
const DISCOVERY_TTL = 6000;            // folder scan cache
const KEEP_DAYS = 7;                   // usage buckets kept around

/* ---------------- helpers ---------------- */

/** Read only the newly appended bytes of a plain-text log.
 *  Returns complete lines; a trailing partial line stays in st.tail for the next call. */
function pullLines(file, st) {
  let size;
  try { size = statSync(file).size; } catch { return []; }
  if (st.offset > size) { st.offset = 0; st.tail = ''; }        // truncated / rotated
  if (size === st.offset) return [];

  let from = st.offset;
  let dropFirst = false;
  if (st.first) {
    st.first = false;
    from = size > TAIL_BYTES ? size - TAIL_BYTES : 0;           // small logs: read them all
    dropFirst = from > 0;                                       // may cut a half line
  }
  const len = size - from;
  if (len <= 0) return [];

  const buf = Buffer.allocUnsafe(len);
  let fd = -1, got = 0;
  try {
    fd = openSync(file, 'r');
    got = readSync(fd, buf, 0, len, from);
  } catch { return []; }                      // locked / rotated mid-read: retry next tick
  finally { if (fd >= 0) { try { closeSync(fd); } catch { } } }
  if (!got) return [];
  st.offset = from + got;

  let text = st.tail + buf.subarray(0, got).toString('utf8');
  if (dropFirst) {
    const i = text.indexOf('\n');
    if (i === -1) { st.tail = ''; return []; }
    text = text.slice(i + 1);
  }
  const lines = text.split('\n');
  st.tail = lines.pop() || '';
  return lines;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const p of content) {
    if (!p) continue;
    if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && p.text) out += p.text;
  }
  return out;
}

/** The first user message is stuffed with injected context - strip it down to the ask. */
function titleFallback(text) {
  let s = String(text || '');
  s = s.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<user-context[\s\S]*?<\/user-context>/g, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/@scene#\d+:"[^"]*"/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 60);
}

/** WorkBuddy workspaces are timestamp folders (2026-11-05-02-03-28) - make them readable. */
function prettyWs(cwd) {
  const base = basename(String(cwd || '').replace(/[\\/]+$/, ''));
  if (!base) return 'WorkBuddy';
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}-${m[4]}:${m[5]}`;          // 11-05 02:03
  return base;
}

const localDay = (ms) => {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------------- sqlite metadata ---------------- */

let db = null;
let dbBroken = false;

async function openDb() {
  if (db || dbBroken) return db;
  if (!existsSync(DB_PATH)) { dbBroken = true; return null; }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    dbBroken = true;
    db = null;
  }
  return db;
}

/* ---------------- source ---------------- */

export function createWorkBuddySource() {
  /* per-file cursors + counters */
  const files = new Map();      // absolute path -> state
  const usageDays = new Map();  // 'YYYY-MM-DD' -> usage bucket
  let discovery = { at: 0, list: [] };
  let metaCache = { at: 0, sessions: new Map() };

  /* -------- usage bookkeeping -------- */

  function bucket(day) {
    let b = usageDays.get(day);
    if (!b) {
      b = { input: 0, output: 0, cacheRead: 0, tokens: 0, calls: 0, credit: 0, sessions: new Map() };
      usageDays.set(day, b);
      if (usageDays.size > KEEP_DAYS) {
        const oldest = [...usageDays.keys()].sort()[0];
        if (oldest && oldest !== day) usageDays.delete(oldest);
      }
    }
    return b;
  }

  function addUsage(sessionId, raw, time) {
    if (!raw || typeof raw !== 'object') return;
    const prompt = raw.prompt_tokens ?? raw.input_tokens ?? 0;
    const output = raw.completion_tokens ?? raw.output_tokens ?? 0;
    const cacheRead = (raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens)
      || raw.prompt_cache_hit_tokens || raw.cache_read_input_tokens || 0;
    if (!prompt && !output) return;
    // prompt_tokens already contains the cached part; the other sources report "fresh input"
    // separately, so normalize here: input = fresh tokens, cacheRead = cached tokens.
    const input = Math.max(0, prompt - Math.min(cacheRead, prompt));
    const b = bucket(localDay(time));
    b.input += input;
    b.output += output;
    b.cacheRead += cacheRead;
    b.tokens += prompt + output;
    b.calls += 1;
    let s = b.sessions.get(sessionId);
    if (!s) { s = { id: sessionId, input: 0, output: 0, cacheRead: 0, tokens: 0, calls: 0, at: 0 }; b.sessions.set(sessionId, s); }
    s.input += input; s.output += output; s.cacheRead += cacheRead; s.tokens += prompt + output; s.calls += 1;
    s.at = Math.max(s.at, time || 0);
  }

  function addCredit(sessionId, credit, time) {
    if (!credit) return;
    const b = bucket(localDay(time));
    b.credit += credit;
    let s = b.sessions.get(sessionId);
    if (!s) { s = { id: sessionId, input: 0, output: 0, cacheRead: 0, tokens: 0, calls: 0, credit: 0, at: 0 }; b.sessions.set(sessionId, s); }
    s.credit = (s.credit || 0) + credit;
    s.at = Math.max(s.at, time || 0);
  }

  /* -------- metadata -------- */

  async function loadMeta() {
    if (Date.now() - metaCache.at < META_TTL && metaCache.sessions.size) return metaCache.sessions;
    const sessions = new Map();
    const d = await openDb();
    if (d) {
      const queries = [
        `select id, cwd, title, custom_title, status, model, created_at, updated_at,
                last_activity_at, mode, is_background_automation
           from sessions
          where deleted_at is null or deleted_at < 0
          order by updated_at desc limit 80`,
        `select id, cwd, title, status, model, created_at, updated_at
           from sessions order by updated_at desc limit 80`,
      ];
      for (const q of queries) {
        try {
          for (const r of d.prepare(q).all()) sessions.set(r.id, r);
          break;
        } catch { /* column set changed in a newer build: fall through to the simpler query */ }
      }
    }
    metaCache = { at: Date.now(), sessions };
    return sessions;
  }

  /* -------- discovery -------- */

  function discover() {
    if (Date.now() - discovery.at < DISCOVERY_TTL) return discovery.list;
    const out = [];
    let dirs = [];
    try { dirs = readdirSync(PROJECTS, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { }
    for (const dir of dirs) {
      const full = join(PROJECTS, dir.name);
      let names = [];
      try { names = readdirSync(full); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.jsonl') || f.endsWith('.file-rollback.ndjson')) continue;
        const file = join(full, f);
        let st;
        try { st = statSync(file); } catch { continue; }
        if (Date.now() - st.mtimeMs > LOOKBACK) continue;          // cold archive: ignore
        out.push({ file, id: f.slice(0, -'.jsonl'.length), size: st.size, mtime: st.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    discovery = { at: Date.now(), list: out.slice(0, MAX_FILES) };
    return discovery.list;
  }

  /* -------- record -> normalized events -------- */

  function ensureTurn(pd, time, st, out) {
    const rid = pd && pd.conversationRequestId;
    if (rid && rid !== st.turnId) {
      st.turnId = rid;
      st.turns += 1;
      out.push({ type: 'turn/start', time, data: { turn: st.turns } });
    }
    const model = (pd && (pd.requestModelName || pd.model)) || '';
    if (model && model !== st.lastModel) {
      st.lastModel = model;
      out.push({ type: 'request/header', time, data: { header: { config: { model } } } });
    }
  }

  function ensureStep(pd, time, st, out) {
    const seq = pd && pd.stepSeq;
    if (seq == null || seq === st.lastStep) return;
    st.lastStep = seq;
    st.steps += 1;
    out.push({ type: 'step/start', time, data: { step: st.steps } });
  }

  function parseRecord(rec, st, out) {
    if (!rec || typeof rec !== 'object') return;
    const t = rec.type;
    const time = rec.timestamp || Date.now();
    const pd = rec.providerData || {};
    if (rec.cwd && !st.cwd) st.cwd = rec.cwd;

    if (t === 'message') {
      if (rec.role === 'user') {
        const text = textOf(rec.content);
        const clean = titleFallback(text);
        if (clean) {
          if (!st.title) st.title = clean;
          out.push({ type: 'user/message', time, data: { text: clean.slice(0, 200) } });
        }
        return;
      }
      if (rec.role === 'assistant') {
        ensureTurn(pd, time, st, out);
        ensureStep(pd, time, st, out);
        addUsage(st.id, pd.rawUsage, time);
        out.push({ type: 'assistant/message', time, data: { model: pd.requestModelName || pd.model } });
      }
      return;
    }

    if (t === 'reasoning') {
      ensureTurn(pd, time, st, out);
      ensureStep(pd, time, st, out);
      return;
    }

    if (t === 'function_call') {
      ensureTurn(pd, time, st, out);
      ensureStep(pd, time, st, out);
      st.calls += 1;
      out.push({
        type: 'tool/call', time,
        data: { callId: rec.callId || `wb${st.calls}`, name: rec.name || '?', arguments: rec.arguments || {} },
      });
      return;
    }

    if (t === 'function_call_result') {
      const text = (rec.output && rec.output.text) || '';
      const isError = (rec.status && rec.status !== 'completed') || /^\s*(Error|错误)[:：]/.test(text);
      out.push({
        type: 'tool/result', time,
        data: { toolCallId: rec.callId, isError: !!isError, toolName: rec.name },
      });
      return;
    }

    if (t === 'credit-usage') {
      addCredit(st.id, pd.credit, time);
      return;
    }

    if (t === 'ai-title' && rec.aiTitle) {
      st.title = rec.aiTitle;
      out.push({ type: 'session/title', time, data: { title: rec.aiTitle } });
      return;
    }

    if (t === 'session-meta' && rec.cwd) {
      out.push({ type: 'session', time, data: { cwd: rec.cwd } });
    }
  }

  /* -------- public API -------- */

  return {
    source: 'workbuddy',

    /** Poll every recently touched WorkBuddy session log.
     *  Returns { sessions: Map<key, { meta, events }> } */
    async poll() {
      const meta = await loadMeta();
      const found = discover();
      const sessions = new Map();

      for (const f of found) {
        let st = files.get(f.file);
        if (!st) {
          st = {
            id: f.id, file: f.file, cwd: '', offset: 0, tail: '', first: true,
            turnId: '', lastStep: null, turns: 0, steps: 0, calls: 0,
            lastModel: '', title: '',
          };
          files.set(f.file, st);
        }
        st.id = f.id;

        const events = [];
        const lines = pullLines(f.file, st);
        for (const line of lines) {
          if (!line.trim()) continue;
          try { parseRecord(JSON.parse(line), st, events); } catch { /* partial / corrupt line */ }
        }

        const row = meta.get(f.id) || null;
        if (!st.cwd && row && row.cwd) st.cwd = row.cwd;
        if (!st.title && row) st.title = row.custom_title || row.title || '';

        const key = 'wb:' + f.id;
        sessions.set(key, {
          meta: {
            id: f.id,
            shortId: f.id.replace(/[^a-z0-9]/gi, '').slice(0, 8),
            title: st.title || (row && (row.custom_title || row.title)) || '(untitled)',
            agent: 'WorkBuddy',
            ws: prettyWs(st.cwd || (row && row.cwd) || ''),
            status: (row && row.status) || 'idle',
            model: st.lastModel || (row && row.model) || '',
            file: f.file,
            createdAt: (row && row.created_at) || 0,
            updatedAt: (row && row.updated_at) || 0,
          },
          events,
        });
      }

      /* forget cursors for logs that rotated away */
      const alive = new Set(found.map(f => f.file));
      for (const k of files.keys()) if (!alive.has(k)) files.delete(k);

      return { sessions };
    },

    /** today's WorkBuddy token usage, shaped like the MiniMax source so /usage can merge them */
    usageSince(ts) {
      const b = usageDays.get(localDay(ts)) || bucket(localDay(ts));
      const hit = (b.input + b.cacheRead) ? b.cacheRead / (b.input + b.cacheRead) : 0;
      const per = [...b.sessions.values()].sort((x, y) => y.at - x.at);
      return {
        tokens: b.tokens, input: b.input, output: b.output, cacheRead: b.cacheRead,
        credit: b.credit, calls: b.calls, hit,
        sessions: per, dayStart: ts,
      };
    },

    meta: () => metaCache.sessions,
  };
}
