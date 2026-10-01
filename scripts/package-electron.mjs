/* Packages the Electron app for a platform.

   @electron/packager rather than electron-builder, for one reason: it does one
   thing. It takes a directory and an Electron version and produces a runnable
   application, with no signing step, no auto-update configuration and no
   opinion about how the app should be laid out on disk afterwards. Everything
   this project wants from a packager is in that sentence.

   Both targets are built from the same directory and the same dist/, so the
   Linux and Windows applications are the same application. */

import { packager } from '@electron/packager';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* One output directory per platform, and never artifacts/ itself.

   @electron/packager's `overwrite` deletes the whole `out` directory before it
   starts. Pointing it at artifacts/ therefore deleted the Tauri builds sitting
   beside it - which is how two finished binaries were lost in about a second.
   A packager that empties its output directory gets a directory of its own. */
const outFor = (platform) => path.join(ROOT, 'artifacts', `electron-${platform}`);

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('package: dist/ is missing - run `npm run build:web` first');
  process.exit(1);
}

/* The pinned version matters: a packaged app carries the runtime it was built
   against, and unpinned it would silently change under the client. */
const ELECTRON_VERSION = '41.10.7';

const platforms = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = platforms.length ? platforms : ['linux', 'win32'];

const targets = wanted.map((platform) => ({
  platform: platform === 'win32' ? 'win32' : 'linux',
  out: outFor(platform === 'win32' ? 'windows' : 'linux'),
  exec: platform === 'win32' ? 'CustomMediaPlayer' : 'custom-media-player',
}));

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

packager({
  dir: path.join(ROOT, 'shells', 'electron'),
  overwrite: true,
  asar: true,
  /* Declared above and forgotten here, which is why the first run failed with
     "Unable to determine Electron version". The version has to be pinned: a
     packaged app carries the runtime it was built against, and left to itself
     the packager would quietly change it under the client. */
  electronVersion: ELECTRON_VERSION,
  appVersion: '1.0.0',
  appCopyright: 'MIT',
  /* Copied into the app directory. packager requires these to come from the
     root package.json rather than the app's own, and says so only in a stack. */
  name: 'custom-media-player',
  description: 'A media player that keeps real file paths, so a playlist survives a restart.',
  executableName: 'custom-media-player',
  targets,
})
  .then((results) => {
    const { execSync } = require('node:child_process');
    for (const built of results) {
      const size = execSync(`du -sh "${built}"`).toString().trim().split('\t')[0];
      console.log(`package: ${built}  (${size})`);
    }
    /* An explicit exit. Awaiting the packager's promise at the top level of a
       module left the process to exit on its own schedule and print
       "unsettled top-level await" instead of a result - the work finished, the
       exit did not. */
    process.exit(0);
  })
  .catch((err) => {
    console.error('package: failed -', err && err.message ? err.message : err);
    process.exit(1);
  });
