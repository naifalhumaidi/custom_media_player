/* Compiles src/ into js/, which is what index.html loads.

   esbuild rather than tsc, deliberately. The output is one classic script per
   source file - not a bundle - because index.html loads them in a fixed order
   with plain <script> tags and each one registers a global. A bundler would
   produce a single file and change how the page is put together, which is a
   restructuring nobody asked for and would leave the load order implicit.

   So: no bundling, no module graph, no import map. The same page, the same
   order, the same file names, and js/ stays readable in a browser's sources
   panel - which is the main thing lost by compiling at all.

   The output names are given explicitly rather than derived from the source
   layout. src/ is organised the way a person would want to read it
   (core, source, bridge, ui); js/ keeps the names index.html already asks for,
   so the page, the scripts that allowlist the files, and the tests that read
   them all stay as they were.

   tsc still does the real work, but only as a checker: `npm run typecheck`
   runs it with --noEmit, so the compiler's judgement applies to every build
   without emitting anything. */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/* The project root, which is the directory above this script's. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* out name -> source. The order is the order index.html loads them in, and the
   order matters: mime defines what a file is, the sources define how to reach
   one, the bridge picks a source, and app.js uses both. A file listed before
   something it depends on runs first and finds nothing. */
const ENTRY_POINTS = {
  mime: 'src/core/mime.ts',
  'source-web': 'src/source/browser.ts',
  'source-tauri': 'src/source/tauri.ts',
  'source-electron': 'src/source/electron.ts',
  source: 'src/source/index.ts',
  media: 'src/bridge/media.ts',
  i18n: 'src/ui/i18n.ts',
  menubar: 'src/ui/menubar.ts',
  settings: 'src/ui/settings.ts',
  app: 'src/app.ts',
};

const watched = process.argv.includes('--watch');

const options = {
  entryPoints: Object.fromEntries(
    Object.entries(ENTRY_POINTS).map(([name, file]) => [name, path.join(ROOT, file)]),
  ),
  outdir: path.join(ROOT, 'js'),
  /* Each file transpiled on its own. Legal only because every import in src/ is
     type-only and therefore erased - an import that survived would turn one of
     these into a module, and a <script> tag without type="module" would refuse
     to run it. `scripts/check-port.mjs` fails the build if that ever changes. */
  bundle: false,
  target: ['es2022'],
  platform: 'browser',
  charset: 'utf8',
  legalComments: 'none',
  keepNames: true,
  sourcemap: 'linked',
  logLevel: 'warning',
};

if (watched) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('build:web: watching src/');
} else {
  await build(options);

  /* A compile that silently produced nothing would otherwise be found out by
     opening the app, so it is checked here where it costs a millisecond. */
  for (const name of Object.keys(ENTRY_POINTS)) {
    const out = path.join(ROOT, 'js', `${name}.js`);
    const size = readFileSync(out, 'utf8').length;
    if (size < 40) throw new Error(`build:web: js/${name}.js is ${size} bytes - the compile produced nothing`);
  }
  console.log(`build:web: ${Object.keys(ENTRY_POINTS).length} files compiled into js/`);
}