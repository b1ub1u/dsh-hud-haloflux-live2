/* Claude Code data source for the HUD.
 *
 * Reads the Claude Code transcript store (same layout the official CLI uses):
 *   <claude-root>/projects/<encoded-cwd>/<session-uuid>.jsonl   append-only, one JSON per line
 * where <claude-root> is $CLAUDE_CONFIG_DIR or ~/.claude.
 *
 * Record shapes:
 *   { type:'user',      message:{ role:'user', content: 'text' | [ {type:'text'} | {type:'tool_result', tool_use_id, is_error} ] },
 *                       cwd, sessionId, timestamp, isMeta?, isSidechain? }
 *   { type:'assistant', message:{ id, model, content:[ {type:'text'} | {type:'thinking'} | {type:'tool_use', id, name, input} ],
 *                                 usage:{ input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } },
 *                       cwd, sessionId, timestamp }
 *   { type:'summary',   summary, leafUuid }
 *   { type:'system' | 'progress' | 'file-history-snapshot' | 'queued_command', ... }   -> ignored
 *
 * Emits the SAME normalized event vocabulary as the DSH / MiniMax Code / WorkBuddy sources,
 * so server.mjs pushes all four harnesses through one state machine and one SSE stream.
 *
 * Nothing here requires Claude Code to be installed: with no store on disk the source simply
 * reports zero sessions, and it starts working the moment the CLI writes its first transcript.
 */

import { statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_ROOT = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const PROJECTS = join(CLAUDE_ROOT, 'projects');

const TAIL_BYTES = 8 * 1024 * 1024;    // first read: whole file if small, else the last 8 MB
const LOOKBACK = 12 * 3600 * 1000;     // only transcripts touched in the last 12 h are tailed
const MAX_FILES = 24;                  // hard cap: never parse the whole archive on startup
const DISCOVERY_TTL = 6000;
const KEEP_DAYS = 7;

/* ---------------- helpers ---------------- */

function pullLines(file, st) {
  let size;
  try { size = statSync(file).size; } catch { return []; }
  if (st.offset > size) { st.offset = 0; st.tail = ''; }        // truncated / rotated
  if (size === st.offset) return [];

  let from = st.offset;
  let dropFirst = false;
  if (st.first) {
    st.first = false;
    from = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    dropFirst = from > 0;
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

const blockText = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const p of c) {
    if (!p) continue;
    if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && p.text) out += p.text;
  }
  return out;
};

function titleFallback(text) {
  let s = String(text || '');
  s = s.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<user-context[\s\S]*?<\/user-context>/g, '');
  s = s.replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/Caveat:[\s\S]*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 60);
}

/** project folders are `-Users-me-proj` / `C--Users-me-proj`: keep just the last segment */
function wsFromDir(dirName) {
  const s = String(dirName || '').replace(/^-+|-+$/g, '');
  const parts = s.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Claude Code';
}

const prettyWs = (cwd, dirName) => {
  const base = basename(String(cwd || '').replace(/[\\/]+$/, ''));
  if (base) return base;
  return wsFromDir(dirName);
};

const localDay = (ms) => {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const tsOf = (v) => {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
};

/* ---------------- source ---------------- */

export function createClaudeSource() {
  const files = new Map();      // absolute path -> cursor state
  const usageDays = new Map();  // 'YYYY-MM-DD' -> usage bucket
  let discovery = { at: 0, list: [] };

  function bucket(day) {
    let b = usageDays.get(day);
    if (!b) {
      b = { input: 0, output: 0, cacheRead: 0, tokens: 0, calls: 0, sessions: new Map() };
      usageDays.set(day, b);
      if (usageDays.size > KEEP_DAYS) {
        const oldest = [...usageDays.keys()].sort()[0];
        if (oldest && oldest !== day) usageDays.delete(oldest);
      }
    }
    return b;
  }

  function addUsage(sessionId, u, time) {
    if (!u || typeof u !== 'object') return;
    const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    if (!fresh && !cacheRead && !output) return;
    const b = bucket(localDay(time));
    b.input += fresh;
    b.cacheRead += cacheRead;
    b.output += output;
    b.tokens += fresh + cacheRead + output;
    b.calls += 1;
    let s = b.sessions.get(sessionId);
    if (!s) { s = { id: sessionId, input: 0, output: 0, cacheRead: 0, tokens: 0, calls: 0, at: 0 }; b.sessions.set(sessionId, s); }
    s.input += fresh; s.cacheRead += cacheRead; s.output += output; s.tokens += fresh + cacheRead + output; s.calls += 1;
    s.at = Math.max(s.at, time || 0);
  }

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
        if (!f.endsWith('.jsonl')) continue;
        // subagent transcripts get their own `agent-*.jsonl` file - they belong to the parent
        // session's activity, not to a session of their own
        if (f.startsWith('agent-')) continue;
        const file = join(full, f);
        let st;
        try { st = statSync(file); } catch { continue; }
        if (Date.now() - st.mtimeMs > LOOKBACK) continue;
        out.push({ file, id: f.slice(0, -'.jsonl'.length), dir: dir.name, size: st.size, mtime: st.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    discovery = { at: Date.now(), list: out.slice(0, MAX_FILES) };
    return discovery.list;
  }

  /* -------- record -> normalized events -------- */

  function parseRecord(rec, st, out) {
    if (!rec || typeof rec !== 'object') return;
    const t = rec.type;
    const time = tsOf(rec.timestamp);
    if (rec.cwd && !st.cwd) st.cwd = rec.cwd;

    if (t === 'summary') {
      if (rec.summary) {
        st.title = String(rec.summary).slice(0, 80);
        out.push({ type: 'session/title', time, data: { title: st.title } });
      }
      return;
    }

    if (t === 'user') {
      const m = rec.message || {};
      const content = m.content;
      // tool results come back as a user record whose content is a tool_result block list
      if (Array.isArray(content)) {
        let handled = false;
        for (const p of content) {
          if (!p) continue;
          if (p.type === 'tool_result') {
            handled = true;
            const err = p.is_error === true || (rec.toolUseResult && rec.toolUseResult.interrupted === true);
            out.push({ type: 'tool/result', time, data: { toolCallId: p.tool_use_id, isError: !!err } });
          }
        }
        if (handled) return;
      }
      // a genuine human prompt starts a new turn
      const text = blockText(content);
      if (!text || rec.isMeta === true) return;
      const clean = titleFallback(text);
      if (!clean) return;
      if (!st.title) st.title = clean;
      st.turns += 1;
      out.push({ type: 'turn/start', time, data: { turn: st.turns } });
      out.push({ type: 'user/message', time, data: { text: clean.slice(0, 200) } });
      return;
    }

    if (t === 'assistant') {
      const m = rec.message || {};
      const model = m.model || '';
      if (model && model !== st.lastModel) {
        st.lastModel = model;
        out.push({ type: 'request/header', time, data: { header: { config: { model } } } });
      }
      // one assistant record = one API step (its own message id)
      const mid = m.id || rec.uuid || `s${st.steps + 1}`;
      if (mid !== st.lastMsgId) {
        st.lastMsgId = mid;
        st.steps += 1;
        out.push({ type: 'step/start', time, data: { step: st.steps } });
      }
      addUsage(st.id, m.usage, time);

      let hasText = false;
      for (const p of (m.content || [])) {
        if (!p) continue;
        if (p.type === 'tool_use') {
          st.calls += 1;
          out.push({
            type: 'tool/call', time,
            data: { callId: p.id || `cc${st.calls}`, name: p.name || '?', arguments: p.input || {} },
          });
        } else if (p.type === 'text') {
          hasText = true;
        }
      }
      if (hasText) out.push({ type: 'assistant/message', time, data: { model } });
      return;
    }
    /* system / progress / file-history-snapshot / queued_command: nothing the HUD draws */
  }

  return {
    source: 'claude',

    async poll() {
      const found = discover();
      const sessions = new Map();

      for (const f of found) {
        let st = files.get(f.file);
        if (!st) {
          st = {
            id: f.id, file: f.file, dir: f.dir, cwd: '', offset: 0, tail: '', first: true,
            turns: 0, steps: 0, calls: 0, lastMsgId: '', lastModel: '', title: '',
          };
          files.set(f.file, st);
        }
        st.id = f.id;

        const events = [];
        for (const line of pullLines(f.file, st)) {
          if (!line.trim()) continue;
          try { parseRecord(JSON.parse(line), st, events); } catch { /* partial / corrupt line */ }
        }

        const key = 'cc:' + f.id;
        sessions.set(key, {
          meta: {
            id: f.id,
            shortId: f.id.replace(/[^a-z0-9]/gi, '').slice(0, 8),
            title: st.title || '(untitled)',
            agent: 'Claude Code',
            ws: prettyWs(st.cwd, f.dir),
            status: 'idle',
            model: st.lastModel,
            file: f.file,
            createdAt: 0,
            updatedAt: f.mtime,
          },
          events,
        });
      }

      const alive = new Set(found.map(f => f.file));
      for (const k of files.keys()) if (!alive.has(k)) files.delete(k);
      return { sessions };
    },

    usageSince(ts) {
      const b = usageDays.get(localDay(ts)) || bucket(localDay(ts));
      const hit = (b.input + b.cacheRead) ? b.cacheRead / (b.input + b.cacheRead) : 0;
      return {
        tokens: b.tokens, input: b.input, output: b.output, cacheRead: b.cacheRead,
        calls: b.calls, hit,
        sessions: [...b.sessions.values()].sort((x, y) => y.at - x.at),
        dayStart: ts,
      };
    },

    root: () => CLAUDE_ROOT,
    onDisk: () => existsSync(PROJECTS),
  };
}
