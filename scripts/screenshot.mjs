// Dev helper: boot the app (mock backend) offscreen and save screenshots of
// each view. Used to eyeball the design without a display.

import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.env.SHOT_DIR || root;

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      contextIsolation: true, sandbox: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(root, 'app', 'index.html'));
  const shoot = async (name) => {
    await new Promise((r) => setTimeout(r, 1400));
    const img = await win.webContents.capturePage();
    writeFileSync(path.join(outDir, `shot-${name}.png`), img.toPNG());
    console.log(`shot-${name}.png`);
  };
  await shoot('containers');
  await win.webContents.executeJavaScript(`document.querySelector('[data-view="images"]').click()`);
  await shoot('images');
  await win.webContents.executeJavaScript(`document.querySelector('.row').click()`);
  await shoot('detail');
  await win.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click()`);
  await shoot('settings');
  app.quit();
});
