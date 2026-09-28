const { app, BrowserWindow } = require('electron');
const fs = require('fs');
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
  const outDir = process.env.OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of process.env.FILES.split(';')) {
    if (!f) continue;
    const url = 'file:///' + f.replace(/\\/g, '/');
    const r = await win.webContents.executeJavaScript(
      `window.__variants(${JSON.stringify(url)})`, true);
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    for (const [k, v] of Object.entries(r.pngs)) {
      fs.writeFileSync(path.join(outDir, `${stem}--${k}.png`),
        Buffer.from(v.split(',')[1], 'base64'));
    }
    console.log(`${stem}  ${r.w}x${r.h}  사람=${r.people}  몸안물건=[${r.held.join(',')}]`);
  }
  app.quit();
});
