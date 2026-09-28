/**
 * dsh-job-badge — the badge itself (browser half).
 *
 * WHY PLAIN DOM AND NOT A MODULE-LOADER CLIENT
 *   A `dsh.client` half loads only if the browser's module graph already knows the package, and that
 *   graph is built at boot: a bundle installed into a running Host never appears there until a
 *   restart. This file needs nothing from that graph - the host half serves it and injects one
 *   `<script>` row into index.html, so a page refresh is enough.
 *
 * WHY A PUSH CHANNEL AND NOT ONLY POLLING
 *   The whole point is that the window is in the background when the job finishes, and a hidden
 *   Chromium page throttles timers (to roughly one wake-up a minute under intensive throttling).
 *   A server-sent event arrives as a network message, which the renderer still handles immediately,
 *   so the chime lands on time. Polling stays as the safety net: it paints the first state and it
 *   covers a stream that dies quietly.
 *
 * WHY NOTHING IS BUILT FROM A JOB LABEL
 *   Labels come from tool input, i.e. from the model. Every string below reaches the DOM through
 *   `textContent`; there is no innerHTML anywhere in this file, by design.
 */
(function () {
  'use strict';

  var HERE = document.currentScript;
  var STATE_URL = (HERE && HERE.getAttribute('data-job-badge-state')) || null;
  var STREAM_URL = (HERE && HERE.getAttribute('data-job-badge-stream')) || '';
  var ACK_URL = (HERE && HERE.getAttribute('data-job-badge-ack')) || null;
  if (!STATE_URL) return;   /* no route to read: stay out of the way rather than guess a path */

  var ROOT_ID = 'dsh-job-badge';
  var STYLE_ID = 'dsh-job-badge-style';
  var MUTE_KEY = 'dsh-job-badge.muted';
  /** Fallback cadence when a frame does not carry one; the host sends its own in `ui.pollMs`. */
  var POLL_MS = 2500;

  /* ------------------------------------------------------------------ text */

  var ZH = (function () {
    try { return String(navigator.language || '').toLowerCase().indexOf('zh') === 0; } catch (e) { return false; }
  })();

  var TEXT = ZH ? {
    label: '后台任务',
    runningOne: '1 个在跑',
    runningMany: '{n} 个在跑',
    unreadOne: '1 个刚结束',
    unreadMany: '{n} 个刚结束',
    running: '进行中',
    settled: '已结束',
    ack: '全部已读',
    close: '收起',
    empty: '没有后台任务',
    soundOn: '提示音：开',
    soundOff: '提示音：关',
    stRunning: '运行中',
    stStopping: '停止中',
    stCompleted: '已完成',
    stKilled: '已取消',
    stFailed: '失败',
    ago: '{n}前完成',
    justNow: '刚刚完成',
    minutes: '{n} 分钟',
    hours: '{n} 小时',
    stale: '读不到后台任务状态，正在重试',
    toastDone: '后台任务完成',
    toastFailed: '后台任务失败',
    toastMany: '{n} 个后台任务已结束',
    toastTook: '耗时 {d}',
    toastMore: '（还有 {n} 个）',
  } : {
    label: 'Background tasks',
    runningOne: '1 running',
    runningMany: '{n} running',
    unreadOne: '1 finished',
    unreadMany: '{n} finished',
    running: 'Running',
    settled: 'Finished',
    ack: 'Mark read',
    close: 'Collapse',
    empty: 'No background tasks',
    soundOn: 'Sound: on',
    soundOff: 'Sound: off',
    stRunning: 'running',
    stStopping: 'stopping',
    stCompleted: 'completed',
    stKilled: 'cancelled',
    stFailed: 'failed',
    ago: 'finished {n} ago',
    justNow: 'finished just now',
    minutes: '{n}m',
    hours: '{n}h',
    stale: 'Cannot read task state, retrying',
    toastDone: 'Background task completed',
    toastFailed: 'Background task failed',
    toastMany: '{n} background tasks finished',
    toastTook: 'took {d}',
    toastMore: ' (+{n} more)',
  };

  function t(key, vars) {
    var raw = TEXT[key] || key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, function (all, name) {
      return vars[name] === undefined ? all : String(vars[name]);
    });
  }

  /* --------------------------------------------------------------- helpers */

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'text') el.textContent = String(value);
        else if (key === 'class') el.className = value;
        else if (key === 'style') el.setAttribute('style', value);
        else if (key.indexOf('on') === 0 && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'id' || key === 'role' || key === 'title'
          || key.indexOf('aria') === 0 || key.indexOf('data-') === 0) el.setAttribute(key, String(value));
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        for (var j = 0; j < child.length; j++) if (child[j]) el.appendChild(child[j]);
      } else if (typeof child === 'string' || typeof child === 'number') {
        /* text goes in as a text node: appendChild(String) throws, and every label here is
         * model-authored, so building markup from it is exactly what must not happen */
        el.appendChild(document.createTextNode(String(child)));
      } else el.appendChild(child);
    }
    return el;
  }

  function fmtDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    var r = s % 60;
    if (m < 60) return m + 'm' + (r < 10 ? '0' + r : r) + 's';
    var hours = Math.floor(m / 60);
    var mm = m % 60;
    return hours + 'h' + (mm < 10 ? '0' + mm : mm) + 'm';
  }

  function statusText(status) {
    if (status === 'completed') return t('stCompleted');
    if (status === 'failed') return t('stFailed');
    if (status === 'killed') return t('stKilled');
    if (status === 'stopping') return t('stStopping');
    return t('stRunning');
  }

  function statusColor(status) {
    if (status === 'completed') return 'var(--dsw-alias-state-success-primary,#2ea043)';
    if (status === 'failed') return 'var(--dsw-alias-state-error-primary,#d9534f)';
    if (status === 'killed') return 'var(--dsw-alias-state-idle-primary,#8a8f98)';
    if (status === 'stopping') return 'var(--dsw-alias-state-warn-primary,#e8a33d)';
    return 'var(--dsw-alias-brand-primary,#4d6bfe)';
  }

  function statusGlyph(status) {
    if (status === 'completed') return '✓';
    if (status === 'failed') return '!';
    if (status === 'killed') return '×';
    return '·';
  }

  function isLive(status) {
    return status !== 'completed' && status !== 'failed' && status !== 'killed';
  }

  /** A real spinner: a rotating '◌' is symmetrical enough to look static. */
  function spinner(color) {
    return h('span', { class: 'jb-spin', 'aria-hidden': 'true', style: 'border-top-color:' + color });
  }

  function readMuted() {
    try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }

  function writeMuted(value) {
    try { window.localStorage.setItem(MUTE_KEY, value ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  /* ----------------------------------------------------------------- styles */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '#' + ROOT_ID + '{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;' +
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;align-items:flex-end;pointer-events:none}' +
      '#' + ROOT_ID + ' *{box-sizing:border-box}' +
      '#' + ROOT_ID + ' .jb-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;' +
      'padding:6px 10px;border-radius:999px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary,#111);' +
      'background:var(--dsw-alias-bg-overlay,rgba(30,30,32,.96));' +
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));box-shadow:0 4px 16px rgba(0,0,0,.28)}' +
      '#' + ROOT_ID + ' .jb-chip:hover{border-color:var(--dsw-alias-label-secondary,rgba(127,127,127,.6))}' +
      '#' + ROOT_ID + ' .jb-chip[data-unread="1"]{border-color:var(--dsw-alias-state-success-primary,#2ea043)}' +
      '#' + ROOT_ID + ' .jb-chip[data-stale="1"]{opacity:.55}' +
      '#' + ROOT_ID + ' .jb-glyph{display:inline-block;line-height:1;font-size:13px}' +
      '#' + ROOT_ID + ' .jb-spin{display:inline-block;width:11px;height:11px;border-radius:50%;' +
      'border:1.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);' +
      'animation:jb-spin .8s linear infinite;vertical-align:-1px}' +
      '#' + ROOT_ID + ' .jb-count{font-variant-numeric:tabular-nums}' +
      '#' + ROOT_ID + ' .jb-sep{opacity:.4}' +
      '#' + ROOT_ID + ' .jb-unread{color:var(--dsw-alias-state-success-primary,#2ea043);font-weight:600}' +
      '#' + ROOT_ID + ' .jb-pulse{animation:jb-pop .45s ease-out,jb-halo 1.4s ease-out 3}' +
      '#' + ROOT_ID + ' .jb-panel{pointer-events:auto;width:320px;max-width:min(320px,calc(100vw - 36px));' +
      'max-height:min(60vh,420px);display:flex;flex-direction:column;overflow:hidden;border-radius:10px;' +
      'color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-layer-1,rgba(32,32,34,.98));' +
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));box-shadow:0 10px 30px rgba(0,0,0,.35)}' +
      '#' + ROOT_ID + ' .jb-head{display:flex;align-items:center;gap:8px;padding:8px 10px;' +
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}' +
      '#' + ROOT_ID + ' .jb-title{font-weight:600}' +
      '#' + ROOT_ID + ' .jb-sub{color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}' +
      '#' + ROOT_ID + ' .jb-spacer{flex:1}' +
      '#' + ROOT_ID + ' button.jb-mini{font:inherit;cursor:pointer;border-radius:6px;padding:2px 6px;' +
      'background:transparent;border:0;color:var(--dsw-alias-label-secondary,#6b7280)}' +
      '#' + ROOT_ID + ' button.jb-mini:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));' +
      'color:var(--dsw-alias-label-primary,#111)}' +
      '#' + ROOT_ID + ' .jb-body{overflow:auto;padding:4px 6px 6px}' +
      '#' + ROOT_ID + ' .jb-section{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;' +
      'padding:6px 4px 2px;text-transform:none}' +
      '#' + ROOT_ID + ' .jb-row{display:grid;grid-template-columns:14px 1fr auto;gap:2px 6px;' +
      'padding:4px;border-radius:6px}' +
      '#' + ROOT_ID + ' .jb-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}' +
      '#' + ROOT_ID + ' .jb-rowglyph{line-height:1.5;text-align:center}' +
      '#' + ROOT_ID + ' .jb-rowlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#' + ROOT_ID + ' .jb-rowmeta{color:var(--dsw-alias-label-secondary,#6b7280);' +
      'font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '#' + ROOT_ID + ' .jb-rowdetail{grid-column:2 / 4;color:var(--dsw-alias-label-secondary,#6b7280);' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}' +
      '#' + ROOT_ID + ' .jb-empty{color:var(--dsw-alias-label-secondary,#6b7280);padding:10px 6px}' +
      '#' + ROOT_ID + ' .jb-foot{display:flex;align-items:center;gap:8px;padding:6px 10px;' +
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}' +
      '@keyframes jb-spin{to{transform:rotate(360deg)}}' +
      '@keyframes jb-pop{0%{transform:scale(.86)}60%{transform:scale(1.07)}100%{transform:scale(1)}}' +
      '@keyframes jb-halo{0%{box-shadow:0 0 0 0 rgba(46,160,67,.5)}100%{box-shadow:0 0 0 14px rgba(46,160,67,0)}}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ----------------------------------------------------------- state + view */

  var state = {
    data: null,
    open: false,
    muted: readMuted(),
    armed: false,
    skew: 0,
    pageStart: Date.now(),
    chimed: {},
    lastChimeAt: 0,
    failures: 0,
    stale: false,
  };

  var root = null;
  var panelEl = null;
  var chipEl = null;
  var liveTimer = null;

  function hostNow() { return Date.now() - state.skew; }

  function destroyRoot() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    panelEl = null;
    chipEl = null;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function ensureRoot() {
    ensureStyles();
    if (root && root.parentNode) return root;
    root = h('div', { id: ROOT_ID });
    var position = (state.data && state.data.ui && state.data.ui.position) || 'bottom-right';
    var vertical = position.indexOf('top') === 0 ? 'top:18px;' : 'bottom:18px;';
    var horizontal = position.indexOf('left') >= 0 ? 'left:18px;align-items:flex-start;' : 'right:18px;';
    root.setAttribute('style', vertical + horizontal);
    document.body.appendChild(root);
    /* the panel sits on the side the chip is not: above a bottom chip, below a top chip */
    var panelFirst = position.indexOf('top') !== 0;
    panelEl = buildPanel();
    chipEl = buildChip();
    if (panelFirst) { root.appendChild(panelEl); root.appendChild(chipEl); }
    else { root.appendChild(chipEl); root.appendChild(panelEl); }
    return root;
  }

  function summarize() {
    var d = state.data;
    var running = d ? d.counts.running : 0;
    var unseen = d ? d.unseen : 0;
    var parts = [];
    if (running > 0) parts.push(t(running === 1 ? 'runningOne' : 'runningMany', { n: running }));
    if (unseen > 0) parts.push(t(unseen === 1 ? 'unreadOne' : 'unreadMany', { n: unseen }));
    return parts.join(' · ');
  }

  function buildChip() {
    var chip = h('button', {
      class: 'jb-chip',
      type: 'button',
      'aria-expanded': 'false',
      title: t('label'),
    });
    chip.addEventListener('click', function (event) {
      event.stopPropagation();
      togglePanel();
    });
    return chip;
  }

  function paintChip() {
    if (!chipEl) return;
    var d = state.data;
    var running = d ? d.counts.running : 0;
    var unseen = d ? d.unseen : 0;
    chipEl.textContent = '';
    chipEl.setAttribute('data-unread', unseen > 0 ? '1' : '0');
    chipEl.setAttribute('data-stale', state.stale ? '1' : '0');
    chipEl.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    chipEl.setAttribute('aria-label', t('label') + (summarize() ? '：' + summarize() : ''));
    chipEl.title = (state.stale ? t('stale') + ' · ' : '') + t('label') + (summarize() ? '：' + summarize() : '');

    if (running > 0) {
      chipEl.appendChild(spinner(statusColor('running')));
      chipEl.appendChild(h('span', { class: 'jb-count' }, String(running)));
    }
    if (running > 0 && unseen > 0) chipEl.appendChild(h('span', { class: 'jb-sep' }, '·'));
    if (unseen > 0) {
      chipEl.appendChild(h('span', { class: 'jb-glyph jb-unread', 'aria-hidden': 'true' }, '✓'));
      chipEl.appendChild(h('span', { class: 'jb-count jb-unread' }, String(unseen)));
    }
    if (state.open) chipEl.appendChild(h('span', { class: 'jb-glyph', 'aria-hidden': 'true', style: 'opacity:.55' }, '▾'));
  }

  function flagPulse() {
    if (!chipEl) return;
    chipEl.classList.remove('jb-pulse');
    /* restart the animation: reading offsetWidth forces a reflow between the two states */
    void chipEl.offsetWidth;
    chipEl.classList.add('jb-pulse');
    window.setTimeout(function () { if (chipEl) chipEl.classList.remove('jb-pulse'); }, 4200);
  }

  function buildRow(row, settled) {
    var live = isLive(row.status);
    var glyph = live
      ? spinner(statusColor(row.status))
      : h('span', { class: 'jb-glyph', style: 'color:' + statusColor(row.status), 'aria-hidden': 'true' }, statusGlyph(row.status));

    var label = h('span', { class: 'jb-rowlabel', title: row.label }, row.label);
    var started = Number(row.startedAt) || hostNow();
    var meta = settled
      ? statusText(row.status) + ' · ' + fmtDuration((Number(row.finishedAt) || started) - started)
      : statusText(row.status) + ' · ' + fmtDuration(hostNow() - started);

    var detailText = settled
      ? [row.kind, row.detail].filter(Boolean).join(' · ')
      : [row.kind, row.progress].filter(Boolean).join(' · ');

    return h('div', { class: 'jb-row', 'data-status': row.status },
      h('span', { class: 'jb-rowglyph' }, glyph),
      label,
      h('span', { class: 'jb-rowmeta' }, meta),
      detailText ? h('span', { class: 'jb-rowdetail', title: detailText }, detailText) : null,
    );
  }

  function buildPanel() {
    var panel = h('div', { class: 'jb-panel', role: 'dialog', 'aria-label': t('label') });
    panel.addEventListener('click', function (event) { event.stopPropagation(); });
    return panel;
  }

  function paintPanel() {
    if (!panelEl) return;
    var d = state.data;
    panelEl.textContent = '';
    if (!state.open) { panelEl.style.display = 'none'; return; }
    panelEl.style.display = 'flex';

    var running = d ? d.running : [];
    var settled = d ? d.settled : [];
    var unseen = d ? d.unseen : 0;

    var head = h('div', { class: 'jb-head' },
      h('span', { class: 'jb-title' }, t('label')),
      h('span', { class: 'jb-sub' }, summarize() || t('empty')),
      h('span', { class: 'jb-spacer' }),
      unseen > 0 ? h('button', {
        class: 'jb-mini',
        type: 'button',
        title: t('ack'),
        onclick: function () { acknowledge(); },
      }, t('ack')) : null,
      h('button', {
        class: 'jb-mini',
        type: 'button',
        title: t('close'),
        'aria-label': t('close'),
        onclick: function () { togglePanel(false); },
      }, '×'),
    );
    panelEl.appendChild(head);

    var body = h('div', { class: 'jb-body' });
    if (running.length === 0 && settled.length === 0) {
      body.appendChild(h('div', { class: 'jb-empty' }, t('empty')));
    }
    if (running.length > 0) {
      body.appendChild(h('div', { class: 'jb-section' }, t('running') + ' · ' + running.length));
      for (var i = 0; i < running.length; i++) body.appendChild(buildRow(running[i], false));
    }
    if (settled.length > 0) {
      body.appendChild(h('div', { class: 'jb-section' }, t('settled') + ' · ' + settled.length));
      for (var j = 0; j < settled.length; j++) body.appendChild(buildRow(settled[j], true));
    }
    panelEl.appendChild(body);

    var newest = settled.length > 0 ? Number(settled[0].finishedAt) || 0 : 0;
    var ago = '';
    if (newest > 0) {
      var delta = Math.max(0, hostNow() - newest);
      if (delta < 45000) ago = t('justNow');
      else if (delta < 3600000) ago = t('ago', { n: t('minutes', { n: Math.round(delta / 60000) }) });
      else ago = t('ago', { n: t('hours', { n: Math.round(delta / 3600000) }) });
    }
    panelEl.appendChild(h('div', { class: 'jb-foot' },
      h('button', {
        class: 'jb-mini',
        type: 'button',
        title: state.muted ? t('soundOff') : t('soundOn'),
        onclick: function () { toggleMute(); },
      }, (state.muted ? '🔇 ' : '🔔 ') + (state.muted ? t('soundOff') : t('soundOn'))),
      h('span', { class: 'jb-spacer' }),
      h('span', { class: 'jb-sub' }, state.stale ? t('stale') : ago),
    ));
  }

  function render() {
    var d = state.data;
    var running = d ? d.counts.running : 0;
    var unseen = d ? d.unseen : 0;
    if (running === 0 && unseen === 0 && !state.open) { destroyRoot(); return; }
    ensureRoot();
    paintChip();
    paintPanel();
    /* a running row shows a live duration, so it needs a clock of its own between frames */
    if (running > 0 && !liveTimer) {
      liveTimer = window.setInterval(function () {
        if (state.data && state.data.counts.running > 0) paintPanel();
      }, 1000);
    } else if (running === 0 && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  /* ------------------------------------------------------------------ panel */

  function onDocumentPointerDown(event) {
    if (!state.open || !root) return;
    if (root.contains(event.target)) return;
    togglePanel(false);
  }

  function onKeyDown(event) {
    if (state.open && (event.key === 'Escape' || event.key === 'Esc')) togglePanel(false);
  }

  function togglePanel(next) {
    var want = next === undefined ? !state.open : Boolean(next);
    state.open = want;
    if (want) {
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      /* opening is looking: the count clears when the human opens the badge */
      acknowledge();
    } else {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }
    render();
  }

  /* ------------------------------------------------------------------ sound */

  var audio = null;

  function chime(kind) {
    var ui = (state.data && state.data.ui) || {};
    var volume = typeof ui.volume === 'number' ? ui.volume : 0.35;
    if (state.muted || volume <= 0) return false;
    var mode = ui.sound || 'always';
    if (mode === 'never') return false;
    if (mode === 'hidden' && !document.hidden) return false;
    var now = Date.now();
    /* a burst of settlements is one sound, not five */
    if (now - state.lastChimeAt < 2500) return false;
    state.lastChimeAt = now;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      if (!audio) audio = new Ctor();
      if (audio.state === 'suspended' && typeof audio.resume === 'function') audio.resume().catch(function () {});
      var notes = kind === 'bad' ? [[660, 0], [440, 0.15]]
        : kind === 'answer' ? [[988, 0], [1318.51, 0.12], [1760, 0.24]]   // someone needs YOUR answer
          : kind === 'asking' ? [[784, 0], [588, 0.14]]                  // the page you are in is asking
            : [[880, 0], [1318.51, 0.13]];
      var t0 = audio.currentTime;
      for (var i = 0; i < notes.length; i++) {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = notes[i][0];
        var at = t0 + notes[i][1];
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(at);
        osc.stop(at + 0.34);
      }
      return true;
    } catch (e) {
      return false;   /* an autoplay policy must never break the badge */
    }
  }

  function toggleMute() {
    state.muted = !state.muted;
    writeMuted(state.muted);
    render();
  }

  /* ---------------------------------------------------------------- notify */

  /*
   * The badge cannot be seen while the window is minimized, and a title prefix only shows up in a
   * taskbar tooltip. So there are two channels that DO reach a minimized window, and both are used:
   * a system notification, and the taskbar badge. Neither may take the badge down with it.
   */
  function notify(rows) {
    var ui = (state.data && state.data.ui) || {};
    var mode = ui.notify || 'hidden';
    if (mode === 'never' || rows.length === 0) return;
    if (mode === 'hidden' && !document.hidden) return;
    var Ctor = window.Notification;
    if (typeof Ctor !== 'function') return;
    try {
      var failed = false;
      for (var i = 0; i < rows.length; i++) if (rows[i].status === 'failed') failed = true;
      var title = rows.length === 1
        ? (failed ? t('toastFailed') : t('toastDone'))
        : t('toastMany', { n: rows.length });
      var first = rows[0];
      var started = Number(first.startedAt) || 0;
      var ended = Number(first.finishedAt) || 0;
      var body = first.label + (started && ended ? ' · ' + t('toastTook', { d: fmtDuration(ended - started) }) : '');
      if (rows.length > 1) body += t('toastMore', { n: rows.length - 1 });
      /* silent: the page already plays its own chime, and two sounds for one completion is noise */
      var note = new Ctor(title, { body: body, tag: 'dsh-job-badge', silent: true });
      note.onclick = function () { try { window.focus(); } catch (e) { /* ignore */ } };
    } catch (e) {
      /* a refused notification must never take the badge down with it */
    }
  }

  /** Ask once, from a real gesture: Chromium refuses a permission prompt without one. */
  function armNotifications() {
    try {
      if (state.armed || typeof window.Notification !== 'function') return;
      state.armed = true;
      if (window.Notification.permission === 'default' && typeof window.Notification.requestPermission === 'function') {
        window.Notification.requestPermission().catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }

  /*
   * The taskbar badge: the number on the app icon, which survives being minimized. Chromium exposes
   * it in installed windows; where it does not exist this is a no-op, and it has to stay one.
   */
  function badge(unseen) {
    try {
      if (unseen > 0) {
        if (typeof navigator.setAppBadge === 'function') navigator.setAppBadge(unseen).catch(function () { });
      } else if (typeof navigator.clearAppBadge === 'function') {
        navigator.clearAppBadge().catch(function () { });
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ title */

  function syncTitle(unseen) {
    try {
      var base = String(document.title || '').replace(/^\(\d+\)\s*/, '');
      var want = unseen > 0 ? '(' + unseen + ') ' + base : base;
      if (document.title !== want) document.title = want;
    } catch (e) { /* a title is a nicety, not a contract */ }
  }

  /* ------------------------------------------------------------------- data */

  function acknowledge() {
    if (!state.data || state.data.unseen === 0 || !ACK_URL) return;
    /* optimistically clear locally, then let the host's answer be the truth */
    state.data = Object.assign({}, state.data, { unseen: 0 });
    syncTitle(0);
    render();
    try {
      fetch(ACK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .catch(function () { /* the next frame re-reads the real count */ });
    } catch (e) { /* ignore */ }
  }

  function apply(payload) {
    if (!payload || typeof payload !== 'object') return;
    state.failures = 0;
    state.stale = false;
    state.skew = Date.now() - (Number(payload.now) || Date.now());

    /* which settlements are new to THIS page: unread, not yet chimed, and finished after load.
     * A page opened on an existing unread count must not fire a sound for old news. */
    var fresh = [];
    var settled = payload.settled || [];
    for (var i = 0; i < settled.length; i++) {
      var row = settled[i];
      if (!row || !row.unseen) continue;
      if (state.chimed[row.id]) continue;
      state.chimed[row.id] = true;
      if ((Number(row.finishedAt) || 0) > state.pageStart - 5000) fresh.push(row);
    }

    var before = state.data ? state.data.unseen : 0;
    state.data = payload;
    syncTitle(Number(payload.unseen) || 0);
    badge(Number(payload.unseen) || 0);
    render();

    if (fresh.length > 0) {
      var bad = false;
      for (var k = 0; k < fresh.length; k++) if (fresh[k].status === 'failed') bad = true;
      chime(bad ? 'bad' : 'ok');
      flagPulse();
      notify(fresh);
    } else if (before === 0 && (Number(payload.unseen) || 0) > 0) {
      /* unread without a fresh settlement: the badge still has to demand attention */
      flagPulse();
    }
  }

  function markStale() {
    state.failures++;
    /* one failed read is noise; three in a row means the page has lost the Host and should say so
     * quietly instead of pretending everything is clear */
    if (state.failures >= 3 && !state.stale) {
      state.stale = true;
      if (state.data) render();
    }
  }

  var reading = false;

  function read() {
    if (reading || !STATE_URL) return;
    reading = true;
    fetch(STATE_URL, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (payload) { apply(payload); })
      .catch(markStale)
      .then(function () { reading = false; }, function () { reading = false; });
  }

  var pollTimer = null;
  var currentPollMs = 0;
  var lastFrameError = null;

  function pollMs() {
    var ui = (state.data && state.data.ui) || {};
    var ms = Number(ui.pollMs);
    return Number.isFinite(ms) && ms >= 250 ? ms : POLL_MS;
  }

  function connect() {
    /* The baseline is a plain poll at the host's cadence, and it never stops. The push channel is
     * an accelerator, not the transport: the desktop shell forwards the page's requests through a
     * custom scheme, and a poll survives any layer in between. */
    pollTimer = window.setInterval(read, pollMs());
    currentPollMs = pollMs();
    if (!STREAM_URL || typeof window.EventSource !== 'function') return;
    var source = null;
    try { source = new EventSource(STREAM_URL); } catch (e) { return; }
    source.onmessage = function (event) {
      try { apply(JSON.parse(event.data)); } catch (e) {
        /* A torn frame is not a state, but a bug in here must not be silent either - and it must
         * not fill the console either, so each distinct message is reported once. */
        var why = e && e.message ? e.message : String(e);
        if (why !== lastFrameError) {
          lastFrameError = why;
          try { console.error('[job-badge] frame rejected:', why); } catch (e2) { /* ignore */ }
        }
      }
    };
    /* an error only means the accelerator is gone; the poll is already running */
    source.onerror = function () { if (source.readyState === 2) { try { source.close(); } catch (e) { /* ignore */ } } };
  }

  /* ------------------------------------------------------- someone needs an answer */

  /*
   * CHIME WHEN A CONVERSATION IS WAITING FOR A PERSON.
   *
   * Two cases the user asked for, and they are audibly different on purpose:
   *
   *   another conversation is waiting for an answer   -> 'answer', rising three notes
   *   the conversation THIS page is showing is asking  -> 'asking', a lower two notes
   *
   * The second is quieter information: the question is already on screen in front of you, so a loud
   * chime would be noise. The first is the one that actually needs reaching - the question is in
   * another window you are not looking at, and nothing else in the UI says so.
   *
   * WHERE THE DATA COMES FROM
   *   session-watch already computes this state (`waiting-for-human`, see awaiting-human-test.mjs
   *   there) and serves it on a route stamped with its own load mtime. That stamp is exactly why the
   *   URL cannot be hardcoded: it changes on every plugin install. session-watch publishes it on the
   *   script tag it injects, so that tag is the handle - one element lookup, no new route on either
   *   side, and nothing to keep in sync by hand.
   *
   *   The tag may not exist for the first seconds after a page load (whichever plugin injects first
   *   wins the race), so discovery retries rather than giving up: a feature that silently does nothing
   *   when the plugin happened to load late is worse than no feature.
   *
   * NO CHIME FOR OLD NEWS: the first snapshot only primes the set. A question that was already
   * waiting before this page loaded has already been seen; sounding for it is the false alarm that
   * makes a chime worthless.
   */
  var SW_TAG_ID = 'session-watch-notice-loader';
  var SW_ATTR = 'data-session-watch-state';
  var WAIT_POLL_MS = 5000;
  var swWaiting = {};    /* session id -> true, currently waiting for a human */
  var swChimed = {};     /* session id -> true, already chimed for this wait */
  var swPrimed = false;
  var swReading = false;

  function swUrl() {
    var tag = document.getElementById(SW_TAG_ID);
    var url = tag && tag.getAttribute(SW_ATTR);
    return url || null;
  }

  function readWaiting() {
    var url = swUrl();
    if (!url || swReading) return;
    swReading = true;
    fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (sw) {
        swReading = false;
        if (!sw || !sw.available || !sw.sessions) return;
        var want = {};
        for (var i = 0; i < sw.sessions.length; i++) {
          if (sw.sessions[i].state === 'waiting-for-human') want[sw.sessions[i].id] = true;
        }
        if (!swPrimed) {
          /* first look: adopt what is already true, chime for none of it */
          swWaiting = want;
          for (var id in want) swChimed[id] = true;
          swPrimed = true;
          return;
        }
        var mine = false;
        for (var id2 in want) {
          if (swWaiting[id2] || swChimed[id2]) continue;
          swChimed[id2] = true;
          if (sw.selfSessionId && id2 === sw.selfSessionId) mine = true;
        }
        swWaiting = want;
        if (mine) chime('asking');                            /* the page in front of you is asking */
        else if (Object.keys(want).length) chime('answer');   /* somewhere else needs you */
      }, function () { swReading = false; })
      .then(function () { swReading = false; }, function () { swReading = false; });
  }

  function startWaitingWatch() {
    var tries = 0;
    var finder = window.setInterval(function () {
      tries++;
      if (swUrl() || tries > 40) {
        clearInterval(finder);
        readWaiting();
        window.setInterval(readWaiting, WAIT_POLL_MS);
      }
    }, 500);
  }

  function start() {
    if (window.__dshJobBadge) return;   /* one badge per page, even if the tag is injected twice */
    window.__dshJobBadge = true;
    read();
    connect();
    startWaitingWatch();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) read();
    });
    /* the first real gesture is the one chance to ask for the notification permission */
    document.addEventListener('pointerdown', armNotifications, { capture: true, once: true });
    document.addEventListener('keydown', armNotifications, { capture: true, once: true });
    /* a frame can carry a different cadence; rebuilding the timer is cheaper than a second timer */
    window.setInterval(function () {
      var want = pollMs();
      if (pollTimer && want !== currentPollMs) {
        clearInterval(pollTimer);
        pollTimer = window.setInterval(read, want);
        currentPollMs = want;
      }
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
