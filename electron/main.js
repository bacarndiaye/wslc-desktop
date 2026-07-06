'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const wslc = require('./wslc');

let win = null;

/* ----------------------------------------------------------- settings */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = { theme: 'system', refreshSeconds: 5, wslcBin: '' };

function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; }
  catch { return { ...defaultSettings }; }
}

function saveSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  if (s.wslcBin) process.env.WSLC_DESKTOP_BIN = s.wslcBin;
  applyTheme(s.theme);
}

function applyTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  updateTitlebarOverlay();
}

function updateTitlebarOverlay() {
  if (!win || process.platform !== 'win32') return;
  const dark = nativeTheme.shouldUseDarkColors;
  try {
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: dark ? '#ffffff' : '#1b1b1b',
      height: 48,
    });
  } catch { /* not supported on this platform/build */ }
}

/* ------------------------------------------------------------- window */

function createWindow() {
  const settings = loadSettings();
  if (settings.wslcBin) process.env.WSLC_DESKTOP_BIN = settings.wslcBin;
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1b1b1b', height: 48 },
      backgroundMaterial: 'mica',
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // A broken GPU state (e.g. a shader cache corrupted by a forced kill
  // during an update) can swallow the first paint: ready-to-show then never
  // fires and the window stays hidden forever, looking like a failed launch.
  const forceShow = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);
  win.on('closed', () => { clearTimeout(forceShow); win = null; });

  nativeTheme.on('updated', () => {
    updateTitlebarOverlay();
    if (win) win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
  });

  // External links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ----------------------------------------------------------------- ipc */

function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, (_ev, ...args) => fn(...args));

  h('wslc:listContainers', () => wslc.listContainers());
  h('wslc:listImages', () => wslc.listImages());
  h('wslc:listVolumes', () => wslc.listVolumes());
  h('wslc:listNetworks', () => wslc.listNetworks());
  h('wslc:containerAction', (name, action) => wslc.containerAction(name, action));
  h('wslc:inspect', (name) => wslc.inspect(name));
  h('wslc:pullImage', (ref) => wslc.pullImage(ref));
  h('wslc:removeImage', (ref) => wslc.removeImage(ref));
  h('wslc:runContainer', (opts) => wslc.runContainer(opts));
  h('wslc:createVolume', (name) => wslc.createVolume(name));
  h('wslc:removeVolume', (name) => wslc.removeVolume(name));
  h('wslc:createNetwork', (name) => wslc.createNetwork(name));
  h('wslc:removeNetwork', (name) => wslc.removeNetwork(name));
  h('wslc:version', () => wslc.version());
  h('wslc:sessionInfo', () => wslc.sessionInfo());
  h('wslc:diagnose', () => wslc.diagnose());
  h('wslc:isMock', () => wslc.MOCK);

  h('app:getSettings', () => loadSettings());
  h('app:saveSettings', (s) => { saveSettings(s); return loadSettings(); });
  h('app:isDark', () => nativeTheme.shouldUseDarkColors);
  h('app:version', () => app.getVersion());

  h('app:openExternal', (url) => {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) shell.openExternal(url);
  });

  // "Open terminal" hands the interactive session to a real console
  // (Windows Terminal when available) — wslc needs one to behave.
  h('app:openTerminal', (name) => {
    if (process.platform !== 'win32') return;
    const safe = String(name).replace(/[^\w.-]/g, '');
    const cmd = `wt.exe wslc exec -it ${safe} sh || start "WSLC — ${safe}" cmd /k wslc exec -it ${safe} sh`;
    spawn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });

  ipcMain.on('logs:start', (ev, streamId, name) => {
    const wc = ev.sender;
    wslc.startLogs(
      streamId,
      name,
      (chunk) => { if (!wc.isDestroyed()) wc.send(`logs:data:${streamId}`, chunk); },
      () => { if (!wc.isDestroyed()) wc.send(`logs:end:${streamId}`); },
    );
  });
  ipcMain.on('logs:stop', (_ev, streamId) => wslc.stopLogs(streamId));
}

/* --------------------------------------------------------------- boot */

module.exports = { registerIpc };

// Only drive the app lifecycle when loaded as the entry point (tools like
// scripts/screenshot.mjs require this file just for registerIpc).
if (require.main !== module) {
  /* library use */
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Launching the app again must always surface a window, even if the
    // running instance is a leftover whose window is hidden or gone.
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // If the GPU process keeps dying, relaunch once in software rendering
  // instead of leaving the user with an invisible window.
  let gpuCrashes = 0;
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU' || !['crashed', 'abnormal-exit'].includes(details.reason)) return;
    gpuCrashes += 1;
    if (gpuCrashes >= 2 && !process.argv.includes('--disable-gpu')) {
      app.relaunch({ args: process.argv.slice(1).concat('--disable-gpu') });
      app.exit(0);
    }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
