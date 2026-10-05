/* Turning the page's shortcut table into Electron accelerators.
 *
 * Its own file, with no Electron in it, for one reason: it has to be testable.
 * Every accelerator in the menu used to be a hardcoded string, and the result was
 * a menu that could name a key the page did not answer to - which is what "some
 * shortcuts are broken" turned out to be. Reading the keys from the table instead
 * fixes that, but only for as long as nobody writes one down again, and a rule
 * nothing checks is a rule that quietly stops being true.
 *
 * The translation is the easy part to get wrong: the table spells a key the way a
 * person reads it, and Electron wants its own dialect. A wrong answer here is
 * invisible until somebody presses the key, which is why it is a function with
 * tests rather than a line inside a menu.
 */

/* The table's spellings, and what Electron calls the same thing. */
const GLYPHS = {
  '\u2190': 'Left',   /* the arrows are drawn in the table */
  '\u2191': 'Up',
  '\u2192': 'Right',
  '\u2193': 'Down',
  '\u2423': 'Space',  /* the mark for a key with nothing printed on it */
  ',': ',', '.': '.', '/': '/', ';': ';', "'": "'",
  '[': '[', ']': ']', '-': '-', '=': '=', '\\': '\\', '`': '`',
};

/* A keycap can carry two characters: the shifted one above and the one it makes
 * below. The table prints both, shifted first, because that is the order they are
 * read off the cap. The binding is the second one - the character the key
 * actually produces when pressed without a modifier. */
function oneCharacter(spelling) {
  const trimmed = String(spelling).trim();
  const parts = trimmed.split(' ');
  if (parts.length === 2 && parts.every((p) => p.length > 0)) return parts[1];
  return trimmed;
}

/* "Ctrl+," to "CmdOrCtrl+,". Nothing to nothing. */
function toElectronAccelerator(spelling) {
  if (!spelling) return undefined;
  /* Split on the modifier separator first, then take the printable half of the
     last part. The other order loses the modifier: "Ctrl+< ," cut on the space
     gives ["Ctrl+<", ","] and the answer is a bare comma. */
  const parts = String(spelling).trim().split('+');
  const tail = oneCharacter(parts.pop());
  const out = [];
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === 'ctrl' || m === 'control' || m === 'meta' || m === 'command') out.push('CmdOrCtrl');
    else if (m === 'shift') out.push('Shift');
    else if (m === 'alt') out.push('Alt');
  }
  /* A single character is a letter or a symbol; Electron wants it capitalised.
     Anything longer is a name it already knows, or a key the table should not
     have produced - passed through rather than guessed at. */
  out.push(GLYPHS[tail] || (tail.length === 1 ? tail.toUpperCase() : tail));
  return out.join('+');
}

/* The first key bound to an action. Undefined when the action is bound to
 * nothing, which is what an item with no key should say - and better than a
 * stale key from a table that no longer has it. */
function accelFor(bindings, id) {
  const keys = bindings && bindings[id];
  if (!keys || !keys.length) return undefined;
  return toElectronAccelerator(keys[0]);
}

module.exports = { toElectronAccelerator, accelFor, oneCharacter };