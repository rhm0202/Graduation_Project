const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const IMG_DIR = process.env.IMG_DIR;
const OUT = process.env.OUT_JSON;

app.commandLine.appendSwitch('enable-unsafe-webgpu');

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
  const imgs = fs.readdirSync(IMG_DIR).filter((f) => /\.(jpg|png)$/i.test(f))
    .map((f) => 'file:///' + path.join(IMG_DIR, f).replace(/\\/g, '/'));
  console.log(imgs.length + ' images');
  const rows = await win.webContents.executeJavaScript(
    `window.__survey(${JSON.stringify(imgs)})`, true);
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));

  const all = [], withObjBig = [];
  let nPeopleImgs = 0;
  for (const r of rows) {
    nPeopleImgs++;
    for (const f of r.holesWith) all.push({ f, file: r.file });
  }
  all.sort((a, b) => b.f - a.f);
  console.log(`\n사람이 잡힌 사진 ${nPeopleImgs}장, 윤곽 안 구멍 ${all.length}개`);
  const pct = (p) => all.length ? all[Math.min(all.length - 1,
    Math.floor(all.length * (1 - p / 100)))].f : NaN;
  console.log('구멍 넓이 / 사람 박스 넓이 분포:');
  for (const p of [50, 75, 90, 95, 99, 100]) {
    console.log(`  상위 ${String(p).padStart(3)}%ile  ${(pct(p) * 100).toFixed(2)}%`);
  }
  const cap = 0.06;
  const over = all.filter((x) => x.f > cap);
  console.log(`\n상한 6% 를 넘는 구멍: ${over.length}개 / ${all.length}개 `
    + `(${(100 * over.length / all.length).toFixed(1)}%)`);
  console.log('넘는 것들: ' + over.slice(0, 15).map((x) =>
    `${x.file.replace('000000000', '')} ${(x.f * 100).toFixed(1)}%`).join(', '));

  // 물건 마스크 합치기가 실제로 구멍을 줄였는가
  let better = 0, same = 0;
  for (const r of rows) {
    if (!r.held.length) continue;
    const a = r.holesNo.reduce((s, v) => s + v, 0);
    const b = r.holesWith.reduce((s, v) => s + v, 0);
    if (b < a - 1e-6) better++; else same++;
  }
  console.log(`\n물건이 잡힌 사진에서 마스크 합치기로 구멍 총량이 준 경우: ${better}, 그대로: ${same}`);
  app.quit();
});
