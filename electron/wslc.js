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

// Settings can change WSLC_DESKTOP_BIN at runtime; the cache must be
// dropped or the old binary keeps being used until the app restarts.
function resetBinCache() { cachedBin = null; }

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

// wslc misbehaves in processes without a console (a GUI app is one):
// session-store access can fail with ERROR_SHARING_VIOLATION even when the
// same command works in a terminal. Running through cmd.exe gives wslc an
// invisible console to inherit — terminal-like conditions. The mode is
// auto-detected on first failure and remembered for the app's lifetime.
let execMode = process.env.WSLC_DESKTOP_EXEC_MODE || 'auto'; // auto | direct | cmd

function cmdQuote(a) {
  return /[\s"^&|<>()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : String(a);
}

function runOnce(args, timeout, mode = 'direct') {
  const useCmd = mode === 'cmd' && process.platform === 'win32';
  const file = useCmd ? 'cmd.exe' : findBin();
  const argv = useCmd
    ? ['/d', '/s', '/c', [findBin(), ...args].map(cmdQuote).join(' ')]
    : args;
  return new Promise((resolve) => {
    const child = execFile(file, argv, {
      timeout,
      windowsHide: true,
      windowsVerbatimArguments: useCmd,
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

// Seam for unit tests: run()/diagnose() go through impl.runOnce so the
// retry / fallback logic can be exercised without spawning processes.
const impl = { runOnce };

function run(args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return enqueue(async () => {
    let res = await impl.runOnce(args, timeout, execMode === 'cmd' ? 'cmd' : 'direct');
    // Direct mode hit the no-console lock issue? Try once through cmd.exe;
    // adopt it for the rest of the session if it answers.
    if (!res.ok && execMode === 'auto' && SHARING_VIOLATION.test(res.stderr + res.stdout)) {
      const alt = await impl.runOnce(args, timeout, 'cmd');
      if (alt.ok) { execMode = 'cmd'; return alt; }
      res = alt;
    }
    for (let attempt = 0; !res.ok && SHARING_VIOLATION.test(res.stderr + res.stdout) && attempt < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      res = await impl.runOnce(args, timeout, execMode === 'cmd' ? 'cmd' : 'direct');
    }
    if (res.ok && execMode === 'auto') execMode = 'direct';
    return res;
  });
}

// IPC arguments come from the renderer and end up as wslc argv entries.
// wslc's preview CLI has no documented end-of-options separator ("--"), so
// anything that could parse as a flag (leading "-") is rejected here — the
// single choke point every action goes through — rather than per call site.
const NAME_RE = /^[\w][\w.-]*$/; // container / volume / network names
const REF_RE = /^[\w][\w./:@+-]*$/; // image references (repo[:tag][@digest])

function checkArg(value, re, what) {
  return re.test(String(value ?? ''))
    ? null
    : { ok: false, error: `Invalid ${what}: ${JSON.stringify(String(value ?? ''))}` };
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

// wslc's --format json is machine-shaped: epoch-second timestamps, numeric
// state enums, port structs, byte sizes. Everything is turned into display
// strings here, once, so views and the columns fallback agree on one shape.
// The plain-text fallback is also locale-sensitive (French Windows prints
// NOM / ÉTAT / DATE DE CRÉATION headers), hence the localized pick aliases.

const PORT_PROTOCOLS = { 6: 'tcp', 17: 'udp' }; // IANA protocol numbers

function formatPort(p) {
  if (!p || typeof p !== 'object') return String(p ?? '').trim();
  const host = pick(p, 'hostport');
  const cont = pick(p, 'containerport') || host;
  if (host === '' && cont === '') return '';
  const addr = String(pick(p, 'bindingaddress', 'hostip') || '');
  const protoRaw = pick(p, 'protocol');
  const proto = PORT_PROTOCOLS[protoRaw] || (String(protoRaw).match(/^[a-z]+$/i) ? String(protoRaw).toLowerCase() : 'tcp');
  return `${addr ? `${addr}:` : ''}${host || cont}->${cont || host}/${proto}`;
}

function epochToText(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return String(v ?? '').trim(); // already text ("15 minutes ago")
  const ms = n < 1e12 ? n * 1000 : n; // wslc emits epoch seconds
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min > 1 ? 's' : ''} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} days ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function formatBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return String(v ?? '').trim(); // already text ("1.2 GB")
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = n; let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function normalizeContainer(raw) {
  const name = String(pick(raw, 'name', 'names', 'container', 'nom') || '').replace(/^\//, '');
  const stateVal = pick(raw, 'state', 'status', 'état', 'etat');
  // Numeric enum in JSON mode: 2 = running (checked against inspect's
  // State.Status), 1 = created. Strings come from the plain-text fallback.
  let state;
  if (typeof stateVal === 'number') {
    state = stateVal === 2 ? 'running' : (stateVal === 1 ? 'created' : 'stopped');
  } else {
    const s = String(stateVal).toLowerCase();
    state = /running|up/.test(s) ? 'running' : (/creat/.test(s) ? 'created' : 'stopped');
  }
  const changed = epochToText(pick(raw, 'statechangedat'));
  const statusText = typeof stateVal === 'number'
    ? `${state}${changed ? ` ${changed}` : ''}`
    : String(pick(raw, 'status', 'state', 'état', 'etat') || '');
  const ports = asArray(pick(raw, 'ports', 'publishedports', 'port'))
    .flatMap((p) => (p && typeof p === 'object' ? [formatPort(p)] : String(p).split(',')))
    .map((s) => s.trim()).filter(Boolean);
  return {
    id: String(pick(raw, 'id', 'containerid', 'id de conteneur') || name),
    name,
    image: String(pick(raw, 'image') || ''),
    state,
    status: statusText,
    ports,
    created: epochToText(pick(raw, 'createdat', 'created', 'date de création')),
    network: String(pick(raw, 'network', 'networks', 'réseau') || ''),
  };
}

function normalizeImage(raw) {
  const repo = String(pick(raw, 'repository', 'name', 'image', 'dépôt', 'depot') || '');
  const tag = String(pick(raw, 'tag', 'balise') || '');
  return {
    id: String(pick(raw, 'id', 'imageid') || `${repo}:${tag}`),
    reference: tag && !repo.includes(':') ? `${repo}:${tag}` : repo,
    size: formatBytes(pick(raw, 'size', 'taille')),
    created: epochToText(pick(raw, 'createdat', 'created', 'createdsince', 'date de création')),
  };
}

function normalizeVolume(raw) {
  return {
    name: String(pick(raw, 'name', 'volumename', 'nom') || ''),
    driver: String(pick(raw, 'driver', 'pilote') || 'local'),
    mountpoint: String(pick(raw, 'mountpoint') || ''),
  };
}

function normalizeNetwork(raw) {
  return {
    name: String(pick(raw, 'name', 'networkname', 'nom') || ''),
    id: String(pick(raw, 'id', 'networkid') || ''),
    driver: String(pick(raw, 'driver', 'pilote') || ''),
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
  const bad = checkArg(name, NAME_RE, 'container name');
  if (bad) return bad;
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
  const bad = checkArg(name, NAME_RE, 'container name');
  if (bad) return bad;
  const res = await run(['inspect', name]);
  if (!res.ok) return { ok: false, error: friendlyError(res) };
  const parsed = parseJsonLoose(res.stdout);
  return { ok: true, data: parsed ?? res.stdout };
}

async function pullImage(reference) {
  if (MOCK) return mock.pullImage(reference);
  const bad = checkArg(reference, REF_RE, 'image reference');
  if (bad) return bad;
  const res = await run(['pull', reference], { timeout: LONG_TIMEOUT });
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

async function removeImage(reference) {
  if (MOCK) return mock.removeImage(reference);
  const bad = checkArg(reference, REF_RE, 'image reference');
  if (bad) return bad;
  const res = await run(['rmi', reference]);
  if (res.ok) return { ok: true };
  const res2 = await run(['image', 'remove', reference]);
  return res2.ok ? { ok: true } : { ok: false, error: friendlyError(res2) };
}

async function runContainer(opts) {
  if (MOCK) return mock.runContainer(opts);
  let bad = checkArg(opts.image, REF_RE, 'image reference');
  if (!bad && opts.name) bad = checkArg(opts.name, NAME_RE, 'container name');
  if (!bad && opts.network) bad = checkArg(opts.network, NAME_RE, 'network name');
  // Ports/volumes/env have a broader grammar; only a value that could be
  // read as a flag is rejected.
  for (const v of [...(opts.ports || []), ...(opts.volumes || []), ...(opts.env || [])]) {
    if (!bad && /^\s*-/.test(String(v))) bad = { ok: false, error: `Invalid value: ${JSON.stringify(String(v))}` };
  }
  if (bad) return bad;
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

async function simpleNamedAction(mockKey, argv, name, what) {
  if (MOCK) return mock[mockKey](name);
  const bad = checkArg(name, NAME_RE, what);
  if (bad) return bad;
  const res = await run([...argv, name]);
  return res.ok ? { ok: true } : { ok: false, error: friendlyError(res) };
}

const createVolume = (name) => simpleNamedAction('createVolume', ['volume', 'create'], name, 'volume name');
const removeVolume = (name) => simpleNamedAction('removeVolume', ['volume', 'remove'], name, 'volume name');
const createNetwork = (name) => simpleNamedAction('createNetwork', ['network', 'create'], name, 'network name');
const removeNetwork = (name) => simpleNamedAction('removeNetwork', ['network', 'remove'], name, 'network name');

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
  const probes = [
    { args: ['--version'], mode: 'direct' },
    { args: ['system', 'session', 'list'], mode: 'direct' },
    { args: ['list', '-a'], mode: 'direct' },
    { args: ['list', '-a'], mode: 'cmd' }, // compares console-inherited execution
  ];
  for (const { args, mode } of probes) {
    const t0 = Date.now();
    const res = await impl.runOnce(args, 45_000, mode);
    steps.push({
      cmd: `wslc ${args.join(' ')}${mode === 'cmd' ? '   [via cmd.exe]' : ''}`,
      code: res.code,
      timedOut: res.timedOut,
      ms: Date.now() - t0,
      stdout: res.stdout.slice(0, 4000),
      stderr: res.stderr.slice(0, 4000),
    });
    if (res.timedOut) break; // no point hammering a wedged session
  }
  return { bin: findBin(), execMode, steps };
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
  if (!NAME_RE.test(String(name ?? ''))) {
    onData(`\n[wslc error] invalid container name\n`);
    onEnd();
    return;
  }
  // Starting `logs -f` races the session-store lock like any other wslc
  // invocation, so the spawn goes through the single-lane queue. The slot is
  // released once the stream is up (first output, or a grace period for a
  // silent container) — an established stream no longer contends with the
  // one-shot commands, which is why the whole -f lifetime must not hold the
  // queue: it would starve every refresh until the stream stops.
  enqueue(() => new Promise((release) => {
    let released = false;
    const releaseOnce = () => { if (!released) { released = true; clearTimeout(grace); release(); } };
    const grace = setTimeout(releaseOnce, 1500);
    const child = spawn(findBin(), ['logs', '-f', '--tail', '200', name], {
      windowsHide: true,
    });
    logStreams.set(streamId, child);
    child.stdout.on('data', (d) => { releaseOnce(); onData(d.toString()); });
    child.stderr.on('data', (d) => { releaseOnce(); onData(d.toString()); });
    child.on('close', () => { releaseOnce(); logStreams.delete(streamId); onEnd(); });
    child.on('error', (e) => { releaseOnce(); logStreams.delete(streamId); onData(`\n[wslc error] ${e.message}\n`); onEnd(); });
  }));
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
  resetBinCache,
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
  _internals: {
    parseColumns, parseJsonLoose, normalizeContainer, normalizeImage, normalizeVolume, normalizeNetwork,
    pick, enqueue, formatPort, epochToText, formatBytes,
    friendlyError, listWithFallback, checkArg, NAME_RE, REF_RE,
    impl, // stub impl.runOnce to test run()'s retry / fallback logic
    setExecMode: (m) => { execMode = m; },
    getExecMode: () => execMode,
  },
};
