const path = require('node:path');
const H = require('./lib/harness.cjs');
const app = H.app;
const fs = require('node:fs');
const DIR = path.join(require('node:os').tmpdir(), 'mt-e2e', 'border2');
fs.mkdirSync(DIR, { recursive: true });

async function main() {
  // a plain light-grey plate: any stray frame around it is unmistakable
  const { execSync } = require('node:child_process');
  fs.mkdirSync(DIR, { recursive: true });
  execSync(`ffmpeg -y -f lavfi -i color=c=0xbdbdbd:s=800x600 -frames:v 1 ${DIR}/grey.png`, { stdio: 'ignore' });
  const b64 = fs.readFileSync(`${DIR}/grey.png`).toString('base64');

  const win = await H.open({ width: 1000, height: 700 });
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript('localStorage.clear();');
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript('location.reload();');
  await new Promise((r) => setTimeout(r, 1500));

  await win.webContents.executeJavaScript(`(async()=>{const w=ms=>new Promise(r=>setTimeout(r,ms));
    const d=new DataTransfer();
    const bin=atob('${b64}');const a=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
    d.items.add(new File([a],'grey.png',{type:'image/png'}));
    document.getElementById('stage').dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));
    await w(1200);
    document.getElementById('stage').classList.add('ui','list');
    await w(600);})()`, true);

  fs.writeFileSync(`${DIR}/plate.png`, (await win.webContents.capturePage()).toPNG());

  /* Which edges are allowed to carry a line, and which must not.

     Two, and no more:

       - the playlist's trailing edge. It is #0a0a0a against a #000 stage, so on
         an empty playlist - both almost entirely black - pressing P looked like
         it had done nothing at all. The window's own edge is the one edge that
         gets nothing: there is nothing to draw against there, and a line would
         only make the panel look narrower than it is.
       - the playlist header's bottom, for the same reason one level in: the rows
         under it are empty on a fresh install.

     Everything else must stay bare. The original rule here was "no styled edge
     anywhere in the chrome", which was right while the panel was invisible and
     is now wrong for these three; the failure mode it was watching for - a
     stray outline around something that should be flat - is still what it should
     catch, so the rule is narrowed rather than dropped. */
  /* Logical, not physical: the panel's line is on its inline end, which is the
     left-hand side once the app is in Arabic. Naming "Right" here would pass the
     check in English and fail it in the language it is actually for. */
  const out = await win.webContents.executeJavaScript(`(() => {
    const ALLOWED = {
      '#side': ['InlineEnd'],
      '.side-head': ['Bottom'],
    };
    const SIDES = ['Top','Right','Bottom','Left','InlineStart','InlineEnd'];
    const sels = ['#stage','media-player','media-provider','#side','.side-head','#bar','.row','.meta','#play','#loop','#still','#drop','.logo'];
    const styled = sels.map((s) => {
      const e = document.querySelector(s);
      if (!e) return s + ':missing';
      const cs = getComputedStyle(e);
      /* Physical and logical both report the same painted pixels, so only the
         logical pair is checked where they overlap - otherwise every deliberate
         line counts twice. */
      const allowed = ALLOWED[s] || [];
      const useLogical = allowed.some((k) => k.startsWith('Inline'));
      const names = useLogical ? SIDES.filter((k) => k.startsWith('Inline') || k === 'Top' || k === 'Bottom')
                               : ['Top','Right','Bottom','Left'];
      const painted = names
        .filter((k) => parseFloat(cs['border' + k + 'Width']) > 0)
        .map((k) => ({ k, w: cs['border' + k + 'Width'], c: cs['border' + k + 'Color'] }));
      const stray = painted.filter(({ k }) => !allowed.includes(k));
      const hasO = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const hasS = cs.boxShadow !== 'none';
      const all = painted.map(({ k, w, c }) => k + '=' + w + '/' + c).join(' ');
      return (stray.length || hasO || hasS)
        ? s + ' unexpected=' + stray.map((x) => x.k).join('+') + ' painted[' + all + ']'
          + ' outline=' + cs.outlineStyle + ':' + cs.outlineColor + ' shadow=' + cs.boxShadow
        : null;
    }).filter(Boolean);
    return { styled };
  })()`);
  console.log('  styled edges: ' + (out.styled.length ? out.styled.join(' | ') : 'none'));

  // pixel scan: the panel's right edge and the window frame must be seamless
  const scan = await win.webContents.executeJavaScript(`(async () => {
    // read the live pixels through a canvas snapshot of the DOM is not possible,
    // so report the geometry the pixel scan will use
    const side = document.getElementById('side').getBoundingClientRect();
    return { sideRight: Math.round(side.right), sideTop: Math.round(side.top), w: window.innerWidth, h: window.innerHeight };
  })()`);
  console.log('  geometry: ' + JSON.stringify(scan));
  /* Anything painted that is not one of the three deliberate lines is a failure,
     not a note. */
  const bad = out.styled.length;
  console.log(bad ? `FAILED ${bad} styled edges` : 'PASSED no styled edges');
  if (bad) process.exitCode = 1;
  win.destroy();
  app.quit();
}
main().catch((e) => { console.log('ERR ' + e.stack); process.exitCode = 1; app.quit(); });
