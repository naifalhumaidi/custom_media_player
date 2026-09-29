/* Localisation: the two tables, digit formatting, plurals, and the sweep that
   rewrites the document. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../helpers/app-harness.js';

const I18N_SRC = fs.readFileSync(path.join(ROOT, 'js/i18n.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* A minimal document, so the module under test does not depend on the app's
   markup - the markup is checked against the tables separately below. */
function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  dom.window.eval(I18N_SRC);
  return dom;
}

let dom;
let I18n;

beforeEach(() => {
  dom = boot();
  I18n = dom.window.I18n;
});

afterEach(() => {
  dom.window.close();
});

describe('the string tables', () => {
  /* A key present in one language and missing from the other renders as the key
     itself, which the user would read verbatim. The tables are not exported, so
     this compares the two literals in the shipped source. */
  it('every English key has an Arabic counterpart', () => {
    const enBlock = I18N_SRC.slice(I18N_SRC.indexOf('en: {'), I18N_SRC.indexOf('ar: {'));
    const arBlock = I18N_SRC.slice(I18N_SRC.indexOf('ar: {'));

    const keysOf = (block) => {
      const found = new Set();
      for (const m of block.matchAll(/^\s{6}'([^']+)':/gm)) found.add(m[1]);
      return found;
    };
    const en = keysOf(enBlock);
    const ar = keysOf(arBlock);

    expect(en.size).toBeGreaterThan(50);
    expect(ar.size).toBeGreaterThan(50);
    expect([...en].filter((k) => !ar.has(k))).toEqual([]);
    expect([...ar].filter((k) => !en.has(k))).toEqual([]);
  });

  it('every data-i18n attribute in the markup resolves to a real key', () => {
    const used = [...MARKUP.matchAll(/data-i18n(?:-title|-aria|-alt)?="([^"]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(30);
    const missing = [...new Set(used)].filter((key) => I18n.t(key) === key);
    expect(missing).toEqual([]);
  });

  it('no table entry is dead weight', () => {
    const referenced = new Set([
      ...[...MARKUP.matchAll(/data-i18n(?:-title|-aria|-alt)?="([^"]+)"/g)].map((m) => m[1]),
    ]);
    /* keys the app builds in JS */
    for (const file of ['app.js', 'js/settings.js', 'js/i18n.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of src.matchAll(/\bt\('([^']+)'/g)) referenced.add(m[1]);
    }
    const enBlock = I18N_SRC.slice(I18N_SRC.indexOf('en: {'), I18N_SRC.indexOf('ar: {'));
    const keys = [...new Set([...enBlock.matchAll(/^\s{6}'([^']+)':/gm)].map((m) => m[1]))];
    expect(keys.filter((k) => !referenced.has(k))).toEqual([]);
  });
});

describe('t()', () => {
  it('resolves a key in the active language', () => {
    expect(I18n.t('app.title')).toBe('Media Tools');
    I18n.setLang('ar');
    expect(I18n.t('app.title')).toBeTruthy();
    expect(I18n.t('app.title')).not.toBe('Media Tools');
  });

  it('returns the key itself when nothing matches, rather than undefined', () => {
    expect(I18n.t('no.such.key')).toBe('no.such.key');
  });

  it('fills {placeholders}', () => {
    expect(I18n.t('panel.items', { n: 7 })).toBe('7 items');
    expect(I18n.t('panel.itemsTotal', { n: 7, time: '4:00' })).toBe('7 items · 4:00');
  });

  it('replaces every occurrence, not just the first', () => {
    const got = I18n.t('panel.itemsTotal', { n: '3', time: '4:00' });
    expect(got).toBe('3 items · 4:00');
  });

  it('picks the right English plural form', () => {
    expect(I18n.t('panel.items', { n: '1' })).toBe('1 item');
    expect(I18n.t('panel.items', { n: '2' })).toBe('2 items');
    expect(I18n.t('panel.items', { n: 0 })).toBe('0 items');
  });

  it('uses Arabic plural categories, not a single form for every count', () => {
    I18n.setLang('ar');
    const zero = I18n.t('panel.items', { n: 0 });
    const one = I18n.t('panel.items', { n: 1 });
    const two = I18n.t('panel.items', { n: 2 });
    const few = I18n.t('panel.items', { n: 3 });
    const many = I18n.t('panel.items', { n: 11 });
    expect(new Set([zero, one, two, few, many]).size).toBeGreaterThan(3);
  });

  it('picks the Arabic category from digits the caller already formatted', () => {
    /* updateTotal() passes num(count), which in Arabic is Arabic-Indic digits.
       Number() cannot read those, and Intl.PluralRules answers "other" for
       NaN - so the six forms silently collapsed to one. */
    I18n.setLang('ar');
    /* the digit glyphs legitimately differ - what must match is the chosen
       form, so compare the text with the digits stripped out */
    const words = (n) => I18n.t('panel.items', { n: I18n.num(n) }).replace(/[٠-٩\d]/g, '');
    for (const n of [0, 1, 2, 3, 11]) {
      expect(words(n), `count ${n} picked the wrong Arabic form`)
        .toBe(I18n.t('panel.items', { n }).replace(/[٠-٩\d]/g, ''));
    }
    /* and they are genuinely different forms, not all "other" */
    expect(new Set([1, 2, 3, 11].map(words)).size).toBeGreaterThan(2);
  });

  it('a plural set asked for with no count returns text, not an object', () => {
    expect(typeof I18n.t('panel.items')).toBe('string');
    expect(typeof I18n.t('panel.itemsTotal')).toBe('string');
  });
});

describe('num()', () => {
  it('formats in the active language', () => {
    expect(I18n.num(1234)).toBe('1,234');
    I18n.setLang('ar');
    /* Arabic-Indic digits, because a bare "ar" locale resolves to the Latin
       numbering system in current CLDR */
    expect(I18n.num(1234)).toBe('١٬٢٣٤');
  });

  it('never throws on bad input', () => {
    expect(() => I18n.num(NaN)).not.toThrow();
    expect(typeof I18n.num(undefined)).toBe('string');
  });

  it('produces digits the time formatter can take apart one at a time', () => {
    I18n.setLang('ar');
    /* the formatter pads by digit, so each digit must format on its own */
    expect(I18n.num(0)).toHaveLength(1);
    expect(I18n.num(7)).toHaveLength(1);
  });
});

describe('setLang()', () => {
  it('ignores an unknown language and keeps the current one', () => {
    expect(I18n.setLang('fr')).toBe('en');
    expect(I18n.getLang()).toBe('en');
  });

  it('sets the document language and direction', () => {
    I18n.setLang('ar');
    expect(dom.window.document.documentElement.lang).toBe('ar');
    expect(dom.window.document.documentElement.dir).toBe('rtl');
    I18n.setLang('en');
    expect(dom.window.document.documentElement.dir).toBe('ltr');
  });

  it('still re-applies the document on a switch to the same language', () => {
    /* the stored language is often already active at boot, and a no-op switch
       must not leave the markup untranslated */
    dom.window.document.body.innerHTML = '<span data-i18n="app.title"></span>';
    I18n.setLang('en');
    expect(dom.window.document.querySelector('[data-i18n]').textContent).toBe('Media Tools');
  });

  it('notifies listeners once per real change', () => {
    let calls = 0;
    I18n.onChange(() => { calls += 1; });
    I18n.setLang('ar');
    expect(calls).toBe(1);
    I18n.setLang('ar');
    expect(calls).toBe(1);
  });

  it('a failing listener does not stop the others, or the switch itself', () => {
    const seen = [];
    I18n.onChange(() => { throw new Error('boom'); });
    I18n.onChange(() => seen.push('second'));
    expect(() => I18n.setLang('ar')).not.toThrow();
    expect(I18n.getLang()).toBe('ar');
    expect(seen).toEqual(['second']);
  });
});

describe('apply()', () => {
  it('rewrites text, titles, accessible names and alt text', () => {
    dom.window.document.body.innerHTML = `
      <span data-i18n="app.title"></span>
      <button data-i18n-title="bar.open"></button>
      <button data-i18n-aria="bar.mute"></button>
      <img data-i18n-alt="app.logoAlt">
    `;
    I18n.apply();
    const d = dom.window.document;
    expect(d.querySelector('[data-i18n]').textContent).toBe('Media Tools');
    expect(d.querySelector('[data-i18n-title]').title).toBeTruthy();
    expect(d.querySelector('[data-i18n-aria]').getAttribute('aria-label')).toBe('Mute');
    expect(d.querySelector('[data-i18n-alt]').alt).toBe('Media Tools');
  });

  it('can be scoped to part of the document', () => {
    I18n.setLang('ar');
    /* inserted after the language switch, so only a scoped sweep can reach it */
    dom.window.document.body.innerHTML = `
      <div id="part"><span data-i18n="app.title"></span></div>
      <span data-i18n="app.title"></span>
    `;
    I18n.apply(dom.window.document.getElementById('part'));
    expect(dom.window.document.querySelector('#part span').textContent).not.toBe('Media Tools');
    expect(dom.window.document.querySelector('body > span').textContent).toBe('');
  });

  it('the keyboard hints name a key the handler actually matches', () => {
    /* a localised comma or question mark is a different code point, so
       following the tooltip would press a key that does nothing */
    I18n.setLang('ar');
    for (const [key, glyph] of [
      ['bar.previousKey', ','],
      ['bar.nextKey', '.'],
      ['bar.helpKey', '?'],
    ]) {
      expect(I18n.t(key)).toContain(glyph);
    }
  });
});

describe('detect()', () => {
  it('falls back to English for a language with no table', () => {
    expect(I18n.detect()).toBe('en');
  });
});
