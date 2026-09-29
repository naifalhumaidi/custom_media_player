/* Loads the app's classic scripts into the jsdom window.

   The app ships as plain <script> tags, not ES modules, so each file is read
   from disk and evaluated in the window exactly as the browser would. Reading
   the shipped file (rather than a copy in the test) is the point: a test cannot
   silently drift away from the code it claims to cover. */

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

/* The order index.html declares them in. The dialogs are parsed by jsdom before
   anything runs, which is what lets settings.wire() bind successfully. */
export const SCRIPTS = [
  'js/source-web.js',
  'js/source.js',
  'js/media.js',
  'js/i18n.js',
  'js/settings.js',
  'app.js',
];

export function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/* Evaluate one shipped script against the current jsdom window. */
export function loadScript(file, target = globalThis.window) {
  // eslint-disable-next-line no-eval
  target.eval(readSource(file));
  return target;
}

/* Load a subset, for tests that only need one module. */
export function loadScripts(files, target = globalThis.window) {
  for (const file of files) loadScript(file, target);
  return target;
}
