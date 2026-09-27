#!/usr/bin/env node
'use strict';
/*
 * preview.mjs - see the badge NOW, without touching the running app.
 *
 * WHY
 *   The desktop shell freezes its index injection table at Host startup, so the real badge only
 *   appears after the app restarts. That is a bad first impression for a feature whose whole point
 *   is "you can see it". This serves the real `notice.js` - the same bytes the Host serves - over a
 *   throwaway local server, with a looping demo: two jobs run, one completes, one fails, a new one
 *   starts, and every cycle repeats. Nothing here is part of the plugin's runtime path.
 *
 *   Chromium will not start an AudioContext before the page has been interacted with, so CLICK THE
 *   PAGE ONCE if you want to hear the chime.
 *
 * Usage: node test/preview.mjs [--port 8799]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const notice = fs.readFileSync(path.join(here, '..', 'notice.js'), 'utf8');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 8799));

const UI = { position: 'bottom-right', sound: 'always', volume: 0.35, pollMs: 2500 };

let nextId = 1;
const running = [];
const settled = [];
let unseen = 0;
let revision = 0;
const clients = new Set();

const touch = (causedUnread) => {
  revision++;
  if (causedUnread) unseen++;
  broadcast();
};

function state() {
  return {
    available: true,
    revision,
    now: Date.now(),
    unseen,
    counts: {
      running: running.length,
      settled: settled.length,
      unseen,
      failed: settled.filter((row) => row.status === 'failed').length,
    },
    running,
    settled,
    ui: UI,
  };
}

function broadcast() {
  const frame = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
}

/* ------------------------------------------------------------------ demo loop */

/* Frozen poses, so a screenshot or a design review sees the same thing twice. A posed page polls a
 * fixed state and opens no stream: nothing in the demo can move under it. */
function posedState(pose) {
  const at = Date.now();
  const rows = [
    { id: 'demo-1', kind: 'pwsh', label: 'npm run build', status: 'running', startedAt: at - 80_000, progress: 'bundling 42%' },
    { id: 'demo-2', kind: 'subagent', label: 'research the plugin API', status: 'running', startedAt: at - 12_000, progress: 'reading 6 files…' },
  ];
  const done = [
    { id: 'demo-3', kind: 'pwsh', label: 'pwsh -File publish.ps1', status: 'completed', startedAt: at - 190_000, finishedAt: at - 65_000, detail: 'exit code: 0', unseen: true },
  ];
  const withUnread = pose === 'unread';
  const running = pose === 'busy' ? rows.slice(0, 1) : rows;
  const settled = withUnread ? done : [];
  return {
    available: true,
    revision: 1,
    now: at,
    unseen: withUnread ? 1 : 0,
    counts: {
      running: running.length,
      settled: settled.length,
      unseen: withUnread ? 1 : 0,
      failed: 0,
    },
    running,
    settled: settled.map((row) => Object.assign({}, row, { unseen: withUnread })),
    ui: UI,
  };
}

const LABELS = [
  ['pwsh', 'npm run build'],
  ['subagent', 'research the plugin API'],
  ['pwsh', 'pwsh -File publish.ps1'],
  ['subagent', 'summarize 40 transcripts'],
];
let cycle = 0;

function start() {
  const [kind, label] = LABELS[cycle % LABELS.length];
  running.push({ id: `demo-${nextId++}`, kind, label, status: 'running', startedAt: Date.now(), progress: 'starting…' });
  touch(false);
}

function settleFile() {
  const job = running.shift();
  if (!job) return;
  const failed = cycle % 3 === 2;
  settled.unshift(Object.assign({}, job, {
    status: failed ? 'failed' : 'completed',
    finishedAt: Date.now(),
    detail: failed ? 'exit code: 1' : 'exit code: 0',
    unseen: true,
  }));
  delete settled[0].progress;
  touch(true);
}

function tick() {
  cycle++;
  for (const job of running) {
    job.progress = `working… ${(cycle * 7) % 100}%`;
  }
  if (cycle === 1) { start(); start(); }
  if (cycle % 9 === 5) start();
  if (cycle % 6 === 0) settleFile();
  if (cycle % 30 === 0) { settled.length = 0; unseen = 0; }
  touch(false);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    const pose = url.searchParams.get('pose') === 'busy' || url.searchParams.get('pose') === 'unread'
      ? url.searchParams.get('pose')
      : '';
    const tag = `<script src="/notice.js" data-job-badge-state="/state.json${pose ? `?pose=${pose}` : ''}" `
      + `data-job-badge-stream="${pose ? '' : '/stream'}" data-job-badge-ack="/ack.json" defer></script>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>job-badge preview</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#101012;color:#e8e8ea}
main{max-width:520px;text-align:center}h1{font-size:18px;font-weight:600}code{background:#1d1d20;padding:1px 5px;border-radius:4px}
p{opacity:.75}</style></head>
<body><main>
<h1>后台任务提示图标 · 预览</h1>
<p>右下角就是真实的 <code>notice.js</code>：两个任务在跑 → 一个完成 → 一个失败 → 再起一个，30 秒一轮。</p>
<p>点一下这个页面再等下一次完成，才听得到提示音（浏览器不允许未交互就出声）。<br>点图标打开面板，未读计数会被清掉。</p>
<p><code>?pose=unread</code> 冻结成"1 个未读完成"，<code>?pose=busy</code> 冻结成"只有一个在跑"，方便截图。</p>
</main>
${tag}
</body></html>`);
    return;
  }
  if (url.pathname === '/notice.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(notice);
    return;
  }
  if (url.pathname === '/state.json') {
    const pose = url.searchParams.get('pose');
    const body = pose === 'busy' || pose === 'unread' ? posedState(pose) : state();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/ack.json') {
    req.resume();
    req.on('end', () => {
      unseen = 0;
      for (const row of settled) row.unseen = false;
      touch(false);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, unseen: 0 }));
    });
    return;
  }
  res.writeHead(404).end('nope');
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
setInterval(tick, 1000).unref();

console.log(`job-badge preview: http://127.0.0.1:${PORT}/`);
console.log('serving the real notice.js; Ctrl+C to stop.');
