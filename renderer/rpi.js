/** Raspberry Pi control channel and MediaMTX WHEP video lifecycle. */
import { state, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY } from './state.js';
import { addRpiSource, clearRpiSource, removeSource } from './sources.js';

const SPOTLIGHT_CORE_URL = 'ws://localhost:8765';
const TRACKING_FRAME_WIDTH = 1920;
const TRACKING_FRAME_HEIGHT = 1080;
const COMMAND_MAX_AGE_MS = 250;
let trackingEpoch = 0;
let videoAttempt = null;
let videoRetryTimer = null;
let videoRetryAttempts = 0;

export function connectToSpotlightCore() {
  if (state.piWebSocket?.readyState === WebSocket.CONNECTING) return;
  if (state.piWebSocket?.readyState === WebSocket.OPEN) {
    if (!videoAttempt || ['failed', 'closed', 'disconnected'].includes(videoAttempt.pc.connectionState)) {
      videoRetryAttempts = 0;
      const { ip, port, streamName } = _loadRpiSettings();
      void connectWebRTC(ip, port, streamName);
    }
    return;
  }
  clearTimeout(state.piReconnectTimer);
  state.piReconnectTimer = null;
  try {
    const ws = new WebSocket(SPOTLIGHT_CORE_URL);
    state.piWebSocket = ws;
    const isCurrent = () => state.piWebSocket === ws;
    ws.onopen = () => {
      if (!isCurrent()) { ws.close(); return; }
      state.piConnected = true;
      state.piMotorReady = false;
      state.piReconnectAttempts = 0;
      // Reconnecting must not move the camera to 90 degrees.
      sendTrackingState(state.autoTrackingEnabled);
      videoRetryAttempts = 0;
      const { ip, port, streamName } = _loadRpiSettings();
      void connectWebRTC(ip, port, streamName);
    };
    ws.onmessage = event => {
      if (!isCurrent() || typeof event.data !== 'string') return;
      try { handlePiMessage(JSON.parse(event.data)); } catch { /* malformed reply */ }
    };
    ws.onclose = event => {
      if (!isCurrent()) return;
      state.piWebSocket = null;
      state.piConnected = false;
      state.piMotorReady = false;
      disconnectWebRTC();
      if (event.code !== 1000 && state.piReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        state.piReconnectAttempts++;
        updatePiConnectionStatus(false, `제어 재연결 중 (${state.piReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        state.piReconnectTimer = setTimeout(connectToSpotlightCore, RECONNECT_DELAY);
      } else {
        updatePiConnectionStatus(false, '제어 연결이 종료되었습니다.');
      }
    };
    ws.onerror = () => {
      if (isCurrent()) updatePiConnectionStatus(false, 'spotlight_core 연결 오류');
    };
  } catch (error) {
    updatePiConnectionStatus(false, `제어 연결 실패: ${error.message}`);
  }
}

export function disconnectFromSpotlightCore() {
  clearTimeout(state.piReconnectTimer);
  state.piReconnectTimer = null;
  sendTrackingState(false);
  const ws = state.piWebSocket;
  state.piWebSocket = null;
  state.piConnected = false;
  state.piMotorReady = false;
  state.piReconnectAttempts = 0;
  ws?.close(1000, '사용자 요청으로 연결 종료');
  disconnectWebRTC();
  const src = state.sources.find(s => s.type === 'rpi');
  if (src) removeSource(src.id);
  updatePiConnectionStatus(false);
}

export function sendTrackingState(enabled) {
  trackingEpoch++;
  if (state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ tracking: enabled ? 'on' : 'off', epoch: trackingEpoch }));
}

export function setupPiConnectionUI() {
  document.getElementById('connect-pi-btn')?.addEventListener('click', connectToSpotlightCore);
  document.getElementById('disconnect-pi-btn')?.addEventListener('click', disconnectFromSpotlightCore);
  updatePiConnectionStatus(false);
}

function handlePiMessage(data) {
  if (data.type !== 'control_status') return;
  state.piMotorReady = data.ready === true;
  state.piMotorStatus = data.motor ?? null;
  if (!data.connected) updatePiConnectionStatus(false, '파이 제어 채널 재연결 중');
  else if (!data.ready) updatePiConnectionStatus(false, data.error || '모터 상태 동기화 중');
  else refreshConnectionStatus();
}

function refreshConnectionStatus() {
  const connected = state.rtcPeerConnection?.connectionState === 'connected'
    && state.piVideoStream?.readyState >= 2;
  updatePiConnectionStatus(connected && state.piMotorReady,
    !state.piMotorReady ? '모터 상태 동기화 중' : '영상 연결 중');
}

function releaseVideo() {
  const video = state.piVideoStream;
  state.piVideoStream = null;
  clearRpiSource();
  if (video) {
    video.pause();
    video.srcObject?.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
}

function disposeAttempt(attempt) {
  if (!attempt) return;
  clearTimeout(attempt.timeout);
  clearTimeout(attempt.disconnectedTimer);
  attempt.abort.abort();
  attempt.pc.ontrack = null;
  attempt.pc.onconnectionstatechange = null;
  attempt.pc.oniceconnectionstatechange = null;
  attempt.pc.close();
  if (attempt.resourceUrl) {
    void fetch(attempt.resourceUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
}

function abortable(operation, signal) {
  // Chromium may leave createOffer/setDescription pending when its peer closes.
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException('Connection replaced', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([operation, cancelled])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

export function disconnectWebRTC() {
  clearTimeout(videoRetryTimer);
  videoRetryTimer = null;
  const old = videoAttempt;
  videoAttempt = null;
  state.rtcPeerConnection = null;
  disposeAttempt(old);
  releaseVideo();
}

export async function connectWebRTC(ip, port = 8000, streamName = 'cam') {
  disconnectWebRTC();
  let attempt;
  const whepUrl = `http://${ip}:${port}/${streamName}/whep`;
  const fail = error => {
    if (!attempt || videoAttempt !== attempt) return;
    console.warn('[WebRTC]', error.message);
    disconnectWebRTC();
    updatePiConnectionStatus(false, `영상 연결 실패: ${error.message}`);
    if (state.piConnected && videoRetryAttempts < MAX_RECONNECT_ATTEMPTS) {
      videoRetryAttempts++;
      videoRetryTimer = setTimeout(() => {
        videoRetryTimer = null;
        void connectWebRTC(ip, port, streamName);
      }, RECONNECT_DELAY);
    }
  };
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    attempt = { pc, abort: new AbortController(), resourceUrl: null };
    videoAttempt = attempt;
    state.rtcPeerConnection = pc;
    const wait = operation => abortable(operation, attempt.abort.signal);
    const isCurrent = () => videoAttempt === attempt;
    attempt.timeout = setTimeout(() => fail(new Error('영상 연결 시간 초과')), 10000);
    updatePiConnectionStatus(false, '영상 연결 중');
    pc.ontrack = event => {
      if (!isCurrent() || event.track.kind !== 'video') return;
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      releaseVideo();
      const video = document.createElement('video');
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      state.piVideoStream = video;
      const attach = () => {
        if (isCurrent() && state.piVideoStream === video) addRpiSource();
      };
      video.addEventListener('loadedmetadata', attach, { once: true });
      video.addEventListener('loadeddata', () => {
        if (!isCurrent()) return;
        clearTimeout(attempt.timeout);
        videoRetryAttempts = 0;
        refreshConnectionStatus();
      }, { once: true });
      event.track.addEventListener('ended', () => {
        if (isCurrent()) fail(new Error('영상 트랙 종료'));
      }, { once: true });
      if (video.readyState >= 1) attach();
      void video.play().catch(() => {});
    };
    const changed = () => {
      if (!isCurrent()) return;
      const connection = pc.connectionState;
      const ice = pc.iceConnectionState;
      if (connection === 'failed' || connection === 'closed' || ice === 'failed') {
        fail(new Error('영상 연결 끊김'));
      } else if (connection === 'disconnected' || ice === 'disconnected') {
        if (!attempt.disconnectedTimer) {
          attempt.disconnectedTimer = setTimeout(() => fail(new Error('영상 연결 응답 없음')), 3000);
        }
      } else if (connection === 'connected') {
        if (state.piVideoStream?.readyState >= 2) {
          clearTimeout(attempt.timeout);
          videoRetryAttempts = 0;
        }
        clearTimeout(attempt.disconnectedTimer);
        attempt.disconnectedTimer = null;
        refreshConnectionStatus();
      }
    };
    pc.onconnectionstatechange = changed;
    pc.oniceconnectionstatechange = changed;
    pc.addTransceiver('video', { direction: 'recvonly' });
    const offer = await wait(pc.createOffer());
    if (!isCurrent()) return;
    await wait(pc.setLocalDescription(offer));
    if (!isCurrent()) return;
    const response = await wait(fetch(whepUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp, signal: attempt.abort.signal,
    }));
    const location = response.headers.get('Location');
    if (location) attempt.resourceUrl = new URL(location, whepUrl).href;
    if (!isCurrent()) { disposeAttempt(attempt); return; }
    if (!response.ok) throw new Error(`WHEP 응답 ${response.status}`);
    const answer = await wait(response.text());
    if (!isCurrent()) return;
    await wait(pc.setRemoteDescription({ type: 'answer', sdp: answer }));
  } catch (error) {
    if (!attempt) updatePiConnectionStatus(false, `영상 연결 실패: ${error.message}`);
    else fail(error);
  }
}

export function updatePiConnectionStatus(connected, message) {
  const indicator = document.getElementById('pi-status-indicator');
  const status = document.getElementById('pi-status-text');
  const detail = document.getElementById('pi-connection-status');
  const connect = document.getElementById('connect-pi-btn');
  const disconnect = document.getElementById('disconnect-pi-btn');
  const text = connected ? '연결됨' : (message || '연결 안 됨');
  indicator?.style.setProperty('background-color', connected ? 'var(--color-success)' : 'var(--color-danger)');
  indicator?.classList.toggle('connected', connected);
  indicator?.classList.toggle('disconnected', !connected);
  if (status) status.textContent = `라즈베리파이: ${text}`;
  if (detail) {
    detail.textContent = text;
    detail.style.backgroundColor = connected ? 'var(--color-success)' : 'var(--bg-medium)';
    detail.style.color = connected ? 'white' : 'var(--text-secondary)';
  }
  if (connect) connect.style.display = connected ? 'none' : 'inline-block';
  if (disconnect) disconnect.style.display = state.piWebSocket || videoAttempt ? 'inline-block' : 'none';
}

export function sendObjectCoords({ x, y, frameWidth, frameHeight, observedAtMs }) {
  const ws = state.piWebSocket;
  if (!state.piMotorReady || !state.autoTrackingEnabled || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 0) return;
  if (![x, y, frameWidth, frameHeight, observedAtMs].every(Number.isFinite) || frameWidth <= 0 || frameHeight <= 0) return;
  const age = performance.now() - observedAtMs;
  if (age < 0 || age > COMMAND_MAX_AGE_MS) return;
  ws.send(JSON.stringify({
    type: 'object_detected', epoch: trackingEpoch,
    obj_x: x * TRACKING_FRAME_WIDTH / frameWidth,
    obj_y: y * TRACKING_FRAME_HEIGHT / frameHeight,
    observed_at_ms: Date.now() - age,
  }));
}

export function sendServoInit() {
  if (state.piWebSocket?.readyState !== WebSocket.OPEN) return;
  state.piWebSocket.send(JSON.stringify({ type: 'servo_init' }));
}

function _loadRpiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('spotlightCamSettings') || '{}');
    return {
      ip: saved.raspberryPiIp || '192.168.137.114',
      port: parseInt(saved.raspberryPiPort || '8000', 10),
      streamName: saved.mediamtxStream || 'cam',
    };
  } catch { return { ip: '192.168.137.114', port: 8000, streamName: 'cam' }; }
}
