/**
 * dsh-job-badge — 后台任务提示图标（宿主半边）
 *
 * WHAT THIS IS
 *   DSH's background jobs (a `run_in_background` shell call, a background subagent) settle with no
 *   signal a person can see: the model gets its completion notice, the human gets nothing. This
 *   plugin mirrors the registry into a small badge in the corner of the page, counts what is still
 *   running, and turns into an unread badge plus a chime when something finishes.
 *
 * WHY THE HOST OWNS THE STATE
 *   `ctx.jobs.events` is the only global feed: subscribed with `{ owners: 'all' }` it reports every
 *   job in the process, whoever owns it. A page-side plugin could only see one session's roster, and
 *   the whole point of a background task is that you are looking somewhere else. So the host half
 *   keeps one tally, and the page is a renderer of it. Acknowledging is host state too, so two open
 *   windows cannot disagree about how many completions are unread.
 *
 * HOW THE PAGE GETS IT
 *   Two routes and one injected `<script>`, deliberately not a `dsh.client` half: a client module
 *   only loads from the module graph built at boot, so a bundle installed into a running Host never
 *   appears there until a restart. The injected script is an ordinary script served by this host
 *   half, so a page refresh is enough (see README for the measured detail).
 *     GET  /job-badge/state-<stamp>.json    the snapshot, for polling and for curl
 *     GET  /job-badge/stream-<stamp>        server-sent events: one frame per change
 *     POST /job-badge/ack-<stamp>.json      clear the unread count
 *     GET  /job-badge/ui-<stamp>.js         the badge itself, injected into index.html
 *
 * WHY EVERY ROUTE CARRIES A STAMP
 *   Re-registering a fixed path throws `webserver: duplicate undefined route`, and that error does
 *   not merely fail the new instance: the old one is left alive but orphaned outside the loader.
 *   The stamp is this file's own mtime, so a new generation is a new set of paths, and a second
 *   apply() of the same generation finds the stamp already mounted and does nothing at all.
 *
 * WHAT THIS FILE MUST NOT DO
 *   Job labels come from tool input, i.e. from the model. They travel to the page as JSON and are
 *   written with textContent only; nothing here or in notice.js ever builds HTML from a label.
 */
import fs from 'node:fs';

/** This file's own mtime, so a reload is a new generation of routes. */
const LOAD_STAMP = (() => {
  try { return String(Math.floor(fs.statSync(new URL('./index.js', import.meta.url)).mtimeMs)); }
  catch { return String(Date.now()); }
})();

const STATE_ROUTE = `/job-badge/state-${LOAD_STAMP}.json`;
const STREAM_ROUTE = `/job-badge/stream-${LOAD_STAMP}`;
const ACK_ROUTE = `/job-badge/ack-${LOAD_STAMP}.json`;
const UI_ROUTE = `/job-badge/ui-${LOAD_STAMP}.js`;

/** One owner per host: disposal or a failed activation releases it. */
const MOUNTED = new WeakMap();

/** Settled statuses. Anything else is still work in progress as far as the badge is concerned. */
const TERMINAL = new Set(['completed', 'killed', 'failed']);

export const inject = ['timer', 'webServer', 'jobs'];

/* ------------------------------------------------------------------ tracker */

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The tally, with no Cordis, no HTTP and no clock of its own beyond the injectable `now`.
 *
 * Kept separate from `apply` on purpose: this is where every rule that could be wrong lives
 * (what counts as running, what counts as unread, when a row is dropped), so it can be tested
 * exhaustively without a Host - see test/tracker-test.mjs.
 *
 * @param options.keepMs   how long a finished row stays listed
 * @param options.maxRows  hard cap on finished rows
 * @param options.now      clock, injectable for tests
 */
export function createTracker(options = {}) {
  const keepMs = Math.max(0, finite(options.keepMs, 30 * 60 * 1000));
  const maxRows = Math.max(1, Math.floor(finite(options.maxRows, 40)));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** id -> row, for jobs that are running or stopping. */
  const live = new Map();
  /** Settled rows, newest first. */
  const done = [];
  /** Settled ids the human has not looked at yet. */
  const unseen = new Set();
  let revision = 0;

  function project(view, extra) {
    const id = String(view.id);
    const row = {
      id,
      kind: typeof view.kind === 'string' && view.kind !== '' ? view.kind : 'task',
      label: typeof view.label === 'string' && view.label !== '' ? view.label : id,
      status: typeof view.status === 'string' && view.status !== '' ? view.status : 'running',
      startedAt: finite(view.startedAt, now()),
    };
    if (view.owner !== undefined && view.owner !== null && view.owner !== '') row.owner = String(view.owner);
    if (typeof view.progress === 'string' && view.progress !== '') row.progress = view.progress;
    if (typeof view.detail === 'string' && view.detail !== '') row.detail = view.detail;
    if (extra) Object.assign(row, extra);
    return row;
  }

  /** The two visible fields of a live row. A no-op progress tick must not wake the stream. */
  function sameLive(a, b) {
    return Boolean(a) && a.status === b.status && a.progress === b.progress
      && a.label === b.label && a.kind === b.kind;
  }

  /**
   * Drop aged and surplus rows. Returns true when something was actually dropped, because an
   * unchanged tally must not produce a frame.
   */
  function prune() {
    const cutoff = now() - keepMs;
    let changed = false;
    while (done.length > 0) {
      const last = done[done.length - 1];
      const tooOld = keepMs > 0 && finite(last.finishedAt, 0) < cutoff;
      if (!tooOld && done.length <= maxRows) break;
      done.pop();
      /* an id that is gone from the list must not survive in the unread count: the badge would
       * then claim more unread items than the panel can show */
      unseen.delete(last.id);
      changed = true;
    }
    return changed;
  }

  function settle(view, cause, awaited) {
    const row = project(view, { finishedAt: finite(view.finishedAt, now()) });
    if (cause !== undefined) row.cause = cause;
    else if (view.cause !== undefined) row.cause = view.cause;
    const at = done.findIndex((r) => r.id === row.id);
    if (at >= 0) done.splice(at, 1);
    done.unshift(row);
    live.delete(row.id);
    /*
     * WHO IS THIS NEWS FOR?
     *
     * `awaited` is the registry telling us that a caller was inside `jobs.wait()` when this settled
     * - in practice the FOREGROUND shell tool, which waits on its own process and then removes the
     * record. That result is surfacing in the conversation at this very moment, with a human looking
     * at it; counting it as unread is what made every tool call chime once. The registry publishes
     * the flag for exactly this purpose ("so a completion reporter can skip settlements a waiting
     * caller already collected"), so this is the rule, not a heuristic.
     *
     * A real background job has no waiter - the spawning tool returned immediately - so it arrives
     * with `awaited: false` and does light the badge. A `teardown` settlement has no reader left at
     * all: history, never a notification.
     */
    if (row.cause !== 'teardown' && awaited !== true) unseen.add(row.id);
    prune();
    revision++;
    return true;
  }

  return {
    /** Feed one `JobEvent`. Returns true when the visible tally changed. */
    ingest(event) {
      if (!event || typeof event !== 'object') return false;
      const type = event.type;
      /* output frames carry byte counters only; the badge shows durations, not byte totals */
      if (type === 'output') return false;
      const view = event.job;
      if (!view || view.id === undefined || view.id === null) return false;
      const id = String(view.id);

      if (type === 'settled') return settle(view, event.cause, event.awaited === true);

      if (type === 'registered' || type === 'progress' || type === 'stopping') {
        /* defensive: a lifecycle event that already carries a terminal status is a settlement */
        if (TERMINAL.has(view.status)) return settle(view, undefined);
        const row = project(view);
        if (sameLive(live.get(id), row)) return false;
        live.set(id, row);
        revision++;
        return true;
      }

      if (type === 'removed') {
        const wasLive = live.delete(id);
        const at = done.findIndex((r) => r.id === id);
        if (at >= 0) done.splice(at, 1);
        const wasUnseen = unseen.delete(id);
        if (!wasLive && at < 0 && !wasUnseen) return false;
        revision++;
        return true;
      }

      return false;
    },

    /**
     * Adopt jobs that were already in the registry when this plugin mounted (a live Host reload).
     * Running ones join the roster. Finished ones are history WITHOUT lighting the badge: the
     * human was never watching this collector, so it cannot claim they missed something.
     */
    seed(views) {
      let changed = false;
      for (const view of views || []) {
        if (!view || view.id === undefined || view.id === null) continue;
        const id = String(view.id);
        if (TERMINAL.has(view.status)) {
          if (done.some((r) => r.id === id)) continue;
          done.unshift(project(view, { finishedAt: finite(view.finishedAt, now()) }));
          changed = true;
        } else if (!live.has(id)) {
          live.set(id, project(view));
          changed = true;
        }
      }
      if (changed) { prune(); revision++; }
      return changed;
    },

    /** The human has seen the finished jobs. Returns true when the count actually moved. */
    acknowledge() {
      if (unseen.size === 0) return false;
      unseen.clear();
      revision++;
      return true;
    },

    /** Age rows out; the caller broadcasts when this reports a change. */
    sweep() {
      if (!prune()) return false;
      revision++;
      return true;
    },

    snapshot(ui) {
      const rows = [...live.values()];
      let failed = 0;
      for (const row of done) if (row.status === 'failed') failed++;
      return {
        available: true,
        revision,
        now: now(),
        unseen: unseen.size,
        counts: { running: rows.length, settled: done.length, unseen: unseen.size, failed },
        running: rows,
        settled: done.map((row) => Object.assign({}, row, { unseen: unseen.has(row.id) })),
        ui: ui || {},
      };
    },
  };
}

/* -------------------------------------------------------------- host wiring */

function minutes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function enumerable(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function apply(ctx, config) {
  const server = ctx.webServer;
  if (MOUNTED.has(server)) {
    ctx.logger?.info?.(`job-badge: generation ${LOAD_STAMP} already mounted, skipping re-apply`);
    return;
  }
  const owner = {};
  MOUNTED.set(server, owner);

  const settings = {
    keepMs: minutes(config?.keepMinutes, 30) * 60 * 1000,
    maxRows: clamp(config?.maxRows, 1, 200, 40),
    position: enumerable(config?.position, ['bottom-right', 'bottom-left', 'top-right', 'top-left'], 'bottom-right'),
    sound: enumerable(config?.sound, ['always', 'hidden', 'never'], 'always'),
    /*
     * Windows banners are OPT-IN and off by default, for a measured reason: on a machine whose
     * system notifications are switched off (`PushNotifications\ToastEnabled = 0`) a banner simply
     * never appears - not from this page, not from PowerShell either - so the badge, the taskbar
     * number and the chime are the channels that actually reach a person. Turn this on only where
     * system notifications are known to work; 'hidden' fires it when the window is not visible.
     */
    notify: enumerable(config?.notify, ['always', 'hidden', 'never'], 'never'),
    volume: clamp(config?.volume, 0, 1, 0.35),
    stream: config?.stream !== false,
  };
  const ui = {
    position: settings.position,
    sound: settings.sound,
    notify: settings.notify,
    volume: settings.volume,
    /*
     * The page polls at this cadence ALWAYS; the push channel only makes it faster. The desktop
     * shell serves the page through a custom scheme whose handler forwards to this server, so a
     * plain poll is the one delivery path no layer in between can break. 2.5s of a local JSON read
     * costs nothing, and a notification that actually arrives beats a quiet wire.
     */
    pollMs: 2500,
  };

  const tracker = createTracker({ keepMs: settings.keepMs, maxRows: settings.maxRows });
  const clients = new Set();
  const disposers = [];

  const cleanup = () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* a failed teardown must not stop the rest */ }
    }
    for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
    clients.clear();
    if (MOUNTED.get(server) === owner) MOUNTED.delete(server);
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  else ctx.on('dispose', cleanup);

  try {
    const register = (route) => disposers.push(server.register({ kind: 'exact', ...route }));
    const frame = () => `data: ${JSON.stringify(tracker.snapshot(ui))}\n\n`;

    const broadcast = () => {
      if (clients.size === 0) return;
      const body = frame();
      for (const res of clients) {
        try { res.write(body); } catch { clients.delete(res); }
      }
    };

    const onChange = () => { try { broadcast(); } catch { /* never break the Host from a listener */ } };

    /*
     * The global feed. `owners: 'all'` is the whole point - a badge that only saw the session in
     * front of you would be blind to the job you walked away from.
     */
    let unsubscribe = null;
    try {
      unsubscribe = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        try { if (tracker.ingest(event)) onChange(); } catch { /* ditto */ }
      });
    } catch (error) {
      ctx.logger?.warn?.(`job-badge: owners:'all' subscription refused, falling back to scope: ${error?.message ?? error}`);
      unsubscribe = ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
        try { if (tracker.ingest(event)) onChange(); } catch { /* ditto */ }
      });
    }
    disposers.push(unsubscribe);

    /*
     * Adopt what was already running. `list()` without a caller sees unowned jobs only, and almost
     * every job is session-owned, so the owners have to be enumerated and asked one by one. A
     * failure here costs history, never correctness - the event feed is the real source.
     */
    const views = [];
    try { views.push(...ctx.jobs.list()); } catch { /* no unowned jobs, or a list race */ }
    let agents = [];
    try { agents = ctx.get?.('agents')?.list?.() ?? []; } catch { /* optional dependency */ }
    for (const agent of agents) {
      try { views.push(...ctx.jobs.list(agent?.id)); } catch { /* foreign or gone */ }
    }
    const seen = new Set();
    tracker.seed(views.filter((view) => {
      const id = view?.id === undefined ? null : String(view.id);
      if (id === null || seen.has(id)) return false;
      seen.add(id);
      return true;
    }));

    register({
      method: 'GET',
      path: STATE_ROUTE,
      handler: (req, res) => {
        const body = JSON.stringify(tracker.snapshot(ui));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      },
    });

    if (settings.stream) {
      register({
        method: 'GET',
        path: STREAM_ROUTE,
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          try { res.flushHeaders?.(); } catch { /* not fatal: the first write flushes anyway */ }
          try { req.socket?.setNoDelay?.(true); } catch { /* best effort */ }
          clients.add(res);
          res.write('retry: 3000\n\n');
          res.write(frame());
          const drop = () => clients.delete(res);
          req.on('close', drop);
          req.on('error', drop);
          res.on('close', drop);
        },
      });
    }

    register({
      method: 'POST',
      path: ACK_ROUTE,
      handler: (req, res) => {
        /* the body is irrelevant; draining it is what lets the socket close cleanly */
        req.resume();
        req.on('end', () => {
          const moved = tracker.acknowledge();
          if (moved) onChange();
          const body = JSON.stringify({ ok: true, unseen: tracker.snapshot(ui).unseen });
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
        });
      },
    });

    /* Age rows out, and keep the push channel alive while nothing happens. */
    disposers.push(ctx.interval(() => {
      if (tracker.sweep()) onChange();
      for (const res of clients) {
        try { res.write(': ping\n\n'); } catch { clients.delete(res); }
      }
    }, 20000));

    let source = null;
    try {
      source = fs.readFileSync(new URL('./notice.js', import.meta.url), 'utf8');
    } catch (error) {
      ctx.logger?.warn?.(`job-badge: notice.js unreadable, no badge will appear: ${error?.message ?? error}`);
    }

    if (source !== null) {
      register({
        method: 'GET',
        path: UI_ROUTE,
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(source),
          });
          res.end(source);
        },
      });

      /*
       * The injected tag carries the routes, so the badge never hard-codes a path: a path written
       * into the page is a path that goes stale on the next generation (that mistake cost the
       * session-watch plugin a console full of 404s).
       */
      ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'script',
          placement: 'body',
          text: `(() => {
  const load = () => {
    if (document.getElementById('dsh-job-badge-loader')) return;
    const el = document.createElement('script');
    el.id = 'dsh-job-badge-loader';
    el.src = ${JSON.stringify(UI_ROUTE)};
    el.setAttribute('data-job-badge-state', ${JSON.stringify(STATE_ROUTE)});
    el.setAttribute('data-job-badge-stream', ${JSON.stringify(settings.stream ? STREAM_ROUTE : '')});
    el.setAttribute('data-job-badge-ack', ${JSON.stringify(ACK_ROUTE)});
    document.body.appendChild(el);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})()`,
        });
      });
    }

    ctx.logger?.info?.(
      `job-badge ready: ${STATE_ROUTE} · sound=${settings.sound} · position=${settings.position}`
      + ` · ${clients.size} page(s) attached at boot`,
    );
  } catch (error) {
    cleanup();
    throw error;
  }
}
