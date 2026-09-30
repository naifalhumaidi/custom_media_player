/* Assembles dist/ - the exact set of files the app needs to run.

   The desktop bundle must not carry the repository. node_modules alone is
   64 MB, and the test suites and documentation are not part of the product.
   So this copies an explicit list rather than the directory minus an ignore
   list: an allowlist cannot silently start shipping something new.

   Usage: node scripts/build-frontend.mjs   (wired to `npm run build:web`) */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');

/* Everything the shipped page loads. Keep in step with index.html. */
const FILES = [
  'index.html',
  'app.js',
  'styles.css',
  'styles-vidstack.css',
  'js/mime.js',
  'js/source-web.js',
  'js/source-tauri.js',
  'js/source-electron.js',
  'js/source.js',
  'js/media.js',
  'js/i18n.js',
  'js/settings.js',
];
const DIRS = ['vendor', 'assets'];

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copy(src, dst);
  }
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const missing = [];
for (const file of FILES) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) { missing.push(file); continue; }
  copy(src, path.join(OUT, file));
}
for (const dir of DIRS) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) { missing.push(dir + '/'); continue; }
  copyDir(src, path.join(OUT, dir));
}

if (missing.length) {
  console.error('build:web: missing from the app directory: ' + missing.join(', '));
  process.exit(1);
}

const bytes = fs.statSync(path.join(OUT, 'index.html')).size;
console.log(`build:web: dist/ assembled (${bytes} byte index.html)`);
