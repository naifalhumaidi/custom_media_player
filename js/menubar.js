"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
const FILE_SOURCE = /* @__PURE__ */ __name(() => window.MediaFileSource, "FILE_SOURCE");
const MENUS = [
  {
    id: "file",
    label: "File",
    alt: "F",
    items: [
      { label: "Open Files", command: "open-files", accel: "open", enabled: /* @__PURE__ */ __name(() => !!FILE_SOURCE()?.openFiles, "enabled") },
      { label: "Add Files", command: "add-files", accel: "addFiles", enabled: /* @__PURE__ */ __name(() => !!FILE_SOURCE()?.openFiles, "enabled") },
      { label: "Add Folder", command: "add-folder", accel: "addFolder", enabled: /* @__PURE__ */ __name(() => typeof FILE_SOURCE()?.openFolder === "function", "enabled") },
      { rule: true },
      { label: "Clear Playlist", command: "clear-playlist", accel: "clear", enabled: /* @__PURE__ */ __name(() => !!FILE_SOURCE()?.canPersist?.(), "enabled") },
      { rule: true },
      { label: "Quit", command: "quit", shellOnly: true }
    ]
  },
  {
    id: "edit",
    label: "Edit",
    alt: "E",
    items: [
      { label: "Play / Pause", command: "play-pause", accel: "playPause" },
      { label: "Previous", command: "previous", accel: "previous" },
      { label: "Next", command: "next", accel: "next" }
    ]
  },
  {
    id: "view",
    label: "View",
    alt: "V",
    items: [
      { label: "Show Playlist", command: "toggle-panel", accel: "panel" },
      { label: "Show Controls", command: "toggle-controls", accel: "controls" },
      { rule: true },
      { label: "Default", command: "fit-contain", accel: "fitDefault" },
      { label: "Crop", command: "fit-cover", accel: "fitCrop" },
      { label: "Stretch", command: "fit-stretch", accel: "fitStretch" },
      { rule: true },
      { label: "Enter Fullscreen", command: "fullscreen", accel: "fullscreen" }
    ]
  },
  {
    id: "playback",
    label: "Playback",
    alt: "P",
    items: [
      { label: "Loop Playlist", command: "toggle-loop", accel: "loop", check: "loop" },
      { label: "Auto Start", command: "toggle-autoplay", accel: "autoplay", check: "autoplay" },
      { label: "Mute", command: "toggle-mute", accel: "mute", check: "mute" }
    ]
  },
  { id: "info", label: "Info", alt: "I", command: "info" },
  { id: "settings", label: "Settings", alt: "S", command: "settings", accel: "settings" }
];
function mountMenuBar(host) {
  const nav = document.createElement("nav");
  nav.id = "menubar";
  nav.setAttribute("aria-label", "Main menu");
  const menu = window;
  let openId = null;
  let returnFocus = null;
  const accelFor = /* @__PURE__ */ __name((id) => {
    if (!id || !menu.MediaMenu || typeof menu.MediaMenu.shortcuts !== "function") return "";
    const found = menu.MediaMenu.shortcuts().find((s) => s.id === id);
    return found && found.pretty ? String(found.pretty) : "";
  }, "accelFor");
  const state = /* @__PURE__ */ __name(() => {
    const bar = document.getElementById("loop");
    return {
      loop: !!bar && bar.classList.contains("on"),
      autoplay: !!document.getElementById("autoplay")?.classList.contains("on"),
      mute: !!window.MediaBridge?.muted
    };
  }, "state");
  const close = /* @__PURE__ */ __name((toFocus) => {
    if (!openId) return;
    const panel = nav.querySelector(`[data-panel="${openId}"]`);
    const button = nav.querySelector(`[data-menu="${openId}"]`);
    panel?.removeAttribute("data-open");
    button?.removeAttribute("aria-expanded");
    button?.classList.remove("on");
    openId = null;
    const back = toFocus === void 0 ? returnFocus : toFocus;
    returnFocus = null;
    back?.focus?.();
  }, "close");
  const send = /* @__PURE__ */ __name((command) => {
    if (command === "quit") {
      const shell = window.MediaShell;
      if (shell && typeof shell.quit === "function") shell.quit();
      return;
    }
    if (menu.MediaMenu && typeof menu.MediaMenu.send === "function") menu.MediaMenu.send(command);
  }, "send");
  const buildPanel = /* @__PURE__ */ __name((heading) => {
    const panel = document.createElement("div");
    panel.className = "menu-panel";
    panel.dataset.panel = heading.id;
    panel.setAttribute("role", "menu");
    for (const entry of heading.items || []) {
      if (entry.rule) {
        const rule = document.createElement("div");
        rule.className = "menu-rule";
        rule.setAttribute("role", "separator");
        panel.appendChild(rule);
        continue;
      }
      if (entry.shellOnly && !window.MediaShell?.quit) continue;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item";
      item.setAttribute("role", "menuitem");
      item.dataset.command = entry.command || "";
      const tick = document.createElement("span");
      tick.className = "menu-tick";
      tick.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = entry.label || "";
      const accel = document.createElement("span");
      accel.className = "mi-acc";
      accel.textContent = accelFor(entry.accel);
      item.append(tick, label, accel);
      item.addEventListener("click", () => {
        if (item.disabled) return;
        close(null);
        send(entry.command || "");
      });
      panel.appendChild(item);
    }
    return panel;
  }, "buildPanel");
  const refresh = /* @__PURE__ */ __name(() => {
    const now = state();
    nav.querySelectorAll(".menu-item").forEach((item) => {
      const entry = (headingItems(item) || []).find((e) => e.command === item.dataset.command);
      if (!entry) return;
      if (entry.check) {
        item.querySelector(".menu-tick").textContent = now[entry.check] ? "✓" : "";
        item.setAttribute("aria-checked", String(!!now[entry.check]));
      }
      const available = entry.enabled ? entry.enabled() : true;
      item.disabled = !available;
      item.classList.toggle("off", !available);
    });
  }, "refresh");
  const headingItems = /* @__PURE__ */ __name((item) => {
    const panel = item.closest(".menu-panel");
    const heading = MENUS.find((m) => `menu-panel-${m.id}` === panel?.id);
    return heading ? heading.items || [] : null;
  }, "headingItems");
  for (const heading of MENUS) {
    const wrap = document.createElement("div");
    wrap.className = "menu-wrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-head";
    button.dataset.menu = heading.id;
    button.setAttribute("aria-haspopup", heading.items ? "menu" : "false");
    button.setAttribute("aria-expanded", "false");
    button.textContent = heading.label;
    button.innerHTML = heading.label.replace(
      new RegExp(`^(${heading.alt})`),
      '<u aria-hidden="true">$1</u>'
    ) + "";
    button.addEventListener("click", () => {
      if (openId === heading.id) {
        close();
        return;
      }
      returnFocus = button;
      if (heading.command) {
        send(heading.command);
        return;
      }
      nav.querySelectorAll(".menu-panel").forEach((p) => p.removeAttribute("data-open"));
      nav.querySelectorAll(".menu-head").forEach((b) => {
        b.setAttribute("aria-expanded", "false");
        b.classList.remove("on");
      });
      const panel = wrap.querySelector(".menu-panel");
      panel?.setAttribute("data-open", "");
      button.setAttribute("aria-expanded", "true");
      button.classList.add("on");
      openId = heading.id;
      refresh();
      panel?.querySelector(".menu-item:not([disabled])")?.focus();
    });
    wrap.appendChild(button);
    if (heading.items) {
      const panel = buildPanel(heading);
      panel.id = `menu-panel-${heading.id}`;
      wrap.appendChild(panel);
    }
    nav.appendChild(wrap);
  }
  nav.addEventListener("pointerover", (e) => {
    const head = e.target.closest(".menu-head");
    if (!head || !openId) return;
    if (head.dataset.menu === openId) return;
    head.click();
  });
  nav.addEventListener("pointerleave", () => {
    if (openId) close(null);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!openId) return;
    if (nav.contains(e.target)) return;
    close(null);
  });
  document.addEventListener("keydown", (e) => {
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    if (alt && /^[a-z]$/i.test(e.key)) {
      const heading = MENUS.find((m) => m.alt.toLowerCase() === e.key.toLowerCase());
      if (heading) {
        e.preventDefault();
        close(null);
        nav.querySelector(`[data-menu="${heading.id}"]`)?.focus();
        nav.querySelector(`[data-menu="${heading.id}"]`)?.click();
        return;
      }
    }
    if (!openId) return;
    const panel = nav.querySelector(`[data-panel="${openId}"]`);
    if (!panel) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...panel.querySelectorAll(".menu-item:not([disabled])")];
      if (!items.length) return;
      const here = items.indexOf(document.activeElement);
      const next = (here + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
      return;
    }
    if (e.key === "Tab") close();
  }, true);
  const observer = new MutationObserver(() => {
    if (openId) refresh();
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });
  host.appendChild(nav);
  refresh();
}
__name(mountMenuBar, "mountMenuBar");
window.MountMenuBar = mountMenuBar;
//# sourceMappingURL=menubar.js.map
