/* The contracts, written down.

   Three file sources, two desktop shells and one bridge, and none of app.js
   knows which it is talking to. That only holds because every one of them keeps
   to a shape agreed here. Before the port these shapes lived in prose in
   js/source.js and in the comments on each adapter, which is a fine way to
   document them and a poor way to check them: nothing stopped an adapter from
   quietly losing a method.

   So this file is the single source of truth, and `tests/unit/contract.test.ts`
   holds every source to it.

   The browser adapter's `File` and the desktop adapters' paths are different
   things that mean the same row, which is why `file` is only ever set by the
   browser source and `path` only ever by a desktop one. */

/** What can be shown. `null` means "not something this app can play", which is
 *  different from a type it does not recognise yet. */
export type MediaKind = 'image' | 'video' | 'audio' | null;

/** One row in the playlist.

 *  `url` is deliberately not part of this: it is not durable. It names a port
 *  from a shell process that no longer exists once the app closes, which is why
 *  it is registered when a row is created and stripped before it is saved. */
export interface MediaItem {
  name: string;
  mime: string;
  kind: MediaKind;
  /** Absolute path, desktop sources only. The browser source sets it to
   *  null rather than leaving it out, so a row is comparable across sources. */
  path?: string | null;
  /** The browser's own handle, browser source only. */
  file?: File | null;
  size: number;
  /** Set when the file has turned out to be gone. The row stays. */
  missing: boolean;
  /** Where the player can actually load it. Set by the source, never persisted. */
  url?: string | null;
  /** A downscaled still for the playlist row, drawn once. */
  thumb?: string | null;
  /** Resume position, in seconds. */
  position?: number;
  duration?: number | null;
  /** Whether playback ran off the end of the file. Cleared when the row is
   *  played again, so it does not become a permanent "do not autoplay" flag. */
  openEnded?: boolean;
}

/* Note what is deliberately NOT here: an index signature.

   An earlier version had `[key: string]: unknown`, on the theory that a row
   might carry anything. It made every unlisted property `unknown`, and that
   propagated: 82 errors in app.ts alone of the form "'x' is of type unknown",
   each one pointing at this file rather than at the code that had to think about
   it. A row's shape is exactly the list above, and if a row ever needs another
   field then it should be added here on purpose - where the three sources and the
   app all meet, and where a missing property is one error instead of a hundred. */

/** Everything the app needs from wherever its files come from.

 *  `urlFor` is synchronous on purpose. The app uses it inside a try/catch in two
 *  places and in a plain assignment in a third; a promise there would either be
 *  awaited in two spots and silently wrong in the third, or rejected where
 *  nothing catches it. Registration therefore happens when a row enters the
 *  playlist. */
export interface FileSource {
  canPersist(): boolean;
  openFiles(): Promise<MediaItem[]>;
  urlFor(item: MediaItem): string;
  release(item: MediaItem): void;
  loadState(): Promise<SavedState | null>;
  saveState(state: SavedState | Record<string, unknown>): Promise<void>;

  openFolder?(): Promise<MediaItem[]>;
  /* May be async, and the app awaits it. A desktop adapter has to ask its shell
     for a playable URL per item, and that is an IPC round trip - so a sync
     signature here is a trap: an adapter that resolves a URL and is typed as
     sync type-checks, then hands the app a bare item that cannot play. */
  dropItems?(event: DragEvent): MediaItem[] | Promise<MediaItem[]>;
  fileExists?(item: MediaItem): Promise<boolean>;
  /** Desktop shells that deliver drops outside the DOM subscribe here. */
  onExternalDrop?(callback: (items: MediaItem[]) => void): () => void;
}

/** The fullscreen route a shell offers. js/media.js prefers this when present and
 *  keeps the page's own API for the browser, which has no problem with it. */
export interface FullscreenHook {
  readonly active: boolean;
  toggle(): void | Promise<void>;
  onChange(listener: (active: boolean) => void): void;
}

/** What js/media.js exposes to app.js. The only place a media library is named. */
export interface MediaBridge {
  ticket(): number;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  fullscreen: boolean;

  init(): void;
  /** Drop whatever is loaded, back to the idle stage. */
  clear(): void;
  /** Paint a progress bar by hand. The library will not tell you where the
   *  pointer is between events, so the app does this on mousemove. */
  paintTime(ratio: number): void;
  paintVolume(ratio: number): void;
  load(item: { url: string; mime: string; kind: MediaKind; position?: number }, kind: MediaKind, autoplay: boolean): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seekBy(delta: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  setLoop(on: boolean): void;
  toggleFullscreen(): void | Promise<void>;
  onFullscreenChange(listener: () => void): void;

  ownsArrowKey(target: EventTarget | null): boolean;

  on<K extends keyof BridgeEvents>(event: K, listener: (payload: BridgeEvents[K]) => void): void;
  onFullscreenChange(listener: () => void): void;
}

/** Everything the bridge reports back. The app subscribes to these and to
 *  nothing else. */
export interface BridgeEvents {
  time: { currentTime: number };
  play: void;
  pause: void;
  /** Fired when a track reaches its end on its own. */
  ended: void;
  /** Fired when the current source cannot be played at all. */
  error: unknown;
  /** Fired when the browser refuses to start audio without a gesture. */
  blocked: void;
  volume: { volume: number; muted: boolean };
  [key: string]: unknown;
}

/** Translations. `t` takes a dotted key and never throws: an unknown key returns
 *  the key itself, so a missing translation is visible on screen rather than
 *  blank. */
export interface I18nModule {
  /** `vars` is a bag, not a positional list, because a string may carry both a
   *  count and a formatted duration - `panel.itemsTotal` uses `{ n, time }` - and
   *  a positional signature cannot express which is which. It also drives the
   *  plural forms, so `n` is the count when there is one. */
  t(key: string, vars?: Record<string, string | number>): string;
  num(value: number): string;
  apply(lang?: string): void;
  getLang(): string;
  setLang(lang: string): void;
  onChange(listener: (lang: string) => void): (lang: string) => void;
  dir(lang?: string): string;
  detect(): string;
  readonly DEFAULT_LOGO_GOLD: string;
  readonly languages: string[];
}

/** Language, brand colour and logo: the preferences that outlive a session and
 *  that a settings panel edits. */
export interface SettingsModule {
  load(state?: SavedState | null): void;
  save(): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  wire(): void;
  applyAll(): void;
  setBrandColor(colour: string): void;
  setLang(lang: string): void;
  setLogo(dataUrl: string | null): void;
  readonly prefs: Record<string, unknown>;
}

/** What survives a session.

    Written by every source in the same shape - a browser tab into localStorage, a
    desktop shell into a JSON file - so the app's restore path is one piece of
    code rather than two. Declared here because the restore reads every one of
    these fields with a default, and a field added to the writer without being
    added here is a silent no-op on the next launch. */
export interface SavedState {
  index?: number;
  position?: number;
  /** 'contain' | 'cover' | 'fill' - how the picture is fitted to the stage. */
  fit?: string;
  loop?: boolean;
  volume?: number;
  muted?: boolean;
  /** Whether the control bar is showing. `false` means hidden; absent means show. */
  ui?: boolean;
  list?: boolean;
  autoplay?: boolean;
  settings?: Record<string, unknown>;
  /** Desktop sources only: a browser tab cannot keep these. */
  items?: MediaItem[];
}

/** The shared type table. One answer to "what is this file", for every source. */
export interface MediaMimeModule {
  EXT_TYPES: Record<string, string>;
  extensionOf(name: string): string;
  mimeFor(name: string, osType: string): string;
  kindOf(mime: string): MediaKind;
  baseName(path: string): string;
  isPlayable(name: string): boolean;
}

declare global {
  /* eslint-disable-next-line @typescript-eslint/no-namespace */
  interface Window {
    MediaMime?: MediaMimeModule;
    MediaFileSource?: FileSource;
    MediaFileSourceWeb?: FileSource;
    MediaFileSourceTauri?: FileSource;
    MediaFileSourceElectron?: FileSource;
    MediaBridge?: MediaBridge;
    MediaFullscreen?: FullscreenHook;
    I18n?: I18nModule;
    MediaSettings?: SettingsModule;

    /** The preload's bridge, present only in the Electron shell. */
    MediaShell?: {
      shell: string;
      pickFiles(): Promise<string[]>;
      pickFolder(): Promise<string | null>;
      listFolder(dir: string): Promise<string[]>;
      fileExists(file: string): Promise<boolean>;
      loadState(): Promise<SavedState | null>;
      saveState(state: SavedState | Record<string, unknown>): Promise<void>;
      mediaUrl(file: string): Promise<string>;
      setFullscreen(on: boolean): void;
      isFullscreen(): Promise<boolean>;
      pathForFile(file: File): string;
      walkthrough?: {
        setSize(width: number, height: number): Promise<void>;
        isFullscreen(): Promise<boolean>;
        simulateDrop(paths: string[]): Promise<number>;
      };
      dropFilesForTest?(paths: string[]): void;
      takeDropPaths?(): string[];
    };

    /** Present only in the Tauri shell. */
    __TAURI__?: {
      core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>; convertFileSrc(path: string): string };
      event?: { listen(name: string, fn: (event: { payload: unknown }) => void): Promise<() => void> };
      /* Just the window calls this shell makes. Typed as an opaque object
         because everything it exposes is checked at runtime first: an older
         shell may not have the API at all, and a missing method must be a
         fallback rather than a crash. */
      window?: {
        getCurrentWindow?: () => {
          onResized(handler: () => void): Promise<unknown>;
        };
      };
    };
    __TAURI_INTERNALS__?: unknown;

    /** Set by the walkthrough, read by the shell when it prints the report. */
    __WALKTHROUGH_REPORT__?: Record<string, unknown>;
    __PROBE_FILE__?: string;
    __PROBE_MP3__?: string;
    __PROBE_DROP__?: boolean;
  }
}