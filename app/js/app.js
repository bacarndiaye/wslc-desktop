// App shell: theme, navigation, background refresh, search, session bar.

import { api, host, isElectron } from './api.js';
import { containersView, imagesView, volumesView, networksView, settingsView, openDetailPane, closeDetailPane } from './views.js';

const ctx = {
  view: 'containers',
  filter: '',
  settings: { theme: 'system', refreshSeconds: 5, wslcBin: '' },
  appVersion: '',
  wslcVersion: '',
  data: {
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    composeProjects: new Map(), // container name -> project label
    error: '',
    loaded: false,
  },
  refresh,
  act,
  openDetail: (c, tab) => openDetailPane(ctx, c, tab),
  applyFilter(items, textOf) {
    const q = ctx.filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => textOf(it).toLowerCase().includes(q));
  },
  async applyThemeFromSettings() {
    const dark = ctx.settings.theme === 'dark' ? true
      : ctx.settings.theme === 'light' ? false
        : await host.isDark().catch(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
};

const VIEWS = {
  containers: containersView,
  images: imagesView,
  volumes: volumesView,
  networks: networksView,
  settings: settingsView,
};

/* ------------------------------------------------------------ rendering */

function render() {
  const content = document.getElementById('content');
  const scroll = content.scrollTop;
  content.innerHTML = '';
  content.append(VIEWS[ctx.view](ctx));
  content.scrollTop = scroll;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.toggleAttribute('aria-current', false);
    if (btn.dataset.view === ctx.view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  document.getElementById('count-containers').textContent = ctx.data.containers.length || '';
  document.getElementById('count-images').textContent = ctx.data.images.length || '';
  document.getElementById('count-volumes').textContent = ctx.data.volumes.length || '';
  document.getElementById('count-networks').textContent = ctx.data.networks.length || '';
}

/* ---------------------------------------------------------------- data */

let refreshTimer = null;
let refreshing = false;

async function refresh(immediateRender = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const [c, i, v, n] = await Promise.all([
      api.listContainers(), api.listImages(), api.listVolumes(), api.listNetworks(),
    ]);
    ctx.data.error = [c, i, v, n].find((r) => !r.ok)?.error || '';
    if (c.ok) ctx.data.containers = c.items;
    if (i.ok) ctx.data.images = i.items;
    if (v.ok) ctx.data.volumes = v.items;
    if (n.ok) ctx.data.networks = n.items;
    ctx.data.loaded = true;
    void resolveComposeProjects();
    const anyOk = [c, i, v, n].some((r) => r.ok);
    updateEngineStatus(anyOk && !ctx.data.error);
    // If the engine answered but the boot-time probe had failed (cold
    // session), fill in the version and session details now.
    if (anyOk && !ctx.wslcVersion) void initSessionBar();
  } finally {
    refreshing = false;
  }
  if (immediateRender || true) render();
}

// Compose project labels only show through `wslc inspect`; resolve them
// lazily and cache per container name so the list stays fast.
const inspected = new Set();
async function resolveComposeProjects() {
  const pending = ctx.data.containers.filter((c) => !inspected.has(c.name)).slice(0, 8);
  if (!pending.length) return;
  let changed = false;
  await Promise.all(pending.map(async (c) => {
    inspected.add(c.name);
    try {
      const res = await api.inspect(c.name);
      const data = Array.isArray(res.data) ? res.data?.[0] : res.data;
      const project = data?.Config?.Labels?.['com.wslc-compose.project'];
      if (res.ok && project) { ctx.data.composeProjects.set(c.name, project); changed = true; }
    } catch { /* keep ungrouped */ }
  }));
  if (changed && ctx.view === 'containers') render();
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refresh(), Math.max(2, ctx.settings.refreshSeconds) * 1000);
}

async function act(name, action, verb) {
  updateHint(`${verb} ${name}…`);
  const res = await api.containerAction(name, action);
  updateHint('');
  if (!res.ok) {
    const { toast } = await import('./ui.js');
    toast(res.error, 'error', 8000);
  }
  if (action === 'remove') closeDetailPane();
  refresh(true);
}

/* ------------------------------------------------------------ sessionbar */

let firstContact = false;

function updateEngineStatus(ok) {
  const dot = document.querySelector('#sess-engine .dot');
  const text = document.getElementById('sess-engine-text');
  if (ok) firstContact = true;
  if (!ok && !firstContact) {
    // Nothing has answered yet: most likely the wslc session is cold-starting
    // (first call after a Windows boot can take over a minute).
    dot.className = 'dot dot-wait';
    text.textContent = 'Starting the wslc session… first start can take a minute';
    return;
  }
  dot.className = `dot ${ok ? 'dot-running' : 'dot-error'}`;
  text.textContent = ok
    ? (ctx.wslcVersion || 'wslc engine')
    : 'wslc not responding — open Settings for diagnostics';
}

function updateHint(msg) {
  document.getElementById('sess-hint').textContent = msg;
}

let sessionBarBusy = false;
async function initSessionBar() {
  if (sessionBarBusy) return;
  sessionBarBusy = true;
  try { await initSessionBarInner(); } finally { sessionBarBusy = false; }
}

async function initSessionBarInner() {
  const ver = await api.version();
  ctx.wslcVersion = ver.ok ? ver.version : '';
  updateEngineStatus(ver.ok);

  if (await api.isMock()) document.getElementById('sess-mock').hidden = false;
  if (!ver.ok) return; // refresh() keeps retrying; session details wait for contact

  const info = await api.sessionInfo();
  if (info.ok && info.sessions.length) {
    const sess = info.sessions[0];
    const box = document.getElementById('sess-session');
    box.hidden = false;
    box.innerHTML = '';
    box.append(
      document.createTextNode(sess.name),
    );
    const badge = document.createElement('span');
    badge.className = `badge ${sess.elevated ? 'badge-caution' : 'badge-accent'}`;
    badge.textContent = sess.elevated ? 'Administrator session' : 'Standard session';
    badge.title = sess.elevated
      ? 'This session belongs to elevated terminals. Containers created here are invisible to non-admin terminals.'
      : 'Non-elevated session — recommended.';
    box.append(badge);
    if (info.sessions.length > 1) {
      const more = document.createElement('span');
      more.className = 'badge';
      more.textContent = `+${info.sessions.length - 1} other session${info.sessions.length > 2 ? 's' : ''}`;
      more.title = 'wslc keeps one session per user and elevation level; each has its own containers and images.';
      box.append(more);
    }
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  // Fonts: prefer Segoe Fluent Icons glyphs, fall back to unicode elsewhere.
  try {
    if (!document.fonts.check('16px "Segoe Fluent Icons"')) {
      document.documentElement.classList.add('no-fluent-icons');
    }
  } catch { document.documentElement.classList.add('no-fluent-icons'); }
  if (!isElectron || navigator.platform.startsWith('Linux')) {
    document.documentElement.classList.add('no-mica');
  }

  try {
    ctx.settings = await host.getSettings();
    ctx.appVersion = await host.appVersion();
  } catch { /* bridge unavailable: keep defaults so the UI still renders */ }
  await ctx.applyThemeFromSettings();
  host.onThemeChanged(async () => { await ctx.applyThemeFromSettings(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => ctx.applyThemeFromSettings());

  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => {
      ctx.view = btn.dataset.view;
      closeDetailPane();
      render();
      document.getElementById('content').focus({ preventScroll: true });
    });
  }

  const search = document.getElementById('search');
  search.addEventListener('input', () => { ctx.filter = search.value; render(); });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); search.focus(); }
    if (e.key === 'Escape') { closeDetailPane(); if (document.activeElement === search) { search.value = ''; ctx.filter = ''; render(); } }
  });

  document.getElementById('detail-close').addEventListener('click', closeDetailPane);

  render();               // instant shell with placeholders
  await refresh(true);    // first data load
  initSessionBar();
  scheduleRefresh();
}

boot();
