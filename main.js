const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

//webGPU 가속 활성화
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

let writableStream = null;
let savePath = 'C:\\VideoRecoding';

// 업데이트 서버 URL (GitHub Releases 또는 자체 서버)
const UPDATE_SERVER_URL = 'https://raw.githubusercontent.com/wer134/application/main/updates/latest.json';

/**
 * 메인 브라우저 창을 생성합니다.
 */
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: true
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');
}

let selectedGpuName = null;

function startGpuMonitoring(win) {
  const cmd = `powershell -NoProfile -Command "try { $s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples | Where-Object { $_.CookedValue -gt 0 }; if ($s) { [math]::Round(($s | Measure-Object CookedValue -Sum).Sum, 1) } else { 0 } } catch { 0 }"`;

  setInterval(() => {
    exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (!err && !win.isDestroyed()) {
        const usage = Math.min(parseFloat(stdout.trim()) || 0, 100);
        win.webContents.send('gpu-usage', usage);
      }
    });
  }, 2000);
}

app.whenReady().then(async () => {
  createWindow();
  const win = BrowserWindow.getAllWindows()[0];
  startGpuMonitoring(win);

  // GPU 이름 전송 (렌더러 준비 후)
  const gpuInfo = await app.getGPUInfo('basic');
  const gpuName = gpuInfo?.gpuDevice?.[0]?.driverVendor
    ? `${gpuInfo.gpuDevice[0].driverVendor}`
    : null;

  // PowerShell로 정확한 GPU 이름 조회
  exec(
    `powershell -NoProfile -Command "(Get-WmiObject Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"`,
    { timeout: 5000 },
    (err, stdout) => {
      const name = !err && stdout.trim() ? stdout.trim() : (gpuName || 'Unknown GPU');
      if (!win.isDestroyed()) win.webContents.send('gpu-name', name);
    }
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
/**
 * 녹화 시작 IPC 핸들러
 * 렌더러에서 녹화 시작 신호를 받으면 파일 스트림을 생성합니다.
 */
ipcMain.on('start-recording', () => {
  console.log('MAIN: 녹화 시작 신호 수신');

  const fileName = `obs-recording-${Date.now()}.webm`;
  const fullPath = path.join(savePath, fileName);

  try {
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }
  } catch (err) {
    console.error('Main: 폴더 생성 실패', err);
    return;
  }

  console.log(`MAIN: 파일 저장 위치: ${fullPath}`);
  writableStream = fs.createWriteStream(fullPath);
});

/**
 * 비디오 청크 수신 IPC 핸들러
 * 렌더러에서 전송된 비디오 데이터 청크를 파일에 기록합니다.
 * @param {Object} event - IPC 이벤트 객체
 * @param {Uint8Array} chunk - 비디오 데이터 청크
 */
ipcMain.on('video-chunk', (event, chunk) => {
  if (writableStream) {
    writableStream.write(Buffer.from(chunk));
  }
});

/**
 * 녹화 중지 IPC 핸들러
 * 녹화 종료 신호를 받으면 파일 스트림을 닫습니다.
 */
ipcMain.on('stop-recording', () => {
  console.log('MAIN: 녹화 중지 신호 수신');
  if (writableStream) {
    writableStream.end();
    writableStream = null;
    console.log('MAIN: 파일 저장 완료.');
  }
});

/**
 * 앱 종료 IPC 핸들러
 */
ipcMain.on('exit-app', () => {
  app.quit();
});

/**
 * 메뉴 > Edit > Copy IPC 핸들러
 */
ipcMain.on('menu-copy', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.webContents.copy();
});

/**
 * 메뉴 > Edit > Paste IPC 핸들러
 */
ipcMain.on('menu-paste', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.webContents.paste();
});

/**
 * 메뉴 > View > Toggle Fullscreen IPC 핸들러
 */
ipcMain.on('menu-toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setFullScreen(!win.isFullScreen());
  }
});

/**
 * 메뉴 > View > Force Reload IPC 핸들러
 */
ipcMain.on('menu-reload', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.webContents.reload();
});

/**
 * 메뉴 > View > Toggle Developer Tools IPC 핸들러
 */
ipcMain.on('menu-toggle-devtools', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.webContents.toggleDevTools();
});

/**
 * 저장 위치 선택 다이얼로그 IPC 핸들러
 * 사용자가 폴더를 선택하면 저장 경로를 업데이트합니다.
 * @param {Object} event - IPC 이벤트 객체
 * @returns {Promise<string|null>} 선택된 경로 또는 null
 */
ipcMain.handle('select-save-path', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '녹화 파일 저장 위치 선택'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    savePath = result.filePaths[0];
    console.log(`MAIN: 저장 경로 변경: ${savePath}`);
    return savePath;
  }
  return null;
});

/**
 * 현재 저장 경로 조회 IPC 핸들러
 * @returns {string} 현재 저장 경로
 */
ipcMain.handle('get-save-path', () => {
  return savePath;
});

/**
 * 녹화 파일 목록 조회 IPC 핸들러
 * @returns {Promise<string[]>} 녹화 파일 목록
 */
ipcMain.handle('show-recordings', async () => {
  try {
    if (!fs.existsSync(savePath)) {
      return [];
    }
    const files = fs.readdirSync(savePath);
    return files.filter(file => file.endsWith('.webm')).sort().reverse();
  } catch (err) {
    console.error('녹화 파일 목록 조회 실패:', err);
    return [];
  }
});

// ============================================
// 라즈베리파이 통신 및 메시지 규격
// ============================================

let rpiSocket = null;

/**
 * 1. 객체 위치 정보 (ROI Message) 생성
 * @param {number} x - 객체 중심 x 좌표 (pixel)
 * @param {number} y - 객체 중심 y 좌표 (pixel)
 * @param {number} w - ROI 너비 (pixel)
 * @param {number} h - ROI 높이 (pixel)
 */
function createROIMessage(x, y, w, h) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h)
  };
}

/**
 * 2. 카메라 제어 정보 (Control Message) 생성
 * @param {number} pan - 팬(Pan) 각도 (degree)
 * @param {number} tilt - 틸트(Tilt) 각도 (degree)
 */
function createControlMessage(pan, tilt) {
  return {
    pan: Number(pan),
    tilt: Number(tilt)
  };
}

/**
 * 3. 상태 정보 (Status Message) 생성
 * @param {string|number} status - 추적 상태 코드
 */
function createStatusMessage(status) {
  return {
    status: status,
    timestamp: Date.now()
  };
}

/**
 * 라즈베리파이 WebSocket 연결 IPC 핸들러
 */
ipcMain.handle('connect-rpi', async (event, ip) => {
  return new Promise((resolve) => {
    try {
      if (rpiSocket) {
        rpiSocket.close();
        rpiSocket = null;
      }

      const wsUrl = `ws://${ip}:8765`;
      console.log(`[RPi] Connecting to ${wsUrl}`);

      // Electron 39+ (Node 20+) 환경에서는 global.WebSocket 사용 가능
      rpiSocket = new WebSocket(wsUrl);

      rpiSocket.onopen = () => {
        console.log('[RPi] Connected');
        resolve({ success: true });
        resolve({ success: true, streamUrl: `http://${ip}:8000/stream.mjpg` });
        rpiSocket.send(JSON.stringify(createStatusMessage('CONNECTED')));
      };

      rpiSocket.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          event.sender.send('rpi-message', data);
        } catch (e) {
          console.error('[RPi] Message parse error:', e);
        }
      };

      rpiSocket.onerror = (err) => {
        console.error('[RPi] Error:', err.message);
        resolve({ success: false, error: err.message });
      };

      rpiSocket.onclose = () => {
        console.log('[RPi] Disconnected');
        event.sender.send('rpi-disconnected');
        rpiSocket = null;
      };
    } catch (error) {
      console.error('[RPi] Setup failed:', error);
      resolve({ success: false, error: error.message });
    }
  });
});

ipcMain.handle('disconnect-rpi', () => {
  if (rpiSocket) {
    rpiSocket.close();
    rpiSocket = null;
  }
  return { success: true };
});

ipcMain.on('send-control', (event, { pan, tilt }) => {
  if (rpiSocket && rpiSocket.readyState === 1) {
    const msg = createControlMessage(pan, tilt);
    rpiSocket.send(JSON.stringify(msg));
  }
});

// ============================================
// 자동 업데이트 기능
// ============================================

/**
 * 버전 문자열을 비교합니다.
 * @param {string} version1 - 비교할 버전 1
 * @param {string} version2 - 비교할 버전 2
 * @returns {number} version1 > version2면 1, 같으면 0, 작으면 -1
 */
function compareVersions(version1, version2) {
  const v1parts = version1.split('.').map(Number);
  const v2parts = version2.split('.').map(Number);
  const maxLength = Math.max(v1parts.length, v2parts.length);

  for (let i = 0; i < maxLength; i++) {
    const v1part = v1parts[i] || 0;
    const v2part = v2parts[i] || 0;

    if (v1part > v2part) return 1;
    if (v1part < v2part) return -1;
  }
  return 0;
}

/**
 * 업데이트 서버에서 최신 버전 정보를 가져옵니다.
 * @returns {Promise<Object|null>} 업데이트 정보 또는 null
 */
async function checkForUpdates() {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(UPDATE_SERVER_URL);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          'User-Agent': `SpotlightCam/${app.getVersion()}`
        }
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const updateInfo = JSON.parse(data);
            resolve(updateInfo);
          } catch (error) {
            console.error('업데이트 정보 파싱 실패:', error);
            resolve(null);
          }
        });
      });

      req.on('error', (error) => {
        console.error('업데이트 확인 요청 실패:', error);
        resolve(null);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        console.error('업데이트 확인 타임아웃');
        resolve(null);
      });

      req.end();
    } catch (error) {
      console.error('업데이트 확인 오류:', error);
      resolve(null);
    }
  });
}

/**
 * 업데이트가 필요한지 확인하고 결과를 반환합니다.
 * @returns {Promise<Object|null>} 업데이트 정보 또는 null
 */
async function getUpdateInfo() {
  try {
    const updateInfo = await checkForUpdates();
    if (!updateInfo) {
      return null;
    }

    const currentVersion = app.getVersion();
    const latestVersion = updateInfo.version;

    if (compareVersions(latestVersion, currentVersion) > 0) {
      return {
        available: true,
        currentVersion: currentVersion,
        latestVersion: latestVersion,
        downloadUrl: updateInfo.downloadUrl,
        releaseNotes: updateInfo.releaseNotes || '업데이트가 사용 가능합니다.',
        releaseDate: updateInfo.releaseDate
      };
    }

    return {
      available: false,
      currentVersion: currentVersion,
      latestVersion: latestVersion
    };
  } catch (error) {
    console.error('업데이트 정보 가져오기 실패:', error);
    return null;
  }
}

/**
 * 업데이트 확인 IPC 핸들러
 * 렌더러에서 업데이트 확인을 요청하면 서버에서 최신 버전을 확인합니다.
 * @param {Object} event - IPC 이벤트 객체
 * @returns {Promise<Object|null>} 업데이트 정보
 */
ipcMain.handle('check-for-updates', async (event) => {
  console.log('업데이트 확인 요청');
  return await getUpdateInfo();
});

/**
 * 업데이트 다운로드 IPC 핸들러
 * 사용자가 업데이트를 다운로드하기로 결정하면 브라우저에서 다운로드 페이지를 엽니다.
 * @param {Object} event - IPC 이벤트 객체
 * @param {string} downloadUrl - 다운로드 URL
 */
ipcMain.on('download-update', (_event, downloadUrl) => {
  console.log('업데이트 다운로드:', downloadUrl);
  shell.openExternal(downloadUrl);
});

/**
 * 시스템에 설치된 GPU 목록 조회 IPC 핸들러
 * @returns {Promise<Array<{index: number, name: string}>>} GPU 목록
 */
ipcMain.handle('get-gpu-list', () => {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name"`,
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([{ index: 0, name: 'Unknown GPU' }]);
          return;
        }
        const gpus = stdout.trim().split('\n')
          .map((name, index) => ({ index, name: name.trim() }))
          .filter(g => g.name);
        resolve(gpus);
      }
    );
  });
});

/**
 * 선택된 GPU 설정 IPC 핸들러
 * @param {string} name - 선택된 GPU 이름
 */
ipcMain.on('set-selected-gpu', (event, name) => {
  selectedGpuName = name;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.webContents.send('gpu-name', name);
  }
});
