#!/usr/bin/env node
'use strict';
/*
 * verify-live.mjs - check the INSTALLED plugin against the RUNNING Host.
 *
 * WHAT IT ANSWERS, AND WHY EACH PART IS NEEDED
 *   1. Is the installed copy current? A `file:` dependency is hardlinked, but writing a file breaks
 *      the link: after an edit the profile can be serving bytes that no longer exist in the repo.
 *      Comparing the hashes is the only way to know.
 *   2. Which generation is live? Every route carries a stamp derived from its index.js mtime, and
 *      Node caches ES modules by URL - so a Host that keeps running after an edit keeps serving the
 *      generation it imported FIRST, at that older stamp. Probing says which stamps answer, which is
 *      exactly the difference between "installed" and "live".
 *
 * Usage: node test/verify-live.mjs [--port 19387] [--profile <profile dir>] [--stamp <ms>]
 *   Exit 0 when the running Host serves the currently installed generation.
 *   Exit 1 with the reason otherwise (that is a report, not a test failure of the plugin).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const port = Number(arg('port', 19387));
const profile = arg('profile', path.join(os.homedir(), '.dsh', 'profiles', 'desktop'));
const installed = path.join(profile, 'node_modules', '@local', 'dsh-job-badge');

const FILES = ['index.js', 'notice.js', 'package.json', 'cordis.patch.yml'];

/* Read both copies byte-for-byte and compare: a hardlink that was broken by an edit shows up here
 * as "DIFFERS", and that is the failure this script exists to catch. */
function compare() {
  const rows = [];
  for (const name of FILES) {
    const a = path.join(repo, name);
    const b = path.join(installed, name);
    const hasA = fs.existsSync(a);
    const hasB = fs.existsSync(b);
    if (!hasA || !hasB) { rows.push({ name, state: hasA ? 'not installed' : 'missing in repo' }); continue; }
    const same = fs.readFileSync(a).equals(fs.readFileSync(b));
    rows.push({ name, state: same ? 'same' : 'DIFFERS', same });
  }
  return rows;
}

/* The stamp is the file's mtime in milliseconds, floored - the same arithmetic index.js performs. */
function stampOf(file) {
  try { return String(Math.floor(fs.statSync(file).mtimeMs)); }
  catch { return null; }
}

async function probe(stamp) {
  const url = `http://127.0.0.1:${port}/job-badge/state-${stamp}.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { url, ok: false, status: res.status };
    const body = await res.json();
    return { url, ok: true, status: res.status, body };
  } catch (error) {
    return { url, ok: false, error: error?.message ?? String(error) };
  }
}

let code = 0;
console.log(`repo      : ${repo}`);
console.log(`installed : ${installed}`);
console.log(`host      : http://127.0.0.1:${port}`);

console.log('\n1) installed bytes vs repo');
const rows = compare();
for (const row of rows) console.log(`   ${row.state === 'same' ? '  ok  ' : ' FAIL '} ${row.name}: ${row.state}`);
if (rows.some((r) => r.same === false)) {
  console.log('   -> the profile copy is stale: re-run plugin_manager install_bundle, then restart DSH.');
  code = 1;
}

console.log('\n2) which generation answers');
const installedStamp = stampOf(path.join(installed, 'index.js'));
const repoStamp = stampOf(path.join(repo, 'index.js'));
const extra = arg('stamp', '');
const candidates = [['installed now', installedStamp], ['repo now', repoStamp]];
if (extra !== '') candidates.unshift(['from --stamp', extra]);
const results = [];
const seenStamps = new Set();
for (const [label, stamp] of candidates) {
  if (stamp === null || seenStamps.has(stamp)) continue;
  seenStamps.add(stamp);
  const result = await probe(stamp);
  results.push({ label, stamp, result });
  if (!result.ok) {
    console.log(`   ${label} (${stamp}): no answer (${result.status ?? result.error})`);
    continue;
  }
  const b = result.body;
  console.log(`   ${label} (${stamp}): LIVE  running=${b.counts.running} settled=${b.counts.settled} unseen=${b.unseen} pollMs=${b.ui?.pollMs}`);
  for (const job of (b.running || []).slice(0, 5)) console.log(`        running: [${job.kind}] ${job.label}`);
  for (const job of (b.settled || []).slice(0, 5)) console.log(`        settled: [${job.kind}] ${job.label} -> ${job.status}${job.unseen ? ' (unread)' : ''}`);
}

const live = results.find((r) => r.result.ok && r.label === 'installed now');
if (live) {
  console.log('\nOK: the running Host serves the installed generation.');
  console.log('    The badge on screen still needs the desktop app to have started AFTER this plugin was');
  console.log('    installed: the shell freezes the index injection table at Host startup, so restart once.');
} else if (results.some((r) => r.result.ok)) {
  console.log('\nPARTIAL: one generation answers, but not the currently installed one.');
  console.log('    That is the module cache at work: a Host keeps serving the code it imported first, at that');
  console.log('    first import\'s stamp. Restart the Host (or the app) to move to the installed bytes.');
  code = 1;
} else {
  console.log('\nNOT LIVE: no job-badge route answered.');
  console.log('    Either the plugin is not enabled in this profile, or the Host has not started since install.');
  code = 1;
}

/* exitCode, not exit(): calling exit() while an undici socket is closing trips a libuv assertion on
 * Node 24 (win async.c). The event loop drains on its own once the keep-alive sockets time out. */
process.exitCode = code;
