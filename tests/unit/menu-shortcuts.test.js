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

import { toElectronAccelerator, accelFor, oneCharacter } from '../../shells/electron/accelerators.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = readFileSync(join(ROOT, 'shells', 'electron', 'main.cjs'), 'utf8');
const APP = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');

/* The table, read out of the source rather than imported: it is a TypeScript
   module that cannot be loaded from here, and a test that keeps its own copy of
   the list would go stale exactly like the menu did. */
const tableIds = [...APP.matchAll(/\{ id: '([a-zA-Z]+)', label: '[^']*', keys: \[([^\]]*)\] \}/g)]
  .map((m) => ({ id: m[1], keys: m[2] }));

describe("the desktop menu's shortcuts", () => {
  it('has a table to read', () => {
    /* If this fails, the matcher above has drifted from the source and every
       other check in this file is passing for the wrong reason. */
    expect(tableIds.length).toBeGreaterThan(15);
    expect(tableIds.map((e) => e.id)).toContain('playPause');
    expect(tableIds.map((e) => e.id)).toContain('mute');
  });

  it('writes no accelerator down by hand', () => {
    /* A literal accelerator is the whole bug. It cannot be compared with the
       table, so it drifts the first time a key is reassigned, and nothing else
       in the build notices. */
    const literals = [...MAIN.matchAll(/accelerator: '([^']*)'/g)].map((m) => m[1]);
    expect(literals,
      'these accelerators are written down instead of read from the shortcut table:\n  '
      + literals.join('\n  ')).toEqual([]);
  });

  it('names only actions that exist in the table', () => {
    const named = [...MAIN.matchAll(/accelFor\(B, '([^']+)'\)/g)].map((m) => m[1]);
    expect(named.length,
      'no menu item reads the table, so the menu cannot follow a reassignment').toBeGreaterThan(10);

    const known = new Set(tableIds.map((e) => e.id));
    const unknown = named.filter((id) => !known.has(id));
    expect(unknown,
      'the menu asks for a key for an action the table does not have, so it would show none:\n  '
      + unknown.join('\n  ')).toEqual([]);
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
  it('names every top-level item with the key that opens it', () => {
    const headings = [...MAIN.matchAll(/^ {6}label: '([A-Za-z]+) \(Alt\+&([A-Z])\)',$/gm)]
      .map((m) => ({ name: m[1], key: m[2] }));

    expect(headings.length,
      'the menu bar should name its shortcut on every top-level item').toBeGreaterThanOrEqual(6);
    expect(headings.map((h) => h.name)).toEqual(
      expect.arrayContaining(['File', 'Edit', 'View', 'Playback', 'Info', 'Settings']));
  });

  it('gives no two headings the same Alt key', () => {
    const keys = [...MAIN.matchAll(/^ {6}label: '[A-Za-z]+ \(Alt\+&([A-Z])\)',$/gm)]
      .map((m) => m[1]);
    const seen = new Set();
    const clashes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(clashes, 'these Alt keys would open two menus at once').toEqual([]);
  });

  it('does not claim a bare letter that belongs to something else', () => {
    /* A heading saying "Settings (S)" would send people to S, which is Stretch.
         Every heading has to name Alt, or the letter in brackets has to be one
         nothing else is bound to. */
    const bare = [...MAIN.matchAll(/^ {6}label: '[A-Za-z]+ \(([A-Z])\)',$/gm)].map((m) => m[1]);
    expect(bare,
      'these headings show a bare letter that would do something else').toEqual([]);
  });

  it('gives an item no key rather than a stale one', () => {
    expect(accelFor({}, 'mute')).toBeUndefined();
    expect(accelFor({ mute: [] }, 'mute')).toBeUndefined();
    expect(accelFor({ mute: ['M'] }, 'mute')).toBe('M');
  });
});

describe('translating the table into an Electron accelerator', () => {
  it('keeps a letter a capital letter', () => {
    expect(toElectronAccelerator('M')).toBe('M');
    expect(toElectronAccelerator('F')).toBe('F');
  });

  it('names the arrows rather than passing the drawing through', () => {
    expect(toElectronAccelerator('\u2190')).toBe('Left');
    expect(toElectronAccelerator('\u2193')).toBe('Down');
  });

  it('names the spacebar', () => {
    expect(toElectronAccelerator('\u2423')).toBe('Space');
  });

  it('writes Ctrl as CmdOrCtrl, which is what a Mac wants and a PC accepts', () => {
    expect(toElectronAccelerator('Ctrl+,')).toBe('CmdOrCtrl+,');
    expect(toElectronAccelerator('Shift+X')).toBe('Shift+X');
  });

  it('takes the printable half of a keycap that carries two characters', () => {
    /* The table prints "< ," for the comma key, shifted first. The binding is the
       comma: pressing "<" means Shift+comma, which is a different key. */
    expect(oneCharacter('< ,')).toBe(',');
    expect(oneCharacter('> .')).toBe('.');
    expect(toElectronAccelerator('< ,')).toBe(',');
    expect(toElectronAccelerator('Ctrl+< ,')).toBe('CmdOrCtrl+,');
  });

  it('translates every binding the table actually ships', () => {
    const missing = [];
    for (const entry of tableIds) {
      const keys = [...entry.keys.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      for (const key of keys) {
        const accel = toElectronAccelerator(key);
        if (!accel) missing.push(`${entry.id}: ${key}`);
      }
    }
    expect(missing,
      'these bindings would reach the menu with no key at all').toEqual([]);
  });
});