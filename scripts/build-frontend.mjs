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

/* Everything the shipped page loads, copied under the name it already has.

   Every path here is the same in the repository and in dist, and that is the
   point rather than a convenience. `app.js` used to be listed on its own and
   copied to `dist/app.js`, while the compiler emits `js/app.js` and index.html
   asked for `js/app.js` - so the one file with a name to translate was also the
   one file being read from somewhere nobody edited.

   It was a hand-written app.js from before the TypeScript port, left in the
   repository root since September. Every desktop build shipped it, talking to
   freshly compiled adapters, and the walkthrough reported against it. Nothing
   failed: the file parsed, defined every function the page called, and threw
   nothing. The symptom was a clear button that was never wired and a colour
   pick that never ran - both of which exist, in the sources, and were not in the
   artefact.

   A build that reads a file nobody edits any more is not a build failing. It is
   a build quietly doing something other than what it says. Hence no name
   translation here, and hence the check at the bottom. */
const FILES = [
  'index.html',
  'styles.css',
  'styles-vidstack.css',
  'js/app.js',
  'js/mime.js',
  'js/source-web.js',
  'js/source-tauri.js',
  'js/source-electron.js',
  'js/source.js',
  'js/media.js',
  'js/i18n.js',
  'js/menubar.js',
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

/* The build says it assembled dist/. It did - out of whatever was on disk. This
   asks the question that would have caught the stale app.js, cheaply, on every
   build rather than once when somebody noticed a button did nothing.

   Each id the page looks up must be defined in the app.js that was just copied.
   A missing one means dist/ is running a different program from the one in the
   repository, which is the failure with no error message. */
{
  const app = fs.readFileSync(path.join(OUT, 'js/app.js'), 'utf8');
  const wanted = ['clear-list', 'add-folder', 'mute', 'fs', 'side', 'stage', 'help', 'settings-modal'];
  const absent = wanted.filter((id) => !app.includes(`'${id}'`) && !app.includes(`"${id}"`));
  if (absent.length) {
    console.error(
      'build:web: dist/js/app.js does not know these elements: ' + absent.join(', ') +
      '\n           Either the TypeScript build did not run before this one, or the' +
      '\n           file being copied is not the one the sources produce.' +
      '\n           Run `npm run build:web`, which does both in order.',
    );
    process.exit(1);
  }
}

const bytes = fs.statSync(path.join(OUT, 'index.html')).size;
console.log(`build:web: dist/ assembled (${bytes} byte index.html)`);
