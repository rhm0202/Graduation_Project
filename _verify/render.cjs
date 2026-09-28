const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('enable-unsafe-webgpu');

const base = { fade: { lo: 0.45, hi: 0.55 }, refine: true, radius: 8, erode: 1,
  fill: true, cap: 0.06, obj: true };
const SETTINGS = [
  { name: 'A-보정끔', ...base, refine: false },
  { name: 'B-보정끔-예전램프', ...base, refine: false, fade: { lo: 0.75, hi: 0.85 } },
  { name: 'C-반경8(현재)', ...base },
  { name: 'D-반경2', ...base, radius: 2 },
  { name: 'E-guide평균반경8', ...base, avgGuide: true },
];

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
  const outDir = process.env.OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of process.env.FILES.split(';')) {
    if (!f) continue;
    const url = 'file:///' + f.replace(/\\/g, '/');
    const r = await win.webContents.executeJavaScript(
      `window.__render(${JSON.stringify(url)}, ${JSON.stringify(SETTINGS)})`, true);
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    for (const [k, v] of Object.entries(r.pngs)) {
      fs.writeFileSync(path.join(outDir, `${stem}--${k}.png`),
        Buffer.from(v.split(',')[1], 'base64'));
    }
    console.log(`${stem} ${r.w}x${r.h} 격자${r.MASK_RES} 사람${r.people}`);
  }
  app.quit();
});
