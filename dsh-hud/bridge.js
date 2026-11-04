/* DSH ? HALOFLUX ??live bridge (injected after HALOFLUX's own script).
   - replaces every simulated panel with real DeepSeek Harness data
   - drives the beat clock / beams / ring / camera from actual activity
   - idle = completely still (no drift, no camera push-in, no fake loops)
   Runs in the same classic-script scope: C, setParam, onBeat, ringRot, rot,
   cAdv/cDiff/cVal/cIdx, drawAdv/drawDiff/drawVal/drawIdx are all reachable.
   HALOFLUX is PolyForm Noncommercial ??personal, noncommercial use only. */
(() => {
  /* ---------- 1. stop the demo's fake content timers ---------- */
  for (let i = 1; i < 20000; i++) clearInterval(i);

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const F = '"JetBrains Mono",Consolas,monospace';
  const PROBE = new URLSearchParams(location.search).has('probe');   // capture mode: ignore the observer tool itself
  const WALL = new URLSearchParams(location.search).has('wall') || location.pathname.startsWith('/wall');
  const ZOOM_MAX = 0.12;                 // camera push-in multiplier (1.7 max shot ????.08?)
  const SHOT_CAP = 1.7;
  const fmt = (n) => (n ?? 0).toLocaleString();
  const short = (s, n = 26) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '...' : String(s || ''));

  /* ---------- 2. relabel ---------- */
  ['今日 TOKENS', '今日花费', '余额', '缓存命中', '峰谷剩余'].forEach((v, i) => {
    const el = document.querySelectorAll('.kpi .k')[i]; if (el) el.textContent = v;
  });
  // ---- replace the demo branding with personal labels (license credit moved to the footer line) ----
  const brandH = document.querySelector('.brand h1');
  if (brandH) brandH.textContent = 'DEEPSEEK HARNESS';
  const brandP = document.querySelector('.brand p');
  if (brandP) brandP.textContent = '大肥鱼 · 实时会话可视化';
  // 署名/许可：仓库的 README.md / NOTICE.md / LICENSE 已完整保留；
  // 壁纸上默认不显示（个人本地使用），需要时把 SHOW_CREDIT 改成 true。
  const SHOW_CREDIT = false;
  if (SHOW_CREDIT) {
    const creditEl = document.createElement('div');
    creditEl.id = 'hf-credit';
    creditEl.textContent = 'HALOFLUX by Ryder191 \u00b7 PolyForm Noncommercial \u00b7 \u4e2a\u4eba\u975e\u5546\u4e1a\u4f7f\u7528';
    const statusBox = document.querySelector('.ov.status');
    (statusBox || document.body).appendChild(creditEl);
    const creditCss = document.createElement('style');
    creditCss.textContent = '#hf-credit{font:9px/1.6 ui-monospace,Consolas,monospace;letter-spacing:.08em;color:#6b6f78;text-align:right;margin-top:10px;pointer-events:none;white-space:nowrap}';
    document.head.appendChild(creditCss);
  }

  // ---- typeface: MiSans for CJK, JetBrains Mono for latin/numbers ----
  const fontCss = document.createElement('style');
  fontCss.textContent = [
    'body,.app,.p,.p h3,.kpi .k,.kpi .v,.feed div,.code div,.ag,.routes,.chip,.ov,.ov.status .sm,.brand p,button,input{',
    "  font-family:'JetBrains Mono','MiSans','HarmonyOS Sans SC','Alibaba PuHuiTi 3.0',Consolas,monospace !important;",
    '}',
    ".brand h1{font-family:'JetBrains Mono','MiSans',Consolas,monospace !important;letter-spacing:.10em !important}",
    '.p h3,.kpi .k,#dsh-media .lbl{letter-spacing:.12em !important}',
  ].join('\n');
  document.head.appendChild(fontCss);

  const kpiCss = document.createElement('style');
  kpiCss.textContent = '.kpi .k{font-size:10.5px !important;letter-spacing:.05em !important;color:#aab2bd !important}';
  document.head.appendChild(kpiCss);

  const brandSub = document.querySelector('.brand p');

  const TITLES = ['工具调用流', '事件速率 / 3 分钟', '会话工作台', '会话活跃图',
    '工作区 / 路由', '工具耗时', '会话 / 调度', '工具分布 / 热力图'];
  document.querySelectorAll('.p h3').forEach((el, i) => { if (TITLES[i]) el.textContent = TITLES[i]; });

  const caps = document.querySelectorAll('.p .cap');
  if (caps[0]) caps[0].textContent = '一行一个会话 · 越亮说明该时段事件越多';
  if (caps[1]) caps[1].textContent = '工作区 → 会话数 → 每分钟事件';
  if (caps[2]) caps[2].textContent = '最近调用耗时 · 粉色 = 失败';
  if (caps[3]) caps[3].textContent = '一行一个活跃会话';
  if (caps[4]) caps[4].textContent = '工具 × 时间 · 越亮调用越多';
  const advBtns = $('advBtns'); if (advBtns) advBtns.style.display = 'none';
  const hideConsole = document.createElement('style');
  hideConsole.textContent = '.ov.console{display:none !important}';
  document.head.appendChild(hideConsole);

  /* ---------- 2a. start in standby: kill the first-seconds zoom/brightness flash ---------- */
  try {
    const STANDBY = {
      tempo: 0.4, ringSpeed: 0, ringPause: 3, dataFlicker: 0, webSpin: 0, webPulseAmp: 0,
      runnerCount: 0, runnerSpeed: 0, cometPerBeat: 0, cometBurst: 0, cometTrickle: 0,
      beamBright: 0, beamGlow: 0, beamLen: 0.2, beamBounce: 0, dashBright: 0,
      hazeCount: 0, hazeBright: 0, burstRate: 0, burstSize: 0, burstBright: 0,
      flareRate: 0, flareBright: 0, rimBright: 0.12, camZoom: ZOOM_MAX, camera: 0,
    };
    for (const k in STANDBY) setParam(k, STANDBY[k], true);
    if (typeof shots !== 'undefined') for (const sh of shots) if (sh.z > SHOT_CAP) sh.z = SHOT_CAP;
  } catch (e) {}

  /* ---------- 2b. wallpaper mode: halo only, no console chrome ---------- */
  if (WALL) { /* full console stays visible; only perf tuning applies */ }

  /* ---------- 3. history ---------- */
  const H = { samples: [], sess: new Map(), tools: [], axis: 0, lastEvents: 0 };
  const WINDOW = 180000;   // 3 min of history on the x axis

  function ingest(st) {
    if (!st) return;
    const at = st.at || Date.now();
    H.samples.push({ t: at, v: st.rate || 0 });
    while (H.samples.length && H.samples[0].t < at - WINDOW) H.samples.shift();

    for (const s of st.sessions || []) {
      let a = H.sess.get(s.id);
      if (!a) { a = []; H.sess.set(s.id, a); }
      a.push({ t: at, v: s.rate || 0, title: s.title, ws: s.ws });
      while (a.length && a[0].t < at - WINDOW) a.shift();
      // keep insertion order fresh
      H.sess.delete(s.id); H.sess.set(s.id, a);
    }

    if (st.toolLog) H.tools = st.toolLog;

    // freeze the time axis while nothing happens ??the picture stops moving
    const ev = st.totals?.events || 0;
    if (ev > H.lastEvents || !H.axis) { H.lastEvents = ev; H.axis = at; }
  }

  /* ---------- 4. real canvas panels ---------- */
  const t0 = () => (H.axis || Date.now()) - WINDOW;
  const xOf = (t, w) => ((t - t0()) / WINDOW) * w;

  drawAdv = function () {                    // EVENT RATE
    const x = cAdv.x, w = cAdv.w, h = cAdv.h;
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(120,125,135,.14)'; x.lineWidth = 1;
    for (let i = 0; i <= 6; i++) { const px = Math.round(i * w / 6) + .5; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke(); }
    const pts = H.samples.filter(p => p.t >= t0() && p.t <= (H.axis || Infinity));
    x.font = `800 8px ${F}`; x.textBaseline = 'top'; x.fillStyle = '#9a9ea7';
    if (!pts.length) { x.fillText('standby / 0 evt/min', 4, 4); return; }
    const mx = Math.max(10, ...pts.map(p => p.v));
    const bw = Math.max(1, (w / (WINDOW / 500)) * 0.7);
    pts.forEach(p => {
      const px = xOf(p.t, w), bh = Math.max(0, (p.v / mx) * (h - 12));
      x.fillStyle = p.v > 0 ? 'rgba(235,238,244,.86)' : 'rgba(120,125,135,.25)';
      x.fillRect(px - bw / 2, h - bh - 1, bw, bh);
    });
    x.fillStyle = '#e6e8ec'; x.fillText(`${pts[pts.length - 1].v}/min`, 4, 3);
    x.fillStyle = '#4a4e56'; x.fillText('3 MIN', w - 32, 3);
  };

  drawDiff = function () {                   // SESSION ACTIVITY MAP
    const x = cDiff.x, w = cDiff.w, h = cDiff.h;
    x.clearRect(0, 0, w, h);
    const rows = [...H.sess.entries()].slice(0, 8);
    if (!rows.length) { x.font = `600 8px ${F}`; x.fillStyle = '#6b6f78'; x.fillText('no sessions', 4, 4); return; }
    const cols = 30, cw = w / cols, rh = Math.max(3, Math.min(9, h / Math.max(rows.length, 1)));
    let mx = 1;
    for (const [, a] of rows) for (const p of a) mx = Math.max(mx, p.v);
    rows.forEach(([, a], r) => {
      for (let c = 0; c < cols; c++) {
        const b0 = t0() + c * (WINDOW / cols), b1 = b0 + WINDOW / cols;
        let v = 0;
        for (const p of a) if (p.t >= b0 && p.t < b1 && p.v > v) v = p.v;
        const k = Math.min(1, v / mx);
        x.fillStyle = k > 0.7 ? `rgba(240,166,198,${0.35 + k * 0.5})`
          : `rgba(${20 + k * 200 | 0},${23 + k * 200 | 0},${30 + k * 205 | 0},${0.12 + k * 0.8})`;
        x.fillRect(c * cw + 0.5, r * rh + 0.5, cw - 1, rh - 1);
      }
    });
  };

  drawVal = function () {                    // TOOL LATENCY
    const x = cVal.x, w = cVal.w, h = cVal.h;
    x.clearRect(0, 0, w, h);
    x.font = `600 7px ${F}`; x.textBaseline = 'top';
    const log = (H.tools || []).filter(t => t.t <= (H.axis || Infinity)).slice(-30);
    if (!log.length) { x.fillStyle = '#6b6f78'; x.fillText('no tool calls yet', 4, 4); return; }
    const mx = Math.max(1, ...log.map(t => t.ms || 0));
    const bw = w / log.length;
    log.forEach((t, i) => {
      const bh = Math.max(1, ((t.ms || 0) / mx) * (h - 14));
      x.fillStyle = t.ok ? 'rgba(235,238,244,.8)' : '#f0a6c6';
      x.fillRect(i * bw, h - bh - 1, Math.max(1, bw - 1), bh);
    });
    const last = log[log.length - 1];
    x.fillStyle = '#9a9ea7'; x.fillText(`${last.ms}ms / ${short(last.name, 10)}`, 4, 2);
    x.fillStyle = '#4a4e56'; x.fillText('ms', w - 12, 2);
  };

  drawIdx = function () {                    // TOOL MIX / HEATMAP
    const x = cIdx.x, w = cIdx.w, h = cIdx.h;
    x.clearRect(0, 0, w, h);
    const log = (H.tools || []).filter(t => t.t <= (H.axis || Infinity));
    if (!log.length) { x.font = `600 8px ${F}`; x.fillStyle = '#6b6f78'; x.fillText('no data', 4, 4); return; }
    const counts = new Map();
    for (const t of log) counts.set(t.name, (counts.get(t.name) || 0) + 1);
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
    const cols = 24, rh = h / names.length, cw = w / cols;
    names.forEach((n, r) => {
      for (let c = 0; c < cols; c++) {
        const b0 = t0() + c * (WINDOW / cols), b1 = b0 + WINDOW / cols;
        let cnt = 0;
        for (const t of log) if (t.name === n && t.t >= b0 && t.t < b1) cnt++;
        const k = Math.min(1, cnt / 3);
        x.fillStyle = `rgba(${30 + k * 210 | 0},${30 + k * 170 | 0},${40 + k * 195 | 0},${0.2 + k * 0.8})`;
        x.fillRect(c * cw + 0.5, r * rh + 0.5, cw - 1, rh - 1);
      }
    });
  };

  /* ---------- 5. freeze the ring + beat clock when idle ---------- */
  let AC = 0;                      // smoothed activity: 0 = standby, 1 = working
  let AC_TARGET = 0;               // raw activity straight from the data stream
  updateBeat = function (dt) {
    sinceBeat += dt;
    if (AC < 0.12) { env = Math.exp(-sinceBeat * 4.5); return; }   // no beats at all while idle
    beatT -= dt;
    if (beatT <= 0) { beatT += PATTERN[beatI++ % PATTERN.length] * 0.92 / C.tempo; sinceBeat = 0; beatN++; onBeat(); }
    env = Math.exp(-sinceBeat * 4.5);
  };

  updateRing = function (dt) {
    if (rot.t < rot.dur) {
      rot.t += dt;
      ringRot = rot.from + (rot.to - rot.from) * rot.ease(Math.min(1, rot.t / rot.dur));
    } else {
      rot.hold -= dt;
      // drift with velocity smoothing, so leaving a tween does not snap from 0 to full speed
      const active = clamp((C.ringSpeed || 0) / 3, 0, 1);
      const targetVel = 0.02 * active + 0.10 * (1 - active);
      ringVel += (targetVel - ringVel) * (1 - Math.exp(-dt / 0.5));
      ringRot += ringVel * dt;
    }
  };

  // gentler rotation presets: longer, always ease-in-out, activity scales them softly
  if (typeof ringMove === 'function') {
    ringMove = function () {
      const r = Math.random();
      let d, dur;
      if (r < 0.22) { d = rr(0.45, 0.85); dur = rr(1.6, 2.4); }        // long, calm sweep
      else if (r < 0.64) { d = rr(0.10, 0.26); dur = rr(0.9, 1.5); }   // small nudge
      else { d = rr(0.04, 0.12); dur = rr(0.8, 1.3); }                  // tiny drift
      if (Math.random() < 0.08) d = -d * 0.5;
      d *= Math.min(1.5, 0.6 + 0.4 * ((C.ringSpeed || 0) / 3));
      Object.assign(rot, {
        from: ringRot, to: ringRot + d, t: 0, dur,
        ease: easeIO,
        hold: rr(0.25, 0.9) * Math.max(0.6, C.ringPause || 1)
      });
    };
  }


  /* 构图：整体往左一点（镜头略偏右看），给右边的光束留空间；
     同时加大镜头的浮动感（轻微平移 + 呼吸缩放） */
  if (typeof updateCam === 'function') {
    const origUpdateCam = updateCam;
    let camT0 = performance.now();
    updateCam = function (dt) {
      origUpdateCam(dt);
      try {
        const tt = (performance.now() - camT0) / 1000;
        const shift = W * 0.07;                        // 画面整体左移
        const floatX = Math.sin(tt * 0.33) * 7;        // 缓慢左右漂
        const floatY = Math.sin(tt * 0.26 + 1.2) * 5;  // 缓慢上下漂
        cam.x += shift + floatX;
        cam.y += floatY;
        cam.z *= 1 + 0.015 * Math.sin(tt * 0.21 + 0.4); // 呼吸感
        clampCam();
      } catch (e) {}
    };
  }

  /* ---------- 5b. ring data cards: real content instead of decorative blocks ---------- */
  let HF_CARDS = [{ k: 'STANDBY', v: 'no session activity' }];

  /* ---------- per-agent identity colours ----------
     Each AI gets its own signature colour so you can tell them apart at a glance.
     The STATE is shown separately (dot ring / text), so colour is pure identity. */
  const AGENT_COLOR = {
    // internal: the DSH session itself
    'DSH':          [232, 234, 240],   // 冷白
    'DEEPSEEK':     [232, 234, 240],
    // external
    'ChatGPT':      [116, 227, 172],   // 薄荷绿
    'WorkBuddy':    [ 99, 179, 255],   // 天蓝
    'MiniMax Code': [186, 140, 255],   // 紫罗兰
    'MiniMax':      [186, 140, 255],
    'Doubao':       [255, 138, 176],   // 桃粉
    '豆包':         [255, 138, 176],
    'Claude':       [214, 160, 110],   // 陶土橘
    'Cursor':       [140, 200, 140],   // 草绿
  };
  const FALLBACK_COLORS = [[120, 200, 255], [255, 180, 120], [180, 255, 160], [255, 160, 220], [160, 180, 255]];
  function agentColor(name) {
    if (!name) return FALLBACK_COLORS[0];
    const key = String(name).trim();
    if (AGENT_COLOR[key]) return AGENT_COLOR[key];
    const low = key.toLowerCase();
    for (const k in AGENT_COLOR) if (k.toLowerCase() === low) return AGENT_COLOR[k];
    // stable hash so an unknown agent always keeps the same colour
    let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }
  const rgbHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  let slotSeq = 0;
  renderSlot = function (s) {
    const band = RO - R, h = s.hpx;
    const c = document.createElement('canvas');
    const SC = RING_SC * 1.9;
    c.width = Math.ceil(band * SC); c.height = Math.ceil((h + 2) * SC);
    const x = c.getContext('2d'); x.scale(SC, SC); x.textBaseline = 'top';
    const card = HF_CARDS[slotSeq % HF_CARDS.length]; slotSeq++;
    const tint = card.c || [232, 234, 240];
    const cw = Math.max(10, band - 4), ch = Math.max(8, h);
    const kind = slotSeq % 4;

    // B: status tint — success is white, failed calls are pink
    x.fillStyle = rgba(tint, 0.05);
    x.fillRect(0, 0, cw, ch);

    if (kind === 1) {
      // C1: real latency bars (last 8 calls), pink when failed
      const log = (H.tools || []).slice(-24);
      const mx = Math.max(1, ...log.map(t2 => t2.ms || 0));
      log.forEach((t2, i) => {
        const rh = ch / Math.max(1, log.length);
        const w = (cw - 2) * ((t2.ms || 0) / mx);
        x.fillStyle = t2.ok ? rgba(tint, 0.42) : 'rgba(240,166,198,.7)';
        x.fillRect(1, 0.5 + i * rh, Math.max(0.8, w), Math.max(0.8, rh - 0.4));
      });
    } else if (kind === 2) {
      // C2: tool-mix heat grid from real call counts
      const cnt = {};
      for (const t2 of (H.tools || [])) { const k = humanVerb(t2.name); cnt[k] = (cnt[k] || 0) + 1; }
      const vals = Object.entries(cnt).sort((a2, b2) => b2[1] - a2[1]).slice(0, 6);
      const mx = Math.max(1, ...vals.map(v => v[1]));
      const cols = 6, rows = 4, cellW = cw / cols, cellH = ch / rows;
      for (let i = 0; i < cols * rows; i++) {
        const v = vals[i % Math.max(1, vals.length)];
        const q = v ? v[1] / mx : 0;
        x.fillStyle = (i < vals.length) ? rgba(tint, 0.10 + q * 0.55) : 'rgba(120,125,135,.08)';
        x.fillRect((i % cols) * cellW + 0.4, Math.floor(i / cols) * cellH + 0.4, cellW - 0.8, cellH - 0.8);
      }
    } else if (kind === 3) {
      // C3: big readout (today's tokens / cost)
      const u = window.__USAGE;
      let num = '—', lab = 'TOKENS';
      if (u && u.today) { num = u.today.tokens >= 1e6 ? (u.today.tokens / 1e6).toFixed(0) + 'M' : fmtTok(u.today.tokens); }
      x.font = `800 9px ${FONT}`; x.fillStyle = rgba(tint, 1); x.fillText(num, 1, 1);
      if (ch > 22) { x.font = `500 5.5px ${FONT}`; x.fillStyle = rgba(tint, .85); x.fillText(lab, 1, 12); }
    } else {
      // A: action card, wider band + bigger type
      x.font = `800 9px ${FONT}`; x.fillStyle = rgba(tint, 1);
      x.fillText(String(card.k).slice(0, Math.max(2, Math.floor(cw / 13))), 1, 1);
      if (ch > 20) {
        x.font = `500 6px ${FONT}`; x.fillStyle = rgba(tint, .9);
        x.fillText(String(card.v).slice(0, Math.max(4, Math.floor(cw / 10))), 1, 12);
      }
      x.fillStyle = rgba(tint, .9); x.fillRect(cw - 3, 1.2, 2, 2);
    }
    s.c = c;
  };

  /* ---------- 6. panels (DOM) ---------- */
  const VERB = (name) => {
    const n = String(name || '').toLowerCase();
    if (/^(read|grep|glob|find|ls|cat)$/.test(n)) return 'read';
    if (/^(write|edit|apply_patch|create_file)$/.test(n)) return 'build';
    if (/web|fetch|search/.test(n)) return 'qa';
    return 'check';
  };

  let LAST_STATE = null;

  let PANELS_READY = false;

  function humanVerb(name) {
    const n = String(name || '').toLowerCase();
    if (/pwsh|bash|shell|terminal|cmd|node|python|npm|npx|pnpm|git|docker/.test(n)) return '运行命令';
    if (n === 'read') return '读取文件';
    if (n === 'write' || n === 'create_file') return '新建文件';
    if (n === 'edit' || n === 'apply_patch') return '修改文件';
    if (/grep|glob|find|^ls$/.test(n)) return '查找内容';
    if (/web_search|web_fetch|search/.test(n)) return '联网查询';
    if (/read_image|image/.test(n)) return '看图';
    if (/ask_user_question/.test(n)) return '等你确认';
    if (/job_|schedule/.test(n)) return '后台任务';
    if (/subagent/.test(n)) return '派子任务';
    return '调用工具';
  }

  function humanObj(name, args) {
    if (!args) return '';
    let a2 = args;
    if (typeof a2 === 'string') { try { a2 = JSON.parse(a2); } catch (e) { return short(String(a2).replace(/\s+/g, ' '), 56); } }
    const pick = a2.description || a2.path || a2.file_path || a2.command || a2.pattern || a2.query || a2.url || a2.prompt || a2.title;
    return pick ? short(String(pick).replace(/\s+/g, ' '), 56) : '';
  }

  function buildPanels() {
    const sec = document.querySelector('.panels');
    if (!sec) return;
    const wrap = document.createElement('div');
    wrap.id = 'hf-bottom';
    wrap.innerHTML = [
      '<section class="panels" id="hf-main">',
      '<div class="p"><h3>现在任务</h3><div class="hf-now" id="hfNowIcon">○</div>',
      '<div class="hf-nowtxt" id="hfNowVerb">空闲</div><div class="cap" id="hfNowWhat">等你安排任务</div>',
      '<div class="cap" id="hfNowDur"></div></div>',
      '<div class="p"><h3>工具调用</h3><div class="feed" id="hfActs"></div></div>',
      '<div class="p"><h3>事件速率</h3><div class="rate-head"><b id="mRateVal">0</b><span>evt/min</span></div><canvas id="mRate"></canvas></div>',
      '<div class="p"><h3>工具分布</h3><div class="feed" id="mMix"></div></div>',
      '</section>',
      '<section class="panels hf-mini" id="hf-mini">',
      '<div class="p"><h3>进度</h3><div class="hf-big" id="hfProg">第 0 轮</div>',
      '<div class="cap" id="hfProgSub">—</div><div class="cap" id="hfProgSub2">—</div></div>',
      '<div class="p"><h3>用量 · 费用</h3><div class="hf-use" id="hfUse"></div></div>',
      '<div class="p"><h3>会话工作台</h3><div class="feed" id="hfWork"></div></div>',
      '<div class="p"><h3>今日之最</h3><div class="hf-use" id="hfFun"></div></div>',
      '<div class="p"><h3>外部 AI</h3><div class="feed" id="mChatBody"></div></div>',
      '</section>'
    ].join('');
    sec.replaceWith(wrap);

    const css = document.createElement('style');
    css.textContent = [
      '#dsh-ext,#dsh-usage{display:none !important}',
      '#hf-bottom{display:block;padding:8px 12px 12px;padding-bottom:var(--taskbar-safe,49px)}',
      '#hf-main{display:grid;grid-template-columns:1.4fr 1.9fr 1.2fr 1.3fr !important;gap:8px;padding:0 !important}',
      '#hf-mini{display:grid;grid-template-columns:1.1fr 1.45fr 1.05fr 1.05fr 1.2fr !important;gap:8px;padding:0 !important;margin-top:8px}',
      '#hf-bottom .p{background:var(--panel,#0e0f12);border:1px solid var(--line,#25282e);height:clamp(100px,11vh,136px);padding:7px 10px 6px;overflow:hidden;display:flex;flex-direction:column}',
      '#hf-mini .p{height:clamp(100px,11vh,136px) !important;padding:7px 10px 6px !important}',
      '#hf-bottom .p h3{font-size:10px !important;letter-spacing:.08em !important;margin:0 0 4px !important;color:#e8eaee !important}',
      '#hf-mini .p h3{font-size:8.5px !important;margin-bottom:2px !important;color:#9aa0aa !important}',
      '.panels .cap{font-size:9.5px !important;white-space:normal !important;line-height:1.4;color:#8d939c !important;margin-top:2px !important}',
      '.hf-now{position:absolute;top:6px;right:9px;font-size:14px;line-height:1;color:#8fe3ff;margin:0}',
      '#hf-main .p:first-child{position:relative}',
      '.hf-nowtxt{font-size:16px;font-weight:800;color:#fff;margin:0 0 1px}',
      '.hf-big{font-size:16px;font-weight:800;color:#fff;margin:2px 0}',
      '#hfActs div,#hfWork div,#mChatBody div{font-size:9.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b9bec7}',
      '#hfActs i{color:#8d939c;font-style:normal;margin-right:4px}',
      '#mChatBody b{color:#fff}',
      '#hfActs b{color:#e8eaee;font-weight:700;margin:0 4px}',
      '#hfActs .bad{color:#ff7d8a}',
      '.hf-use div{font-size:9.5px;line-height:1.45;color:#b9bec7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.hf-use b{color:#fff;font-weight:700}',
      '#hf-main .feed,#hf-mini .feed{justify-content:flex-start !important}',
      '.ov.status .sm{display:none !important}',
      '.rate-head{display:flex;align-items:baseline;gap:5px;margin-bottom:2px}',
      '.rate-head b{font:800 11px/1 \"JetBrains Mono\",Consolas,monospace;color:#fff}',
      '.rate-head span{font:600 9px/1 \"JetBrains Mono\",Consolas,monospace;color:#9aa0aa}',
      '#mMix{gap:2px}',
      '#mMix .arow{display:flex;align-items:center;gap:6px;font-size:9.5px;line-height:1.5}',
      '#mMix .arow b{font-weight:400;color:#8d939c;width:4.1em;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#mMix .arow i{flex:1;height:5px;background:rgba(255,255,255,.08);display:block;min-width:0}',
      '#mMix .arow i span{display:block;height:100%;background:rgba(235,238,244,.85)}',
      '#mMix .arow em{font-style:normal;font-family:\"JetBrains Mono\",Consolas,monospace;font-weight:700;color:#b9bec7;width:2.6em;text-align:right;flex:none}',
      '#hf-mini canvas{display:block;width:100%;flex:1;min-height:0}',
      '#mChatBody{justify-content:flex-start !important}'
    ].join('\n');
    document.head.appendChild(css);
    PANELS_READY = true;
    // keep the panel row just clear of the Windows taskbar: measure it and add 1px.
    // (the wallpaper canvas spans the full screen including the taskbar strip, so a
    //  fixed guess can either clip the panels or leave a visible gap.)
    try {
      const measureTaskbar = () => {
        const vh = window.innerHeight;
        // screen.availHeight is in CSS px on this display; the taskbar is the difference
        const avail = (screen.availHeight || vh);
        const gap = Math.max(0, vh - avail);
        const safe = (gap > 0 ? gap : 48) + 1;      // +1px clearance over the taskbar
        document.documentElement.style.setProperty('--taskbar-safe', safe + 'px');
      };
      measureTaskbar();
      setInterval(measureTaskbar, 3000);            // follows taskbar autohide/resolution changes
    } catch (e) {}
    setTimeout(() => { try { setParam('ringWidth', 1.72, true); } catch (e) {} }, 800);
    try { drawAdv = () => {}; drawDiff = () => {}; drawVal = () => {}; drawIdx = () => {}; } catch (e) {}
    setInterval(drawMini, 700);
  }

  function canvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = 2.5;   // fixed supersampling: the wallpaper forces devicePixelRatio 0.65
    const w = Math.max(10, c.clientWidth), h = Math.max(10, c.clientHeight);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.textBaseline = 'top';
    x.clearRect(0, 0, w, h);
    return { x, w, h };
  }

  function drawMini() {
    const r = canvasCtx('mRate');
    if (r) {
      const pts = H.samples.slice(-300);
      const mx = Math.max(10, ...pts.map(p => p.v));
      const bw = r.w / Math.max(1, pts.length);
      pts.forEach((p, i) => {
        const bh = (p.v / mx) * (r.h - 2);
        r.x.fillStyle = 'rgba(235,238,244,.88)';
        r.x.fillRect(i * bw, r.h - bh, Math.max(1, bw * 0.8), bh);
      });
    }
  }

  function renderPanels(st) {
    LAST_STATE = st;
    if (!PANELS_READY) buildPanels();
    const tot = st.totals || {}, sess = st.sessions || [], top = sess[0] || {};

    // 现在在做什么
    let icon = '○', verb = '空闲', what = '等你安排任务';
    const pend = top.currentTool;
    if (pend) { icon = '▶'; verb = humanVerb(pend.name); what = humanObj(pend.name, pend.args) || '执行中…'; }
    else if (top.status === 'thinking') { icon = '◐'; verb = '思考中'; what = top.title ? '话题：' + top.title : '整理下一步'; }
    else if (top.status === 'tool' || (tot.activeTools || 0) > 0) { icon = '▶'; verb = '执行中'; what = '工具运行中'; }
    if ($('hfNowIcon')) $('hfNowIcon').textContent = icon;
    if ($('hfNowVerb')) $('hfNowVerb').textContent = verb;
    if ($('hfNowWhat')) $('hfNowWhat').textContent = what;
    if ($('hfNowDur')) $('hfNowDur').textContent = pend && pend.t0 ? ('已经跑了 ' + Math.max(1, Math.round((Date.now() - pend.t0) / 1000)) + ' 秒') : '';

    // 进度
    if ($('hfProg')) $('hfProg').textContent = '第 ' + (top.turn || 0) + ' 轮 · ' + (top.steps || 0) + ' 步';
    if ($('hfProgSub')) $('hfProgSub').textContent = '工具 ' + (top.tools || 0) + ' 次 · 报错 ' + (top.errors || 0) + ' 次';
    if ($('hfProgSub2')) $('hfProgSub2').textContent = '会话：' + (top.title ? short(top.title, 14) : '—');

    // 最近动作
    const acts = (st.feed || []).slice().reverse().slice(0, 5);
    if ($('hfActs')) $('hfActs').innerHTML = acts.map(f => {
      const tm = f.t ? new Date(f.t).toTimeString().slice(0, 5) : '';
      return '<div class="' + (f.ok === false ? 'bad' : '') + '"><i>' + tm + '</i><b>' + humanVerb(f.name) + '</b>' + esc(humanObj(f.name, f.args)) + '</div>';
    }).join('') || '<div>暂无动作</div>';

    // 今日之最
    const tools = st.toolLog || [];
    let maxMs = 0;
    for (const t2 of tools) if ((t2.ms || 0) > maxMs) maxMs = t2.ms;
    const hourAgo = Date.now() - 3600000;
    const recent = tools.filter(x => (x.t || 0) > hourAgo).length;
    const lines = [];
    lines.push('最长一次 <b>' + (maxMs >= 1000 ? (maxMs / 1000).toFixed(1) + ' 秒' : maxMs + ' 毫秒') + '</b>');
    lines.push('最近 1 小时 <b>' + recent + '</b> 次动作');
    lines.push('今日共 <b>' + (top.tools || 0) + '</b> 次工具调用');
    if ((top.jobsActive || 0) > 0) lines.push('后台任务 <b>' + top.jobsActive + '</b> 个');
    if ($('hfFun')) $('hfFun').innerHTML = lines.map(x => '<div>' + x + '</div>').join('');

    // 会话工作台
    if ($('hfWork')) {
      const wl = [];
      wl.push('<div>' + (top.title ? esc(short(top.title, 15)) : '无活跃会话') + '</div>');
      wl.push('<div>第 ' + (top.turn || 0) + ' 轮 · ' + (top.steps || 0) + ' 步</div>');
      wl.push('<div>速率 ' + (st.rate || 0) + '/分 · ' + (top.status === 'tool' ? '干活' : top.status === 'thinking' ? '思考' : '空闲') + '</div>');
      $('hfWork').innerHTML = wl.join('');
    }

    // 事件速率数值 + 工具分布（DOM 渲染，字体与面板完全一致）
    if ($('mRateVal')) {
      const pts = H.samples;
      $('mRateVal').textContent = pts.length ? pts[pts.length - 1].v : 0;
    }
    if ($('mMix')) {
      const cnt2 = {};
      for (const t2 of (H.tools || [])) { const k2 = humanVerb(t2.name); cnt2[k2] = (cnt2[k2] || 0) + 1; }
      const tops = Object.entries(cnt2).sort((a2, b2) => b2[1] - a2[1]).slice(0, 4);
      const mx2 = Math.max(1, ...tops.map(e => e[1]));
      $('mMix').innerHTML = tops.map(e =>
        '<div class="arow"><b>' + esc(e[0]) + '</b><i><span style="width:' + Math.max(2, Math.round(e[1] / mx2 * 100)) + '%"></span></i><em>x' + e[1] + '</em></div>'
      ).join('') || '<div class="arow"><b>暂无</b></div>';
    }

    // bottom status + callout
    const big = $('stBig');
    if (big) big.textContent = (AC >= 0.12 ? '工作中' : '待命') + ' · ' + (st.rate || 0) + ' 事件/分';
    if ($('chkK')) $('chkK').textContent = top.ws ? String(top.ws).toUpperCase() : 'NO ACTIVE SESSION';
    if ($('chkV')) $('chkV').textContent = top.title ? short(top.title, 34) : 'idle — waiting for work';
    // 圆环数据卡：最近工具调用 + 会话 + 总计
    const ringCards = [];
    for (const f of (st.feed || []).slice(-10).reverse()) {
      const dur = f.ms != null ? (f.ms >= 1000 ? (f.ms / 1000).toFixed(1) + 's' : f.ms + 'ms') : '';
      ringCards.push({
        k: humanVerb(f.name),
        v: dur + ' ' + short(humanObj(f.name, f.args), 18),
        w: Math.min(1, (f.ms || 0) / 3000),
        c: f.ok === false ? [240, 166, 198] : null
      });
    }
    for (const s2 of sess.slice(0, 3)) {
      ringCards.push({
        k: short(s2.ws || 'SESSION', 12).toUpperCase(),
        v: short(s2.title, 22),
        w: Math.min(1, (s2.rate || 0) / 40),
        c: agentColor('DSH')            // internal sessions carry the DSH identity colour
      });
    }
    ringCards.push({ k: 'EVENTS', v: fmt(tot.events), w: Math.min(1, (st.rate || 0) / 60) });
    ringCards.push({ k: 'TOOLS', v: fmt(tot.tools), w: Math.min(1, (tot.activeTools || 0) / 3) });
    // external AI activity: one card per app that is currently running, in its own colour
    try {
      const ext = window.__EXT;
      if (ext && ext.apps) {
        for (const a of ext.apps) {
          if (!a || !a.running) continue;
          const st2 = (ext.busy && a.name === (ext.apps[0] || {}).name) ? '生成中' : a.state;
          ringCards.push({
            k: String(a.name).toUpperCase().slice(0, 12),
            v: short(st2 + (a.snippet ? ' · ' + a.snippet : ''), 22),
            w: st2 === '生成中' ? 1 : st2 === '使用中' ? 0.75 : st2 === '已打开' ? 0.5 : 0.25,
            c: agentColor(a.name)
          });
        }
      }
    } catch (e) {}
    HF_CARDS = ringCards.length ? ringCards : HF_CARDS;

  }

  /* ---------- 7. drive the visuals (idle ??zero) ---------- */
  let target = null, cameraOn = null;

  function driveParams(st) {
    const tot = st.totals || {};
    // instantaneous load: events in the last 4s (?? events ??full) or a running tool
    const short = clamp(st.rateShort || 0, 0, 999);
    const running = PROBE ? 0 : clamp(tot.activeTools || 0, 0, 9);
    const ext = Date.now() < extBusyUntil ? 0.85 : 0;   // external AI working → keep the ring alive
    const t = clamp(Math.max(short / 2, running, ext), 0, 1);
    const errs = clamp(tot.errors || 0, 0, 40);
    AC_TARGET = t;
    target = {
      tempo: 0.40 + 2.10 * t,
      ringSpeed: 3.0 * t,
      ringPause: 3.0 - 2.8 * t,
      dataFlicker: 4.0 * t,
      webSpin: 1.5 * t,
      webPulseAmp: 0.9 * t,
      runnerCount: 620 * t,
      runnerSpeed: 0.85 * t,
      cometPerBeat: 2.6 * t,
      cometBurst: 8 * t,
      cometTrickle: 2.5 * t,
      beamBright: 2.4 * t,
      beamGlow: 3.5 * t,
      beamLen: 0.2 + 1.6 * t,
      beamBounce: 2 * t,
      dashBright: 2 * t,
      hazeCount: 18 * t,
      hazeBright: 2.4 * t,
      burstRate: 3.5 * t,
      burstSize: 3 * t,
      burstBright: 2.4 * t,
      flareRate: 3.5 * t + Math.min(1.2, errs * 0.25),
      flareBright: 2 * t,
      rimBright: 0.12 + 1.8 * t,
      // camera: shots already push in; multiplier stays small (default ceiling 0.18 ????.12?)
      camZoom: ZOOM_MAX * 0.6 + ZOOM_MAX * 0.4 * t,
    };
    // cap the built-in shots too, so no close-up can exceed SHOT_CAP before the multiplier
    try { if (typeof shots !== 'undefined' && shots.length) for (const sh of shots) if (sh.z > SHOT_CAP) sh.z = SHOT_CAP; } catch (e) {}
    const cam = t > 0.08 ? 1 : 0;
    if (cam !== cameraOn) { cameraOn = cam; try { setParam('camera', cam, true); } catch (e) {} }
  }

  function pulse(b) {
    if (!b) return;
    const n = Math.min(5, (b.tools || 0) + (b.turns || 0) * 2);
    for (let i = 0; i < n; i++) setTimeout(() => { try { onBeat(); } catch (e) {} }, i * 70);
  }

  const HEAVY = new Set(['runnerCount', 'hazeCount', 'beamGlow', 'flareRate', 'burstRate', 'cometBurst', 'cometTrickle']);
  const LOAD = WALL ? 0.50 : 1;          // wallpaper mode runs lighter: it is on screen all day
  let quality = 1;                       // auto-drops when the frame rate sags

  setInterval(() => {
    if (!target) return;
    try {
      for (const k in target) {
        const cur = C[k];
        const slow = k === 'tempo' || k === 'ringSpeed' || k === 'ringPause';
        const tgt = HEAVY.has(k) ? target[k] * quality * LOAD : target[k];
        const tau = slow ? 0.42 : 0.20;                    // seconds to reach ~63% of the gap
        const kk = 1 - Math.exp(-0.12 / tau);              // the loop runs every 120 ms
        const next = cur + (tgt - cur) * kk;
        if (Math.abs(next - cur) > 0.003) setParam(k, next, true);
      }
    } catch (e) {}
  }, 120);

  /* ---------- 8. live feed ---------- */
  function connect() {
    try {
      const es = new EventSource('/stream');
      es.addEventListener('state', (ev) => {
        try {
          const st = JSON.parse(ev.data);
          ingest(st);
          driveParams(st);
          renderPanels(st);
          pulse(st.bursts);
        } catch (e) {}
      });
      es.onerror = () => setTimeout(connect, 1500);
    } catch (e) { setTimeout(connect, 1500); }
  }
  connect();

  /* ---------- 9. standby = slow motion, not a freeze ----------
     The whole simulation advances through dt inside frame(). In standby we feed it
     a clock that runs at 10% speed: the disc keeps its slow idle drift, the "breathing"
     layers settle, and everything still fades out because dt stays > 0.
     At full activity the clock runs at real time again. */
  /* wallpaper mode: force DPR 1 ??a 4K screen at DPR2 allocates 7680?4320 buffers (??30 MB each) */
  if (WALL) {
    try {
      const nativeDPR = Math.min(window.devicePixelRatio || 1, 2); // use the real display DPR (1.5 on 150% scaling) so canvas renders 1:1 with physical pixels - kills moire
      Object.defineProperty(window, 'devicePixelRatio', { get: () => nativeDPR, configurable: true });
      setTimeout(() => { try { resizeAll(); } catch (e) {} }, 400);
      setTimeout(() => {   // report the real devicePixelRatio + canvas size + layout metrics
        try {
          const c = document.querySelector('canvas') || document.querySelectorAll('canvas')[0];
          const w = c ? c.width : 0, h = c ? c.height : 0;
          const vh = window.innerHeight, avail = screen.availHeight || vh;
          const safe = getComputedStyle(document.documentElement).getPropertyValue('--taskbar-safe').trim() || '0px';
          const bottom = document.getElementById('hf-bottom');
          const lastRow = document.getElementById('hf-mini');
          const br = lastRow ? lastRow.getBoundingClientRect() : (bottom ? bottom.getBoundingClientRect() : null);
          fetch('/probe?dpr=' + encodeURIComponent(String(window.devicePixelRatio)) +
            '&w=' + w + '&h=' + h +
            '&vh=' + vh + '&avail=' + avail + '&safe=' + encodeURIComponent(safe) +
            '&panelBottom=' + (br ? Math.round(br.bottom) : -1)).catch(() => {});
        } catch (e) {}
      }, 1500);
    } catch (e) {}
  }
  if (WALL) {
    const origRAF = window.requestAnimationFrame.bind(window);
    let nextSlot = 0;
    window.requestAnimationFrame = (cb) => {
      const now = performance.now();
      const ms = document.hidden ? 500 : Math.round(20 + 40 * Math.pow(1 - AC, 1.6));
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + ms;
      return setTimeout(() => origRAF(cb), wait);
    };
  }

  const prevFrame = frame;
  let realLast = performance.now();
  let fakeT = last;                       // `last` is HALOFLUX's own frame clock
  let fpsEMA = 60, qFrames = 0;
  frame = function (now) {
    const dt = Math.min(0.05, (now - realLast) / 1000);
    realLast = now;
    // adaptive quality: heavy particles/beams back off before the frame rate sags
    if (dt > 0) fpsEMA = fpsEMA * 0.92 + (1 / dt) * 0.08;
    if (++qFrames >= 40) {
      qFrames = 0;
      if (fpsEMA < 46 && quality > 0.35) quality = Math.max(0.35, quality - 0.1);
      else if (fpsEMA > 56 && quality < 1) quality = Math.min(1, quality + 0.05);
    }
    if (WALL) quality = Math.min(quality, 0.7);
    // activity envelope: fast attack (~0.12 s), gentle release (~0.85 s) -> no hard on/off
    const kUp = 1 - Math.exp(-dt / 0.12);
    const kDn = 1 - Math.exp(-dt / 0.85);
    AC += (AC_TARGET - AC) * (AC_TARGET > AC ? kUp : kDn);
    const ease = AC * AC * (3 - 2 * AC);                    // smoothstep 0..1
    const speed = 0.10 + 0.90 * ease;                       // was: 0.10 -> 1.00 in one frame
    fakeT += dt * 1000 * speed;
    prevFrame(fakeT);
  };

  /* ---------- 10. local player (QQ Music / Spotify / any SMTC app) ---------- */
  const styleEl = document.createElement('style');
  styleEl.textContent = `
  #dsh-media{position:fixed;top:84px;left:0;z-index:60;min-width:250px;max-width:340px;
    background:#0b0c0f;border:1px solid var(--line2,#3a3e46);border-left:0;padding:9px 12px 9px 14px;
    font-family:${F};color:var(--text,#cfd2d8);pointer-events:auto}
  #dsh-media .lbl{font-size:8px;letter-spacing:1.6px;color:#6b6f78}
  #dsh-media .tt{font-size:12px;font-weight:800;color:#f4f5f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
  #dsh-media .ar{font-size:9px;color:#9a9ea7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  #dsh-media .ctl{display:flex;gap:6px;margin-top:7px;align-items:center}
  #dsh-media button{background:#15171b;color:var(--text,#cfd2d8);border:1px solid var(--line2,#3a3e46);
    font:inherit;font-size:10px;padding:3px 8px;cursor:pointer;line-height:1.2}
  #dsh-media button:hover{border-color:#cfd2d8;color:#fff}
  #dsh-media .st{margin-left:auto;font-size:8px;letter-spacing:1px;color:#98e0cf}
  `;
  document.head.appendChild(styleEl);

  const mediaEl = document.createElement('div');
  mediaEl.id = 'dsh-media';
  mediaEl.innerHTML = `<div class="lbl">正在播放 · 本地播放器</div>
    <div class="tt" id="mTitle">--</div>
    <div class="ar" id="mArtist">--</div>
    <div class="ctl">
      <button data-act="prev">上一首</button>
      <button data-act="toggle">播放 / 暂停</button>
      <button data-act="next">下一首</button>
      <span class="st" id="mState">--</span>
    </div>`;
  document.body.appendChild(mediaEl);

  // player is collapsible: hidden by default, toggled by the top-right button
  // player is open by default in wallpaper mode (the toggle button still collapses it)
  mediaEl.style.display = WALL ? 'block' : 'none';
  const mediaToggle = document.createElement('div');
  mediaToggle.id = 'dsh-media-toggle';
  mediaToggle.textContent = WALL ? '♪ 收起' : '♪ 播放器';
  document.body.appendChild(mediaToggle);
  const toggleCss = document.createElement('style');
  toggleCss.textContent = '#dsh-media-toggle{position:fixed;top:66px;right:14px;z-index:61;' +
    'background:#0b0c0f;border:1px solid var(--line2,#3a3e46);color:#b9bec7;padding:4px 10px;' +
    'font:10px/1.3 ui-monospace,Consolas,monospace;letter-spacing:.08em;cursor:pointer;pointer-events:auto;user-select:none}' +
    '#dsh-media-toggle:hover{color:#fff;border-color:#cfd2d8}';
  document.head.appendChild(toggleCss);
  mediaToggle.addEventListener('click', () => {
    const open = mediaEl.style.display === 'none';
    mediaEl.style.display = open ? 'block' : 'none';
    mediaToggle.textContent = open ? '♪ 收起' : '♪ 播放器';
  });

  const bgmWidget = $('bgm'); if (bgmWidget) bgmWidget.style.display = 'none';
  const mTitle = mediaEl.querySelector('#mTitle');
  const mArtist = mediaEl.querySelector('#mArtist');
  const mState = mediaEl.querySelector('#mState');

  function paintMedia(m) {
    const ok = m && m.ok && m.title;
    mTitle.textContent = ok ? m.title : '未检测到播放器';
    mArtist.textContent = ok ? [m.artist, m.album, (m.app || '').replace('.exe', '')].filter(Boolean).join(' · ') : '打开 QQ 音乐 / Spotify 后自动显示';
    mState.textContent = ok ? (m.status === 'Playing' ? '播放中' : m.status === 'Paused' ? '已暂停' : String(m.status || '').toUpperCase()) : '';
    mState.style.color = ok && m.status === 'Playing' ? '#98e0cf' : '#6b6f78';
  }

  async function pollMedia() {
    try { paintMedia(await (await fetch('/media', { cache: 'no-store' })).json()); } catch (e) {}
  }
  mediaEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    try { await fetch('/media/action?do=' + b.dataset.act, { method: 'POST' }); } catch (e) {}
    setTimeout(pollMedia, 700);
  });
  pollMedia(); setInterval(pollMedia, 2500);   // wallpaper hides the panel ??no polling at all


  /* ---------- 11. external AI apps (ChatGPT / WorkBuddy) ---------- */
  const extStyle = document.createElement('style');
  extStyle.textContent = '#dsh-ext{position:fixed;top:58px;left:14px;z-index:60;width:330px;background:#0b0c0f;' +
    'border:1px solid var(--line2,#3a3e46);padding:9px 11px;color:#cfd2d8}' +
    '#dsh-ext .lbl{font-size:9px;letter-spacing:.16em;color:#6b6f78;margin-bottom:5px}' +
    '#dsh-ext .row{display:flex;align-items:center;gap:6px;margin-top:5px}' +
    '#dsh-ext .dot{width:6px;height:6px;border-radius:50%;background:#4a4e56;flex:0 0 auto}' +
    '#dsh-ext .nm{font-weight:800;font-size:11px;color:#e8eaee;min-width:88px}' +
    '#dsh-ext .st{font-size:9px;color:#9aa0aa;margin-left:auto}' +
    '#dsh-ext .wk{color:#f0a6c6}' +
    '#dsh-ext .sn{font-size:9.5px;color:#8d939c;line-height:1.5;margin:2px 0 0 12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}';
  document.head.appendChild(extStyle);
  const extEl = document.createElement('div');
  extEl.id = 'dsh-ext';
  extEl.innerHTML = '<div class="lbl">外部 AI</div><div id="extRows"></div>';
  document.body.appendChild(extEl);

  let extBusyUntil = 0;

  function paintChatGptMini(data) {
    const el = document.getElementById('mChatBody');
    if (!el) return;
    const rows = (data && data.apps) || [];
    if (!rows.length) { el.innerHTML = '<div>无数据</div>'; return; }
    // running = vivid identity colour; NOT running = greyed out. That is the whole point:
    // you glance at the panel and instantly see who is actually alive right now.
    el.innerHTML = rows.map(a => {
      const busy = data.busy ? '生成中' : a.state;
      const sn = a.snippet ? short(a.snippet, 34) : '';
      const col = rgbHex(agentColor(a.name));
      const on = !!a.running;
      // alive: full colour + full opacity. dead: desaturated grey, low opacity.
      const dotStyle = on
        ? 'background:' + col + ';opacity:1'
        : 'background:#4a4e56;opacity:.45';
      const nameStyle = on
        ? 'color:' + col
        : 'color:#5b6068';
      const nameWeight = on ? 700 : 400;
      return '<div style="display:flex;align-items:baseline;gap:5px;white-space:nowrap;overflow:hidden;' +
          'opacity:' + (on ? 1 : 0.62) + '">' +
        '<span style="width:5px;height:5px;border-radius:50%;flex:0 0 auto;' + dotStyle + '"></span>' +
        '<b style="' + nameStyle + ';font-weight:' + nameWeight + '">' + esc(a.name) + '</b>' +
        '<span style="color:' + (on ? '#c8ccd4' : '#565b63') + ';margin-left:auto">' + esc(busy) + '</span></div>' +
        (sn ? '<div style="font-size:9px;color:#6b6f78;padding-left:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(sn) + '</div>' : '');
    }).join('');
  }

  function paintExt(data) {
    window.__EXT = data || null;
    paintChatGptMini(data);
    const rows = (data && data.apps) || [];
    if (data && data.busy) extBusyUntil = Date.now() + 4000;   // keep the ring alive between probes
    const color = (name) => rgbHex(agentColor(name));
    const html = rows.map(a => {
      const sn = a.snippet ? '<div class="sn">' + esc(a.snippet) + '</div>' : '';
      const wk = a.work ? ' <span class="wk">· ' + esc(a.work) + '</span>' : '';
      const on = !!a.running;
      // same rule as the bottom panel: alive = vivid, dead = greyed out
      const dotStyle = on ? 'background:' + color(a.name) + ';opacity:1' : 'background:#4a4e56;opacity:.45';
      const nmStyle = on ? 'color:' + color(a.name) + ';font-weight:800' : 'color:#5b6068;font-weight:400';
      return '<div class="row" style="opacity:' + (on ? 1 : 0.62) + '">' +
        '<span class="dot" style="' + dotStyle + '"></span>' +
        '<span class="nm" style="' + nmStyle + '">' + esc(a.name) + '</span>' +
        '<span class="st">' + (data.busy ? '生成中' : esc(a.state)) + wk + '</span></div>' + sn;
    }).join('');
    document.getElementById('extRows').innerHTML = html || '<div class="row"><span class="st">无数据</span></div>';
  }
  async function pollExt() {
    try { paintExt(await (await fetch('/external', { cache: 'no-store' })).json()); } catch (e) {}
  }
  pollExt();
  setInterval(pollExt, 2000);

  /* external AI heartbeat: beats while ChatGPT/other app is generating */
  setInterval(() => {
    if (Date.now() < extBusyUntil) { try { onBeat(); } catch (e) {} }
  }, 700);

  /* ---------- 12. HARD MUTE: never let HALOFLUX's built-in mp3 play ----------
     Lively/WebView2 grants autoplay, so the demo BGM can start on its own.
     Kill the element and intercept play() so nothing can resume it. */
  try {
    const bgmAudio = document.getElementById('bgmAudio');
    if (bgmAudio) {
      bgmAudio.pause();
      bgmAudio.muted = true;
      bgmAudio.volume = 0;
      bgmAudio.removeAttribute('src');
      bgmAudio.removeAttribute('data-src');
      try { bgmAudio.load(); } catch (e) {}
      bgmAudio.remove();
    }
    const bgmWidget = document.getElementById('bgm');
    if (bgmWidget) bgmWidget.remove();
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'bgmAudio' || this.tagName === 'AUDIO') return Promise.resolve();
      return nativePlay.apply(this, arguments);
    };
  } catch (e) {}


  /* ---------- 13. usage / cost panel (from dsh-cost-meter ledger) ---------- */
  const useCss = document.createElement('style');
  useCss.textContent = '#dsh-usage{position:fixed;right:14px;top:190px;z-index:60;width:350px;background:#0b0c0f;' +
    'border:1px solid var(--line2,#3a3e46);padding:9px 11px;color:#cfd2d8}' +
    '#dsh-usage .lbl{font-size:9px;letter-spacing:.16em;color:#6b6f78;margin-bottom:5px}' +
    '#dsh-usage .r{display:flex;gap:8px;align-items:baseline;margin-top:4px;font-size:9.5px;line-height:1.5}' +
    '#dsh-usage .k{color:#6b6f78;min-width:52px}' +
    '#dsh-usage .v{color:#e8eaee;font-weight:700}' +
    '#dsh-usage .s{color:#8d939c}' +
    '#dsh-usage .hi{color:#f0a6c6}';
  document.head.appendChild(useCss);
  const useEl = document.createElement('div');
  useEl.id = 'dsh-usage';
  useEl.innerHTML = '<div class="lbl">用量 · 费用</div><div id="useRows"></div>';
  document.body.appendChild(useEl);

  const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
  const fmtCny = (n) => '¥' + (n || 0).toFixed(4);
  const fmtDur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + '时' + String(m % 60).padStart(2, '0') + '分'; };

  function paintUsage(u) {
    window.__USAGE = u;
    const labels = ['今日 TOKENS', '今日花费', '余额', '缓存命中', '峰谷剩余'];
    document.querySelectorAll('.kpi .k').forEach((el, i) => { if (labels[i]) el.textContent = labels[i]; });
    if (!u || u.error) return;
    const t2 = u.today || {}, p = u.peak || {}, s = u.session;
    const vals = [
      fmtTok(t2.tokens || 0),
      '¥' + (t2.costCny || 0).toFixed(2),
      u.balance != null ? '¥' + u.balance.toFixed(2) : '—',
      ((t2.hit || 0) * 100).toFixed(1) + '%',
      fmtDur(p.remainMs || 0)
    ];
    vals.forEach((v, i) => { const el = document.getElementById('k' + i); if (el) el.textContent = v; });
    const segs = document.querySelectorAll('.kpi .seg i');
    const widths = [
      Math.min(100, (t2.tokens || 0) / 3e8 * 100),
      Math.min(100, (t2.costCny || 0) / Math.max(1, u.balance || 100) * 200),
      100,
      (t2.hit || 0) * 100,
      Math.min(100, (p.remainMs || 0) / 36e5 / 6 * 100)
    ];
    segs.forEach((el, i) => { el.style.width = Math.max(2, Math.round(widths[i] || 2)) + '%'; });

    const el = document.getElementById('hfUse');
    if (el) {
      const rows = [];
      if (s) rows.push('<div>本会话 <b>¥' + s.costCny.toFixed(4) + '</b> · 命中 ' + (s.hit * 100).toFixed(1) + '%</div>');
      rows.push('<div>今日 <b>' + fmtTok(t2.tokens || 0) + ' tok</b> · ¥' + (t2.costCny || 0).toFixed(2) + '</div>');
      if (u.balance != null) rows.push('<div>余额 <b>¥' + u.balance.toFixed(2) + '</b></div>');
      if (p.nextLabel) rows.push('<div>' + (p.inPeak ? '峰时' : '平价') + '剩余 <b>' + fmtDur(p.remainMs || 0) + '</b> · ' + p.nextLabel + ' 转' + (p.inPeak ? '平价' : '峰时') + '</div>');
      el.innerHTML = rows.join('');
    }
  }

  async function pollUsage() {
    try {
      const sid = (LAST_STATE && LAST_STATE.sessions && LAST_STATE.sessions[0]) ? LAST_STATE.sessions[0].id : '';
      const u = await (await fetch('/usage?session=' + encodeURIComponent(sid), { cache: 'no-store' })).json();
      paintUsage(u);
    } catch (e) {}
  }
  setInterval(pollUsage, 5000);
  setTimeout(pollUsage, 1500);

  window.__HF = { read: () => ({ ...C }), hist: H, get activity() { return AC; } };
})();
