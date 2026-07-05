// Service layer around the wslc CLI. Every UI action funnels through here.
// Design rules:
//  - never trust the preview's output shape: try JSON, fall back to columns
//  - every call has a timeout so a wedged session shows an error, not a hang
//  - WSLC_DESKTOP_MOCK=1 swaps in electron/mock.js (UI dev without wslc)

'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const MOCK = process.env.WSLC_DESKTOP_MOCK === '1';
const mock = MOCK ? require('./mock') : null;

// The first wslc call after a Windows boot starts the whole session
// (utility VM): it can take well over a minute. Timeouts are generous and
// the UI reports "starting" rather than failing fast.
const DEFAULT_TIMEOUT = 120_000;
const LONG_TIMEOUT = 15 * 60_000; // pull / build

let cachedBin = null;

function findBin() {
  if (cachedBin) return cachedBin;
  const candidates = [
    process.env.WSLC_DESKTOP_BIN,
    'wslc.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'WSL', 'wslc.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'wslc.exe') { cachedBin = c; return c; } // resolved via PATH by spawn
    try { fs.accessSync(c); cachedBin = c; return c; } catch { /* next */ }
  }
  cachedBin = 'wslc.exe';
  return cachedBin;
}

// wslc.exe locks its session files: two concurrent invocations fail with
// ERROR_SHARING_VIOLATION. All calls therefore go through a single-lane
// queue (terminals never run two commands at once — we must not either),
// and transient sharing violations are retried.
let queueTail = Promise.resolve();
function enqueue(fn) {
  const next = queueTail.then(fn, fn);
  queueTail = next.then(() => {}, () => {});
  return next;
}

const SHARING_VIOLATION = /ERROR_SHARING_VIOLATION|0x80070020|utilisé par un autre processus|used by another process/i;

function runOnce(args, timeout) {
  return new Promise((resolve) => {
    const child = execFile(findBin(), args, {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (error.code ?? 1) : 0,
        timedOut: Boolean(error && error.killed),
        stdout: stdout || '',
        stderr: stderr || (error && !stdout ? String(error.message || '') : ''),
      });
    });
    child.on('error', (err) => resolve({ ok: false, code: 1, timedOut: false, stdout: '', stderr: String(err.message) }));
  });
}

function run(args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return enqueue(async () => {
    let res = await runOnce(args, timeout);
    for (let attempt = 0; !res.ok && SHARING_VIOLATION.test(res.stderr + res.stdout) && attempt < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      res = await runOnce(args, timeout);
    }
    return res;
  });
}

function parseJsonLoose(text) {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* maybe NDJSON */ }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const objs = [];
  for (const line of lines) {
    try { objs.push(JSON.parse(line)); } catch { return null; }
  }
  return objs;
}

// Plain-text fallback: header row with column names, rows aligned under them.
function parseColumns(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols = [];
  const re = /(\S[\S ]*?)(?=\s{2,}|$)/g;
  let m;
  while ((m = re.exec(header)) !== null) cols.push({ name: m[1].trim(), start: m.index });
  return lines.slice(1).map((line) => {
    const row = {};
    cols.forEach((col, i) => {
      const end = i + 1 < cols.length ? cols[i + 1].start : line.length;
      row[col.name.toUpperCase()] = line.slice(col.start, end).trim();
    });
    return row;
  });
}

function pick(obj, ...names) {
  for (const n of names) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === n.toLowerCase()) {
        const v = obj[key];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
  }
  return '';
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [v];
}

function normalizeContainer(raw) {
  const name = String(pick(raw, 'name', 'names', 'container') || '').replace(/^\//, '');
  const stateRaw = String(pick(raw, 'state', 'status') || '').toLowerCase();
  const running = /running|up/.test(stateRaw);
  const ports = asArray(pick(raw, 'ports', 'publishedports', 'port'))
    .flatMap((p) => String(p).split(',')).map((s) => s.trim()).filter(Boolean);
  return {
    id: String(pick(raw, 'id', 'containerid') || name),
    name,
    image: String(pick(raw, 'image') || ''),
    state: running ? 'running' : (/creat/.test(stateRaw) ? 'created' : 'stopped'),
    status: String(pick(raw, 'status', 'state') || ''),
    ports,
    created: String(pick(raw, 'createdat', 'created') || ''),
    network: String(pick(raw, 'network', 'networks') || ''),
  };
}

function normalizeImage(raw) {
  const repo = String(pick(raw, 'repository', 'name', 'image') || '');
  const tag = String(pick(raw, 'tag') || '');
  return {
    id: String(pick(raw, 'id', 'imageid') || `${repo}:${tag}`),
    reference: tag && !repo.includes(':') ? `${repo}:${tag}` : repo,
    size: String(pick(raw, 'size') || ''),
    created: String(pick(raw, 'createdat', 'created', 'createdsince') || ''),
  };
}

function normalizeVolume(raw) {
  return {
    name: String(pick(raw, 'name', 'volumename') || ''),
    driver: String(pick(raw, 'driver') || 'local'),
    mountpoint: String(pick(raw, 'mountpoint') || ''),
  };
}

function normalizeNetwork(raw) {
  return {
    name: String(pick(raw, 'name', 'networkname') || ''),
    id: String(pick(raw, 'id', 'networkid') || ''),
    driver: String(pick(raw, 'driver') || ''),
  };
}

async function listWithFallback(jsonArgs, plainArgs, normalize) {
  let res = await run(jsonArgs);
  if (res.ok) {
    const parsed = parseJsonLoose(res.stdout);
    if (parsed) return { ok: true, items: asArray(parsed).map(normalize).filter((x) => x.name || x.id || x.reference) };
  }
  res = await run(plainArgs);
  if (!res.ok) return { ok: false, error: friendlyError(res), items: [] };
  return { ok: true, items: parseColumns(res.stdout).map(normalize).filter((x) => x.name || x.id || x.reference) };
}

function friendlyError(res) {
  if (res.timedOut) {
    return 'wslc did not answer in time. The session may be wedged — see the session bar for recovery steps.';
  }
  const msg = (res.stderr || res.stdout || '').trim();
  if (/0x8007000e|too many volumes/i.test(msg)) {
    return 'This WSL session hit the preview limit of ~15 mounted volumes. Run "wsl --shutdown" from Windows, then try again.';
  }
  if (SHARING_VIOLATION.test(msg)) {
    return 'wslc files are locked by another wslc command still running. It usually clears on the next refresh; close other wslc windows if it persists.';
  }
  return msg || `wslc exited with code ${res.code}`;
}

/* ------------------------------------------------------------------ API */

async function listContainers() {
  if (MOCK) return mock.listContainers();
  return listWithFallback(['list', '-a', '--format', 'json'], ['list', '-a'], normalizeContainer);
}

async function listImages() {
  if (MOCK) return mock.listImages();
  return listWithFallback(['images', '--format', 'json'], ['images'], normalizeImage);
}

async function listVolumes() {
  if (MOCK) return mock.listVolumes();
  return listWithFallback(['volume', 'list', '--format', 'json'], ['volume', 'list'], normalizeVolume);
}

async function listNetworks() {
  if (MOCK) return mock.listNetworks();
  return listWithFallback(['network', 'list', '--format', 'json'], ['network', 'list'], normalizeNetwork);
}

async function containerAction(name, action) {
  if (MOCK) return mock.containerAction(name, action);
  const argsByAction = {
    start: ['start', name],
    stop: ['stop', name],
    restart: null, // emulated below: wslc has no restart
    remove: ['remove', '-f', name],
  };
  if (action === 'restart') {
    const stop = await run(['stop', name], { timeout: 60_000 });
    if (!stop.ok) return { ok: false, error: friendlyError(stop) };
    const start = await run(['start', name], { timeout: 60_000 });
    return start.ok ? { ok: true } : { ok: false, error: friendlyError(start) };
  }
  const args = argsByAction[action];
  if (!args) return { ok: false, error: `Unknown action: ${action}` };
  const res = await run(args, { timeout: 60_000 });
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function inspect(name) {
  if (MOCK) return mock.inspect(name);
  const res = await run(['inspect', name]);
  if (!res.ok) return { ok: false, error: friendlyError(res) };
  const parsed = parseJsonLoose(res.stdout);
  return { ok: true, data: parsed ?? res.stdout };
}

async function pullImage(reference) {
  if (MOCK) return mock.pullImage(reference);
  const res = await run(['pull', reference], { timeout: LONG_TIMEOUT });
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function removeImage(reference) {
  if (MOCK) return mock.removeImage(reference);
  const res = await run(['rmi', reference]);
  if (res.ok) return { ok: true };
  const res2 = await run(['image', 'remove', reference]);
  return res2.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function runContainer(opts) {
  if (MOCK) return mock.runContainer(opts);
  const args = ['run', '-d'];
  if (opts.name) args.push('--name', opts.name);
  for (const p of opts.ports || []) args.push('-p', p);
  for (const v of opts.volumes || []) args.push('-v', v);
  for (const e of opts.env || []) args.push('-e', e);
  if (opts.network) args.push('--network', opts.network);
  args.push(opts.image);
  if (opts.command) args.push(...String(opts.command).split(/\s+/).filter(Boolean));
  const res = await run(args, { timeout: LONG_TIMEOUT });
  return res.ok ? { ok: true, id: res.stdout.trim() } : { ok: false, error: friendlyError(res) };
}

async function createVolume(name) {
  if (MOCK) return mock.createVolume(name);
  const res = await run(['volume', 'create', name]);
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function removeVolume(name) {
  if (MOCK) return mock.removeVolume(name);
  const res = await run(['volume', 'remove', name]);
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function createNetwork(name) {
  if (MOCK) return mock.createNetwork(name);
  const res = await run(['network', 'create', name]);
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function removeNetwork(name) {
  if (MOCK) return mock.removeNetwork(name);
  const res = await run(['network', 'remove', name]);
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function version() {
  if (MOCK) return mock.version();
  const res = await run(['--version'], { timeout: 60_000 });
  return { ok: res.ok, version: (res.stdout || res.stderr).trim().split(/\r?\n/)[0] || 'unknown' };
}

// Raw, copyable results for the Settings diagnostics panel: exactly what
// wslc answered, so bug reports contain facts instead of guesses.
// Bypasses the call queue on purpose: when the queue is stuck behind a
// wedged session, diagnostics must still answer. A sharing violation in
// the output is itself a useful signal here.
async function diagnose() {
  if (MOCK) return { bin: 'mock', steps: [{ cmd: 'mock', code: 0, ms: 0, stdout: 'mock backend active', stderr: '' }] };
  const steps = [];
  for (const args of [['--version'], ['system', 'session', 'list'], ['list', '-a']]) {
    const t0 = Date.now();
    const res = await runOnce(args, 45_000);
    steps.push({
      cmd: `wslc ${args.join(' ')}`,
      code: res.code,
      timedOut: res.timedOut,
      ms: Date.now() - t0,
      stdout: res.stdout.slice(0, 4000),
      stderr: res.stderr.slice(0, 4000),
    });
    if (res.timedOut) break; // no point hammering a wedged session
  }
  return { bin: findBin(), steps };
}

// Session facts for the session bar. Elevation is inferred from the session
// name wslc itself reports (wslc-cli-admin-<user> vs wslc-cli-<user>).
async function sessionInfo() {
  if (MOCK) return mock.sessionInfo();
  const res = await run(['system', 'session', 'list'], { timeout: 10_000 });
  if (!res.ok) return { ok: false, error: friendlyError(res), sessions: [] };
  const out = res.stdout;
  const parsed = parseJsonLoose(out);
  const rows = parsed ? asArray(parsed) : parseColumns(out);
  const sessions = rows.map((r) => {
    const name = String(pick(r, 'name', 'session', 'sessionname') || '');
    return { name, elevated: /admin/i.test(name), raw: r };
  }).filter((s) => s.name);
  return { ok: true, sessions };
}

/* ------------------------------------------------------- log streaming */

const logStreams = new Map(); // streamId -> child

function startLogs(streamId, name, onData, onEnd) {
  if (MOCK) return mock.startLogs(streamId, name, onData, onEnd, logStreams);
  const child = spawn(findBin(), ['logs', '-f', '--tail', '200', name], {
    windowsHide: true,
  });
  logStreams.set(streamId, child);
  child.stdout.on('data', (d) => onData(d.toString()));
  child.stderr.on('data', (d) => onData(d.toString()));
  child.on('close', () => { logStreams.delete(streamId); onEnd(); });
  child.on('error', (e) => { logStreams.delete(streamId); onData(`\n[wslc error] ${e.message}\n`); onEnd(); });
}

function stopLogs(streamId) {
  const child = logStreams.get(streamId);
  if (!child) return;
  logStreams.delete(streamId);
  if (typeof child.kill === 'function') child.kill();
  else if (typeof child === 'function') child(); // mock returns a cancel fn
}

module.exports = {
  MOCK,
  findBin,
  listContainers,
  listImages,
  listVolumes,
  listNetworks,
  containerAction,
  inspect,
  pullImage,
  removeImage,
  runContainer,
  createVolume,
  removeVolume,
  createNetwork,
  removeNetwork,
  version,
  sessionInfo,
  diagnose,
  startLogs,
  stopLogs,
  // exported for unit tests
  _internals: { parseColumns, parseJsonLoose, normalizeContainer, normalizeImage, pick, enqueue },
};
