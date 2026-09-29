# Media Tools — requirements

Prototype that grows into a real local media player. Desktop shell comes last.

## 1. Media sources
- 1.1 Local files only for now (no streaming/URL sources).
- 1.2 Add via file picker and via drag-and-drop.
- 1.3 Playlists may mix **images, video and audio** in one list.
- 1.4 Non-media files are ignored.
- 1.5 Items keep a stable identity: name, kind, **MIME type**, path, duration,
      thumbnail, saved position. The MIME type is mandatory (see 8.5).
- 1.6 The decision "what kind of file is this" lives in ONE place, `js/mime.js`,
      shared by every source. The browser source is handed a `File` and the
      desktop source a path, but the answer is the same and getting it wrong
      adds a row that can never play.

## 2. Display
- 2.1 Media fills the window edge to edge.
- 2.2 Three fit modes, switchable while playing:
  - **Default** — whole frame visible, letterboxed (aspect preserved)
  - **Crop** — fills the screen, overflow cut off (aspect preserved)
  - **Stretch** — fills the screen, aspect ignored (distorted)
- 2.3 Fit modes apply to images and video equally.
- 2.4 Audio shows no picture (placeholder only).
- 2.5 Fullscreen toggle, system-level.
- 2.6 Fit mode CSS must target the element the library creates
      (`media-provider > video`, a **type** selector — the provider has no `id`).
- 2.7 Both the video and the image must declare a **base** `object-fit`. The
      browser's initial value is `fill`, which silently districts everything.
- 2.8 The `<img>` must be `position: absolute; inset: 0` **and** carry a
      `z-index` above the player. A static in-flow image is painted *under* an
      absolutely positioned player, so it becomes invisible and unclickable.

## 3. Playback
- 3.1 Play / pause.
- 3.2 Skip to previous / next item.
- 3.3 Seek ±10s.
- 3.4 Seekable progress bar with elapsed / total time.
- 3.5 One loop toggle: repeat the whole playlist forever.
- 3.6 Auto-advance to the next item when one finishes; loop decides whether it wraps.
- 3.7 Volume + mute.
- 3.8 Click the picture: play / pause. Double-click: fullscreen.
- 3.9 Images are skipped by the seek controls (no timeline).

## 4. Interface
- 4.1 The control bar is **visible by default** and hides with one key. A first
      run has no saved state, so anything written as `!!state.ui` evaluates to
      false and would leave a new user with no controls at all.
- 4.2 One key shows/hides the controls.
- 4.3 Minimal, clean, custom look — no library chrome.
- 4.4 Playlist sidebar, hidden by default, toggled by one key.
- 4.5 Sidebar rows show: thumbnail, name, duration, kind badge, remove button.
- 4.6 Video thumbnails are generated from the first frame.
- 4.7 Row click plays that item; the current item stays highlighted.
- 4.8 Drag to reorder; the playing item follows its new position.
- 4.9 Every row is reachable and operable from the keyboard: focusable, `Enter`
      or `Space` to play, arrow keys to move focus, `aria-current` on the row
      that is playing. Mouse-only operation is not acceptable.
- 4.10 Focus is drawn the same way a selected row is: a flat background plus a
      2px inset edge. Never a detached outline, which reads as a stray border.
- 4.11 State that is only conveyed by colour - a lit toggle, a muted speaker -
      is also stated in text (`aria-pressed`) or in the control's own name.
- 4.12 Sidebar shows item count and total runtime when known.
- 4.13 The sidebar's ✕ **closes the panel only**. Wiping the playlist is a
      separate action (`⇧X`), kept off the panel so it cannot be hit by accident.
- 4.14 Rows carry no borders: the active row is a flat background plus a 2px
      inset edge marker. Hard row edges read as stray grey borders, and a
      translucent panel lets the picture bleed through the text.
- 4.15 The panel uses the full stage height and the bar is laid **over** its
      lower edge, so no control is ever covered and the bar keeps the full width.
- 4.16 Transport controls hidden for images (no play/seek/volume).
- 4.17 The panel opens on an empty playlist, so the first drop always has a target.
- 4.18 The start window is only the dimmed brand mark; there is no text on it.

## 5. Adding media
- 5.1 Drop on the window: add **and play the dropped item immediately**.
- 5.2 Drop on the sidebar, or the sidebar `+` button, or the picker: **add only**, never interrupt playback.
- 5.3 The two drop zones are visually distinguishable.
- 5.4 Unsupported files are skipped without breaking the playlist.

## 6. Keyboard
| Key | Action |
| --- | --- |
| `Space` / `K` | play / pause |
| `←` / `→` | seek ∓10s |
| `,` / `.` | previous / next item |
| `H` | show / hide controls |
| `P` | show / hide playlist |
| `Esc` | close the playlist |
| `D` | default view (fit) |
| `C` | crop |
| `S` | stretch |
| `L` | loop |
| `M` | mute |
| `F` | fullscreen |
| `↑` / `↓` | volume |
| `⇧X` | clear the playlist (replaced the removed clear button) |
| `?` / `I` | open / close the instructions dialog |

`Space` always means play / pause, even while a control still holds focus: the
handler runs in the capture phase, calls `preventDefault()` and drops focus, so
the browser never re-activates the focused button instead.

## 7. Persistence (desktop phase)
- 7.1 Playlist, order, current item, playback position, fit, loop, volume and
      sidebar/control visibility survive an app restart.
- 7.2 Store **file paths**, not file contents — nothing is copied.
- 7.3 Restore shows the same item at the same timestamp, without auto-playing.
- 7.4 Missing files are dropped from the playlist, not fatal.

## 8. Technical constraints
- 8.1 No custom playback code if a maintained library already does it well.
- 8.2 File I/O lives behind one adapter so the browser build and the desktop
      build share the same UI code.
- 8.3 **Run it with `node serve.js`.** Opening `index.html` from `file://` does
      not work: the vendored library and the blob URLs need an HTTP origin.
- 8.4 Works in Chromium-based browsers at minimum.
- 8.5 Three things about Vidstack 1.15.6 that are easy to get wrong and were
      found only by running a real browser:
      - the source prop is **`src`**, and it accepts an array of `{src, type}`.
        There is no `sources` prop. Setting a non-existent prop silently does
        nothing and nothing ever plays.
      - the **MIME type is required**. A `blob:` URL has no extension for the
        library to infer a provider from, so without a type it never creates a
        `<video>` element.
      - the **`load` strategy must be `eager`**. The default waits on an
        IntersectionObserver for a provider that does not exist yet.
- 8.6 Drive the player through its **own element API** (`play()`, `paused`,
      `currentTime`, `volume`, `muted`, `loop`). Hand-dispatched
      `media-*-request` events are ignored unless the library dispatches them
      through its own remote, so they must not be used.
- 8.7 The library's sliders keep correct state and ARIA values but their
      `--slider-fill` custom property stays `0%` in 1.15.6, so the app paints
      the fill itself from `time-update` / `volume-change`.
- 8.8 **`autoPlay` only works on the first source.** On a track change the
      library is still tearing down the previous provider and swallows it, so
      the next track loads paused. The bridge remembers the request and replays
      `play()` on `loaded-metadata` / `can-play`.
- 8.9 The library's components call `stopPropagation()` on `keydown`, so a
      bubbling document listener never sees a key once a control has focus.
      The app's key handler is registered in the **capture** phase and yields
      arrow keys to whichever slider is focused.
- 8.10 CSS cannot reach inside a `<use>` shadow tree. A glyph cannot be hidden
      by styling a path inside the referenced group, so every stateful control
      carries one `<use>` per state and app.js picks which one by toggling a
      class.
- 8.11 The library sizes `<media-volume-slider>` with a **percentage**, which
      contributes nothing to a flex group's intrinsic width. The group's last
      button was therefore pushed outside the window at every size. Fixed with
      an explicit `width` on the slider.
- 8.12 A control that needs an argument must not be passed straight to
      `addEventListener`: the listener hands it its `Event`, which is truthy,
      so every state read back as "on". Wrapped in an arrow function instead.
- 8.13 **The library has its own keyboard layer and it collides with the app's
      shortcuts.** Its defaults are:
      `seekForward: "l L ArrowRight"`, `seekBackward: "j J ArrowLeft"`,
      `toggleMuted: "m"`, `toggleFullscreen: "f"`, `toggleCaptions: "c"`,
      `togglePaused: "k Space"`.
      It reads `e.key` off the same event the app handles, so `l` toggled loop
      *and* seeked forward, `c` also toggled captions, and `f`'s second toggle
      cancelled the app's fullscreen. `preventDefault()` cannot fix this: the
      library is not cancelling anything, it is acting on the key. The map is
      cleared with `keyShortcuts = {}`; the sliders keep their own arrow-key
      handling, which is a separate code path.
- 8.14 A control that is `flex: 0 0 max-content` cannot shrink, so on a narrow
      window its last buttons sit outside the viewport. It needs
      `flex: 0 1 max-content` **and** `flex-wrap: wrap` so it reflows instead.

## 9. Layout rules
- The playlist panel occupies the **full height** of the stage. The control bar
  is laid **on top of** the panel's lower edge (`z-index` 25 over 15) rather than
  the panel being shortened, so the bar keeps the full window width and the
  playlist gets the whole window.
- Clicking anywhere outside the panel and the bar closes the panel.
- Reordering reflows the list **live** during the drag: crossing a row's midpoint
  moves the dragged node for real, so what is shown mid-drag is the result. A
  cancelled drag (Esc, or released outside) restores the original order.

## 10. Instructions
- All instructions live in the dialog opened by the `?` button in the bar or the
  `?` / `I` keys. The start window is only the brand mark, held back to 22%
  opacity.

## 11. Settings
- The gear button in the bar opens Settings; `Esc` closes it, and it and the
  instructions dialog can never be open at the same time.
- Options: **language** (English / العربية), **logo** (a chosen image, or the one
  shipped in the markup, or none) and **brand colour** (any colour, or the colour
  sampled from the logo, `#aa7827`).
- The brand colour is published as CSS custom properties (`--gold`, `--gold-soft`,
  `--enabled-bg/fg`, `--hover-bg/fg`), so a change is a single style write and
  both stylesheets follow.
- Hover and "enabled" deliberately share one colour family: a control that is on
  and a control under the pointer must look the same. The same tokens drive the
  playlist rows.
- `PLAYLIST` and the file name in the bar are drawn in the brand colour.

## 12. Languages
- English and Arabic, switchable at runtime. `html[lang]` and `html[dir]` follow
  the choice, so the whole interface mirrors in Arabic.
- Numbers use the active language's digits, so counts and durations read
  naturally. Arabic uses `ar-u-nu-arab`: with a bare `ar` the browser resolves
  the locale to the **Latin** numbering system, which would leave Western digits
  inside Arabic text.
- The plural category is chosen from the count, and the count usually arrives
  already formatted — in Arabic that is Arabic-Indic digits, which `Number()`
  cannot read. It is normalised back to ASCII first, or every count silently
  collapses to the `other` form and Arabic's six categories are dead code.
- A keyboard hint names the **physical key**: `,` and `?` stay ASCII in both
  languages. A localised `،` or `؟` is a different code point, so following the
  tooltip would press a key that does nothing.
- The markup declares its own strings with `data-i18n`, `data-i18n-title` and
  `data-i18n-aria`, so switching never needs the strings duplicated in JS.
  Anything the app builds later (tooltips, counts, durations) goes through
  `I18n.t()` / `I18n.num()`.
- Both dialogs must be parsed **before** the scripts run, otherwise the module
  wires nothing and every control is dead without a visible error.

## 13. Layout
- The playlist panel sits **above** the start overlay, so `P` opens it even with
  an empty playlist; the panel then shows its own empty message.
- The bar is ordered: open files · transport · time / name / position · mute +
  volume · loop · auto-start · fit · fullscreen · instructions · settings.
- `.btn.ic.sm` is the icon **size** modifier. A text button must not reuse the
  name: its padding overrides `.btn.ic`'s `padding: 0` and the flexed icon
  shrinks to a few pixels.

## 14. Failure behaviour
- 14.0 A failure the user cannot see is indistinguishable from the app having
      hung. Every one of these produces a message: a file that will not decode,
      an autoplay the browser refused, and files in a drop that cannot play.
- 14.1 A notice has one of two lifetimes, because the messages mean different
      things. "Press play to start" describes the current state and is retired
      when the media starts; "3 files cannot be played here" describes something
      already done and simply times out. Clearing the second when the video
      loaded hid the refusal in the same tick it appeared.
- 14.2 The notice lives beside the start window, not inside it. The start
      window is hidden as soon as the playlist is non-empty, which is exactly
      when these messages arise.
- 14.3 `⇧X` is undoable with `⇧Z` for thirty seconds. It is the only action that
      destroys work, and the browser source cannot re-resolve a file that was
      never stored, so recovery has to happen before the release.

## 15. Quality gates
- 14.1 `npm test` must pass. The unit tests load the **real** `index.html` and the
      **real** scripts in jsdom; only the playback library is faked, which is the
      boundary `js/media.js` exists to isolate. A hand-written DOM stub is not
      acceptable, because it drifts from the markup it claims to cover.
- 14.2 `npm run test:e2e` must pass. Headless browser suites against the app served
      by `node serve.js`, covering the real layout, real codecs and real input.
- 14.3 Every suite prints exactly one verdict line. A suite that only prints
      measurements cannot be grepped for pass or fail, so a silent regression
      passes unnoticed.
- 14.4 Test audio must never reach the speakers. Chromium's `--mute-audio` alone
      is not enough: it still opens a live stream. The runner also points the
      process at a null sink.
- 14.5 The fixtures are generated by `npm run test:media`, not committed.
- 14.6 The app must produce no uncaught errors and no console warnings during a
      normal session. Both are asserted, not assumed.
- 14.7 A test that fails because the product changed is only acceptable when the
      change was intended **and** the spec above was updated with it.

## 16. Serving
- 15.1 The app is served over HTTP by `node serve.js`; opening `index.html` from
      `file://` does not work, because ES modules and custom elements need a real
      origin.
- 15.2 The server binds **loopback only**. It hands out the whole app directory, so
      on a shared network an all-interfaces bind would give it to anyone who asked.
- 15.3 A malformed request must not kill the process. Bad percent-encoding throws
      out of the request handler, and a decoded NUL makes `fs` throw synchronously;
      both are answered with a 400.
- 15.4 Path checks are separator-aware. A plain `startsWith` also accepts a sibling
      directory whose name merely begins with this one's.
- 15.5 Responses carry an ETag and `nosniff`, and are streamed rather than read
      whole into memory.

## Out of scope (for now)
- Streaming formats (HLS/DASH), captions, speed control, PiP
- Editing, conversion, tags/metadata, multi-window, mobile layout
- Any form of media upload or network source

## Known decisions
- **Playback library: Vidstack 1.15.6** (MIT, vendored at `vendor/vidstack.js` + its
  `base.css`, 52 custom elements). It owns the transport UI, seek, keyboard, fullscreen,
  volume, buffering, captions and accessibility.
- **Transport controls are the library's own components**, not hand-rolled inputs:
  `<media-time-slider>`, `<media-play-button>`, `<media-seek-button>`,
  `<media-mute-button>`, `<media-volume-slider>`, `<media-time>`,
  `<media-fullscreen-button>` and `<media-gesture>`. Our CSS in `styles-vidstack.css`
  only styles their parts (`vds-slider`, `vds-track`, `vds-thumb`, …).
- We hand-write only what the library has no equivalent for: the playlist, the
  sidebar, both drop zones, the fit modes, and persistence.
- Fit mode = CSS `object-fit` on `#media-provider > video` (the player renders a real
  `<video>` as a light-DOM child) and on `#still` for images.
- `js/media.js` is the only file that knows Vidstack exists. Deleting it and reverting
  to a bare `<video>` is the escape hatch if the pre-GA 1.x line becomes a problem.
- Playlist state is kept in memory; persistence arrives with the desktop shell.
- Tauri 2 is the intended desktop shell (Rust toolchain and webkit2gtk are
  already installed on this machine).
- Considered and rejected: Mux `media-playlist` (abandoned 2023), `vidply` (GPL-2.0),
  Video.js 10 (beta), Plyr (archived), Primer `MediaPlaylist` (React), Kaltura
  playkit playlist (coupled to their player).
