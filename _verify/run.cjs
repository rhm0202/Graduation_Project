const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const IMG_DIR = process.env.IMG_DIR;
const OUT_DIR = process.env.OUT_DIR;

app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true },
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (/error|Error|fail/.test(m)) console.log('[page]', m.slice(0, 200));
  });
  await win.loadFile(path.join(__dirname, 'harness.html'));

  // 하네스 준비 대기
  for (let i = 0; i < 240; i++) {
    const ok = await win.webContents.executeJavaScript('!!window.__ready').catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const ready = await win.webContents.executeJavaScript('!!window.__ready').catch(() => false);
  if (!ready) {
    const err = await win.webContents.executeJavaScript(
      'window.__err || "no __ready (모듈 로드 실패)"').catch((e) => String(e));
    console.log('READY FAIL:', err);
    app.quit();
    return;
  }

  const imgs = fs.readdirSync(IMG_DIR).filter((f) => /\.(jpg|png)$/i.test(f))
    .map((f) => 'file:///' + path.join(IMG_DIR, f).replace(/\\/g, '/'));
  const res = await win.webContents.executeJavaScript(
    `window.__run(${JSON.stringify(imgs)})`, true);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [k, v] of Object.entries(res.pngs)) {
    fs.writeFileSync(path.join(OUT_DIR, k.endsWith('.png') ? k : k.replace(/\.[^.]+$/, '') + '-out.png'),
      Buffer.from(v.split(',')[1], 'base64'));
  }
  delete res.pngs;
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(res, null, 1));
  console.log(res.log.join('\n'));
  console.log('\n=== 이미지별 ===');
  for (const r of res.images) {
    console.log(`\n${r.file}  ${r.w}x${r.h}  MASK_RES=${r.MASK_RES}  `
      + `사람=${r.people}  비사람검출=${r.objAll}  몸안물건=[${r.held.join(', ')}]`);
    if (!r.variants.current) { console.log('  (사람 미검출)'); continue; }
    console.log(`  보정범위 ${r.rectWH}   확률장 기울기(0.5 통과, 칸당 중앙값)=`
      + `${r.variants.current.grad}  → 1칸=${(r.w > r.h ? r.w : r.h) / r.MASK_RES ? ((r.w > r.h ? r.w : r.h) / r.MASK_RES).toFixed(1) : '?'}px`);
    console.log('   램프        띠(출력px)  띠(칸)  행당이동  1.5px↑비율  조립ms');
    for (const k of Object.keys(r.variants)) {
      if (k === 'current') continue;
      const v = r.variants[k];
      console.log(`   ${k.padEnd(10)}  ${String(v.bandPx).padStart(9)}  `
        + `${String(v.bandCells).padStart(6)}  ${String(v.meanStep).padStart(8)}  `
        + `${String(v.stepPct).padStart(10)}  ${String(v.ms).padStart(6)}`);
    }
    console.log('  구멍(상한 끈 상태): '
      + (r.holes.length ? r.holes.map((h) =>
        `${h.area}칸 ${h.wh} ${h.frac === null ? '박스밖' : (h.frac * 100).toFixed(1) + '%'}`).join(' | ')
        : '없음'));
  }
  app.quit();
});
