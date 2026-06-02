/**
 * 라즈베리파이 연결 모듈
 *
 * ─ 서보 제어 (WebSocket) ─────────────────────────────────────
 *   connectToSpotlightCore()      : spotlight_core.py에 접속 (ws://localhost:8765)
 *   disconnectFromSpotlightCore() : 연결 해제 (WebSocket + WebRTC 모두 종료)
 *   sendTrackingState(enabled)    : 추적 on/off 전송 (core가 RPi로 중계)
 *   sendObjectCoords(obj_x, obj_y): 객체 좌표 전송 (core가 PID 연산 후 서보 제어)
 *   setupPiConnectionUI()         : 연결/해제 버튼 이벤트 등록
 *
 * ─ 영상 수신 (MediaMTX WebRTC WHEP) ─────────────────────────
 *   connectWebRTC(ip, port, streamName) : WHEP 방식 WebRTC 영상 연결
 *   disconnectWebRTC()                  : WebRTC 연결 해제
 *
 *   WHEP URL 형식: http://{ip}:{port}/{streamName}/whep
 *   예시: http://192.168.137.114:8000/cam/whep
 *
 * ─ 구버전 방식 (주석 보존) ───────────────────────────────────
 *   RPi에서 WebSocket으로 JPEG 프레임을 직접 전송하던 방식
 */

import { state, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY } from './state.js';
import { addRpiSource, removeSource } from './sources.js';

// ═══════════════════════════════════════════════════════════
// 서보 제어: spotlight_core.py (localhost:8765) WebSocket
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
      state.piWebSocket.send(JSON.stringify({ type: 'servo_init' }));

      // 서보 제어 채널 연결 성공 후 WebRTC 영상 연결 시작
      const { ip, port, streamName } = _loadRpiSettings();
      connectWebRTC(ip, port, streamName);
    };

    state.piWebSocket.onmessage = (event) => {
      // Binary(Blob) 프레임은 더 이상 처리하지 않음 — 영상은 WebRTC로 수신
      if (typeof event.data === 'string') {
        try {
          handlePiMessage(JSON.parse(event.data));
        } catch { /* JSON 파싱 오류 무시 */ }
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
  // WebSocket 종료
  if (state.piWebSocket) {
    state.piWebSocket.close(1000, '사용자 요청으로 연결 종료');
    state.piWebSocket = null;
  }

  // WebRTC 종료
  disconnectWebRTC();

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
// 메시지 수신 처리 (서보 제어 응답만)
// ═══════════════════════════════════════════════════════════

function handlePiMessage(data) {
  switch (data.type) {
    case 'system_info': break;
    // video_frame 케이스 제거 — 영상은 MediaMTX WebRTC로 수신
  }
}

// ═══════════════════════════════════════════════════════════
// 영상 수신: MediaMTX WebRTC (WHEP)
// WHEP: WebRTC HTTP Egress Protocol — SDP를 HTTP POST로 교환하는 단순 방식
// 로컬 네트워크 전용이므로 iceServers(STUN/TURN)가 필요 없음
// ═══════════════════════════════════════════════════════════

/**
 * MediaMTX WHEP 프로토콜로 WebRTC 영상 연결을 시작합니다.
 * @param {string} ip         - RPi IP 주소 (예: '192.168.137.114')
 * @param {number} port       - MediaMTX HTTP 포트 (예: 8000)
 * @param {string} streamName - MediaMTX 스트림 경로 (예: 'cam')
 */
export async function connectWebRTC(ip, port = 8000, streamName = 'cam') {
  // 기존 연결 정리
  if (state.rtcPeerConnection) {
    state.rtcPeerConnection.close();
    state.rtcPeerConnection = null;
  }

  // 로컬 네트워크 전용 — STUN/TURN 없음
  const pc = new RTCPeerConnection({ iceServers: [] });
  state.rtcPeerConnection = pc;

  // 트랙 수신 핸들러 (offer 생성 전에 반드시 등록)
  pc.ontrack = (e) => {
    if (!e.streams?.[0]) return;
    const stream = e.streams[0];

    // WebRTC MediaStream을 <video> element에 연결
    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.play().catch(() => { });

    state.piVideoStream = videoEl;

    // 메타데이터 로드 후 소스 등록 (videoWidth/Height 확정 시점)
    videoEl.addEventListener('loadedmetadata', () => {
      addRpiSource();
    }, { once: true });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[WebRTC] ICE 상태:', s);
    if (s === 'failed' || s === 'closed') {
      updatePiConnectionStatus(false, `WebRTC 연결 끊김 (${s})`);
    }
  };

  // 수신 전용 Transceiver 추가 (영상만 수신)
  pc.addTransceiver('video', { direction: 'recvonly' });

  // SDP Offer 생성 및 로컬 디스크립션 설정
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // WHEP 엔드포인트에 SDP Offer 전송
  const whepUrl = `http://${ip}:${port}/${streamName}/whep`;
  console.log('[WebRTC] WHEP 연결 시도:', whepUrl);

  try {
    const response = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });

    if (!response.ok) {
      throw new Error(`서버 응답 오류: ${response.status} ${response.statusText}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    console.log('[WebRTC] SDP Answer 적용 완료 — 영상 수신 대기 중');
  } catch (error) {
    console.error('[WebRTC] 연결 실패:', error);
    pc.close();
    state.rtcPeerConnection = null;
    updatePiConnectionStatus(false, `영상 연결 실패: ${error.message}`);
  }
}

function disconnectWebRTC() {
  if (state.rtcPeerConnection) {
    state.rtcPeerConnection.close();
    state.rtcPeerConnection = null;
  }
  state.piVideoStream = null;
}

// ═══════════════════════════════════════════════════════════
// 상태 표시 / 객체 좌표 전송
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

export function sendObjectCoords(obj_x, obj_y) {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ type: 'object_detected', obj_x, obj_y }));
}

export function sendServoInit() {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ type: 'servo_init' }));
}

// ═══════════════════════════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════════════════════════

/**
 * localStorage에서 RPi 설정을 읽어 반환합니다.
 * 저장된 값이 없으면 기본값(192.168.137.114:8000/cam)을 사용합니다.
 */
function _loadRpiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('spotlightCamSettings') || '{}');
    return {
      ip: saved.raspberryPiIp || '192.168.137.114',
      port: parseInt(saved.raspberryPiPort || '8000', 10),
      streamName: saved.mediamtxStream || 'cam',
    };
  } catch {
    return { ip: '192.168.137.114', port: 8000, streamName: 'cam' };
  }
}

// ═══════════════════════════════════════════════════════════
// [구버전] RPi WebSocket JPEG 프레임 수신 방식 — 보존용 주석
// ═══════════════════════════════════════════════════════════

/*
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
        const ctx = state.trackingCtx;
        ctx.save();
        ctx.translate(0, state.trackingCanvas.height);
        ctx.scale(1, -1);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
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
        const ctx = state.trackingCtx;
        ctx.save();
        ctx.translate(img.width, img.height);
        ctx.rotate(Math.PI);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  } catch (error) {
    console.error('비디오 프레임 처리 오류:', error);
  }
}

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
*/
