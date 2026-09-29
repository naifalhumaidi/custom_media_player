# Software architecture — Media Tools

The shape of the system: the layers, the dependencies between them, the rules
that keep it changeable, and the trade-offs each rule buys. Written for someone
who has to work on this.

**English | [العربية](architecture.ar.md)**

---

## 1. The architecture in one paragraph

A single-page application in vanilla JavaScript, served as static files, with
two boundaries drawn very deliberately — one around the playback library and
one around the file source. Everything else is ordinary stateful DOM code. The
boundaries exist so that the two most likely things to change can each change
without touching the other, and so that the ~900-line application module has
no idea what a `<video>` element is.

## 2. Layers and the dependency rule

```
┌──────────────────────────────────────────────────────────────┐
│  index.html          markup + the inline SVG sprite          │  no logic
├──────────────────────────────────────────────────────────────┤
│  app.js              playlist · panel · drops · keys · dialogs│
│      │               · fit modes · persistence                │
│      │  calls exactly four globals:                          │
│      ├──▶ MediaBridge      (js/media.js)                      │
│      ├──▶ MediaFileSource  (js/source.js → an adapter)       │
│      ├──▶ I18n             (js/i18n.js)                      │
│      └──▶ MediaSettings    (js/settings.js)                  │
├──────────────────────────────────────────────────────────────┤
│  js/media.js         the ONLY file that knows a media        │
│                      library exists                          │
├──────────────────────────────────────────────────────────────┤
│  js/source-web.js     File → object URL · MIME · preferences  │
│  (or a Tauri adapter)      — implements js/source.js         │
├──────────────────────────────────────────────────────────────┤
│  vendor/vidstack.js   the playback library (MIT)             │
└──────────────────────────────────────────────────────────────┘

  serve.js             static files over loopback. Knows no app concept.
  styles.css           the chrome
  styles-vidstack.css  the library's own controls
```

**The rule: dependencies point down only.** `app.js` calls four globals and
imports nothing. Each of the four is a documented interface, not an
implementation detail. This is the property that makes the codebase small
enough to hold in your head.

`serve.js` is deliberately outside the diagram. It is not part of the
application; it is a way to put the application on a socket.

## 3. The two boundaries, and what they really cost

### 3.1 The playback boundary

**The rule:** `js/media.js` is the only file that knows a playback library
exists, and it is the escape hatch. Reverting to a bare `<video>` means
rewriting that file — not a refactor of the app.

**The honest version of the claim.** The *runtime* knowledge is fully
contained: property names, event names, the load lifecycle, the shortcuts, the
quirks. But the markup in `index.html` is built from `<media-*>` custom
elements, because the library renders the transport UI, and that cannot be
otherwise without abandoning the library's own accessibility work. The header
in `js/media.js` states this rather than claiming a guarantee it never had —
a boundary description you cannot trust is worse than none.

The interface:

| Member | Purpose |
|---|---|
| `init()` | idempotent; binds the library's events and clears its shortcuts |
| `load(item, kind, autoplay)` | swap the source, arm the seek and the autoplay |
| `clear()` | release everything, invalidate any load in flight |
| `on(event, fn)` | `time` · `play` · `pause` · `ended` · `error` · `blocked` · `volume` |
| `play` `pause` `toggle` `seekBy` | transport |
| `volume` `muted` `loop` `currentTime` `duration` `playing` | state |
| `paintTime` `paintVolume` | the sliders' fill, which the library leaves at 0% |
| `ownsArrowKey(target)` | whose arrow keys those are |
| `toggleFullscreen()` `fullscreen` `onFullscreenChange()` | fullscreen, on the stage |
| `ticket()` | which load is current |

Two of those exist purely so `app.js` does not have to know a library exists:
`ownsArrowKey` (which elements handle their own arrows) and
`paintTime`/`paintVolume` (which elements are the sliders). Before they were
added, `app.js` queried `media-time-slider` and `media-volume-slider` by name.

### 3.2 The file-source boundary

**The rule:** the interface is documented in `js/source.js` and **validated at
load**. A missing method is a load error naming the method, not a `TypeError`
inside an event handler an hour later.

```
canPersist()  → boolean      can a playlist survive a restart?
openFiles()   → Item[]       the picker
dropItems(e)  → Item[]       drag-and-drop
urlFor(item)  → string       something the player can load
release(item) → void         give back what urlFor took
loadState()   → state        preferences
saveState(s)  → void         and report a failure rather than swallow it
```

`dropItems` is the one method that takes a DOM event, and it is a wart. It
lives in the browser adapter, where a `DataTransfer` exists, but a desktop
shell delivers paths through a completely different route — so that method
will have to be reshaped, or supplemented, when the shell arrives. It is called
out in the file rather than left to be discovered.

## 4. State, and where it lives

| State | Home | Persisted |
|---|---|---|
| the playlist (`items`, `index`) | `app.js` closure | **no** — see below |
| playback (position, volume, mute, loop) | the media element | yes |
| view (fit, bar, panel) | `stage` dataset + classes | yes |
| language, logo, brand colour | `settings.js` | yes |
| strings | `i18n.js` tables | no |

The playlist's non-persistence is architectural, not an omission. A `blob:`
URL dies with the document and a `File` cannot be stored in `localStorage`, so
there is no representation of "this playlist" that survives a reload. The app
therefore refuses to pretend: `canPersist()` returns `false`, and `restore()`
will not rebuild a list the source cannot resolve. The coupling is enforced at
two points, so adding `'items'` to `PERSISTED` alone cannot produce a playlist
of dead rows.

## 5. Error handling

There is no error-handling framework, and there is not meant to be. The rules
are four, and they are uniform:

1. **A failure the user cannot see is a bug.** Anything that can fail for the
   user produces a notice. Nothing degrades to silence.
2. **Notices have the lifetime their meaning requires.** "Press play to start"
   describes the present and is retired when the media starts; "3 files cannot
   be played" describes the past and times out.
3. **A rejected promise at a background boundary is caught and logged.** The
   probe queue, the drop handlers, the save path and the fullscreen request all
   have an explicit failure path.
4. **A thrown error must not escape a caller that has already mutated state.**
   `load()` resolves its URL before touching the DOM, so a failure leaves
   nothing half-applied.

## 6. Styling

Two stylesheets, loaded in this order, and the order is load-bearing:

- `styles-vidstack.css` — the library's controls, reached through the `vds-`
  part classes. These are the parts inside its shadow roots.
- `styles.css` — the application's own chrome, plus the dialogs and the panel.

Two rules govern the whole layer:

**No borders.** A selected or focused thing is a flat background plus a 2px
*inset* edge. This is not a preference; the brief rules out hard edges, and an
outer `border` or `outline` reads as a stray grey line against near-black.
Everything that could draw one is neutralised individually: the UA focus ring,
the native scrollbar, `<input>` chrome, the colour swatch. A dedicated e2e
suite (`border2.cjs`) fails the build if a styled edge reappears.

**Colour is a token set, not a value.** The brand gold is published as custom
properties (`--gold`, `--gold-soft`, `--gold-strong`, `--gold-text`,
`--gold-dim`, `--enabled-bg/fg`, `--hover-bg/fg`), derived once from a single
validated colour. Changing the brand is one style write, and both stylesheets
follow. Derived from one parsed value on purpose: when they were computed
independently, an invalid colour split the palette in two — the raw fill in one
scheme and the derivatives in another.

## 7. Testing strategy

Three tiers, each answering a different question.

| Tier | Question it answers | Runtime |
|---|---|---|
| Unit (jsdom) | does the logic do the right thing? | ~25 s |
| End-to-end (headless Electron) | does it look and behave right? | ~4 min |
| Falsification | could it work without the library at all? | seconds |

**The unit tests load the real markup.** Not a stub — the actual
`index.html`, parsed, with the actual scripts evaluated in the same order the
page declares. A hand-written stub would be faster to write and would drift
from the shipped code within a day, at which point the tests are measuring
their own fiction.

**Only the library is faked**, because that is the boundary the architecture
already draws. The fake is deliberately not a stub: it emits the outgoing
track's time as a source is torn down, can be told to fail a load, and can be
made to refuse a play. Without those three behaviours, the regressions this
project actually suffered could not be reproduced in the fast suite.

**Known gap, stated rather than hidden.** jsdom performs no layout. Geometry,
stacking, overflow, contrast and right-to-left mirroring are only checked in
the browser suite. That gap is not hypothetical: the hidden error notice and
the collapsed Arabic plurals both passed the unit tests, because those tests
asserted a JavaScript property rather than whether anything was visible.

## 8. Architectural decisions and what they buy

| Decision | Buys | Costs |
|---|---|---|
| One boundary file for the library | swapping it is a one-file change | the markup is coupled to `<media-*>` |
| No framework, no build | `node serve.js` and it runs; nothing to audit | hand-written DOM code |
| A separate source adapter | the desktop shell adds a file, not a refactor | one method is DOM-shaped |
| State in one closure | the whole model is readable top to bottom | a monolith; 900 lines, and a big one |
| Debounced saves | one write per interaction | up to 400 ms of staleness on a hard close |
| Token-based colour | rebrand in one place | a level of indirection in the CSS |
| No playlist persistence | never shows a row that cannot play | the feature is simply absent |
| Generated test fixtures | no binaries in the repo | ffmpeg must exist to run e2e |

The monolith is the one worth arguing about. `app.js` is ~900 lines and holds
the playlist, the panel, the drop zones, the fit modes, the keyboard, the
dialogs and persistence. It is at the edge of where a framework would earn its
keep. It has not been split because the seams are all in the same file and all
share one state object, so extracting them would create indirection without
removing coupling — but if this grows, that is the first thing to change.

## 9. Things that will bite you

Learned the hard way; all of them are also in `requirements.md`.

- **The library's keyboard map must stay cleared.** It reads `e.key` off the
  same event, so every letter the app owns fires twice. `preventDefault` does
  not help; the library is not cancelling anything.
- **The app's key handler must stay in the capture phase**, and must decline
  explicitly — because capture means it runs first, including for the playlist
  rows whose own handler it would otherwise pre-empt.
- **`media-time` is Latin-digit only.** The app writes the readout itself or it
  will not follow the language.
- **A `blob:` URL needs an explicit MIME type.** There is no extension to infer
  a provider from.
- **`load` must be `eager`.** The default waits for an `IntersectionObserver` on
  a provider that does not exist yet, and nothing is ever created.
- **CSS cannot reach inside a `<use>` shadow tree.** Each stateful control needs
  one `<use>` per state, with the class choosing between them.
- **A percentage on a physical `left` does not mirror.** Every slider and every
  anchored panel needs a `[dir="rtl"]` override.
- **The playback queue needs a load ticket.** Media events carry no identity,
  so handlers that could belong to a replaced load must close over their own.
