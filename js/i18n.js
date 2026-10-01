"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  const STRINGS = {
    en: {
      dir: "ltr",
      locale: "en",
      "app.title": "Media Tools",
      "app.logoAlt": "Media Tools",
      /* --- control bar --- */
      "bar.open": "Open files",
      "bar.previous": "Previous",
      "bar.previousKey": "Previous (,)",
      "bar.back": "Back 10 seconds",
      "bar.backKey": "Back 10s (←)",
      "bar.play": "Play",
      "bar.pause": "Pause",
      "bar.playKey": "Play / pause (Space)",
      "bar.forward": "Forward 10 seconds",
      "bar.forwardKey": "Forward 10s (→)",
      "bar.next": "Next",
      "bar.nextKey": "Next (.)",
      "bar.mute": "Mute",
      "bar.muteKey": "Mute (m)",
      "bar.unmute": "Unmute",
      "bar.loop": "Loop playlist",
      "bar.loopOn": "Loop playlist (L) — on",
      "bar.loopKey": "Loop playlist (L)",
      "bar.autoplay": "Auto-start on track change",
      "bar.autoplayOff": "Auto-start on track change (A) — off",
      "bar.autoplayKey": "Auto-start on track change (A)",
      "bar.fitDefault": "Default view",
      "bar.fitDefaultKey": "Default / fit (D)",
      "bar.fitCrop": "Crop",
      "bar.fitCropKey": "Crop (C)",
      "bar.fitStretch": "Stretch",
      "bar.fitStretchKey": "Stretch (S)",
      "bar.fullscreen": "Fullscreen",
      "bar.fullscreenKey": "Fullscreen (F)",
      "bar.fullscreenExit": "Leave fullscreen",
      "bar.fullscreenExitKey": "Leave fullscreen (F)",
      "bar.seek": "Seek",
      "bar.unmuteKey": "Unmute (m)",
      "bar.volume": "Volume",
      "bar.help": "Instructions",
      "bar.helpKey": "Instructions (?)",
      "bar.settings": "Settings",
      "bar.settingsKey": "Settings",
      /* --- playlist panel --- */
      "panel.title": "Playlist",
      "panel.add": "Add files to the end",
      "panel.addFolder": "Add a folder",
      "panel.addFolderAria": "Add every playable file in a folder",
      "panel.missing": "gone",
      "panel.missingHint": "This file is no longer where it was. It is kept in case you move it back.",
      "panel.close": "Close the playlist (P)",
      "panel.closeAria": "Close playlist",
      "panel.hint": "Drop here to add — playback keeps going",
      "panel.remove": "Remove",
      "panel.removeAria": "Remove from the playlist",
      "panel.items": { one: "{n} item", other: "{n} items" },
      "panel.itemsTotal": { one: "{n} item · {time}", other: "{n} items · {time}" },
      "notice.cannotPlay": "Cannot play this file",
      "notice.blocked": "Press play to start",
      "notice.dropped": "{n} file(s) cannot be played here",
      "notice.restored": "Restored {n} items — Shift+Z puts them back within 30s",
      "panel.empty": "The playlist is empty. Drop files here to add them.",
      /* --- instructions dialog --- */
      "help.title": "Instructions",
      "help.close": "Close (Esc)",
      "help.files": "Files",
      "help.shortcuts": "Shortcuts",
      "help.notes": "Notes",
      "help.files.1": "Drop files anywhere on the window to add them and start playing.",
      "help.files.2": "Drop files on the playlist panel to add them without interrupting playback.",
      "help.files.3": "Images, video and audio can be mixed freely in one playlist.",
      "help.files.4a": "Click",
      "help.files.4b": "a picture to play or pause.",
      "help.files.4c": "Double-click",
      "help.files.4d": "it for fullscreen.",
      "help.files.5a": "Click a row to play it. Drag a row to reorder. Click",
      "help.files.5b": "to remove it.",
      "help.group.playback": "Playback",
      "help.group.view": "View",
      "help.group.playlist": "Playlist",
      "help.k.playpause": "play / pause",
      "help.k.seek": "seek ∓10s",
      "help.k.prevnext": "previous / next item",
      "help.k.loop": "loop the playlist",
      "help.k.autoplay": "auto-start on track change",
      "help.k.mute": "mute",
      "help.k.volume": "volume",
      "help.k.controls": "show / hide the controls",
      "help.k.panel": "show / hide the playlist",
      "help.k.fit": "default / crop / stretch",
      "help.k.fullscreen": "fullscreen (keeps the panel and controls)",
      "help.k.esc": "close this dialog, or the playlist",
      "help.k.clear": "clear the playlist",
      "help.k.help": "open / close these instructions",
      "help.notes.1a": "On an image,",
      "help.notes.1b": "and",
      "help.notes.1c": "move to the next item instead.",
      "help.notes.2": "Clicking outside the playlist closes it.",
      "help.notes.3": "Everything is kept in memory: a refresh clears the playlist.",
      /* --- settings dialog --- */
      "settings.title": "Settings",
      "settings.close": "Close (Esc)",
      "settings.appearance": "Appearance",
      "settings.language": "Language",
      "settings.languageHint": "Applies immediately, everywhere in the app.",
      "settings.logo": "Logo",
      "settings.logoHint": "Shown on the start window. Remove it to hide the mark.",
      "settings.logoClear": "Remove",
      "settings.color": "Brand colour",
      "settings.colorHint": "Used for highlights, the timeline fill and the active row.",
      "settings.colorReset": "Use the logo colour",
      "settings.logoUseDefault": "Use the default",
      "settings.saveFailed": "Settings could not be saved: the browser storage is full. The logo may be too large.",
      "settings.about": "About",
      "settings.aboutBody": "A local media player for images, video and audio. Playlists live in memory only.",
      "lang.en": "English",
      "lang.ar": "العربية",
      /* --- shared --- */
      "common.close": "Close"
    },
    ar: {
      dir: "rtl",
      /* The -u-nu-arab extension is deliberate: with a bare "ar" the browser
         resolves the locale to the LATIN numbering system (current CLDR), which
         would leave Western digits sitting inside Arabic text. */
      locale: "ar-u-nu-arab",
      "app.title": "ميديا تولز",
      "app.logoAlt": "ميديا تولز",
      /* --- شريط التحكم --- */
      "bar.open": "فتح ملفات",
      "bar.previous": "السابق",
      "bar.previousKey": "السابق (,)",
      "bar.back": "رجوع ١٠ ثوانٍ",
      "bar.backKey": "رجوع ١٠ ثوانٍ (←)",
      "bar.play": "تشغيل",
      "bar.pause": "إيقاف مؤقت",
      "bar.playKey": "تشغيل / إيقاف (مسافة)",
      "bar.forward": "تقديم ١٠ ثوانٍ",
      "bar.forwardKey": "تقديم ١٠ ثوانٍ (→)",
      "bar.next": "التالي",
      "bar.nextKey": "التالي (.)",
      "bar.mute": "كتم الصوت",
      "bar.muteKey": "كتم الصوت (m)",
      "bar.unmute": "إلغاء الكتم",
      "bar.loop": "تكرار قائمة التشغيل",
      "bar.loopOn": "تكرار قائمة التشغيل (L) — مُفعّل",
      "bar.loopKey": "تكرار قائمة التشغيل (L)",
      "bar.autoplay": "بدء التشغيل تلقائيًا عند تغيّر المقطع",
      "bar.autoplayOff": "بدء التشغيل تلقائيًا عند تغيّر المقطع (A) — مُعطّل",
      "bar.autoplayKey": "بدء التشغيل تلقائيًا عند تغيّر المقطع (A)",
      "bar.fitDefault": "العرض الافتراضي",
      "bar.fitDefaultKey": "افتراضي (D)",
      "bar.fitCrop": "اقتصاص",
      "bar.fitCropKey": "اقتصاص (C)",
      "bar.fitStretch": "تمديد",
      "bar.fitStretchKey": "تمديد (S)",
      "bar.fullscreen": "ملء الشاشة",
      "bar.fullscreenKey": "ملء الشاشة (F)",
      "bar.fullscreenExit": "الخروج من ملء الشاشة",
      "bar.fullscreenExitKey": "الخروج من ملء الشاشة (F)",
      "bar.seek": "موضع التشغيل",
      "bar.unmuteKey": "إلغاء الكتم (m)",
      "bar.volume": "مستوى الصوت",
      "bar.help": "التعليمات",
      "bar.helpKey": "التعليمات (?)",
      "bar.settings": "الإعدادات",
      "bar.settingsKey": "الإعدادات",
      /* --- لوحة قائمة التشغيل --- */
      "panel.title": "قائمة التشغيل",
      "panel.add": "إضافة ملفات إلى النهاية",
      "panel.addFolder": "إضافة مجلد",
      "panel.addFolderAria": "إضافة كل ملف قابل للتشغيل في مجلد",
      "panel.missing": "مفقود",
      "panel.missingHint": "هذا الملف لم يعد في مكانه. أُبقي في حال أعدته إلى مكانه.",
      "panel.close": "إغلاق قائمة التشغيل (P)",
      "panel.closeAria": "إغلاق قائمة التشغيل",
      "panel.hint": "أفلت هنا للإضافة — يستمر التشغيل",
      "panel.remove": "إزالة",
      "panel.removeAria": "إزالة من قائمة التشغيل",
      "panel.items": {
        zero: "لا عناصر",
        one: "عنصر واحد",
        two: "عنصران",
        few: "{n} عناصر",
        many: "{n} عنصرًا",
        other: "{n} عنصر"
      },
      "panel.itemsTotal": {
        zero: "لا عناصر · {time}",
        one: "عنصر واحد · {time}",
        two: "عنصران · {time}",
        few: "{n} عناصر · {time}",
        many: "{n} عنصرًا · {time}",
        other: "{n} عنصر · {time}"
      },
      "notice.cannotPlay": "تعذّر تشغيل هذا الملف",
      "notice.blocked": "اضغط تشغيل للبدء",
      "notice.dropped": "{n} ملف لا يمكن تشغيله هنا",
      "notice.restored": "تمت استعادة {n} عنصر — Shift+Z يعيدها خلال ٣٠ ثانية",
      "panel.empty": "قائمة التشغيل فارغة. أفلت الملفات هنا لإضافتها.",
      /* --- نافذة التعليمات --- */
      "help.title": "التعليمات",
      "help.close": "إغلاق (Esc)",
      "help.files": "الملفات",
      "help.shortcuts": "اختصارات لوحة المفاتيح",
      "help.notes": "ملاحظات",
      "help.files.1": "أفلت الملفات في أي مكان من النافذة لإضافتها وبدء التشغيل.",
      "help.files.2": "أفلت الملفات على لوحة قائمة التشغيل لإضافتها دون مقاطعة التشغيل.",
      "help.files.3": "يمكن خلط الصور والفيديو والصوت في قائمة تشغيل واحدة.",
      "help.files.4a": "اضغط",
      "help.files.4b": "على صورة للتشغيل أو الإيقاف المؤقت.",
      "help.files.4c": "اضغط ضغطًا مزدوجًا",
      "help.files.4d": "عليها لملء الشاشة.",
      "help.files.5a": "اضغط على صف لتشغيله. اسحب الصف لإعادة الترتيب. اضغط",
      "help.files.5b": "لإزالته.",
      "help.group.playback": "التشغيل",
      "help.group.view": "العرض",
      "help.group.playlist": "قائمة التشغيل",
      "help.k.playpause": "تشغيل / إيقاف مؤقت",
      "help.k.seek": "تقديم أو تأخير ١٠ ثوانٍ",
      "help.k.prevnext": "العنصر السابق / التالي",
      "help.k.loop": "تكرار قائمة التشغيل",
      "help.k.autoplay": "بدء التشغيل تلقائيًا عند تغيّر المقطع",
      "help.k.mute": "كتم الصوت",
      "help.k.volume": "مستوى الصوت",
      "help.k.controls": "إظهار / إخفاء أزرار التحكم",
      "help.k.panel": "إظهار / إخفاء قائمة التشغيل",
      "help.k.fit": "افتراضي / اقتصاص / تمديد",
      "help.k.fullscreen": "ملء الشاشة (مع إبقاء اللوحة والأزرار)",
      "help.k.esc": "إغلاق هذه النافذة أو قائمة التشغيل",
      "help.k.clear": "مسح قائمة التشغيل",
      "help.k.help": "فتح / إغلاق هذه التعليمات",
      "help.notes.1a": "عند عرض صورة, تعمل",
      "help.notes.1b": "و",
      "help.notes.1c": "للانتقال إلى العنصر التالي.",
      "help.notes.2": "الضغط خارج قائمة التشغيل يغلقها.",
      "help.notes.3": "تُحفظ كل شيء في الذاكرة فقط: تحديث الصفحة يمسح القائمة.",
      /* --- نافذة الإعدادات --- */
      "settings.title": "الإعدادات",
      "settings.close": "إغلاق (Esc)",
      "settings.appearance": "المظهر",
      "settings.language": "اللغة",
      "settings.languageHint": "تُطبَّق فورًا في كل أنحاء التطبيق.",
      "settings.logo": "الشعار",
      "settings.logoHint": "يظهر في نافذة البداية. أزله لإخفاء العلامة.",
      "settings.logoClear": "إزالة",
      "settings.color": "لون الهوية",
      "settings.colorHint": "يُستخدم في التمييز وتعبئة شريط التقدّم والصف النشط.",
      "settings.colorReset": "استخدام لون الشعار",
      "settings.logoUseDefault": "استخدام الافتراضي",
      "settings.saveFailed": "تعذّر حفظ الإعدادات: مساحة التخزين ممتلئة. قد يكون الشعار كبيرًا.",
      "settings.about": "حول التطبيق",
      "settings.aboutBody": "مشغّل وسائط محلي للصور والفيديو والصوت. قوائم التشغيل محفوظة في الذاكرة فقط.",
      "lang.en": "English",
      "lang.ar": "العربية",
      /* --- مشترك --- */
      "common.close": "إغلاق"
    }
  };
  const DEFAULT_LOGO_GOLD = "#aa7827";
  let lang = "en";
  const listeners = [];
  function detect() {
    const wanted = (navigator.languages || [navigator.language || "en"]).map((l) => String(l).slice(0, 2).toLowerCase());
    return wanted.find((l) => STRINGS[l]) || "en";
  }
  __name(detect, "detect");
  function getLang() {
    return lang;
  }
  __name(getLang, "getLang");
  const dir = /* @__PURE__ */ __name(() => STRINGS[lang].dir, "dir");
  function t(key, vars) {
    const table = STRINGS[lang] || STRINGS.en;
    const raw = table[key] ?? STRINGS.en[key] ?? key;
    let out = raw;
    if (raw && typeof raw === "object" && vars && vars.n !== void 0) {
      const category = pluralCategory(vars.n);
      const fallback = table === STRINGS.en ? STRINGS.en[key] : null;
      out = raw[category] ?? raw.other ?? (fallback && typeof fallback === "object" ? fallback.other : null) ?? key;
    }
    if (typeof out !== "string") out = out && out.other || key;
    if (vars) {
      for (const name of Object.keys(vars)) {
        out = out.split("{" + name + "}").join(String(vars[name]));
      }
    }
    return out;
  }
  __name(t, "t");
  const ASCII_DIGITS = /[\u0660-\u0669]/g;
  const asNumber = /* @__PURE__ */ __name((value) => {
    const folded = String(value).replace(ASCII_DIGITS, (digit) => String(digit.charCodeAt(0) - 1632));
    const n = Number(folded);
    return Number.isFinite(n) ? n : NaN;
  }, "asNumber");
  function pluralCategory(count) {
    const n = asNumber(count);
    if (!Number.isFinite(n)) return "other";
    try {
      return new Intl.PluralRules(STRINGS[lang].locale.split("-")[0]).select(n);
    } catch {
      return "other";
    }
  }
  __name(pluralCategory, "pluralCategory");
  function num(value) {
    try {
      return new Intl.NumberFormat(STRINGS[lang].locale).format(value);
    } catch (err) {
      console.warn("[i18n] num() could not format", value, err);
      return String(value);
    }
  }
  __name(num, "num");
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      if (key) el.textContent = t(key);
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.dataset.i18nTitle;
      if (key) el.title = t(key);
    });
    scope.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const key = el.dataset.i18nAria;
      if (key) el.setAttribute("aria-label", t(key));
    });
    scope.querySelectorAll("img[data-i18n-alt]").forEach((el) => {
      const img = el;
      if (img.dataset.i18nAlt) img.alt = t(img.dataset.i18nAlt);
    });
    const html = document.documentElement;
    html.lang = lang;
    html.dir = dir();
    document.title = t("app.title");
  }
  __name(apply, "apply");
  function setLang(next, opts) {
    if (!STRINGS[next]) return lang;
    const changed = next !== lang;
    lang = next;
    apply(opts && opts.root || void 0);
    if (changed) {
      listeners.slice().forEach((fn) => {
        try {
          fn(lang);
        } catch (err) {
          console.warn("[i18n] listener failed:", err);
        }
      });
    }
    return lang;
  }
  __name(setLang, "setLang");
  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return fn;
  }
  __name(onChange, "onChange");
  window.I18n = {
    t,
    num,
    apply,
    getLang,
    setLang,
    onChange,
    dir,
    detect,
    DEFAULT_LOGO_GOLD,
    languages: Object.keys(STRINGS)
  };
})();
//# sourceMappingURL=i18n.js.map
