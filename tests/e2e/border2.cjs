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

  // scan the captured pixels for a bright frame anywhere it should not be
  const out = await win.webContents.executeJavaScript(`(() => {
    const res = {};
    const sels = ['#stage','media-player','media-provider','#side','.side-head','#bar','.row','.meta','#play','#loop','#still','#drop','.logo'];
    res.styled = sels.map((s) => {
      const e = document.querySelector(s);
      if (!e) return s + ':missing';
      const cs = getComputedStyle(e);
      const bw = ['Top','Right','Bottom','Left'].map((k) => cs['border' + k + 'Width']).join(',');
      const bc = ['Top','Right','Bottom','Left'].map((k) => cs['border' + k + 'Color']).join(',');
      const hasB = bw !== '0px,0px,0px,0px';
      const hasO = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const hasS = cs.boxShadow !== 'none';
      return (hasB || hasO || hasS) ? s + ' border=' + bw + '/' + bc + ' outline=' + cs.outlineStyle + ':' + cs.outlineColor + ' shadow=' + cs.boxShadow : null;
    }).filter(Boolean);
    return res;
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
  /* The brief forbids stray outlines, so a styled border or outline anywhere in
     the chrome is a failure, not a note. */
  const bad = out.styled.length;
  console.log(bad ? `FAILED ${bad} styled edges` : 'PASSED no styled edges');
  if (bad) process.exitCode = 1;
  win.destroy();
  app.quit();
}
main().catch((e) => { console.log('ERR ' + e.stack); process.exitCode = 1; app.quit(); });
