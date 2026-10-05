/* The final pass.
 *
 * Everything a person can do to this app, driven through a real window on a
 * throwaway framebuffer, with the audio on a null sink. It exists because the
 * suites before it were written for one defect each, and a defect nobody thought
 * of has no suite.
 *
 * The shape is scenarios rather than assertions scattered across files: each area
 * does a sequence of things a person would actually do, and checks the state
 * after each one. A check that fails prints what it wanted and what it got, and
 * names the scenario it belongs to - a suite that only says "FAILED" is a suite
 * nobody can act on.
 *
 * Usage:  /usr/lib/electron41/electron --mute-audio tests/e2e/final.cjs
 *
 * The window must be headless. Run it through tests/e2e/run.sh, which also mutes
 * the audio; running it directly mutes audio but still needs a display.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const H = require('./lib/harness.cjs');

const DIR = path.join(os.tmpdir(), 'mt-e2e', 'final');
fs.mkdirSync(DIR, { recursive: true });

/* Steps whose value is an object are "ok" checks; anything else is reported for
   the record. A step that is neither is a suite that has drifted from the page. */
const isCheck = (v) => v && typeof v === 'object' && 'ok' in v;

async function main() {
  const win = await H.open({ width: 1280, height: 800 });
  /* The page's own account of itself, which is the only place a swallowed error
     shows up. Filtered out of the pass/fail count - a warning is information,
     not a defect - but never dropped, because "it printed nothing" and "it
     printed four warnings" are different states. */
  const said = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) said.push(message);
  });

  /* A previous run's playlist would be restored over this one, and every count
     below would then be off by however many tracks it left behind. */
  await H.fresh(win);

  const page = path.join(__dirname, 'finalpage.js');
  let out;
  try {
    out = await H.runScript(win, page);
  } catch (err) {
    console.log(`  the page threw before it finished: ${err && err.message}`);
    win.destroy();
    process.exit(1);
  }

  let pass = 0;
  const failures = [];
  const notes = [];

  /* A page that died part way through used to be reported as a pass.

     The steps it had managed to write were counted, the ones after the throw were
     never written, and the summary said "PASSED all 11 checks" with a green exit -
     because the throw itself was recorded as a note, and notes are not verdicts.
     The same mistake as the shortcuts, one level up: the one line that said
     something had gone wrong was the one line nothing counted.

     So a throw is a failure, and a run that wrote far fewer steps than it should
     has failed too. Both are silent otherwise, which is the whole problem. */
  const threw = out.steps.find(([name]) => name === 'THREW');
  if (threw) {
    console.log(`  FAIL the page threw before it finished`);
    console.log(`       ${threw[1]}`);
  }

  for (const [name, value] of out.steps) {
    if (name === 'THREW') continue;
    if (isCheck(value)) {
      if (value.ok) {
        pass++;
      } else {
        failures.push(name);
        console.log(`  FAIL ${name}`);
        console.log(`       got ${JSON.stringify(value.got)}`);
      }
    } else {
      notes.push([name, value]);
      console.log(`  ---- ${name}`);
      console.log(`       ${value}`);
    }
  }

  /* The layout, at every size a person might use. Measured here rather than in
     the page because a page cannot resize its own window - and measured with the
     playlist still loaded, which is when a layout problem is worth knowing about.
     A control that is clipped is a control that does not exist, however well it
     looks at the size where it was designed. */
  const SIZES = [[1600, 1000], [1440, 900], [1280, 800], [1100, 700],
    [1024, 640], [900, 600], [800, 520], [680, 480], [600, 440], [520, 420], [480, 420]];
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 420));
    const m = await win.webContents.executeJavaScript('window.__measureLayout()', true);
    const clipped = m.clipped.length ? m.clipped.join(' ') : 'everything reachable';
    const bad = !m.inside || m.clipped.length || m.scrollbar;
    if (bad) {
      failures.push('layout at ' + w + 'x' + h);
      console.log(`  FAIL layout at ${w}x${h}`);
      console.log(`       bar ${m.bar} inside=${m.inside} sideways=${m.scrollbar}`);
      console.log(`       clipped: ${clipped}`);
    } else {
      pass++;
      console.log(`  ok   layout at ${w + 'x' + h}`.padEnd(50) + `bar ${m.bar}, ${clipped}`);
    }
  }
  win.setContentSize(1280, 800);
  await new Promise((r) => setTimeout(r, 400));

  await H.shot(win, path.join(DIR, 'final.png'));

  /* What the page said while all of that happened. */
  if (said.length) {
    console.log('  ---- the page said');
    for (const line of said.slice(0, 25)) console.log(`       ${line.slice(0, 160)}`);
  }

  /* A floor, not a fixed number: the count grows as checks are added, and a suite
     that fails halfway through must not be able to pass by writing a few. */
  const FLOOR = 150;
  if (!threw && pass < FLOOR) {
    console.log(`  FAIL only ${pass} checks ran, which is far fewer than there are`);
    failures.push('the suite did not finish');
  }
  if (threw) failures.push('the page threw');

  console.log('');
  /* Spoken the way the other suites speak, so `run.sh` reports this one
     identically to the rest rather than as a blank beside them. */
  console.log(failures.length ? `FAILED ${failures.length} problems` : `PASSED all ${pass} checks`);
  if (failures.length) {
    console.log('  failed:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  win.destroy();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SUITE CRASHED:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});