// SignPath signs the installers *after* electron-builder wrote latest.yml,
// which changes their bytes: the sha512/size in the update metadata no longer
// match and electron-updater would reject every download. This rewrites the
// hashes in place from the signed files. Usage: node scripts/patch-latest-yml.mjs [dist/latest.yml]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'dist/latest.yml';
const dir = path.dirname(file);
const sha512 = (p) => createHash('sha512').update(fs.readFileSync(p)).digest('base64');

// latest.yml is flat and predictable: `url:`/`path:` lines name a file, the
// sha512/size lines that follow describe it.
let current = null;
const out = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => {
  const name = line.match(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/);
  if (name) { current = path.join(dir, name[1]); return line; }
  const sha = line.match(/^(\s*)sha512:/);
  if (sha && current) return `${sha[1]}sha512: ${sha512(current)}`;
  const size = line.match(/^(\s*)size:/);
  if (size && current) return `${size[1]}size: ${fs.statSync(current).size}`;
  return line;
});
fs.writeFileSync(file, out.join('\n'));
console.log(`patched ${file}:\n${out.join('\n')}`);
