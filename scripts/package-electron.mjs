/* Packages the Electron app for a platform.
 *
 * What comes out is an unpacked directory, not an installer: double-click the
 * executable and it runs, with nothing to install and nothing to register. That
 * is what makes it usable for checking a build on a machine that will never keep
 * it.
 *
 * Both targets are built from the same staged directory and the same dist/, so
 * the Linux and Windows applications are the same application.
 */

import { execFileSync } from 'node:child_process';
import { downloadArtifact } from '@electron/get';
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'shells', 'electron');

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('package: dist/ is missing - run `npm run build:web` first');
  process.exit(1);
}

/* The pinned version matters: a packaged app carries the runtime it was built
   against, and unpinned it would silently change under the client. This is the
   same runtime the Linux desktop tests run against, so a build copied to another
   machine behaves like the one that was tested here. */
const ELECTRON_VERSION = '41.10.7';

/* Where the finished applications are collected: `artifacts/windows/` or
   `artifacts/linux/`.

   Never `artifacts/` itself. The packaged application is written straight into
   this folder, but only ever into its own subdirectory - a build that took out
   the parent would take the other shell's finished binaries with it, which is how
   two of them were lost in about a second. */
const EXE_NAME = 'custom-media-player';
const collectFor = (platform) => path.join(ROOT, 'artifacts', platform === 'win32' ? 'windows' : 'linux');
const appNameFor = (platform, arch) => `${EXE_NAME}-${platform}-${arch}`;

/* What actually goes into the application directory.
 *
 * The old version packaged `shells/electron` as-is. That directory has the three
 * JavaScript files and a package.json, and no `dist/` - so the packaged app
 * started, found no `dist/index.html` next to itself, and threw "cannot find the
 * frontend" before a window appeared. Which looks exactly like a packager that
 * failed, and is why this said so little.
 *
 * `main.cjs` looks for the frontend next to itself, then one level up, then two.
 * So the whole thing is staged flat - entry point, preload, accelerators and the
 * built frontend together - and that layout is the one the code already expects.
 * Staged rather than copied into `shells/electron` so the source tree does not
 * collect a second copy of dist/ that has to be kept in step with the first. */
function stage() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cmp-package-'));
  for (const file of ['package.json', 'main.cjs', 'preload.cjs', 'accelerators.cjs']) {
    const from = path.join(SHELL, file);
    if (existsSync(from)) cpSync(from, path.join(dir, file));
  }
  cpSync(path.join(ROOT, 'dist'), path.join(dir, 'dist'), { recursive: true });
  return dir;
}

/* Whatever the runner hands through as a platform name, and nothing else.

   `npm run package:electron -- win32` puts `win32` in argv[2]; running the file
   directly puts it there too. Anything that is not one of the names this can
   actually build is dropped rather than passed on, because an unknown name does
   not fail - it means a build meant for Windows quietly comes out for the host
   machine, prints nothing wrong and hands over a folder that cannot run where it
   was meant to. Said here because it happened. */
const KNOWN = new Set(['linux', 'win32', 'darwin']);
const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const platforms = (asked.length ? asked : ['win32']).filter((p) => KNOWN.has(p));

if (!platforms.length) {
  console.error(`package: no known platform in ${JSON.stringify(asked)} - expected one of ${[...KNOWN].join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * The runtime zip, and why this does not use @electron/packager.
 *
 * @electron/packager hung. Not failed - hung: it printed "Packaging app for
 * platform win32 x64", held the event loop open at zero percent CPU with no
 * child processes, and never resolved. Where it stopped is the one thing worth
 * writing down: after it has the zip, the next line it logs is
 *
 *     Extracting <cached zip> to /tmp/electron-packager/win32-x64-template-XXXX
 *
 * and it never leaves that line. The zip is fine - `unzip` unpacks the same
 * 143 MB file, 345 MB on disk, in under two seconds. It is extractor step
 * itself that does not finish, and there is nothing in the options or the
 * version that makes it do so.
 *
 * So the two things the packager was doing that this actually needed are done
 * here instead, in full view: unpack the runtime, and lay the staged app inside
 * it. That is all a packager does that matters for an unpacked build - the rest
 * is signing and code signing configuration this project does not want, and the
 * one useful thing it took away, `asar`, is a trade rather than a need.
 * ------------------------------------------------------------------------- */

/* Where the runtime zip lives once it has been fetched. Its own cache, which
   means the second build and every build after it costs no network at all - the
   only time this pays for a download is a version change, a different machine,
   or a deleted cache. */
function cachedZip(platform, arch) {
  const pattern = path.join(homedir(), '.cache', 'electron', '*', `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`);
  const found = globSync(pattern);
  return found.length ? found[0] : null;
}

/* Unpack the runtime into `dest`.

   A command, not a library, and that is the whole point of this section: the
   library that would have done it is the one that stopped. Which command is
   whatever the machine has. */
function unpack(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const ways = [
    ['unzip', ['-qq', zip, '-d', dest]],
    ['bsdtar', ['-xf', zip, '-C', dest]],
    ['7z', ['x', '-bso0', '-bsp0', '-y', `-o${dest}`, zip]],
  ];
  for (const [cmd, args] of ways) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      return;
    } catch { /* not installed, or not able: the next one */ }
  }
  throw new Error(`cannot unpack ${zip} - need one of ${ways.map((w) => w[0]).join(', ')}`);
}

/* Build the application for one platform and architecture into its own folder
   under `artifacts/`.

   Returns the folder that was built. */
async function build(platform, arch, stageDir) {
  const outDir = path.join(collectFor(platform), appNameFor(platform, arch));

  const before = cachedZip(platform, arch);
  if (before) {
    console.log(`package: using the cached runtime ${path.basename(before)}`);
  } else {
    console.log(`package: fetching the Electron ${ELECTRON_VERSION} ${platform}-${arch} runtime (this is the one step that spends network)`);
  }
  const zip = await downloadArtifact({ version: ELECTRON_VERSION, platform, arch, artifactName: 'electron' });
  console.log(`package: runtime ${path.basename(zip)}`);

  /* Starts fresh rather than merging into a previous build. A stale file left
     next to a new one is worse than no file, and it is silent. */
  rmSync(outDir, { recursive: true, force: true });
  unpack(zip, outDir);

  /* The runtime calls itself `electron`; the application is this one. Same rename
     the packager would have done, for a window and a taskbar that say what the
     thing is. Windows also has the app's own name in the window title from
     package.json's productName, so the two agree. */
  const from = path.join(outDir, platform === 'win32' ? 'electron.exe' : 'electron');
  const to = path.join(outDir, platform === 'win32' ? `${EXE_NAME}.exe` : EXE_NAME);
  if (existsSync(from)) {
    rmSync(to, { force: true });
    execFileSync('mv', [from, to]);
  }

  /* The runtime ships a demo app. Removing it matters: a build that still has
     `default_app.asar` in resources/ and no `app` will happily load the demo
     instead of throwing, and the window that opens is Electron's default, which
     looks like a successful build. */
  rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });

  /* The staged application, as a plain directory rather than an asar archive.
   *
   * A directory because it is one fewer thing to be wrong: `findRoot` resolves
   * to the app root either way, and a build handed to another machine for
   * testing is more useful when its contents can be read out of it. It is also
   * the layout this app was already tested against. */
  cpSync(stageDir, path.join(outDir, 'resources', 'app'), { recursive: true });

  return outDir;
}

const stageDir = stage();
console.log(`package: staged ${stageDir}`);

/* One at a time: each build unpacks ~345 MB, and two at once would need two
   copies of it side by side. */
(async () => {
  const built = [];
  for (const platform of platforms) {
    console.log(`package: building for ${platform}`);
    const dir = await build(platform, 'x64', stageDir);
    built.push([platform, dir]);
  }
  for (const [platform, dir] of built) {
    console.log(`package: ${dir}`);
  }
  console.log(`package: done - ${built.length === 1 ? 'the executable runs' : 'each executable runs'} as it is, nothing to install`);
  rmSync(stageDir, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error('package: failed -', err && err.message ? err.message : err);
  rmSync(stageDir, { recursive: true, force: true });
  process.exit(1);
});
