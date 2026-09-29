# Analysis — Media Tools

What the problem actually was, what the options were, and why the shipped
design is the one it is. Written for a client or an interviewer who wants to
see the reasoning rather than just the result.

**English | [العربية](analysis.ar.md)**

---

## 1. The problem, stated honestly

The request was "a media player". Taken literally that is a solved problem —
there are dozens, and none of them are small. The parts of the request that
were actually open were the ones nobody states out loud:

- The player must be **local**. No accounts, no uploads, no network. Every file
  lives only in the tab that opened it.
- It must look like **one specific thing**, described by a brief that is almost
  entirely negative: no borders, no text labels on controls, exactly one glyph
  per state, nothing overlapping, nothing clipped at any window size.
- It must work in **Arabic as well as English**, including right-to-left layout
  and Arabic-Indic digits.

That last one is the requirement that does the most work. Right-to-left is not
a mirror flag; it is a question you have to ask about every coordinate you have
written, and about every number you print.

## 2. What the real constraints turned out to be

**A browser tab cannot remember a playlist.** This is the single most
important fact about the problem, and it is not obvious until you try.

When a user drops a file, the page gets a `File` and an `http://` or `blob:`
URL. The `blob:` URL is revoked when the document unloads. A `File` cannot be
written to `localStorage` — `localStorage` holds strings, and a 40 MB video is
not a string. So a browser-based player genuinely cannot offer "my playlist is
still here tomorrow".

The honest options were:

| Option | What it costs |
|---|---|
| Store only names and sizes | A playlist full of rows that cannot play. Worse than not remembering. |
| Use the File System Access API | Chromium-only, and needs a permission prompt on every session. |
| Ship a desktop shell | A second delivery target, a second toolchain. |
| **Don't claim to remember it** | Nothing. |

We took the last one. The app remembers everything about the *session* and is
explicit that the *playlist* is transient. This is a requirement, not a bug:
`js/source-web.js` publishes `canPersist() === false`, and `restore()` refuses to
rebuild a list the source cannot resolve, precisely so the app can never boot
into a playlist of dead rows. The desktop shell is where persistence arrives.

**The design brief fights the platform.** "No borders" is a real constraint
that the default browser UI actively resists: focus rings, the native
scrollbar, `<input>` chrome, and every focusable element all draw a border
unless you remove them individually. The custom scrollbar took the most work of
anything cosmetic in this project.

**Vidstack is not a black box.** The largest single source of lost time in this
project was the playback library, not the app. Its integration quirks are
catalogued in `requirements.md` §8.5–8.14, each one earned.

## 3. Choosing the playback library

The app does not need most of what a media library offers. It needs a
`<video>` that plays, seeks, goes fullscreen, and handles buffering across
browsers — and a lot of things it does not want: analytics hooks, a plugin
system, a React-flavoured API.

**Options considered**

- **Do nothing; use `<video>` directly.** ~1 KB, no framework, total control.
  Rejected as the primary path because Safari's fullscreen and inline-playback
  behaviour on iOS are genuinely fiddly, and because captions and buffering
  handling would all be ours to write and test. Note that this remains the
  *escape hatch*: deleting `js/media.js` and reverting to a bare `<video>` is a
  contained change.
- **Vidstack 1.15.6** (MIT, vendored). Chosen: small, no framework
  requirement, real custom elements, and its own accessibility work.
- **Video.js 10, Plyr, vidply, Mux `media-playlist`, Kaltura playkit, Primer
  `MediaPlaylist`.** Rejected on grounds recorded in `requirements.md`: archived
  (Plyr), abandoned (Mux, 2023), GPL-2.0 (vidply), beta (Video.js 10), or
  coupled to their own player (Kaltura, Primer/React).

**The one decision that cost the most time** was clearing the library's
keyboard map. It ships with `l`, `j`, `f`, `m`, `c`, `k` and the arrows bound.
It reads `e.key` off the same DOM event the app handles, so *every letter the app
owned fired twice*: `l` toggled loop and also seeked forward, `c` also toggled
captions, and `f`'s second toggle cancelled the app's fullscreen. Crucially,
`preventDefault()` does not help — the library is not cancelling anything, and
stopping propagation before the app's handler just means the app never sees the
key. The fix is one line, `keyShortcuts = {}`, and it is only obvious after the
symptom has been misdiagnosed twice.

## 4. The architecture, and why it is shaped this way

```
index.html        markup, inline SVG sprite
app.js            all application state
js/media.js       the ONLY file that knows a playback library exists
js/source.js      picks a file-source adapter, and documents its contract
js/source-web.js  the browser adapter
js/i18n.js        English and Arabic
js/settings.js    language, logo, brand colour
```

**Why one boundary file.** A media library is the most likely thing to replace.
Isolating it means the swap is one file, not a refactor. The honest version of
this claim matters, though: the *runtime* knowledge is fully contained, but the
markup is built from `<media-*>` custom elements and cannot be otherwise. The
header in `js/media.js` says so instead of claiming a guarantee it never had.

**Why the adapter is separate from the bridge.** They are different
dependencies with different replacement stories. The library might change;
the file source might change when the desktop shell arrives. Keeping them
apart means neither forces the other's hand — and the contract in
`js/source.js` is now documented and *validated at load*, so a missing method
fails immediately instead of as a `TypeError` inside an event handler later.

**Why no framework.** The app has one route, no route changes, and no server.
A framework's main value is composing views, and there is nothing to compose.
The real cost of a framework here would be a build step, which would break the
property the project values most: `node serve.js` and it runs.

## 5. What the tests changed

This is the part worth dwelling on, because it is where the work stopped being
opinion and started being measurement.

**The unit tests load the real `index.html` and the real scripts**, in jsdom,
faking only the playback library — which is exactly the boundary the
architecture already draws. A hand-written DOM stub would have been faster to
write and would have drifted from the markup within a day.

**They found six defects that reading the code had not.** The two that matter
most:

- A first-time user got **no control bar at all**. `restore()` ran
  `setUi(!!state.ui)`; a first run has no state; `!!undefined` is `false`. The
  app looked like a start screen with no way out except a keyboard shortcut
  nobody had been told about.
- `render()` called `scrollIntoView` without checking it exists. It throws in
  embedded webviews, and because `render()` runs inside `load()`, the exception
  aborted the caller's probe queue — every playlist row sat at "…" forever.

**A second, adversarial audit found two more, and both were features I had
added hours earlier that had never once worked**: the error notice was rendered
inside a container that is hidden exactly when those messages can appear, and
every Arabic plural collapsed to one form because the count arrives
already-formatted and `Number()` cannot read Arabic-Indic digits.

That second pair is the argument for testing rather than reviewing. Neither is
visible in a code read. Both passed their own unit tests, because those tests
asserted a JavaScript property (`notice.hidden === false`) rather than whether
the user could see anything. A test can be green and still be lying, and the
only defence is asking the question a different way.

## 6. Known limits, stated plainly

- **No playlist persistence in the browser.** By design, above. The desktop
  shell is the fix and it is not built.
- **Reordering by keyboard is not supported.** Moving a row with a mouse works
  and is live-reflowed; a keyboard user can play a row and remove one, but not
  reorder. This is a real accessibility gap, not a considered exclusion.
- **Formats are whatever the browser decodes.** `.mkv` is deliberately not
  claimed, because Matroska is not WebM and claiming it produces a broken row.
  Anything outside the table in `js/source-web.js` is refused with a message
  rather than added and left to fail.
- **One window, no multi-select, no tag reading, no captions.** All listed as
  out of scope in `requirements.md`.
- **`⇧X` is undoable for thirty seconds, not forever.** A longer window would
  be a second copy of the playlist held in memory for no reason.
