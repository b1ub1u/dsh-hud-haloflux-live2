/* Doubao (豆包 PC) data source for the HUD.
 *
 * Doubao is a closed-source Electron chat client; it does not append a local
 * JSONL transcript the way DSH / MiniMax Code / WorkBuddy / Claude Code do.
 * The HUD's existing external.ps1 already UIA-probes the Doubao window every
 * ~3 s and writes {running, state, snippet, title} into .external.json.
 *
 * This source reads that shared snapshot and turns window-state transitions
 * into the SAME normalized event vocabulary the other harnesses emit, so the
 * ring / event-rate / session panels treat Doubao as just another source:
 *
 *   window starts running  → session + session/title
 *   state becomes 执行中    → turn/start + step/start  (model is replying)
 *   state leaves 执行中     → assistant/message        (reply finished)
 *   title/snippet changes
 *     while idle            → user/message            (new prompt sent)
 *
 * Everything is best-effort: if .external.json is missing or Doubao is not
 * running, the source simply reports zero sessions and the HUD stays up.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SNIP_TTL = 2500;          // reuse the last snapshot for 2.5 s
const SESSION_KEY = 'db:main';
const SESSION_ID = 'doubao-main';

export function createDoubaoSource() {
  /* last seen window state, used to detect transitions */
  let prev = null;              // { running, state, snippet, title, at }
  let turns = 0;
  let steps = 0;
  let lastSnippet = '';
  let lastSnippetAt = 0;        // when the UIA snippet last changed
  let cache = { at: 0, data: null };

  function readSnapshot() {
    if (Date.now() - cache.at < SNIP_TTL && cache.data) return cache.data;
    let data = null;
    try {
      const raw = readSnapshotFile();
      const apps = (raw && raw.apps) || [];
      data = apps.find(a => a && a.name === 'Doubao') || null;
    } catch { data = null; }
    cache = { at: Date.now(), data };
    return data;
  }

  /* resolved relative to the project root that server.mjs passes in */
  let snapPath = '';
  function setSnapshotPath(p) { snapPath = p; }
  function readSnapshotFile() {
    if (!snapPath || !existsSync(snapPath)) return null;
    return JSON.parse(readFileSync(snapPath, 'utf8'));
  }

  function titleOf(title) {
    // window title looks like "身高介绍方式 - 豆包 - 豆包浏览器"
    let t = String(title || '').split(' - ')[0].trim();
    if (!t || t === '豆包') t = '(新对话)';
    return t.slice(0, 60);
  }

  return {
    source: 'doubao',

    setSnapshotPath,

    /** Poll the Doubao window snapshot; returns
     *  { sessions: Map<key, {meta, events}> } */
    async poll() {
      const snap = readSnapshot();
      const sessions = new Map();
      const events = [];
      const now = Date.now();

      // not running / unknown -> no session (just like a stopped harness)
      if (!snap || !snap.running) {
        prev = null;
        return { sessions };
      }

      const running = !!snap.running;
      const state = String(snap.state || '').trim();
      const snippet = String(snap.snippet || '').trim();
      const title = titleOf(snap.title);
      // The UIA window state is just "使用中" while Doubao replies, but the
      // reply text itself keeps streaming into the UI - so if the snippet
      // changed within the last 2.5 s we treat it as "generating".
      if (snippet && snippet !== lastSnippet) lastSnippetAt = now;
      const snippetFlowing = (now - lastSnippetAt) < 2500;
      const isWorking = /执行中|生成|思考|responding|generating/i.test(state) || snippetFlowing;

      if (!prev) {
        // first sight of a running Doubao -> open the virtual session
        events.push({ type: 'session', time: now, data: { cwd: 'Doubao', createdAt: now } });
        events.push({ type: 'session/title', time: now, data: { title } });
        lastSnippet = snippet;
        if (isWorking) {
          turns += 1; steps += 1;
          events.push({ type: 'turn/start', time: now, data: { turn: turns } });
          events.push({ type: 'step/start', time: now, data: { step: steps } });
        }
      } else {
        // title changed -> conversation switched / new chat
        if (title && title !== titleOf(prev.title)) {
          events.push({ type: 'session/title', time: now, data: { title } });
        }
        // entering working state -> a new turn started
        if (isWorking && !prev._working) {
          turns += 1; steps += 1;
          events.push({ type: 'turn/start', time: now, data: { turn: turns } });
          events.push({ type: 'step/start', time: now, data: { step: steps } });
        }
        // leaving working state -> reply finished
        if (!isWorking && prev._working) {
          events.push({ type: 'assistant/message', time: now, data: { model: 'Doubao' } });
        }
        // while generating, each snippet tick = one more step (keeps the ring alive)
        if (isWorking && snippet !== prev.snippet) {
          steps += 1;
          events.push({ type: 'step/start', time: now, data: { step: steps } });
        }
      }

      lastSnippet = snippet;
      prev = { running, state, snippet, title, _working: isWorking, at: now };

      sessions.set(SESSION_KEY, {
        meta: {
          id: SESSION_ID,
          shortId: 'doubao',
          title,
          agent: 'Doubao',
          ws: 'Doubao',
          status: isWorking ? 'thinking' : 'idle',
          model: 'Doubao',
          file: '',
          createdAt: now,
          updatedAt: now,
        },
        events,
      });
      return { sessions };
    },

    /* Doubao is a closed client: no local token ledger, so usage is unknown. */
    async usageSince(/*ts*/) { return null; },

    root: () => snapPath || '~/.external.json',
    onDisk: () => !!snapPath && existsSync(snapPath),
  };
}
