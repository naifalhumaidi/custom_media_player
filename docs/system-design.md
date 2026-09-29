# System design — Media Tools

How the system works: the data flow, the invariants it maintains, and the
failure modes it is built to survive. This is the document to read when you
need to change something and want to know what you would be breaking.

**English | [العربية](system-design.ar.md)**

---

## 1. What kind of system this is

A single-page application with no backend, no build step, and no network
traffic. The entire state of the system lives in one JavaScript module's
closure plus the DOM. There is no database, no session, and no server state.

That has one large consequence: **almost every bug in this app is a
synchronisation bug** — the model, the DOM, and the persisted blob disagreeing
with each other. The design is therefore organised around keeping three things
in agreement:

```
items[]   +   index        the model: what is loaded, and which one
    |
    |  render() / renderList() / refreshRow()
    v
the DOM                     what the user sees
    |
    |  save(), debounced 400ms
    v
localStorage                what survives a reload
```

Every change to the model must update all three or none. Most of the defects
this project has had were a fourth thing — the media element — participating
without anyone accounting for it.

## 2. Modules and their contracts

| Module | Owns | Must not know about |
|---|---|---|
| `index.html` | markup, the SVG sprite | any JavaScript behaviour |
| `app.js` | all application state | that a playback library exists |
| `js/media.js` | playback: load, play, seek, fullscreen | the playlist, the UI |
| `js/source.js` | the adapter contract, validated at load | which adapter is active |
| `js/source-web.js` | `File` → object URL, MIME, preferences | the DOM beyond one hidden input |
| `js/i18n.js` | strings, digits, plurals, direction | what anything means |
| `js/settings.js` | language, logo, brand colour | the rest of the settings |
| `serve.js` | static files, loopback only | any application concept |

`app.js` calls four globals and nothing else: `MediaFileSource`, `MediaBridge`,
`I18n`, `MediaSettings`. Each one is a documented interface, and the source
adapter's is validated at load time so a missing method is a load error rather
than a mid-session crash.

## 3. The central abstraction: a media item

```js
{
  name:   'holiday.mp4',      // display
  mime:   'video/mp4',        // REQUIRED: the player picks a provider from it
  kind:   'video' | 'audio' | 'image' | null,
  path:   null,               // a desktop source fills this in
  file:   File,               // the browser source's handle
  url:    'blob:...',         // created lazily, released explicitly
  duration:   3725.4,         // seconds, or null until probed
  thumb:  'data:image/...',   // downscaled, never the original
  position:  124.3,           // resume offset, in seconds
  openEnded: false            // duration reported as Infinity
}
```

Three properties of this shape are load-bearing and each cost a defect:

- **`mime` is mandatory.** A `blob:` URL has no extension for the player to
  infer a provider from. Every load would fail with no indication of why.
- **`kind` may be `null`**, meaning "not playable here". Nulls are filtered out
  at the door and *counted*, so a drop of mixed files tells the user how many
  were refused rather than appearing to be ignored.
- **`file` and `url` have different owners.** The `File` belongs to the app;
  the `url` belongs to the adapter and must be given back. `release()` hands
  back only the URL and keeps the File, which is what makes the clear-undo
  possible and stops a released item becoming permanently unusable.

## 4. Load sequencing

This is the subtlest part of the system, because the media element is
asynchronous and the app is not.

**The problem.** `load(item)` does four things that must be paired up with
events that arrive later, possibly after the item has been replaced:

1. the resume seek, to be applied on `loaded-metadata`
2. the autoplay request, to be replayed on `can-play`
3. the time updates, which must be attributed to the right item
4. the errors, which must skip exactly once

**The mechanism.** Every load takes a ticket (`currentLoad = ++loadSeq`).
Handlers that could belong to a replaced load are installed *per load* and
close over their own ticket, so they can recognise themselves as stale:

```js
function onSuperseded(events, handler) {
  const seq = currentLoad;
  const wrapped = (e) => {
    if (seq !== currentLoad) return;   // a replaced provider: do nothing
    dropLive();
    handler(e);
  };
  ...
}
```

The handlers are registered per load rather than once in `init()` for a
specific reason: media events carry no identity of their own, so a listener
registered once cannot tell *which* load an event belongs to. (An earlier
attempt compared `currentLoad` against itself at event time. It could never
trip, and it shipped in a commit before the browser suite caught it.)

**Three further sequencing rules, each fixing a distinct defect:**

- **Time updates are withheld while no source is ready.** A pause during
  teardown is followed by a `time-update` carrying the *outgoing* track's
  time. The app's index has already moved on, so recording it gave the next
  track a resume position belonging to the previous one.
- **The previous source is dropped before a new one is attached.** Revoking an
  object URL the element is still pointed at is a use-after-free of the
  resource by construction; it appears to work only because the next assignment
  happens to abort the in-flight fetch, which is an implementation detail
  rather than a guarantee.
- **A stale seek is discarded.** `pendingSeek` is zeroed on clear and on every
  new load, so a failed load cannot leave a position behind for the next one.

## 5. Probing

Duration and thumbnail are read on a detached element, in parallel, by three
workers:

```
drop 250 files
   -> probeAll: three workers
      -> probe(item): detached <video>, muted, preload=metadata
         -> await loadedmetadata (2.5s timeout)
         -> seek to 0.1s, await seeked (2s timeout)
         -> drawImage/canvas -> 160px JPEG data URL
      -> refreshRow(item): update THAT row only
```

Three decisions here are all about not making the app feel broken:

- **A detached element, never the player.** Probing must not disturb playback.
- **Short timeouts.** A file that never reports metadata must not hold a worker
  for long: at three workers, a few hundred unreadable files would otherwise
  put the queue minutes behind with no visible sign anything was happening.
- **One row updated, not the list rebuilt.** The list used to be rebuilt on
  every probe completion — O(n²) element churn, and a drag in progress would be
  destroyed mid-gesture. Now `refreshRow` touches one row, and rendering is
  suspended entirely while a row is being dragged.

**Thumbnails are always downscaled.** An image row once carried the item's own
`blob:` URL, so a playlist of large photographs made the browser decode every
original in order to paint a 160px-wide row.

## 6. Persistence

`localStorage`, one key (`mediatools.prefs`), written through a 400 ms debounce.

**What is written:** `index`, `position`, `fit`, `loop`, `volume`, `muted`,
`ui`, `list`, `autoplay`, `settings`.

**What is deliberately not written:** `items`. The playlist holds `blob:` URLs
that die with the document, so writing it would produce rows that cannot play.
`restore()` additionally refuses to rebuild a list unless the source reports
`canPersist()`, so the coupling cannot be broken by adding one word to
`PERSISTED`.

**Two rules that keep the blob honest:**

- **The position is written from the model, not from the element.**
  `items[index].position` is correct by construction; `media.currentTime` is
  still the outgoing track's time during a swap.
- **A failed write is reported, not swallowed.** A base64 logo can overrun the
  quota, and a bare `catch {}` there loses the language, the colour, the volume
  and the position with no visible sign. It now raises an event, the settings
  dialog says so, and large logos are downscaled before they are stored so it
  rarely happens at all.

## 7. Failure model

| Failure | What the user sees | Why it is not worse |
|---|---|---|
| A file will not decode | "Cannot play this file" | one skip per track, never a loop |
| Autoplay refused | "Press play to start" | the icon reflects reality, not intent |
| A drop of unplayable files | "N file(s) cannot be played here" | nothing is silently discarded |
| A corrupt image | the same message | the `<img>` has an error path, which it did not |
| Storage is full | an alert in Settings | the app keeps running, in memory |
| A malformed server request | `400` | the server does not die |
| A keyboard event with no `key` | nothing | handled, previously threw |
| `scrollIntoView` missing | nothing | guarded; it previously aborted the probe queue |

The rule throughout: **a failure the user cannot see is indistinguishable from
the app having hung.** Every one of these produces a message or degrades
silently but harmlessly. None of them leaves the interface lying about state.

Notices have two lifetimes, because the messages mean different things.
"Press play to start" describes the current state and is retired when the
media starts; "3 files cannot be played" describes something already done and
simply times out.

## 8. Input and the keyboard

One global handler, registered in the **capture phase**. That is not a
stylistic choice: the library's controls call `stopPropagation()` on `keydown`,
so a bubbling listener never sees a key once a control has focus. That is why
`l` and `c` appeared to be broken.

Capture phase means the handler runs first, so it must decline explicitly:

1. modified keys (`ctrl`/`meta`/`alt`) — the browser's own shortcuts still work
2. `Escape` — closes the topmost layer, in order
3. the settings dialog, and anything inside a form field — they own the keyboard
4. the library's sliders, for arrow keys
5. a focused playlist row, for Enter, Space and the arrows — the row handler
   owns those, and capture phase would otherwise consume them first

Every documented shortcut has a test that asserts *the specific effect* of the
key, not merely that something changed — an early version of that test passed
while half the shortcuts did nothing, because it compared a snapshot most of
them legitimately left untouched.

## 9. Right to left

`dir="rtl"` on the document mirrors the box model, but not a single hard-coded
coordinate, and not a percentage inside a `left`. Each of these was a real bug:

- the playlist panel was pinned with a physical `left`
- the active-row marker used `inset 2px 0 0` — a physical left edge
- the seek bar's fill and thumb were anchored with `left` plus a percentage, so
  in Arabic the fill grew *away* from the start
- a set of paddings and alignments, all now logical properties

Numbers follow the language. Arabic pins `ar-u-nu-arab`, because a bare `ar`
resolves to the **Latin** numbering system in current CLDR — which would leave
Western digits inside Arabic text. Plural categories come from
`Intl.PluralRules`, applied to a count normalised back to ASCII digits, since
the count usually arrives already formatted.

## 10. The desktop shell: what changes and what does not

The architecture was built for this, so the change is small:

- **Add `js/source-tauri.js`** exporting `window.MediaFileSourceTauri` with
  `openFiles`, `urlFor`, `release`, `loadState`, `saveState`, `canPersist`, and
  a real `dropItems` fed by the shell's own file events rather than a DOM
  `DragEvent`. Load it before `js/source.js` and it is selected automatically.
- **Set `canPersist()` to true** and add `items` to `PERSISTED`. `restore()`
  then builds the list, because the paths resolve.
- **Change nothing else.** `app.js` already gates input until restore settles,
  already queues a drop that arrives early, and already treats `dropItems` as
  possibly asynchronous.

`js/source.js` validates the contract at load, so a desktop adapter with a
mistake in it fails immediately and by name, not later and somewhere else.

## 11. Test strategy

**Unit (`npm test`, jsdom).** Loads the real `index.html` and the real scripts;
fakes only the playback library. Every behaviour is driven through the shipped
DOM — clicks, drops, key presses — because a test that calls an internal
function proves something the user cannot do.

The fake is not a stub. It reproduces the quirks that cause the real defects: a
source change reports the outgoing time as it is torn down, a load can be made
to fail, a play can be refused. Without those, half the regressions this project
had would be untestable in the fast suite.

**End-to-end (`npm run test:e2e`, headless Electron).** The app is served by
`serve.js` and driven for real: actual layout, real codecs, real drag events,
real focus. Fixtures are generated by ffmpeg rather than committed.

Audio is silenced two independent ways, because `--mute-audio` alone still
opens a live stream: Chromium's flag, and a null sink the runner creates and
tears down without touching the machine's default output.

**The gap worth naming.** jsdom has no layout, so geometry, stacking, overflow
and RTL mirroring can only be checked in the browser suite — which is exactly
how the hidden-notice and Arabic-plural defects survived the unit tests. The two
suites are complementary, and the browser one is the authority on anything you
can see.
