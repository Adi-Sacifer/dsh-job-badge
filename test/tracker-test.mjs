#!/usr/bin/env node
'use strict';
/*
 * tracker-test.mjs - the host half, without a Host.
 *
 * WHY
 *   Every rule that could be wrong lives in `createTracker` (what counts as running, what counts as
 *   unread, when a row is dropped), and the rest of index.js is wiring: four routes, one
 *   subscription, one injection row. Both halves are testable in-process, so they are tested here
 *   rather than discovered in the running app. What this file CANNOT prove is that the badge draws
 *   in a browser - test/notice-render.mjs covers that, and test/verify-live.mjs covers the installed
 *   copy talking to the running Host.
 *
 * Usage: node test/tracker-test.mjs
 */
import { apply, createTracker } from '../index.js';

/** The grace period is a real duration, so one case waits on the real clock instead of faking it. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  failures.push(`${label}\n      expected ${b}\n      got      ${a}`);
};
const ok = (label, condition) => check(label, Boolean(condition), true);

const view = (id, over) => Object.assign({
  id, kind: 'bash', label: `job ${id}`, status: 'running', startedAt: 1000,
}, over);

/* ------------------------------------------------------------------ tracker */

{
  const t = createTracker({ graceMs: 0, now: () => 5000 });

  check('registered: one running row', t.ingest({ type: 'registered', job: view('bash-1') }), true);
  let s = t.snapshot({});
  check('running count', s.counts.running, 1);
  check('unseen at start', s.unseen, 0);
  check('available flag', s.available, true);

  check('progress with an identical line is not a change',
    t.ingest({ type: 'progress', job: view('bash-1', { progress: 'step 1' }) }), true);
  check('the same progress line twice is a no-op',
    t.ingest({ type: 'progress', job: view('bash-1', { progress: 'step 1' }) }), false);
  check('a new progress line is a change',
    t.ingest({ type: 'progress', job: view('bash-1', { progress: 'step 2' }) }), true);
  check('progress survives into the snapshot', t.snapshot({}).running[0].progress, 'step 2');

  check('output frames are ignored', t.ingest({ type: 'output', id: 'bash-1', total: 999 }), false);

  check('settled is a change',
    t.ingest({ type: 'settled', cause: 'producer', job: view('bash-1', { status: 'completed', finishedAt: 4200, detail: 'exit 0' }) }), true);
  s = t.snapshot({});
  check('settled leaves the running set', s.counts.running, 0);
  check('settled is listed once', s.counts.settled, 1);
  check('settled raises the unread count', s.unseen, 1);
  check('settled row keeps its detail', s.settled[0].detail, 'exit 0');
  check('settled row is flagged unread', s.settled[0].unseen, true);
  check('duration is derivable from the row', s.settled[0].finishedAt - s.settled[0].startedAt, 3200);

  check('acknowledge moves the count', t.acknowledge(), true);
  check('unread cleared', t.snapshot({}).unseen, 0);
  check('acknowledging twice is a no-op', t.acknowledge(), false);
  check('the row stays listed after ack', t.snapshot({}).counts.settled, 1);
  check('the row is no longer flagged unread', t.snapshot({}).settled[0].unseen, false);
}

{
  /* a teardown settlement is history, not news */
  const t = createTracker({ graceMs: 0, now: () => 9000 });
  t.ingest({ type: 'registered', job: view('bash-9') });
  t.ingest({ type: 'settled', cause: 'teardown', job: view('bash-9', { status: 'killed', finishedAt: 8000 }) });
  const s = t.snapshot({});
  check('teardown settlement is listed', s.counts.settled, 1);
  check('teardown settlement does not light the badge', s.unseen, 0);
  check('teardown cause is recorded', s.settled[0].cause, 'teardown');
}

{
  /*
   * THE FALSE CHIME THAT STARTED THIS RULE. A foreground shell tool waits on its own job
   * (`registry.wait`) and removes the record right after, so the feed delivers
   * settled(awaited:true) + removed back to back. Counting the first as unread made the badge
   * chime once per tool call - the symptom a person actually hears.
   */
  const t = createTracker({ graceMs: 0, now: () => 5000 });
  t.ingest({ type: 'registered', job: view('fg-1') });
  check('a waited settlement is still ingested',
    t.ingest({ type: 'settled', cause: 'producer', awaited: true, job: view('fg-1', { status: 'completed', finishedAt: 4000 }) }), true);
  check('a waited settlement is history, not news', t.snapshot({}).unseen, 0);
  check('it is still listed while it lasts', t.snapshot({}).counts.settled, 1);
  check('the removal that follows leaves nothing behind',
    t.ingest({ type: 'removed', job: view('fg-1', { status: 'completed' }) }), true);
  check('and the badge never moved', t.snapshot({}).unseen, 0);

  /* the other side of the same rule: nobody was waiting -> it is news */
  const bg = createTracker({ graceMs: 0, now: () => 5000 });
  check('an unwatched settlement lights the badge',
    bg.ingest({ type: 'settled', cause: 'producer', awaited: false, job: view('bg-1', { status: 'completed', finishedAt: 4000 }) }), true);
  check('unwatched -> unread', bg.snapshot({}).unseen, 1);

  /* a feed that omits the flag entirely must not silence real completions */
  const legacy = createTracker({ graceMs: 0, now: () => 5000 });
  legacy.ingest({ type: 'settled', cause: 'producer', job: view('bg-2', { status: 'completed', finishedAt: 4000 }) });
  check('a missing awaited flag still counts as news', legacy.snapshot({}).unseen, 1);
}

{
  /* stopping is still running work */
  const t = createTracker({ graceMs: 0, now: () => 0 });
  t.ingest({ type: 'registered', job: view('bash-2') });
  t.ingest({ type: 'stopping', job: view('bash-2', { status: 'stopping' }) });
  check('stopping still counts as running', t.snapshot({}).counts.running, 1);
  check('stopping is visible on the row', t.snapshot({}).running[0].status, 'stopping');
}

{
  /* removal takes the id out of every list at once */
  const t = createTracker({ graceMs: 0, now: () => 0 });
  t.ingest({ type: 'registered', job: view('bash-3') });
  t.ingest({ type: 'settled', job: view('bash-3', { status: 'completed', finishedAt: 10 }) });
  check('removed is a change', t.ingest({ type: 'removed', job: view('bash-3', { status: 'completed' }) }), true);
  const s = t.snapshot({});
  check('removed leaves no finished row', s.counts.settled, 0);
  check('removed leaves no unread count', s.unseen, 0);
  check('removing an unknown id is not a change', t.ingest({ type: 'removed', job: view('nope') }), false);
}

{
  /* a terminal status arriving on a lifecycle event is still a settlement */
  const t = createTracker({ graceMs: 0, now: () => 0 });
  t.ingest({ type: 'registered', job: view('bash-4', { status: 'completed', finishedAt: 3 }) });
  const s = t.snapshot({});
  check('terminal-on-registered lands in settled', s.counts.settled, 1);
  check('terminal-on-registered counts as unread', s.unseen, 1);
}

{
  /*
   * THE GRACE PERIOD. The registry publishes no foreground/background flag at registration, so a
   * job that is over in a moment (a tool call) and one that will run for ten minutes (real
   * background work) look identical at birth. Waiting briefly is the only separator available.
   */
  let clock = 1000;
  const t = createTracker({ now: () => clock, graceMs: 2000 });
  check('a registration is held, not shown', t.ingest({ type: 'registered', job: view('held') }), false);
  check('nothing is counted as running yet', t.snapshot({}).counts.running, 0);
  check('it is waiting', t.hasPending(), true);
  check('a second identical registration is not a change', t.ingest({ type: 'registered', job: view('held') }), false);
  check('nothing promotes early', t.promoteDue(), false);
  clock += 1999;
  check('still nothing at 1999ms', t.promoteDue(), false);
  check('still not running', t.snapshot({}).counts.running, 0);
  clock += 2;
  check('it promotes once the grace has elapsed', t.promoteDue(), true);
  check('now it is running', t.snapshot({}).counts.running, 1);
  check('and nothing is waiting', t.hasPending(), false);
  check('promoting again is a no-op', t.promoteDue(), false);
}

{
  /* a foreground call that settles inside the grace period never appears at all */
  const clock = 1000;
  const t = createTracker({ now: () => clock, graceMs: 2000 });
  t.ingest({ type: 'registered', job: view('fg-fast') });
  check('the fast call is never counted as running', t.snapshot({}).counts.running, 0);
  t.ingest({ type: 'settled', cause: 'producer', awaited: true, job: view('fg-fast', { status: 'completed', finishedAt: 1100 }) });
  check('it lands in history instead', t.snapshot({}).counts.settled, 1);
  check('no pending entry is left behind', t.hasPending(), false);
  check('and it never rang', t.snapshot({}).unseen, 0);
}

{
  /* progress is the one thing the shell tool never reports, so it promotes at once */
  let clock = 1000;
  const t = createTracker({ now: () => clock, graceMs: 2000 });
  t.ingest({ type: 'registered', job: view('bg-progress') });
  check('held at first', t.snapshot({}).counts.running, 0);
  check('progress promotes immediately', t.ingest({ type: 'progress', job: view('bg-progress', { progress: 'step 1' }) }), true);
  check('visible now', t.snapshot({}).counts.running, 1);
  check('and no longer pending', t.hasPending(), false);
  check('the promoted row keeps its progress', t.snapshot({}).running[0].progress, 'step 1');
  clock += 5000;
  check('the promotion timer has nothing left to do', t.promoteDue(), false);
}

{
  /* grace off: the pre-grace behaviour, kept for anyone who wants it */
  const t = createTracker({ now: () => 1000, graceMs: 0 });
  check('grace off promotes at once', t.ingest({ type: 'registered', job: view('eager') }), true);
  check('and it is running immediately', t.snapshot({}).counts.running, 1);
  check('nothing is ever pending', t.hasPending(), false);
}

{
  /* a job that disappears while still pending must leave nothing behind */
  const t = createTracker({ now: () => 1000, graceMs: 2000 });
  t.ingest({ type: 'registered', job: view('gone') });
  check('removing a pending job is a change', t.ingest({ type: 'removed', job: view('gone') }), true);
  check('nothing pending', t.hasPending(), false);
  check('nothing running', t.snapshot({}).counts.running, 0);
  check('nothing listed', t.snapshot({}).counts.settled, 0);
}

{
  /* seeding is never delayed: those jobs have already been alive for an unknown while */
  const t = createTracker({ now: () => 1000, graceMs: 2000 });
  t.seed([view('adopted')]);
  check('a seeded job is running at once', t.snapshot({}).counts.running, 1);
  check('and never waits', t.hasPending(), false);
}

{
  /* the same id settling twice is one row, not two */
  const t = createTracker({ graceMs: 0, now: () => 0 });
  t.ingest({ type: 'settled', job: view('bash-5', { status: 'completed', finishedAt: 1 }) });
  t.ingest({ type: 'settled', job: view('bash-5', { status: 'failed', finishedAt: 2, detail: 'boom' }) });
  const s = t.snapshot({});
  check('a repeated settlement replaces the row', s.counts.settled, 1);
  check('the row keeps the newest status', s.settled[0].status, 'failed');
}

{
  /* ageing and the row cap, driven by an injectable clock */
  let clock = 1_000_000;
  const t = createTracker({ graceMs: 0, now: () => clock, keepMs: 60_000, maxRows: 3 });
  for (let i = 0; i < 5; i++) {
    t.ingest({ type: 'settled', job: view(`bash-${i}`, { status: 'completed', startedAt: clock - 500, finishedAt: clock }) });
  }
  check('maxRows caps the finished list', t.snapshot({}).counts.settled, 3);
  check('maxRows drops the oldest', t.snapshot({}).settled.map((r) => r.id), ['bash-4', 'bash-3', 'bash-2']);
  check('the dropped rows leave the unread count too', t.snapshot({}).unseen, 3);

  clock += 120_000;   /* older than keepMs */
  check('sweep reports the change', t.sweep(), true);
  check('aged rows are gone', t.snapshot({}).counts.settled, 0);
  check('aged unread is gone with them', t.snapshot({}).unseen, 0);
  check('a second sweep is quiet', t.sweep(), false);
}

{
  /* seeding: running adopted, finished adopted as history without lighting the badge */
  const t = createTracker({ graceMs: 0, now: () => 7000 });
  t.seed([
    view('bash-a'),
    view('bash-b', { status: 'completed', finishedAt: 6000, detail: 'exit 0' }),
    view('bash-a'),   /* duplicate id must not double-count */
  ]);
  const s = t.snapshot({});
  check('seed adopts the running job', s.counts.running, 1);
  check('seed adopts the finished job', s.counts.settled, 1);
  check('seed does not claim the human missed it', s.unseen, 0);
  check('seeding the same set again is a no-op', t.seed([view('bash-a')]), false);
}

{
  /* malformed input must not throw: the feed is a Host boundary */
  const t = createTracker({ graceMs: 0 });
  check('null event', t.ingest(null), false);
  check('event without a job', t.ingest({ type: 'registered' }), false);
  check('unknown event type', t.ingest({ type: 'whatever', job: view('x') }), false);
  check('a view with no usable fields still lands', t.ingest({ type: 'registered', job: { id: 'bare' } }), true);
  const row = t.snapshot({}).running[0];
  check('bare row gets a kind default', row.kind, 'task');
  check('bare row gets a label default', row.label, 'bare');
  check('bare row gets a status default', row.status, 'running');
  ok('bare row gets a numeric start', Number.isFinite(row.startedAt));
}

{
  /* the ui block is passed through untouched: the page reads its settings from one frame */
  const t = createTracker({ graceMs: 0 });
  const ui = { position: 'top-left', sound: 'never', volume: 0.1, pollMs: 2000 };
  check('ui passthrough', t.snapshot(ui).ui, ui);
  check('ui defaults to an empty object', createTracker({ graceMs: 0 }).snapshot().ui, {});
}

/* --------------------------------------------------------------- apply() */

function fakeHost(options = {}) {
  const routes = [];
  const injections = [];
  const listeners = [];
  const effects = [];
  const timers = [];
  const mounts = [];
  const logs = [];
  const service = {
    webServer: {
      register(route) {
        if (routes.some((r) => r.method === route.method && r.path === route.path)) {
          throw new Error('webserver: duplicate undefined route');
        }
        routes.push(route);
        return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); };
      },
    },
    jobs: {
      events: {
        subscribe(filter, listener) {
          listeners.push({ filter, listener });
          return () => { const at = listeners.findIndex((l) => l.listener === listener); if (at >= 0) listeners.splice(at, 1); };
        },
      },
      list(caller) { return typeof options.list === 'function' ? options.list(caller) : []; },
    },
    interval(callback, ms) {
      const entry = { callback, ms };
      timers.push(entry);
      return () => { const at = timers.indexOf(entry); if (at >= 0) timers.splice(at, 1); };
    },
    on(name, listener) { mounts.push({ name, listener }); return () => {}; },
    effect(callback) { effects.push(callback); const disposer = callback(); return disposer; },
    get(name) { return name === 'agents' ? (options.agents ?? { list: () => [{ id: 'sess-1' }] }) : undefined; },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  };
  return { service, routes, injections, listeners, effects, timers, mounts, logs };
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    write(chunk) { this.body += chunk; return true; },
    end(chunk) { if (chunk) this.body += chunk; this.ended = true; },
    /* a real ServerResponse is an EventEmitter; the stream handler listens for 'close' */
    on() { return this; },
  };
}

{
  const host = fakeHost();
  /* graceMs 0 here: this block is about routes, frames and acks, so a registration has to count at
   * once. The grace period has its own block further down. */
  apply(host.service, { position: 'top-left', sound: 'hidden', volume: 0.2, keepMinutes: 5, maxRows: 7, graceMs: 0 });

  check('four routes registered', host.routes.length, 4);
  const paths = host.routes.map((r) => r.path).sort();
  ok('every route carries the load stamp', paths.every((p) => /-\d+/.test(p)));
  check('state route is a GET json route', host.routes.some((r) => r.method === 'GET' && /\/job-badge\/state-\d+\.json$/.test(r.path)), true);
  check('stream route exists', host.routes.some((r) => r.method === 'GET' && /\/job-badge\/stream-\d+$/.test(r.path)), true);
  check('ack route is a POST', host.routes.some((r) => r.method === 'POST' && /\/job-badge\/ack-\d+\.json$/.test(r.path)), true);
  check('ui route serves javascript', host.routes.some((r) => r.method === 'GET' && /\/job-badge\/ui-\d+\.js$/.test(r.path)), true);

  check('one jobs subscription', host.listeners.length, 1);
  check('the subscription is the global feed', host.listeners[0].filter, { owners: 'all' });
  check('one injection hook', host.mounts.filter((m) => m.name === 'webserver/index-inject').length, 1);
  check('one heartbeat timer', host.timers.length, 1);
  ok('heartbeat is longer than the sweep age', host.timers[0].ms >= 5000);

  /* mount it and read the state route */
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const res = fakeRes();
  state.handler({ method: 'GET' }, res);
  check('state route answers 200', res.status, 200);
  check('state route is uncacheable', res.headers['cache-control'], 'no-store');
  const first = JSON.parse(res.body);
  check('state starts with nothing', first.counts, { running: 0, settled: 0, unseen: 0, failed: 0 });
  check('state carries the configured ui', first.ui, { position: 'top-left', sound: 'hidden', notify: 'never', volume: 0.2, pollMs: 2500 });

  /* the injection row */
  const table = [];
  host.mounts.find((m) => m.name === 'webserver/index-inject').listener(table);
  check('one injection row', table.length, 1);
  check('the row is a body script', [table[0].kind, table[0].placement], ['script', 'body']);
  const uiPath = host.routes.find((r) => /ui-\d+\.js$/.test(r.path)).path;
  const streamPath = host.routes.find((r) => /stream-\d+$/.test(r.path)).path;
  const ackPath = host.routes.find((r) => /ack-\d+\.json$/.test(r.path)).path;
  ok('the injected loader points at the served script', table[0].text.includes(uiPath));
  ok('the loader passes the state route', table[0].text.includes(state.path));
  ok('the loader passes the stream route', table[0].text.includes(streamPath));
  ok('the loader passes the ack route', table[0].text.includes(ackPath));
  ok('the loader is idempotent in the page', table[0].text.includes('dsh-job-badge-loader'));

  /* an event reaches the state route AND one push frame reaches the attached page */
  const stream = host.routes.find((r) => /stream-\d+$/.test(r.path));
  const streamRes = fakeRes();
  const req = { on() {}, socket: { setNoDelay() {} } };
  stream.handler(req, streamRes);
  check('stream answers 200', streamRes.status, 200);
  check('stream is an event stream', streamRes.headers['content-type'], 'text/event-stream; charset=utf-8');
  check('stream asks the client to retry', streamRes.body.startsWith('retry: 3000\n\n'), true);
  check('stream opens with a frame', streamRes.body.split('data: ').length - 1, 1);

  const listener = host.listeners[0].listener;
  /* real timestamps: keepMinutes ages rows against the wall clock, so a 1970 fixture would be
   * pruned inside the same call that created it and the assertions below would be vacuous */
  const at = Date.now();
  listener({ type: 'registered', job: { id: 'bash-1', kind: 'bash', label: 'npm run build', status: 'running', startedAt: at - 1000 } });
  listener({ type: 'settled', cause: 'producer', job: { id: 'bash-1', kind: 'bash', label: 'npm run build', status: 'completed', startedAt: at - 1000, finishedAt: at, detail: 'exit 0' } });
  check('the push channel carried both changes', streamRes.body.split('data: ').length - 1, 3);

  const res2 = fakeRes();
  state.handler({ method: 'GET' }, res2);
  const second = JSON.parse(res2.body);
  check('state reflects the settlement', second.unseen, 1);
  check('state lists the settled row', second.settled.length, 1);
  check('the settled row is unread', second.settled[0].unseen, true);

  /* the ack route clears it, and says so */
  const ackRes = fakeRes();
  ackPath;   /* the route object is found by path below */
  const ackRoute = host.routes.find((r) => r.method === 'POST');
  ackRoute.handler({ resume() {}, on(name, fn) { if (name === 'end') fn(); } }, ackRes);
  check('ack answers 200', ackRes.status, 200);
  check('ack reports zero unread', JSON.parse(ackRes.body).unseen, 0);
  const res3 = fakeRes();
  state.handler({}, res3);
  check('the state route agrees', JSON.parse(res3.body).unseen, 0);

  /* a heartbeat tick pings the page and sweeps */
  const ticks = host.timers[0];
  const before = streamRes.body.length;
  ticks.callback();
  ok('the heartbeat wrote a ping', streamRes.body.length > before && streamRes.body.indexOf(': ping') >= 0);

  /* a second apply of the same generation is a complete no-op */
  const routesBefore = host.routes.length;
  apply(host.service, {});
  check('a re-apply registers nothing', host.routes.length, routesBefore);
  ok('a re-apply says so', host.logs.some((m) => String(m).includes('already mounted')));

  /* disposing releases the mount, so a later generation can take over.
   * A cordis effect calls the callback now and the RETURNED function at disposal. */
  const disposer = host.effects[0]();
  check('the effect returned the cleanup', typeof disposer, 'function');
  disposer();
  check('cleanup unregistered every route', host.routes.length, 0);
  check('cleanup closed the attached page', streamRes.ended, true);
  check('cleanup unsubscribed from jobs', host.listeners.length, 0);

  const replay = fakeHost();
  apply(replay.service, {});
  check('a fresh host can mount after cleanup', replay.routes.length, 4);
}

{
  /* seeding from the live registry walks the owners, because list() alone sees unowned jobs */
  const now = Date.now();
  const host = fakeHost({
    list: (caller) => (caller === undefined
      ? [{ id: 'unowned-1', kind: 'bash', label: 'unowned', status: 'running', startedAt: now - 100 }]
      : [{ id: 'owned-1', kind: 'bash', label: 'owned', status: 'running', startedAt: now - 200 },
        { id: 'owned-2', kind: 'subagent', label: 'child', status: 'completed', startedAt: now - 900, finishedAt: now - 500 }]),
    agents: { list: () => [{ id: 'sess-1' }, { id: 'sess-2' }] },
  });
  apply(host.service, {});
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const res = fakeRes();
  state.handler({}, res);
  const snapshot = JSON.parse(res.body);
  /* two sessions report the same pair, so the ids must be de-duplicated, not counted twice */
  check('seeded running jobs', snapshot.counts.running, 2);
  check('seeded finished job', snapshot.counts.settled, 1);
  check('seeded history is not unread', snapshot.unseen, 0);
}

{
  /* stream:false leaves polling only, and the injection must not advertise a dead route */
  const host = fakeHost();
  apply(host.service, { stream: false });
  check('no stream route when the channel is off', host.routes.some((r) => /stream-\d+$/.test(r.path)), false);
  const table = [];
  host.mounts.find((m) => m.name === 'webserver/index-inject').listener(table);
  ok('the loader passes an empty stream attribute', table[0].text.includes("setAttribute('data-job-badge-stream', \"\")"));
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const res = fakeRes();
  state.handler({}, res);
  check('polling is fast without a push channel', JSON.parse(res.body).ui.pollMs, 2500);
}

{
  /* a bad config must not break the mount: every knob has a safe landing */
  const host = fakeHost();
  apply(host.service, { keepMinutes: 'soon', maxRows: -4, position: 'middle', sound: 'loud', notify: 'maybe', volume: 9, stream: 'yes' });
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const res = fakeRes();
  state.handler({}, res);
  const ui = JSON.parse(res.body).ui;
  check('bad position falls back', ui.position, 'bottom-right');
  check('bad sound falls back', ui.sound, 'always');
  check('bad notify falls back to off', ui.notify, 'never');
  check('out-of-range volume is clamped', ui.volume, 1);
  check('a truthy non-boolean keeps the stream', ui.pollMs, 2500);
}

{
  /* ui route: the served bytes are notice.js itself */
  const host = fakeHost();
  apply(host.service, {});
  const uiRoute = host.routes.find((r) => /ui-\d+\.js$/.test(r.path));
  const res = fakeRes();
  uiRoute.handler({}, res);
  ok('the ui route serves the badge source', res.body.includes('data-job-badge-state'));
  ok('the served source is not a stale copy', res.body.includes('__dshJobBadge'));
}

{
  /*
   * The promotion timer as the Host runs it: armed by a registration, alive only while something
   * waits, disarmed the moment nothing does. A timer that ran forever would wake an idle Host four
   * times a second for nothing.
   */
  const host = fakeHost();
  apply(host.service, { graceMs: 60 });
  const listener = host.listeners[0].listener;
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const read = () => { const res = fakeRes(); state.handler({}, res); return JSON.parse(res.body); };
  const fastTimer = () => host.timers.find((timer) => timer.ms < 1000);

  check('an idle Host runs no fast timer', Boolean(fastTimer()), false);
  listener({ type: 'registered', job: { id: 'held-1', kind: 'pwsh', label: 'a tool call', status: 'running', startedAt: Date.now() } });
  check('a fresh registration is not counted as running', read().counts.running, 0);
  ok('the registration armed a promotion timer', Boolean(fastTimer()));
  await sleep(90);
  fastTimer().callback();
  check('after the grace it is counted', read().counts.running, 1);
  check('and the timer disarmed itself', Boolean(fastTimer()), false);
  check('the 20s heartbeat never stopped', host.timers.some((timer) => timer.ms === 20000), true);

  /* a job that reports progress skips the wait entirely */
  listener({ type: 'progress', job: { id: 'bg-9', kind: 'subagent', label: 'child', status: 'running', startedAt: Date.now(), progress: 'working' } });
  check('progress is visible immediately', read().counts.running, 2);
  check('progress needed no timer', Boolean(fastTimer()), false);
}

{
  /* the timer only ever exists while something waits, so a listener that registers and settles a
   * fast job leaves the Host with no fast timer at all */
  const host = fakeHost();
  apply(host.service, { graceMs: 60 });
  const listener = host.listeners[0].listener;
  listener({ type: 'registered', job: { id: 'quick', kind: 'pwsh', label: 'echo', status: 'running', startedAt: Date.now() } });
  listener({ type: 'settled', cause: 'producer', awaited: true, job: { id: 'quick', kind: 'pwsh', label: 'echo', status: 'completed', startedAt: Date.now(), finishedAt: Date.now() } });
  listener({ type: 'removed', job: { id: 'quick', kind: 'pwsh', label: 'echo', status: 'completed', startedAt: Date.now() } });
  const state = host.routes.find((r) => /state-\d+\.json$/.test(r.path));
  const res = fakeRes();
  state.handler({}, res);
  const snapshot = JSON.parse(res.body);
  check('a tool call that came and went leaves nothing running', snapshot.counts.running, 0);
  check('and nothing unread', snapshot.unseen, 0);
  check('and nothing listed', snapshot.counts.settled, 0);
  ok('and no fast timer was armed', host.timers.every((timer) => timer.ms === 20000));
}

console.log(`tracker-test: ${pass} assertions passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
