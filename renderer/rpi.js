/**
 * 라즈베리파이 연결 모듈
 * spotlight_core.py (ws://localhost:8765) 와 통신합니다.
 *
 * ─ 신규 방식 ─────────────────────────────────────────────
 *   connectToSpotlightCore()     : spotlight_core.py에 접속
 *   disconnectFromSpotlightCore(): 연결 해제
 *   sendMotorControl(pan, tilt)  : 모터 제어 명령 전송 (core가 RPi로 중계)
 *   sendTrackingState(enabled)   : 추적 on/off 전송 (core가 RPi로 중계)
 *   setupPiConnectionUI()        : 연결/해제 버튼 이벤트 등록
 *
 * ─ 구버전 방식 (주석 보존) ───────────────────────────────
 *   connectToRaspberryPi(ip, port) : RPi에 직접 접속
 *   disconnectFromRaspberryPi()    : 직접 연결 해제
 */

import { state, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY } from './state.js';
// import { showErrorModal } from './media.js'; // [구버전] RPi 직접 연결 시 에러 모달에 사용
import { addRpiSource, removeSource } from './sources.js';

// ═══════════════════════════════════════════════════════════
// 신규 방식: spotlight_core.py (localhost:8765) 연결
// ═══════════════════════════════════════════════════════════

const SPOTLIGHT_CORE_URL = 'ws://localhost:8765';

export function connectToSpotlightCore() {
  if (state.piWebSocket?.readyState === WebSocket.OPEN) return;

  try {
    state.piWebSocket = new WebSocket(SPOTLIGHT_CORE_URL);

    state.piWebSocket.onopen = () => {
      state.piConnected = true;
      state.piReconnectAttempts = 0;
      updatePiConnectionStatus(true);
    };

    state.piWebSocket.onmessage = (event) => {
      if (event.data instanceof Blob) {
        handlePiVideoFrame(event.data);
      } else {
        handlePiMessage(JSON.parse(event.data));
      }
    };

    state.piWebSocket.onclose = (event) => {
      state.piConnected = false;
      if (event.code !== 1000) {
        if (state.piReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          attemptSpotlightReconnect();
        } else {
          updatePiConnectionStatus(false, '연결 실패: 재연결 시도 횟수를 초과했습니다.');
        }
      } else {
        updatePiConnectionStatus(false, '연결이 종료되었습니다.');
      }
    };

    state.piWebSocket.onerror = () => {
      state.piConnected = false;
      updatePiConnectionStatus(false, '연결 오류: spotlight_core.py에 연결할 수 없습니다.');
    };
  } catch (error) {
    updatePiConnectionStatus(false, `WebSocket을 생성할 수 없습니다: ${error.message}`);
  }
}

export function disconnectFromSpotlightCore() {
  if (state.piWebSocket) {
    state.piWebSocket.close(1000, '사용자 요청으로 연결 종료');
    state.piWebSocket = null;
  }
  state.piConnected = false;
  state.piReconnectAttempts = 0;
  if (state.piReconnectTimer) {
    clearTimeout(state.piReconnectTimer);
    state.piReconnectTimer = null;
  }
  updatePiConnectionStatus(false);

  // Sources 패널에서 RPi 소스 제거
  const rpiSrc = state.sources.find(s => s.type === 'rpi');
  if (rpiSrc) removeSource(rpiSrc.id);

  if (state.piVideoStream) {
    state.piVideoStream = null;
    state.trackingCanvas = null;
    state.trackingCtx = null;
  }
}

function attemptSpotlightReconnect() {
  state.piReconnectAttempts++;
  updatePiConnectionStatus(false, `재연결 시도 중... (${state.piReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  state.piReconnectTimer = setTimeout(() => connectToSpotlightCore(), RECONNECT_DELAY);
}

export function sendTrackingState(enabled) {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ tracking: enabled ? 'on' : 'off' }));
}

export function setupPiConnectionUI() {
  const connectBtn = document.getElementById('connect-pi-btn');
  const disconnectBtn = document.getElementById('disconnect-pi-btn');
  connectBtn?.addEventListener('click', () => connectToSpotlightCore());
  disconnectBtn?.addEventListener('click', disconnectFromSpotlightCore);
  updatePiConnectionStatus(false);
}

// ═══════════════════════════════════════════════════════════
// 메시지 수신 처리
// ═══════════════════════════════════════════════════════════

function handlePiMessage(data) {
  switch (data.type) {
    case 'video_frame': handlePiVideoFrame(data.frame); break;
    case 'motor_corrected': handleMotorCorrected(data.control); break;
    case 'motor_status': break;
    case 'system_info': break;
  }
}

/**
 * 모터 보정 완료 응답 처리.
 * RPi가 보정을 적용한 뒤 pan/tilt를 0으로 초기화해 전송하면 호출된다.
 * tracking.js의 pendingCorrection을 리셋해 보정값 누적을 방지한다.
 * @param {{ pan: number, tilt: number }} control
 */
function handleMotorCorrected(control) {
  if (!control) return;
  if (state.pendingCorrection) {
    state.pendingCorrection.pan  = control.pan;
    state.pendingCorrection.tilt = control.tilt;
  }
}

function handlePiVideoFrame(frameData) {
  if (!frameData) return;

  try {
    if (typeof frameData === 'string') {
      const img = new Image();
      img.onload = () => {
        if (!state.trackingCanvas) {
          state.trackingCanvas = document.createElement('canvas');
          state.trackingCanvas.width = img.width;
          state.trackingCanvas.height = img.height;
          state.trackingCtx = state.trackingCanvas.getContext('2d');
          state.piVideoStream = state.trackingCanvas;
          addRpiSource();
        }
        state.trackingCtx.drawImage(img, 0, 0);
      };
      img.src = `data:image/jpeg;base64,${frameData}`;

    } else if (frameData instanceof Blob) {
      const url = URL.createObjectURL(frameData);
      const img = new Image();
      img.onload = () => {
        if (!state.trackingCanvas) {
          state.trackingCanvas = document.createElement('canvas');
          state.trackingCanvas.width = img.width;
          state.trackingCanvas.height = img.height;
          state.trackingCtx = state.trackingCanvas.getContext('2d');
          state.piVideoStream = state.trackingCanvas;
          addRpiSource();
        }
        state.trackingCtx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  } catch (error) {
    console.error('비디오 프레임 처리 오류:', error);
  }
}

// ═══════════════════════════════════════════════════════════
// 상태 표시 / 모터 제어
// ═══════════════════════════════════════════════════════════

export function updatePiConnectionStatus(connected, message) {
  const statusIndicator = document.getElementById('pi-status-indicator');
  const statusText = document.getElementById('pi-status-text');
  const connectionStatus = document.getElementById('pi-connection-status');
  const connectBtn = document.getElementById('connect-pi-btn');
  const disconnectBtn = document.getElementById('disconnect-pi-btn');

  if (connected) {
    statusIndicator?.style.setProperty('background-color', 'var(--color-success)');
    statusIndicator?.classList.replace('disconnected', 'connected');
    if (statusText) statusText.textContent = '라즈베리파이: 연결됨';
    if (connectionStatus) { connectionStatus.textContent = '연결됨'; connectionStatus.style.backgroundColor = 'var(--color-success)'; connectionStatus.style.color = 'white'; }
    if (connectBtn) connectBtn.style.display = 'none';
    if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
  } else {
    statusIndicator?.style.setProperty('background-color', 'var(--color-danger)');
    statusIndicator?.classList.replace('connected', 'disconnected');
    if (statusText) statusText.textContent = message || '라즈베리파이: 연결 안 됨';
    if (connectionStatus) { connectionStatus.textContent = message || '연결 안 됨'; connectionStatus.style.backgroundColor = 'var(--bg-medium)'; connectionStatus.style.color = 'var(--text-secondary)'; }
    if (connectBtn) connectBtn.style.display = 'inline-block';
    if (disconnectBtn) disconnectBtn.style.display = 'none';
  }
}

export function sendMotorControl(pan, tilt) {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  pan = Math.max(-90, Math.min(90, pan));
  tilt = Math.max(-90, Math.min(90, tilt));
  if (Math.abs(pan - state.lastMotorCommand.pan) < 1 && Math.abs(tilt - state.lastMotorCommand.tilt) < 1) return;
  state.lastMotorCommand = { pan, tilt };
  state.piWebSocket.send(JSON.stringify({ type: 'motor_control', pan, tilt, timestamp: Date.now() }));
}

export function sendObjectCoords(obj_x, obj_y) {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ type: 'object_detected', obj_x, obj_y }));
}

// ═══════════════════════════════════════════════════════════
// [구버전] RPi 직접 연결 방식 — 나중에 재사용 가능하도록 보존
// ═══════════════════════════════════════════════════════════

/*
export function connectToRaspberryPi(ip, port = 8765) {
  if (state.piWebSocket?.readyState === WebSocket.OPEN) return;
  try {
    state.piWebSocket = new WebSocket(`ws://${ip}:${port}`);
    state.piWebSocket.onopen = () => {
      state.piConnected = true;
      state.piReconnectAttempts = 0;
      updatePiConnectionStatus(true);
      state.piWebSocket.send(JSON.stringify({ type: 'client_ready', message: 'Electron 클라이언트 연결됨' }));
    };
    state.piWebSocket.onmessage = (event) => {
      try { handlePiMessage(JSON.parse(event.data)); } catch { handlePiVideoFrame(event.data); }
    };
    state.piWebSocket.onclose = (event) => {
      state.piConnected = false;
      if (event.code !== 1000) {
        if (state.piReconnectAttempts < MAX_RECONNECT_ATTEMPTS) attemptReconnect(ip, port);
        else updatePiConnectionStatus(false, '연결 실패: 재연결 횟수 초과');
      } else updatePiConnectionStatus(false, '연결 종료');
    };
    state.piWebSocket.onerror = () => {
      state.piConnected = false;
      updatePiConnectionStatus(false, '네트워크 오류');
    };
  } catch (error) {
    updatePiConnectionStatus(false, `WebSocket 생성 불가: ${error.message}`);
  }
}

export function disconnectFromRaspberryPi() {
  if (state.piWebSocket) { state.piWebSocket.close(1000, '사용자 요청'); state.piWebSocket = null; }
  state.piConnected = false;
  state.piReconnectAttempts = 0;
  if (state.piReconnectTimer) { clearTimeout(state.piReconnectTimer); state.piReconnectTimer = null; }
  updatePiConnectionStatus(false);
}

function attemptReconnect(ip, port) {
  state.piReconnectAttempts++;
  updatePiConnectionStatus(false, `재연결 시도 중... (${state.piReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  state.piReconnectTimer = setTimeout(() => connectToRaspberryPi(ip, port), RECONNECT_DELAY);
}

// 구버전 setupPiConnectionUI — IP/Port 입력을 받아 직접 RPi에 연결
// export function setupPiConnectionUI() {
//   const connectBtn = document.getElementById('connect-pi-btn');
//   const disconnectBtn = document.getElementById('disconnect-pi-btn');
//   const piIpInput = document.getElementById('raspberry-pi-ip');
//   const piPortInput = document.getElementById('raspberry-pi-port');
//
//   connectBtn?.addEventListener('click', () => {
//     const ip = piIpInput?.value.trim();
//     const port = parseInt(piPortInput?.value || '8765');
//     if (!ip) { alert('라즈베리파이 IP 주소를 입력하세요.'); return; }
//     if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) { alert('올바른 IP 주소 형식을 입력하세요.'); return; }
//     connectToRaspberryPi(ip, port);
//   });
//
//   disconnectBtn?.addEventListener('click', disconnectFromRaspberryPi);
//   piIpInput?.addEventListener('keypress', e => { if (e.key === 'Enter') connectBtn?.click(); });
//   piPortInput?.addEventListener('keypress', e => { if (e.key === 'Enter') connectBtn?.click(); });
//   updatePiConnectionStatus(false);
// }
*/
