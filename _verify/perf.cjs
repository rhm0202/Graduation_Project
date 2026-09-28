const { app, BrowserWindow } = require('electron');
const path = require('path');

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
  console.log('마스크 조립 비용 (같은 프레임 20회 중 최소값, CPU 자바스크립트)');
  console.log('파일            해상도     격자  사람 물건  전체    보정뺀것 구멍뺀것 상한뺀것 침식뺀것 물건뺀것');
  for (const f of process.env.FILES.split(';')) {
    if (!f) continue;
    const url = 'file:///' + f.replace(/\\/g, '/');
    const r = await win.webContents.executeJavaScript(
      `window.__perf(${JSON.stringify(url)}, 20)`, true);
    console.log(
      `${r.file.padEnd(15)} ${String(r.w + 'x' + r.h).padEnd(10)} ${String(r.MASK_RES).padStart(4)} `
      + `${String(r.people).padStart(4)} ${String(r.held).padStart(4)}  `
      + `${String(r.full).padStart(6)}  ${String(r['보정없이']).padStart(7)} `
      + `${String(r['구멍메우기없이']).padStart(8)} ${String(r['상한없이']).padStart(8)} `
      + `${String(r['침식없이']).padStart(8)} ${String(r['물건없이']).padStart(8)}`);
    console.log(`   → 보정 ${(r.full - r['보정없이']).toFixed(2)}ms, `
      + `구멍메우기 ${(r.full - r['구멍메우기없이']).toFixed(2)}ms `
      + `(그중 상한 ${(r.full - r['상한없이']).toFixed(2)}ms), `
      + `침식 ${(r.full - r['침식없이']).toFixed(2)}ms, `
      + `물건마스크 ${(r.full - r['물건없이']).toFixed(2)}ms   [추론 ${r.inferMs}ms]`);
  }
  app.quit();
});
