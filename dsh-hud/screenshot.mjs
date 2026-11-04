// CDP screenshot helper: node screenshot.mjs <url> <out.png> [waitMs] [port]
const [url, out, waitMs = '6000', portArg = '9333'] = process.argv.slice(2);
const PORT = Number(portArg);
const hardStop = setTimeout(() => { console.error('timeout'); process.exit(4); }, 45000);

const get = (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, signal: AbortSignal.timeout(5000) });

let target = null;
try {
  const list = await (await get('/json/list')).json();
  target = (list || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl &&
    (t.url.startsWith('about:blank') || t.url.startsWith('http://127.0.0.1:7788')));
} catch (e) { console.error('list failed', e.message); }

if (!target) {
  try { target = await (await get('/json/new?about:blank', { method: 'PUT' })).json(); }
  catch (e) { console.error('new target failed', e.message); }
}
if (!target || !target.webSocketDebuggerUrl) { console.error('no target'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, Number(waitMs)));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (!shot.result || !shot.result.data) { console.error('capture failed', JSON.stringify(shot).slice(0, 200)); process.exit(3); }
const { writeFile } = await import('node:fs/promises');
const buf = Buffer.from(shot.result.data, 'base64');
await writeFile(out, buf);
clearTimeout(hardStop);
console.log('saved', out, buf.length, 'bytes');
try { await get(`/json/close/${target.id}`); } catch (e) {}
ws.close();
process.exit(0);
