/* The menu bar, in the page.
 *
 * It is here because the native one cannot do what was asked. Two things were
 * wanted on the menu bar itself: the shortcut for each heading, and the heading
 * left alone otherwise. A native menu can do the first only by writing the key
 * into the label - "Info (Alt+I)" - because a label is the only thing a native
 * menu item draws. It cannot do the second at all: `MenuItem.toolTip` is macOS
 * only, and no platform offers a menu bar that redraws a heading on hover. On
 * Linux and Windows the answer is no, so the bar is built here where a heading is
 * an element and hover is an ordinary event.
 *
 * It reads the same shortcut table as everything else - the keyboard, the
 * settings table, the tooltips - so a reassignment reaches it without this
 * knowing what a reassignment is. And it sends the same commands through the same
 * table the shell sent them through, so a menu item and the button it replaced
 * cannot drift apart.
 */

type MenuState = { loop: boolean; autoplay: boolean; mute: boolean };

type MenuEntry = {
  /** What the item says. Absent on a rule, which draws nothing. */
  label?: string;
  /** The command it sends, through the app's own table. */
  command?: string;
  /** Which shortcut to show beside it, by the id it has in the table. */
  accel?: string;
  /** A tick in front of the item, following this piece of state. */
  check?: keyof MenuState;
  /** Greyed out and unclickable when this says no. */
  enabled?: () => boolean;
  /** A rule between items. */
  rule?: boolean;
  /** Present only where the shell can do it. */
  shellOnly?: boolean;
};

type MenuHeading = {
  id: string;
  label: string;
  /** The letter Alt reaches it by. */
  alt: string;
  /** No dropdown: the item does the thing itself. */
  command?: string;
  accel?: string;
  items?: MenuEntry[];
};

const FILE_SOURCE = () => (window as any).MediaFileSource;

/* One definition, in the order a person reads it.

   The items that also exist on the control bar are here as well as there, because
   a menu that cannot reach the transport is not a menu. They show no shortcut
   until they are pointed at - see `.mi-acc` - so the bar does not turn into a wall
   of letters, and the control bar's own tooltips already say what each one is. */
const MENUS: MenuHeading[] = [
  {
    id: 'file',
    label: 'File',
    alt: 'F',
    items: [
      { label: 'Open Files', command: 'open-files', accel: 'open', enabled: () => !!FILE_SOURCE()?.openFiles },
      { label: 'Add Files', command: 'add-files', accel: 'addFiles', enabled: () => !!FILE_SOURCE()?.openFiles },
      { label: 'Add Folder', command: 'add-folder', accel: 'addFolder', enabled: () => typeof FILE_SOURCE()?.openFolder === 'function' },
      { rule: true },
      { label: 'Clear Playlist', command: 'clear-playlist', accel: 'clear', enabled: () => !!FILE_SOURCE()?.canPersist?.() },
      { rule: true },
      { label: 'Quit', command: 'quit', shellOnly: true },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    alt: 'E',
    items: [
      { label: 'Play / Pause', command: 'play-pause', accel: 'playPause' },
      { label: 'Previous', command: 'previous', accel: 'previous' },
      { label: 'Next', command: 'next', accel: 'next' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    alt: 'V',
    items: [
      { label: 'Show Playlist', command: 'toggle-panel', accel: 'panel' },
      { label: 'Show Controls', command: 'toggle-controls', accel: 'controls' },
      { rule: true },
      { label: 'Default', command: 'fit-contain', accel: 'fitDefault' },
      { label: 'Crop', command: 'fit-cover', accel: 'fitCrop' },
      { label: 'Stretch', command: 'fit-stretch', accel: 'fitStretch' },
      { rule: true },
      { label: 'Enter Fullscreen', command: 'fullscreen', accel: 'fullscreen' },
    ],
  },
  {
    id: 'playback',
    label: 'Playback',
    alt: 'P',
    items: [
      { label: 'Loop Playlist', command: 'toggle-loop', accel: 'loop', check: 'loop' },
      { label: 'Auto Start', command: 'toggle-autoplay', accel: 'autoplay', check: 'autoplay' },
      { label: 'Mute', command: 'toggle-mute', accel: 'mute', check: 'mute' },
    ],
  },
  { id: 'info', label: 'Info', alt: 'I', command: 'info' },
  { id: 'settings', label: 'Settings', alt: 'S', command: 'settings', accel: 'settings' },
];

/* Published rather than imported.

   The build is one classic script per entry and nothing bundles, so app.ts cannot
   import this any more than it imports the translations - it reads them off the
   window. Same arrangement, same reason.

   Which also means the one thing this file must not contain is a runtime export:
   esbuild keeps those, and a <script> without type="module" will not run a file
   that has one - which is why this is written as a plain script that sets a
   global, the way every other module in src/ is. */
function mountMenuBar(host: HTMLElement): void {
  const nav = document.createElement('nav');
  nav.id = 'menubar';
  nav.setAttribute('aria-label', 'Main menu');

  const menu = window as any;
  let openId: string | null = null;
  /* Where the focus goes back to when a menu closes, so it is never dropped on
     the floor. Losing focus to <body> is what makes a menu feel broken. */
  let returnFocus: HTMLElement | null = null;

  const accelFor = (id: string | undefined): string => {
    if (!id || !menu.MediaMenu || typeof menu.MediaMenu.shortcuts !== 'function') return '';
    const found = menu.MediaMenu.shortcuts().find((s: any) => s.id === id);
    return found && found.pretty ? String(found.pretty) : '';
  };

  const state = (): MenuState => {
    const bar = document.getElementById('loop');
    return {
      loop: !!bar && bar.classList.contains('on'),
      autoplay: !!document.getElementById('autoplay')?.classList.contains('on'),
      mute: !!window.MediaBridge?.muted,
    };
  };

  const close = (toFocus?: HTMLElement | null) => {
    if (!openId) return;
    const panel = nav.querySelector<HTMLElement>(`[data-panel="${openId}"]`);
    const button = nav.querySelector<HTMLElement>(`[data-menu="${openId}"]`);
    panel?.removeAttribute('data-open');
    button?.removeAttribute('aria-expanded');
    button?.classList.remove('on');
    openId = null;
    const back = toFocus === undefined ? returnFocus : toFocus;
    returnFocus = null;
    back?.focus?.();
  };

  const send = (command: string) => {
    if (command === 'quit') {
      const shell = (window as any).MediaShell;
      if (shell && typeof shell.quit === 'function') shell.quit();
      return;
    }
    if (menu.MediaMenu && typeof menu.MediaMenu.send === 'function') menu.MediaMenu.send(command);
  };

  const buildPanel = (heading: MenuHeading) => {
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.dataset.panel = heading.id;
    panel.setAttribute('role', 'menu');

    for (const entry of heading.items || []) {
      if (entry.rule) {
        const rule = document.createElement('div');
        rule.className = 'menu-rule';
        rule.setAttribute('role', 'separator');
        panel.appendChild(rule);
        continue;
      }
      /* Quit only exists where the shell can act on it. An item that is present
         and does nothing is worse than one that is absent. */
      if (entry.shellOnly && !((window as any).MediaShell?.quit)) continue;

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.command = entry.command || '';

      const tick = document.createElement('span');
      tick.className = 'menu-tick';
      /* Kept in the layout whether or not it is drawn, so the labels do not jump
         sideways when something is ticked. */
      tick.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = entry.label || '';

      const accel = document.createElement('span');
      accel.className = 'mi-acc';
      accel.textContent = accelFor(entry.accel);

      item.append(tick, label, accel);
      item.addEventListener('click', () => {
        if (item.disabled) return;
        close(null);
        send(entry.command || '');
      });
      panel.appendChild(item);
    }
    return panel;
  };

  const refresh = () => {
    const now = state();
    nav.querySelectorAll<HTMLElement>('.menu-item').forEach((item) => {
      const entry = (headingItems(item) || []).find((e) => e.command === item.dataset.command);
      if (!entry) return;
      if (entry.check) {
        item.querySelector('.menu-tick')!.textContent = now[entry.check] ? '✓' : '';
        item.setAttribute('aria-checked', String(!!now[entry.check]));
      }
      const available = entry.enabled ? entry.enabled() : true;
      (item as HTMLButtonElement).disabled = !available;
      item.classList.toggle('off', !available);
    });
  };

  const headingItems = (item: HTMLElement): MenuEntry[] | null => {
    const panel = item.closest('.menu-panel') as HTMLElement | null;
    const heading = MENUS.find((m) => `menu-panel-${m.id}` === panel?.id);
    return heading ? heading.items || [] : null;
  };

  for (const heading of MENUS) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-wrap';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-head';
    button.dataset.menu = heading.id;
    button.setAttribute('aria-haspopup', heading.items ? 'menu' : 'false');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = heading.label;
    /* Alt+letter, the way every menu bar on this desktop behaves. The letter is
       drawn underlined on its own, as the underline is the only decoration that
       belongs to the heading - the shortcut itself waits for the hover. */
    button.innerHTML = heading.label.replace(
      new RegExp(`^(${heading.alt})`),
      '<u aria-hidden="true">$1</u>',
    ) + '';

    button.addEventListener('click', () => {
      if (openId === heading.id) { close(); return; }
      returnFocus = button;
      if (heading.command) {
        send(heading.command);
        return;
      }
      nav.querySelectorAll<HTMLElement>('.menu-panel').forEach((p) => p.removeAttribute('data-open'));
      nav.querySelectorAll<HTMLElement>('.menu-head').forEach((b) => {
        b.setAttribute('aria-expanded', 'false');
        b.classList.remove('on');
      });
      const panel = wrap.querySelector<HTMLElement>('.menu-panel');
      panel?.setAttribute('data-open', '');
      button.setAttribute('aria-expanded', 'true');
      button.classList.add('on');
      openId = heading.id;
      refresh();
      panel?.querySelector<HTMLElement>('.menu-item:not([disabled])')?.focus();
    });

    wrap.appendChild(button);
    if (heading.items) {
      const panel = buildPanel(heading);
      panel.id = `menu-panel-${heading.id}`;
      wrap.appendChild(panel);
    }
    nav.appendChild(wrap);
  }

  /* A pointer that wanders from one heading to another should follow, the way it
     does in every menu bar: the first heading opens, and crossing into the next
     one takes the menu with it rather than making a second click. */
  nav.addEventListener('pointerover', (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>('.menu-head');
    if (!head || !openId) return;
    if (head.dataset.menu === openId) return;
    head.click();
  });

  /* A pointer that leaves the bar entirely closes it, which is what every other
     menu does and what stops a menu being left open over the picture. */
  nav.addEventListener('pointerleave', () => { if (openId) close(null); });

  document.addEventListener('pointerdown', (e) => {
    if (!openId) return;
    if (nav.contains(e.target as Node)) return;
    close(null);
  });

  document.addEventListener('keydown', (e) => {
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    if (alt && /^[a-z]$/i.test(e.key)) {
      const heading = MENUS.find((m) => m.alt.toLowerCase() === e.key.toLowerCase());
      if (heading) {
        e.preventDefault();
        close(null);
        nav.querySelector<HTMLElement>(`[data-menu="${heading.id}"]`)?.focus();
        nav.querySelector<HTMLElement>(`[data-menu="${heading.id}"]`)?.click();
        return;
      }
    }
    if (!openId) return;
    const panel = nav.querySelector<HTMLElement>(`[data-panel="${openId}"]`);
    if (!panel) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...panel.querySelectorAll<HTMLElement>('.menu-item:not([disabled])')];
      if (!items.length) return;
      const here = items.indexOf(document.activeElement as HTMLElement);
      const next = (here + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
      return;
    }
    /* Tab out closes rather than walking into the page behind the menu. */
    if (e.key === 'Tab') close();
  }, true);

  /* The ticks follow the same state the control bar shows, so a menu cannot say
     Loop is off while the button is lit. */
  const observer = new MutationObserver(() => { if (openId) refresh(); });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  host.appendChild(nav);
  refresh();
}

window.MountMenuBar = mountMenuBar;
