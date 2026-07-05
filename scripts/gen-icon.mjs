// Rasterize assets/logo.svg to build/icon.png (electron-builder converts it
// to .ico for the Windows installer). Runs in CI before packaging.

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');

mkdirSync(path.join(root, 'build'), { recursive: true });
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
writeFileSync(path.join(root, 'build', 'icon.png'), png);
console.log(`build/icon.png written (${png.length} bytes)`);
