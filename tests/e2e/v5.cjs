const path = require('node:path');
const H = require('./lib/harness.cjs');
const fs = require('node:fs');
const DIR = path.join(require('node:os').tmpdir(), 'mt-e2e', 'v5');
fs.mkdirSync(DIR, { recursive: true });

const expect = {
  'empty: rows at boot': 0,
  'empty: panel hidden': false,
  'empty: p opens the panel': true,
  'empty: panel display': 'flex',
  'empty: panel above the start overlay': true,
  'empty: empty message shown': true,
  'empty: list hidden': true,
  'empty: panel is the hit target there': true,
  'empty: bar still reachable': true,
  'empty: p closes it again': true,
  /* `volume`, not `vds-slider`: the volume control is the app's own input now,
     so it reports its id where the library's element reported a class. Its place
     in the order is what this checks - between mute and loop. */
  /* Open, Info and Settings have moved to the application menu; everything else
     is untouched. The transport, the time, mute, volume and the rest stay in
     this order, which is what this checks. */
  'bar: order': 'prev back play fwd next mute volume loop autoplay fit-d fit-c fit-s fs',
  'help: opens': true,
  'settings: opens': true,
  'settings: language select': true,
  'settings: colour input': true,
  'settings: logo input': true,
  'settings: reset button': true,
  'settings: languages': 'en,ar',
  'icons: none collapsed': 'none',
  'logo: present at boot': true,
  'logo: loaded at boot': true,
  'logo: uses the built-in mark': true,
  'time: placeholder localised': '0:00',
  'settings: colour default': '#aa7827',
  'settings: --gold after pick': 'rgb(58, 123, 213)',
  'settings: picker value': '#3a7bd5',
  'settings: logo preview shown': true,
  'settings: logo applied to the start window': true,
  'settings: clear is enabled': true,
  'settings: clear leaves a mark': true,
  'settings: button offers the default back': 'Remove',
  'settings: clear is disabled with no mark of your own': true,
  'ar: empty message names the buttons': 'إضافة ملفات',
  'bar stays left-to-right in arabic': 'ltr',
  'ar: settings title': 'الإعدادات',
  'ar: help title': 'التعليمات',
  'ar: help table is arabic': true,
  'ar: panel title': 'قائمة التشغيل',
  'ar: side hint': 'أفلت هنا للإضافة — يستمر التشغيل',
  'ar: empty message': true,
  'ar: help says what the app does': true,
  'ar: help lists the settings': true,
  'ar: loop tooltip': 'تكرار قائمة التشغيل (L)',
  'ar: fs tooltip': 'ملء الشاشة (F)',
  'ar: play tooltip': 'تشغيل / إيقاف (مسافة)',
  'ar: close tooltip': 'إغلاق (Esc)',
  'ar: language label': 'اللغة',
  /* The logo field's label is longer now - it says what the mark is for, not
     just "Logo" - and the button beside it has a name of its own. Both are in
     the Arabic too, so this checks the translation is complete rather than that
     it happens to fit. */
  'ar: colour label': 'اللغة | الشعار في نافذة البداية | تغيير الشعار | لون الهوية',
  'ar: select options': 'English/العربية',
  'ar: help groups': 'التشغيل|العرض|قائمة التشغيل',
  'en: dir back to ltr': 'ltr',
  'en: loop tooltip when on': 'Loop playlist (L) — on',
  'en: first duration': '0:08',
  'ar: duration digits': '٠:٠٨',
  'en: total': '4 items',
  'ar: total': '٤ عناصر',
  'ar: html dir': 'rtl',
  'ar: html lang': 'ar',
  'ar: settings closed': true,
  'en: dir back to ltr': 'ltr',
  'en: rows': 4,
  'ar: dir with media': 'rtl',
  'back: counter is latin again': '1 / 4',
};

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const win = await H.open({ width: 1200, height: 760 });
  await H.fresh(win);   // a previous run's saved prefs must not leak in
  const out = await H.runScript(win, require('node:path').join(__dirname, 'v5page.js'));

  let bad = 0;
  for (const [k, v] of out.steps) {
    if (!(k in expect)) { console.log('  ' + String(k).padEnd(44) + v); continue; }
    const ok = String(v) === String(expect[k]);
    if (!ok) { bad++; console.log('  FAIL ' + k + '\n       got  ' + JSON.stringify(v) + '\n       want ' + JSON.stringify(expect[k])); }
    else console.log('  ok   ' + String(k).padEnd(44) + v);
  }

  if (win.harnessErrors.length) console.log('PAGE ERRORS: ' + win.harnessErrors.join(' | '));

  // settings must survive a reload
  await H.run(win, `(async()=>{const w=ms=>new Promise(r=>setTimeout(r,ms));
    window.MediaMenu.send('settings'); await w(300);
    const s=document.getElementById('set-lang'); s.value='ar'; s.dispatchEvent(new Event('change',{bubbles:true}));
    await w(300);
    const c=document.getElementById('set-color'); c.value='#3a7bd5'; c.dispatchEvent(new Event('input',{bubbles:true}));
    await w(700);
    document.getElementById('settings-close').click();})()`);
  const saved = await H.run(win, `JSON.parse(localStorage.getItem('mediatools.prefs') || '{}').settings`);
  console.log('  persisted: ' + JSON.stringify(saved));
  await H.run(win, 'location.reload();');
  await new Promise((r) => setTimeout(r, 1600));
  await H.waitForBoot(win);
  const back = await H.run(win, `({ lang: document.documentElement.lang, dir: document.documentElement.dir, gold: getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(), title: document.querySelector('.side-title').textContent, logoHidden: document.querySelector('.logo').hidden })`);
  console.log('  after reload: ' + JSON.stringify(back));
  let persistOk = saved && saved.lang === 'ar' && saved.color === '#3a7bd5'
    && back.lang === 'ar' && back.dir === 'rtl' && back.gold === 'rgb(58, 123, 213)'
    && back.title === 'قائمة التشغيل';
  if (!persistOk) { console.log('  FAIL settings did not survive a reload'); bad++; }
  // The run ended with the logo restored, so that is what must come back.
  if (back.logoHidden !== false) { console.log('  FAIL restored logo did not persist'); bad++; }
  // An explicit null is different from "never customised": dropping the key
  // entirely must fall back to the shipped logo.
  await H.run(win, `(() => { const p = JSON.parse(localStorage.getItem('mediatools.prefs')); delete p.settings.logo; localStorage.setItem('mediatools.prefs', JSON.stringify(p)); location.reload(); })()`);
  await new Promise((r) => setTimeout(r, 1600));
  await H.waitForBoot(win);
  const restored = await H.run(win, `({ hidden: document.querySelector('.logo').hidden, src: document.querySelector('.logo').getAttribute('src') })`);
  console.log('  logo default restored: ' + JSON.stringify(restored));
  /* "Never customised" falls back to the built-in wordmark. It used to fall back
     to the artwork that shipped in the repository, which meant "remove" put the
     user's own picture straight back. */
  /* Compared against the shipped markup again - the same second source of truth
     removed above, which had already been wrong once. */
  const shipped = await H.run(win, `fetch('/index.html').then(r=>r.text()).then(h=>(/\\<img class="logo" src="([^"]+)"/.exec(h)||[])[1]||'')`);
  if (restored.hidden !== false || !shipped || !String(restored.src).endsWith(shipped.split('/').pop())) {
    console.log('  FAIL built-in mark not shown: ' + JSON.stringify(restored.src) + ' vs ' + JSON.stringify(shipped));
    bad++;
  }

  const grab = async (name, code) => {
    await H.run(win, `(async()=>{const w=ms=>new Promise(r=>setTimeout(r,ms));${code}await w(500);})()`);
    await H.shot(win, `${DIR}/${name}.png`);
    console.log('  shot ' + name);
  };
  await H.fresh(win);
  await grab('1-start-en', "document.getElementById('stage').classList.add('ui');");
  await grab('2-settings-en', "window.MediaMenu.send('settings');");
  await grab('3-settings-ar', "(()=>{const s=document.getElementById('set-lang');s.value='ar';s.dispatchEvent(new Event('change',{bubbles:true}));})();");
  await grab('4-help-ar', "(()=>{document.getElementById('settings-close').click();window.MediaMenu.send('info');})();");
  await grab('5-empty-panel-ar', "(()=>{document.getElementById('help-close').click();(document.activeElement||document).dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true,cancelable:true}));})();");
  await grab('6-playlist-ar', `(async()=>{const w=ms=>new Promise(r=>setTimeout(r,ms));
    const d=new DataTransfer();
    for (const [src,name,type] of [['sample.mp4','a.mp4','video/mp4'],['sample.mp3','c.mp3','audio/mpeg'],['sample.png','b.png','image/png']]) {
      const blob=await (await fetch('http://127.0.0.1:8123/'+src)).blob();
      d.items.add(new File([blob],name,{type}));
    }
    document.getElementById('stage').dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));
    await w(1600);
    const s=document.getElementById('stage');s.classList.add('ui');})();`);

  console.log(bad ? `FAILED ${bad} checks` : 'PASSED all checks');
  win.destroy();
  H.app.quit();
  if (bad) process.exitCode = 1;
}
main().catch((e) => { console.log('ERR ' + e.stack); H.app.quit(); process.exitCode = 1; });
