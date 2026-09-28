const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('enable-unsafe-webgpu');

const IMG = process.env.SEG_IMG;
const LAB = process.env.SEG_LAB;

const SETTINGS = [];
const base = { fade: { lo: 0.45, hi: 0.55 }, refine: true, radius: 8, erode: 1,
  fill: true, cap: 0.06, obj: true };
const add = (name, over) => SETTINGS.push({ name, ...base, ...over });
add('보정끔(대조군)', { refine: false });
add('반경2', { radius: 2 });
add('반경4', { radius: 4 });
add('반경8(현재)', { radius: 8 });
add('guide평균·반경2', { radius: 2, avgGuide: true });
add('guide평균·반경4', { radius: 4, avgGuide: true });
add('guide평균·반경8', { radius: 8, avgGuide: true });
add('guide평균·반경16', { radius: 16, avgGuide: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true },
  });
  await win.loadFile(path.join(__dirname, 'harness.html'));
  for (let i = 0; i < 240; i++) {
    const ok = await win.webContents.executeJavaScript('!!window.__ready').catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const items = [];
  for (const f of fs.readdirSync(IMG).filter((x) => /\.jpg$/i.test(x))) {
    const lf = path.join(LAB, f.replace(/\.jpg$/i, '.txt'));
    if (!fs.existsSync(lf)) continue;
    const polys = fs.readFileSync(lf, 'utf8').split('\n')
      .map((l) => l.trim().split(/\s+/).filter(Boolean).map(Number))
      .filter((v) => v.length > 6 && v[0] === 0)
      .map((v) => v.slice(1));
    if (!polys.length) continue;
    items.push({ path: 'file:///' + path.join(IMG, f).replace(/\\/g, '/'), polys });
  }
  console.log(`사람 폴리곤이 있는 사진 ${items.length}장, 설정 ${SETTINGS.length}가지`);

  const rows = await win.webContents.executeJavaScript(
    `window.__iou(${JSON.stringify(items)}, ${JSON.stringify(SETTINGS)})`, true);
  fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(rows, null, 1));

  console.log(`\n평가된 사진 ${rows.length}장 `
    + `(검출 인원과 정답 인원이 같은 사진만: ${rows.filter((r) => r.people === r.gtPeople).length}장)\n`);
  const show = (subset, title) => {
    if (!subset.length) return;
    console.log(title + `  (${subset.length}장)`);
    const stats = SETTINGS.map((st) => {
      const m = (k) => subset.reduce((s, r) => s + r.s[st.name][k], 0) / subset.length;
      return { name: st.name, iou: m('iou'), bf1: m('bf1'),
        prec: m('prec'), rec: m('rec') };
    });
    const bIou = Math.max(...stats.map((s) => s.iou));
    const bF1 = Math.max(...stats.map((s) => s.bf1));
    console.log('   설정              평균IoU    경계F1   정밀도   재현율');
    for (const s of stats) {
      console.log(`   ${s.name.padEnd(16)}  ${s.iou.toFixed(4)}${s.iou === bIou ? ' *' : '  '}`
        + `  ${s.bf1.toFixed(4)}${s.bf1 === bF1 ? ' *' : ' '}`
        + `  ${s.prec.toFixed(4)}  ${s.rec.toFixed(4)}`);
    }
    console.log('');
  };
  show(rows, '전체');
  show(rows.filter((r) => r.people === r.gtPeople), '검출 인원 = 정답 인원');
  app.quit();
});
