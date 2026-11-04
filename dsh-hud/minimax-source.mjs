/* MiniMax Code data source for the HUD.
 *
 * Reads the local MiniMax Code runtime store:
 *   ~/.minimax/v2/sessions/<y>/<m>/<d>/<dir>/messages.jsonl   append-only event log
 *   ~/.minimax/v2/sqlite/runtime-state.sqlite                 session metadata + token usage
 *
 * It emits the SAME normalized event vocabulary the DeepSeek Harness source uses
 * (session / request-header / turn-start / step-start / tool-call / tool-result /
 * assistant-message / user-message), so the HUD server can push both sources into one
 * state machine and one SSE stream.
 *
 * Everything here is best-effort: if the sqlite store is locked or missing, the source
 * degrades to the plain JSONL log and the HUD keeps working.
 */

import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const V2 = join(homedir(), '.minimax', 'v2');
const SESSIONS_ROOT = join(V2, 'sessions');
const DB_PATH = join(V2, 'sqlite', 'runtime-state.sqlite');

const TAIL_BYTES = 4 * 1024 * 1024;   // first read only looks at the last 4 MB
const META_TTL = 3000;                // sqlite metadata cache
const DISCOVERY_TTL = 3000;           // session folder scan cache

/* ---------------- helpers ---------------- */

function b64urlToId(s) {
  try {
    let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Buffer.from(b, 'base64').toString('utf8');
  } catch { return ''; }
}

/** Pull the newly appended bytes of a plain-text log.
 *  Returns an array of complete lines; a trailing partial line is kept for the next call. */
function pullLines(file, st) {
  let size;
  try { size = statSync(file).size; } catch { return []; }
  if (st.offset > size) { st.offset = 0; st.tail = ''; }      // file was truncated / rotated
  if (size === st.offset) return [];

  let from = st.offset;
  let dropFirst = false;
  if (st.first) {
    st.first = false;
    from = Math.max(0, size - TAIL_BYTES);
    dropFirst = from > 0;                                     // cut a possibly half line
  }
  const len = size - from;
  if (len <= 0) return [];

  const fd = openSync(file, 'r');
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  try { got = readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
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
    if (p.type === 'text' && p.text) out += p.text;
  }
  return out;
}

/* ---------------- sqlite metadata ---------------- */

let db = null;
let dbBroken = false;

async function openDb() {
  if (db || dbBroken) return db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    dbBroken = true;
    db = null;
  }
  return db;
}

/* ---------------- source ---------------- */

export function createMiniMaxSource() {
  /* per-session file cursors */
  const files = new Map();          // dir path -> {offset, tail, first, turns, steps, turnId, lastModel, title}

  let metaCache = { at: 0, sessions: new Map(), usage: null };

  async function loadMeta() {
    if (Date.now() - metaCache.at < META_TTL && metaCache.sessions.size) return metaCache;
    const sessions = new Map();
    const d = await openDb();
    if (d) {
      try {
        const rows = d.prepare(
          `select session_id, agent_name, title, workspace_dir, status, archived,
                  created_at_ms, updated_at_ms, history_relative_dir
             from local_runtime_sessions order by updated_at_ms desc`
        ).all();
        for (const r of rows) sessions.set(r.session_id, r);
      } catch { /* locked / schema changed: keep the previous cache */ }
    }
    metaCache = { at: Date.now(), sessions, usage: metaCache.usage };
    return metaCache;
  }

  /** token usage per session since a timestamp (ms) */
  async function usageSince(ts) {
    const d = await openDb();
    if (!d) return null;
    try {
      const rows = d.prepare(
        `select session_id,
                sum(input_tokens) inp, sum(output_tokens) outp,
                sum(cache_read_tokens) cr, sum(cache_write_tokens) cw,
                sum(cost_usd) cost, count(*) turns, max(ts) last_ts
           from local_runtime_token_usage
          where ts >= ?
          group by session_id`
      ).all(ts);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dayStart = today.getTime();
      let tokens = 0, input = 0, output = 0, cacheRead = 0, cost = 0, turns = 0;
      const per = [];
      for (const r of rows) {
        const tk = (r.inp || 0) + (r.outp || 0) + (r.cr || 0) + (r.cw || 0);
        tokens += tk; input += r.inp || 0; output += r.outp || 0;
        cacheRead += r.cr || 0; cost += r.cost || 0; turns += r.turns || 0;
        per.push({ id: r.session_id, tokens: tk, input: r.inp || 0, output: r.outp || 0, cacheRead: r.cr || 0, cost: r.cost || 0, turns: r.turns || 0, at: r.last_ts || 0 });
      }
      per.sort((a, b) => b.at - a.at);
      const hit = (input + cacheRead) ? cacheRead / (input + cacheRead) : 0;
      return { tokens, input, output, cacheRead, cost, turns, hit, sessions: per, dayStart };
    } catch { return null; }
  }

  /** walk the dated session tree for message logs */
  function discoverFiles() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        if (e.name === 'reports' || e.name === 'workspace') continue;
        const mf = join(p, 'messages.jsonl');
        if (existsSync(mf)) {
          out.push({ dir: p, file: mf });
        } else {
          walk(p, depth + 1);
        }
      }
    };
    walk(SESSIONS_ROOT, 0);
    return out;
  }

  function sessionIdOf(dir) {
    try {
      const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      if (mf && mf.sessionId) return mf.sessionId;
    } catch { /* fall through to the folder-name encoding */ }
    const base = dir.split(/[\\/]/).pop() || '';
    const m = base.match(/session_(.+)$/);
    return m ? b64urlToId(m[1]) : base;
  }

  function titleFallback(text) {
    // the first user message carries a lot of injected system context; strip it away
    let s = String(text || '');
    s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, 60);
  }

  /** Convert one messages.jsonl record into normalized HUD events. */
  function parseRecord(rec, st, out) {
    const m = rec && rec.message;
    if (!m) return;
    const time = m.timestamp || rec.timestamp || Date.now();

    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) {
        if (!st.title) st.title = titleFallback(text);
        out.push({ type: 'user/message', time, data: { text: text.slice(0, 200) } });
      }
      return;
    }

    if (m.role === 'assistant') {
      if (rec.turn_id && rec.turn_id !== st.turnId) {
        st.turnId = rec.turn_id;
        st.turns += 1;
        out.push({ type: 'turn/start', time, data: { turn: st.turns } });
      }
      st.steps += 1;
      out.push({ type: 'step/start', time, data: { step: st.steps } });

      let hasText = false;
      for (const p of (m.content || [])) {
        if (!p) continue;
        if (p.type === 'toolCall') {
          out.push({
            type: 'tool/call', time,
            data: { callId: p.id || `mm${st.calls++}`, name: p.name || '?', arguments: p.arguments || {} },
          });
        } else if (p.type === 'text' || p.type === 'thinking') {
          hasText = true;
        }
      }
      if (m.model && m.model !== st.lastModel) {
        st.lastModel = m.model;
        out.push({ type: 'request/header', time, data: { header: { config: { model: m.model } } } });
      }
      if (hasText) {
        out.push({ type: 'assistant/message', time, data: { model: m.model, provider: m.provider } });
      }
      return;
    }

    if (m.role === 'toolResult') {
      out.push({
        type: 'tool/result', time,
        data: { toolCallId: m.toolCallId, isError: !!m.isError, toolName: m.toolName },
      });
    }
  }

  return {
    source: 'minimax',

    /** Poll every known MiniMax session log; returns
     *  { sessions: Map<key, {meta, events}>, usage } */
    async poll() {
      const meta = await loadMeta();
      const found = discoverFiles();
      const sessions = new Map();

      for (const f of found) {
        let st = files.get(f.dir);
        if (!st) {
          st = { offset: 0, tail: '', first: true, turns: 0, steps: 0, turnId: '', lastModel: '', title: '', calls: 0 };
          files.set(f.dir, st);
        }
        const sessionId = sessionIdOf(f.dir);
        const row = meta.sessions.get(sessionId) || null;
        const lines = pullLines(f.file, st);
        const events = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try { parseRecord(JSON.parse(line), st, events); } catch { /* partial / corrupt line */ }
        }
        if (!lines.length && !row) continue;   // unknown session with nothing to show yet

        const key = 'mm:' + sessionId;
        sessions.set(key, {
          meta: {
            id: sessionId,
            shortId: sessionId.replace(/^mvs_/, '').slice(0, 8),
            title: (row && row.title) || st.title || '(untitled)',
            agent: 'MiniMax Code',
            ws: 'MiniMax Code',
            status: (row && row.status) || 'idle',
            model: st.lastModel || '',
            file: f.file,
            createdAt: (row && row.created_at_ms) || 0,
            updatedAt: (row && row.updated_at_ms) || 0,
          },
          events,
        });
      }

      return { sessions, meta: meta.sessions };
    },

    usageSince,
    meta: () => metaCache.sessions,
  };
}
