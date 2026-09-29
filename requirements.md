# Media Tools — requirements

Prototype that grows into a real local media player. Desktop shell comes last.

## 1. Media sources
- 1.1 Local files only for now (no streaming/URL sources).
- 1.2 Add via file picker and via drag-and-drop.
- 1.3 Playlists may mix **images, video and audio** in one list.
- 1.4 Non-media files are ignored.
- 1.5 Items keep a stable identity: name, kind, **MIME type**, path, duration,
      thumbnail, saved position. The MIME type is mandatory (see 8.5).

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
- 4.1 Controls are **hidden by default**; only the media is visible.
- 4.2 One key shows/hides the controls.
- 4.3 Minimal, clean, custom look — no library chrome.
- 4.4 Playlist sidebar, hidden by default, toggled by one key.
- 4.5 Sidebar rows show: thumbnail, name, duration, kind badge, remove button.
- 4.6 Video thumbnails are generated from the first frame.
- 4.7 Row click plays that item; the current item stays highlighted.
- 4.8 Drag to reorder; the playing item follows its new position.
- 4.9 Sidebar shows item count and total runtime when known.
- 4.10 The sidebar's ✕ **closes the panel only**. Wiping the playlist is a
      separate action (the ✕ in the control bar).
- 4.11 Rows carry no borders: the active row is a flat background plus a 2px
      inset edge marker. Hard row edges read as stray grey borders, and a
      translucent panel lets the picture bleed through the text.
- 4.11 When the panel is open, the control bar shifts so no control is covered.
- 4.12 Transport controls hidden for images (no play/seek/volume).

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
