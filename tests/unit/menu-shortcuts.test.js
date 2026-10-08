/* The menu's keys, checked against the table.
 *
 * This is the guard for a whole family of bugs, and it is here because the family
 * is invisible from the page.
 *
 * Every accelerator in the Electron menu used to be a hardcoded string. The
 * settings table and the tooltips read the real binding, so they were always
 * right; the menu was a private copy that nobody compared against anything.
 * Reassigning a key in Settings moved the table and the tooltip and left the menu
 * naming the old one, and Clear Playlist advertised Cmd+Shift+X while the page
 * had always answered to Shift+X. Two spellings of one action, and both of them
 * worked - which is why nobody could see the problem and why it was reported as
 * "some shortcuts are broken".
 *
 * So the rules are narrow and checkable: no key is written down in the menu, and
 * every action the menu names exists in the table. Both would have caught it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const APP = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');
const MENUBAR = readFileSync(join(ROOT, 'src', 'ui', 'menubar.ts'), 'utf8');

/* The table, read out of the source rather than imported: it is a TypeScript
   module that cannot be loaded from here, and a test that keeps its own copy of
   the list would go stale exactly like the menu did. */
const tableIds = [...APP.matchAll(/\{ id: '([a-zA-Z]+)', label: '[^']*', keys: \[([^\]]*)\] \}/g)]
  .map((m) => ({ id: m[1], keys: m[2] }));

describe('the in-page menu bar', () => {
  it('has a table to read', () => {
    /* If this fails, the matcher above has drifted from the source and every
       other check in this file is passing for the wrong reason. */
    expect(tableIds.length).toBeGreaterThan(15);
    expect(tableIds.map((e) => e.id)).toContain('playPause');
    expect(tableIds.map((e) => e.id)).toContain('mute');
  });

  it('reads every key it shows from the shortcut table', () => {
    /* The accelerators on the menu are shown from the same spelling the settings
       page and the tooltips use - the table's. A literal in the menu bar would
       be a second answer, and two answers is the bug this file exists for. */
    for (const m of MENUBAR.matchAll(/accel: '([^']+)'/g)) {
      expect(tableIds.map((e) => e.id),
        `the menu names accel "${m[1]}", which is not in the table`).toContain(m[1]);
    }
  });

  it('sends only commands the app actually handles', () => {
    /* A command the app does not know is a menu item that does nothing. The
       exception is `quit`, which goes to the shell rather than to the page. */
    /* Quoted (`'open-files':`) and unquoted (`fullscreen:`) alike. */
    const handled = new Set([...APP.matchAll(/^  '?([a-z-]+)'?:/gm)].map((m) => m[1]));
    handled.add('quit');
    for (const m of MENUBAR.matchAll(/command: '([^']+)'/g)) {
      expect([...handled],
        `the menu sends "${m[1]}", which nothing in the app handles`).toContain(m[1]);
    }
  });

  it('every heading shows its way in through Alt', () => {
    /* The headings open with Alt+letter. One letter each, and no two the same,
       because a register of ouvres that share an Alt does not open two menus - it
       opens whichever the browser liked. */
    const alts = [...MENUBAR.matchAll(/alt: '([A-Z])'/g)].map((m) => m[1]);
    expect(alts.length, 'every heading needs an Alt letter').toBeGreaterThanOrEqual(6);
    expect(new Set(alts).size, 'two headings share an Alt key').toBe(alts.length);
  });

  it('names every action with a string that exists in both languages', () => {
    /* A label key that is not in the table of strings prints as the key itself,
       so the settings page would show "bar.addFiles" where it should show what
       the action is called. Checked against both languages, because a key added
       to English and forgotten in Arabic is half a translation. */
    const i18n = readFileSync(join(ROOT, 'src', 'ui', 'i18n.ts'), 'utf8');
    const missing = [];
    for (const entry of APP.matchAll(/\{ id: '([a-zA-Z]+)', label: '([^']+)'/g)) {
      const [, id, label] = entry;
      const times = (i18n.match(new RegExp(`'${label}'`, 'g')) || []).length;
      if (times < 2) missing.push(`${id} wants ${label}, found ${times}`);
    }
    expect(missing,
      'these actions are labelled with a string that is not in both languages').toEqual([]);
  });

  /* The top-level items and the letters Alt reaches them by.

     Read out of the source rather than listed here, so a menu that grows a heading
     is covered without this being told. The shape being looked for is a label that
     carries its own shortcut as text - "Info (Alt+&I)" - because a menu label is
     only ever text, and the one thing it is used for here is telling you what the
     key is. */
});
