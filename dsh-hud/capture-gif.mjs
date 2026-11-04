// Capture the /wall page to a frame sequence (for building the demo GIF).
// usage: node capture-gif.mjs <outDir> <seconds> <fps> <width> <height> <preSleepSeconds>
const [outDir = 'dsh-hud/shots/gif-frames', secs = '12', fps = '7', w = '1152', h = '648', pre = '5'] =
  process.argv.slice(2);
const { mkdir, writeFile } = await import('node:fs/promises');

const mk = await (await fetch('http://127.0.0.1:9990/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(mk.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (m, p = {}) => new Promise((res) => {
  const i = ++id;
  const fn = (e) => { const x = JSON.parse(e.data); if (x.id === i) { ws.removeEventListener('message', fn); res(x); } };
  ws.addEventListener('message', fn);
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:7788/wall' });
await new Promise((r) => setTimeout(r, 2500));
await mkdir(outDir, { recursive: true });

if (+pre > 0) { console.log(`idle ${pre}s ...`); await new Promise((r) => setTimeout(r, +pre * 1000)); }

const interval = 1000 / +fps;
const frames = Math.round(+secs * +fps);
console.log(`capturing ${frames} frames @ ${fps}fps`);
for (let i = 0; i < frames; i++) {
  const t0 = Date.now();
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    await writeFile(`${outDir}/f${String(i).padStart(4, '0')}.png`, Buffer.from(shot.result.data, 'base64'));
  }
  const wait = interval - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await writeFile(`${outDir}/meta.json`, JSON.stringify({ frames, fps: +fps, width: +w, height: +h, pre: +pre }, null, 2));
console.log('done');
ws.close();
process.exit(0);
