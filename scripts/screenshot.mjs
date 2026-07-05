// Dev helper: boot the app (mock backend) offscreen and save screenshots of
// each view. Used to eyeball the design without a display.

import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.env.SHOT_DIR || root;
const { registerIpc } = createRequire(import.meta.url)(path.join(root, 'electron', 'main.js'));

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

process.on('unhandledRejection', (e) => { console.error('[unhandled]', e); app.exit(1); });
setTimeout(() => { console.error('[timeout] giving up'); app.exit(2); }, 90_000);

app.whenReady().then(async () => {
  registerIpc();
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      contextIsolation: true, sandbox: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    console.log(`[console:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (_ev, p, err) => console.log(`[preload-error] ${p}: ${err}`));
  await win.loadFile(path.join(root, 'app', 'index.html'));

  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => console.log(`[js-error] ${e.message}`));
  const theme = process.env.SHOT_THEME;
  const suffix = theme ? `-${theme}` : '';
  const shoot = async (name) => {
    await new Promise((r) => setTimeout(r, 1500));
    if (theme) await js(`document.documentElement.dataset.theme = '${theme}'`);
    const img = await win.webContents.capturePage();
    writeFileSync(path.join(outDir, `shot-${name}${suffix}.png`), img.toPNG());
    console.log(`shot-${name}${suffix}.png`);
  };

  console.log('[dom] content children:', await js(`document.getElementById('content').childElementCount`));
  await shoot('containers');
  await js(`document.querySelector('[data-view="images"]').click()`);
  await shoot('images');
  await js(`document.querySelector('[data-view="containers"]').click()`);
  await js(`var r=document.querySelector('.row'); r && r.click(); !!r`);
  await shoot('detail');
  await js(`document.querySelector('[data-view="settings"]').click()`);
  await shoot('settings');
  app.exit(0);
});
