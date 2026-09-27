#!/usr/bin/env node
'use strict';
/*
 * notice-render.mjs - render notice.js in a REAL browser and assert what it draws.
 *
 * WHY
 *   Every other test here is a Node test, and the claim that matters most - "does a badge actually
 *   appear, count, and turn into an unread mark" - cannot be settled in Node. Asserting that a
 *   source file contains a string is not evidence that an element renders.
 *
 * HOW
 *   A throwaway HTTP server plays every role the real Host plays: it serves notice.js behind a tag
 *   carrying the three data-* routes, answers the state route with synthetic frames, holds a real
 *   server-sent-event stream open, and records acknowledgements. So the badge runs against the same
 *   relative-URL contract it uses in production, with no Host, no auth and no restart. A headless
 *   Edge connects over CDP, pages are loaded, and the live DOM is read back.
 *
 *   One case loads the INJECTION ROW produced by the real `apply()` rather than a hand-written tag,
 *   because "the loader the Host injects actually mounts the badge" is a separate claim from "the
 *   badge works when a tag points at it".
 *
 * Usage: node test/notice-render.mjs [--port 8793] [--cdp 8794] [--edge <path>]
 *   Skips with a clear message (exit 0) when no browser is available, so it never blocks a suite.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTICE = path.join(here, '..', 'notice.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 8793));
const CDP_PORT = Number(arg('cdp', 8794));

const EDGE_CANDIDATES = [
  arg('edge', ''),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edgePath) {
  console.log('notice-render: no Edge found; skipping browser rendering check (not a failure)');
  process.exit(0);
}

/* ------------------------------------------------------------------ fixtures */

const NOW = Date.now();
const num = (over) => Object.assign({
  position: 'bottom-right', sound: 'always', volume: 0.35, pollMs: 15000,
}, over);

const idle = {
  available: true, revision: 1, now: NOW, unseen: 0,
  counts: { running: 0, settled: 0, unseen: 0, failed: 0 }, running: [], settled: [], ui: num(),
};

const twoRunning = {
  available: true, revision: 2, now: NOW, unseen: 0,
  counts: { running: 2, settled: 0, unseen: 0, failed: 0 },
  running: [
    { id: 'bash-1', kind: 'bash', label: 'npm run build', status: 'running', startedAt: NOW - 65000, progress: 'bundling 42%' },
    { id: 'subagent-2', kind: 'subagent', label: 'research the API', status: 'running', startedAt: NOW - 4000 },
  ],
  settled: [], ui: num(),
};

/* the push that has to wake the page up: one settlement, no reload */
const oneSettled = {
  available: true, revision: 3, now: Date.now(), unseen: 1,
  counts: { running: 1, settled: 1, unseen: 1, failed: 0 },
  running: [
    { id: 'subagent-2', kind: 'subagent', label: 'research the API', status: 'running', startedAt: NOW - 4000 },
  ],
  settled: [
    { id: 'bash-1', kind: 'bash', label: 'npm run build', status: 'completed', startedAt: NOW - 65000, finishedAt: Date.now(), detail: 'exit 0', unseen: true },
  ],
  ui: num(),
};

/* a label is model-authored text and must never become markup */
const hostile = {
  available: true, revision: 4, now: Date.now(), unseen: 1,
  counts: { running: 1, settled: 1, unseen: 1, failed: 1 },
  running: [
    { id: 'bash-3', kind: 'bash', label: '<img src=x onerror="window.__xss=1">', status: 'running', startedAt: Date.now() - 1000 },
  ],
  settled: [
    { id: 'bash-4', kind: 'bash', label: '<script>window.__xss=2</script>', status: 'failed', startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000, detail: 'exit 1', unseen: true },
  ],
  ui: num(),
};

let CURRENT = idle;
const sseClients = new Set();
const acks = [];

/* --------------------------------------------------------- the injection row */

/* Ask the real apply() what it would inject, with the smallest fake Host that satisfies it. */
function injectionText() {
  const routes = [];
  let hook = null;
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    jobs: { events: { subscribe: () => () => {} }, list: () => [] },
    interval: () => () => {},
    on: (name, listener) => { if (name === 'webserver/index-inject') hook = listener; return () => {}; },
    effect: (callback) => callback(),
    get: () => undefined,
    logger: { info() {}, warn() {} },
  };
  apply(ctx, {});
  const table = [];
  hook(table);
  const stateRoute = routes.find((r) => /state-\d+\.json$/.test(r.path)).path;
  const streamRoute = routes.find((r) => /stream-\d+$/.test(r.path)).path;
  const ackRoute = routes.find((r) => /ack-\d+\.json$/.test(r.path)).path;
  const uiRoute = routes.find((r) => /ui-\d+\.js$/.test(r.path)).path;
  return { text: table[0].text, stateRoute, streamRoute, ackRoute, uiRoute };
}

const injection = injectionText();

/* ------------------------------------------------------------------ servers */

const noticeSource = fs.readFileSync(NOTICE, 'utf8');
const tag = (state, stream, ack) =>
  `<script src="/plugin/notice.js" data-job-badge-state="${state}" data-job-badge-stream="${stream}" data-job-badge-ack="${ack}" defer></script>`;

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  /* the injected page asks for the stamped routes the real apply() registered; the hand-written
   * page asks for /live/*. Both must answer the same way or step 8 would be testing a 404 page. */
  const isState = url.pathname === '/live/state.json' || url.pathname === injection.stateRoute;
  const isStream = url.pathname === '/live/stream' || url.pathname === injection.streamRoute;
  const isAck = url.pathname === '/live/ack.json' || url.pathname === injection.ackRoute;
  const isUi = url.pathname === '/plugin/notice.js' || url.pathname === injection.uiRoute;

  if (url.pathname === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('dsh', tag('/live/state.json', '/live/stream', '/live/ack.json')));
    return;
  }
  if (url.pathname === '/plain.html') {
    /* no tag, no loader: the page the desktop shell serves before it applies the injection table */
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('dsh plain', '<main id="shell-marker">shell intact</main>'));
    return;
  }
  if (url.pathname === '/injected.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('dsh injected', `<main id="shell-marker">shell intact</main><script>${injection.text}</script>`));
    return;
  }
  if (isUi) {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(noticeSource);
    return;
  }
  if (isState) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(CURRENT));
    return;
  }
  if (isStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(CURRENT)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (isAck) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      acks.push(raw);
      CURRENT = Object.assign({}, CURRENT, { unseen: 0 });
      CURRENT.counts = Object.assign({}, CURRENT.counts, { unseen: 0 });
      CURRENT.settled = CURRENT.settled.map((row) => Object.assign({}, row, { unseen: false }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, unseen: 0 }));
    });
    return;
  }
  res.writeHead(404).end('nope');
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/** Push a frame to every open stream: this is how the page learns without a reload. */
function push(frame) {
  CURRENT = frame;
  const body = `data: ${JSON.stringify(frame)}\n\n`;
  for (const client of sseClients) { try { client.write(body); } catch { sseClients.delete(client); } }
}

/* ------------------------------------------------------------- CDP plumbing */

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-badge-edge-'));
const edge = spawn(edgePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('headless Edge did not open a CDP port');
}

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  failures.push(`${label}\n      expected ${b}\n      got      ${a}`);
};
const ok = (label, condition, detail) => {
  if (condition) { pass++; return; }
  failures.push(`${label}${detail === undefined ? '' : `\n      ${detail}`}`);
};

let ws = null;
let send = null;
let evaluate = null;
let evaluateIn = null;
/** Anything the page logged or threw, so a silent failure is not silent in this harness. */
const pageLog = [];

async function attach(targetMatcher) {
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = targets.find(targetMatcher);
  if (!target) throw new Error('no matching page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      pageLog.push('exception: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      pageLog.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const raw = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
    return r.result.value;
  };
  evaluate = raw;
  evaluateIn = (frameId, expression) => send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }).then((r) => (r.exceptionDetails ? Promise.reject(new Error('threw')) : r.result.value));
}

/** Read the badge out of the live DOM. textContent, not innerText: innerText inserts layout-driven
 *  whitespace between the chip's flex items, which would make an exact assertion measure the browser. */
const READ = `(() => {
  const root = document.getElementById('dsh-job-badge');
  const probe = { xss: window.__xss === undefined ? null : window.__xss, title: document.title };
  if (!root) return Object.assign({ present: false }, probe);
  const chip = root.querySelector('.jb-chip');
  const panel = root.querySelector('.jb-panel');
  return Object.assign({
    present: true,
    roots: document.querySelectorAll('#dsh-job-badge').length,
    chips: root.querySelectorAll('.jb-chip').length,
    chip: chip ? chip.textContent.trim() : null,
    unread: chip ? chip.getAttribute('data-unread') : null,
    spinning: root.querySelectorAll('.jb-spin').length,
    pulsing: chip ? chip.classList.contains('jb-pulse') : false,
    panelVisible: Boolean(panel) && panel.style.display !== 'none',
    rows: root.querySelectorAll('.jb-row').length,
    rowText: Array.from(root.querySelectorAll('.jb-row')).map((r) => r.textContent.trim()),
    sections: Array.from(root.querySelectorAll('.jb-section')).map((s) => s.textContent),
    images: root.querySelectorAll('img,script').length,
  }, probe);
})()`;

const waitFor = (expression, ms) => evaluate(
  `(async () => { const t0 = Date.now(); while (Date.now() - t0 < ${ms}) { if (${expression}) return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`,
);

async function main() {
  await waitForCdp();
  await attach((t) => t.type === 'page');
  await send('Page.enable');
  await send('Runtime.enable');

  const load = async (url, settle = 700) => {
    await send('Page.navigate', { url });
    await sleep(settle);
  };

  /* 1. nothing in the registry -> no element at all: an all-clear badge is noise */
  CURRENT = idle;
  await load(`http://127.0.0.1:${PORT}/page.html`);
  let r = await evaluate(READ);
  if (process.env.JB_DEBUG) {
    /* JB_DEBUG=1 dumps what the page really has: the contract lives in attributes, not in a guess */
    console.error('DIAG', JSON.stringify(await evaluate(`(() => {
      const s = document.querySelector('script[data-job-badge-state]');
      return {
        scripts: Array.from(document.scripts).map((x) => x.src || x.id || x.textContent.slice(0, 40)),
        state: s ? s.getAttribute('data-job-badge-state') : null,
        flag: Boolean(window.__dshJobBadge),
        timeout: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function',
        es: typeof EventSource,
      };
    })()`)));
    console.error('SSE clients after load:', sseClients.size);
    await evaluate(`console.error('PROBE-FROM-PAGE')`);
    await sleep(250);
    console.error('console capture works:', JSON.stringify(pageLog));
    console.error('badge after first frame:', await evaluate(`JSON.stringify({ root: Boolean(document.getElementById('dsh-job-badge')), flag: Boolean(window.__dshJobBadge), scripts: document.scripts.length })`));
  }
  check('idle: the badge does not exist', r.present, false);
  check('idle: the title is untouched', r.title, 'dsh');

  /* 2. two running -> a chip with a spinner and the count, no unread mark */
  push(twoRunning);
  check('running: the chip appears from a push', await waitFor(`document.getElementById('dsh-job-badge')`, 3000), true);
  r = await evaluate(READ);
  ok('running: the chip counts the jobs', /^2$/.test(r.chip), `chip text was ${JSON.stringify(r.chip)}`);
  ok('running: the chip spins', r.spinning >= 1);
  check('running: nothing is marked unread', r.unread, '0');
  check('running: the panel stays closed', r.panelVisible, false);
  check('running: no title prefix', r.title, 'dsh');

  /* 3. one settles -> unread badge, pulsing, and a title prefix, all without a reload */
  push(oneSettled);
  check('settled: the chip turns into an unread mark', await waitFor(`(() => { const c = document.querySelector('#dsh-job-badge .jb-chip'); return Boolean(c) && c.getAttribute('data-unread') === '1'; })()`, 3000), true);
  r = await evaluate(READ);
  ok('settled: the chip shows running and unread side by side', /^1\s*·\s*✓\s*1$/.test(r.chip), `chip text was ${JSON.stringify(r.chip)}`);
  check('settled: the chip pulses', r.pulsing, true);
  check('settled: the title carries the count', r.title, '(1) dsh');

  /* 4. opening the badge is looking: the panel opens and the count clears */
  check('click: the chip exists to click', await waitFor(`Boolean(document.querySelector('#dsh-job-badge .jb-chip'))`, 3000), true);
  await evaluate(`document.querySelector('#dsh-job-badge .jb-chip').click()`);
  check('click: the panel opens', await waitFor(`(() => { const p = document.querySelector('#dsh-job-badge .jb-panel'); return Boolean(p) && p.style.display !== 'none'; })()`, 2000), true);
  r = await evaluate(READ);
  check('click: the panel lists both jobs', r.rows, 2);
  ok('click: the running row names the job and its kind', /research the API/.test(r.rowText.join(' | ')) && /subagent/.test(r.rowText.join(' | ')), r.rowText.join(' | '));
  ok('click: the finished row carries its exit detail', /exit 0/.test(r.rowText.join(' | ')), r.rowText.join(' | '));
  ok('click: the finished row carries its duration', /1m05s/.test(r.rowText.join(' | ')), r.rowText.join(' | '));
  check('click: the sections are named', r.sections.length, 2);
  check('click: the badge stops demanding attention', r.unread, '0');
  check('click: the title prefix is gone', r.title, 'dsh');
  check('click: the host was told', await waitFor(`${acks.length} > 0`, 2000), true);
  check('click: exactly one acknowledgement', acks.length, 1);

  /* 5. a model-authored label is text, never markup */
  push(hostile);
  check('hostile: the badge updates', await waitFor(`document.querySelectorAll('#dsh-job-badge .jb-row').length === 2`, 3000), true);
  r = await evaluate(READ);
  check('hostile: no element was injected from a label', r.images, 0);
  check('hostile: nothing executed', r.xss, null);
  ok('hostile: the label is shown verbatim', /<img src=x onerror=/.test(r.rowText.join(' | ')), r.rowText.join(' | '));

  /* 6. escape closes the panel */
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check('escape: the panel closes', await waitFor(`(() => { const p = document.querySelector('#dsh-job-badge .jb-panel'); return !p || p.style.display === 'none'; })()`, 2000), true);

  /* 7. everything acknowledged and gone -> the badge removes itself */
  push({
    available: true, revision: 9, now: Date.now(), unseen: 0,
    counts: { running: 0, settled: 0, unseen: 0, failed: 0 }, running: [], settled: [], ui: num(),
  });
  check('clear: the badge leaves the page', await waitFor(`!document.getElementById('dsh-job-badge')`, 3000), true);
  check('clear: the title is restored', await waitFor(`document.title === 'dsh'`, 2000), true);

  /* 8. the loader the HOST injects mounts the badge (a different claim from the tag working) */
  push(twoRunning);
  await load(`http://127.0.0.1:${PORT}/injected.html`);
  check('injection: the badge mounts from the real injected row', await waitFor(`Boolean(document.querySelector('#dsh-job-badge .jb-chip'))`, 4000), true);
  r = await evaluate(READ);
  check('injection: the shell is untouched', await evaluate(`document.getElementById('shell-marker').textContent`), 'shell intact');
  ok('injection: it counts the same jobs', /^2$/.test(r.chip), `chip text was ${JSON.stringify(r.chip)}`);
  check('injection: the loader tag is unique', await evaluate(`document.querySelectorAll('#dsh-job-badge-loader').length`), 1);
  check('injection: the injected route is the one the Host served', await evaluate(`fetch(${JSON.stringify(injection.uiRoute)}).then(r => r.status)`), 200);

  /* 9. a second injection of the same loader must not stack a second badge */
  await evaluate(`(() => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(injection.text)}; document.body.appendChild(s); })()`);
  await evaluate(`(() => { const s = document.createElement('script'); s.src = ${JSON.stringify(injection.uiRoute)}; document.body.appendChild(s); })()`);
  await sleep(1200);
  r = await evaluate(READ);
  check('injection: still one badge root', r.roots, 1);
  check('injection: still one chip', r.chips, 1);
  check('injection: still one loader tag', await evaluate(`document.querySelectorAll('#dsh-job-badge-loader').length`), 1);
  check('injection: the title was not double-prefixed', r.title, 'dsh injected');

  /* 10. the DESKTOP shell's own application path: it does not parse the row into the document, it
   * creates a script element, assigns the row's text and appends it (Electron main -> frontend
   * `case "script"`). A row that only survived HTML parsing would pass step 8 and fail here. */
  push(twoRunning);
  await load(`http://127.0.0.1:${PORT}/plain.html`);
  check('desktop path: the badge is absent before the row is applied', await waitFor(`!document.getElementById('dsh-job-badge')`, 1500), true);
  await evaluate(`(() => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(injection.text)}; document.body.append(s); })()`);
  check('desktop path: the row mounts the badge when applied as a script element', await waitFor(`Boolean(document.querySelector('#dsh-job-badge .jb-chip'))`, 4000), true);
  r = await evaluate(READ);
  ok('desktop path: it counts the same jobs', /^2$/.test(r.chip), `chip text was ${JSON.stringify(r.chip)}`);

  /* 11. a MINIMIZED window: the badge is invisible then, so a settlement has to reach the OS. The
   * shell grants every non-media permission, so `new Notification(...)` is the channel; the page
   * must build it from the settled row and must stay silent when the mode says never. */
  await evaluate(`(() => {
    window.__toasts = [];
    window.Notification = function (title, options) {
      window.__toasts.push({ title: title, body: options && options.body, silent: options && options.silent, tag: options && options.tag });
    };
    return 'stubbed';
  })()`);
  const toastFrame = (id, label, notify, status) => ({
    available: true, revision: 40 + id.length, now: Date.now(), unseen: 1,
    counts: { running: 0, settled: 1, unseen: 1, failed: status === 'failed' ? 1 : 0 },
    running: [],
    settled: [{ id: id, kind: 'pwsh', label: label, status: status, startedAt: Date.now() - 65_000, finishedAt: Date.now(), detail: 'exit code: 0', unseen: true }],
    ui: num({ notify: notify }),
  });

  push(toastFrame('toast-1', 'npm run build', 'always', 'completed'));
  check('toast: a completion reaches the OS', await waitFor(`(window.__toasts || []).length === 1`, 3000), true);
  const toast = await evaluate(`JSON.stringify(window.__toasts[0])`);
  check('toast: it names the outcome', JSON.parse(toast).title, '后台任务完成');
  ok('toast: it carries the job label and duration', /npm run build/.test(JSON.parse(toast).body) && /1m05s/.test(JSON.parse(toast).body), toast);
  check('toast: it is silent, because the page already chimed', JSON.parse(toast).silent, true);
  check('toast: it is tagged so a newer completion replaces it', JSON.parse(toast).tag, 'dsh-job-badge');

  push(toastFrame('toast-2', 'failing thing', 'always', 'failed'));
  check('toast: a failure says so', await waitFor(`(window.__toasts || []).length === 2`, 3000), true);
  check('toast: the failure title', await evaluate(`window.__toasts[1].title`), '后台任务失败');

  push(toastFrame('toast-3', 'quiet thing', 'never', 'completed'));
  await sleep(1200);
  check('toast: notify=never stays silent', await evaluate(`(window.__toasts || []).length`), 2);

  console.log(`notice-render: ${pass} assertions passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} FAILED:`);
    for (const f of failures) console.error('  ✗ ' + f);
  }
  return failures.length;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('notice-render: harness error:', error?.message ?? error);
  code = 1;
} finally {
  if (code !== 0) {
    console.error(`\ncollected ${pass} passing assertion(s) before the stop`);
    if (failures.length > 0) {
      console.error(`--- ${failures.length} failed assertion(s) ---`);
      for (const f of failures) console.error('  ✗ ' + f);
    }
    if (pageLog.length > 0) {
      console.error('--- page log ---');
      for (const line of pageLog.slice(-10)) console.error('  ' + line);
    }
  }
  try { ws?.close(); } catch { /* ignore */ }
  try { edge.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(code);
