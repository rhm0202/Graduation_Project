/**
 * 객체 추적 모듈
 * YOLO 기반 객체 감지(시뮬레이션) 및 자동 추적 모드를 담당합니다.
 */
import { state } from './state.js';
import { sendMotorControl, sendTrackingState } from './rpi.js';

function sendTrackingState(enabled) {
  if (state.piWebSocket?.readyState === WebSocket.OPEN) {
    state.piWebSocket.send(JSON.stringify({ tracking: enabled ? 'on' : 'off' }));
  }
}

/**
 * 자동 추적 모드를 토글합니다.
 * spotlight_core.py에 tracking on/off 상태를 전송합니다.
 */
export function toggleAutoTracking() {
  state.autoTrackingEnabled = !state.autoTrackingEnabled;
  const btn = document.getElementById('toggle-auto-tracking');
  if (btn) {
    btn.textContent = `자동 추적: ${state.autoTrackingEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('recording', state.autoTrackingEnabled);
  }
  sendTrackingState(state.autoTrackingEnabled);
  if (state.autoTrackingEnabled) startAutoTracking();
  else stopAutoTracking();
}

function startAutoTracking() {
  if (!state.mediaStream && !state.piVideoStream) {
    console.warn('비디오 스트림이 없습니다.');
    return;
  }

  if (!state.trackingCanvas) {
    state.trackingCanvas = document.createElement('canvas');
    state.trackingCtx = state.trackingCanvas.getContext('2d', { willReadFrequently: true });
  }

  loadYOLOModel();
  processObjectTracking();
}

function stopAutoTracking() {
  if (state.trackingAnimationFrame) {
    cancelAnimationFrame(state.trackingAnimationFrame);
    state.trackingAnimationFrame = null;
  }
  state.detectedObjects = [];
}

async function loadYOLOModel() {
  // TODO: 실제 YOLO 모델 로드 (TensorFlow.js 등)
  console.log('YOLO 모델 로드 (시뮬레이션)');
  state.yoloModel = { loaded: true };
}

/**
 * 객체 추적 루프를 실행합니다.
 */
export function processObjectTracking() {
  if (!state.autoTrackingEnabled) return;

  const videoElement = document.getElementById('main-video-feed');
  if (!videoElement?.videoWidth || !state.trackingCanvas || !state.trackingCtx) {
    state.trackingAnimationFrame = requestAnimationFrame(processObjectTracking);
    return;
  }

  state.trackingCanvas.width = videoElement.videoWidth || 640;
  state.trackingCanvas.height = videoElement.videoHeight || 480;
  state.trackingCtx.drawImage(videoElement, 0, 0, state.trackingCanvas.width, state.trackingCanvas.height);

  detectObjects(state.trackingCanvas).then((objects) => {
    state.detectedObjects = objects;

    const persons = objects.filter((o) => o.class === 'person');
    if (persons.length > 0 && state.piConnected) {
      const main = persons.reduce((prev, curr) =>
        curr.width * curr.height > prev.width * prev.height ? curr : prev,
      );
      const centerX = main.x + main.width / 2;
      const centerY = main.y + main.height / 2;
      const halfW = state.trackingCanvas.width / 2;
      const halfH = state.trackingCanvas.height / 2;
      sendMotorControl(((centerX - halfW) / halfW) * 45, -((centerY - halfH) / halfH) * 45);
    }

    state.trackingAnimationFrame = requestAnimationFrame(processObjectTracking);
  });
}

async function detectObjects(canvas) {
  // TODO: 실제 YOLO 모델 추론
  if (Math.random() > 0.7) {
    return [{
      class: 'person',
      confidence: 0.85,
      x: Math.random() * (canvas.width - 100),
      y: Math.random() * (canvas.height - 100),
      width: 80 + Math.random() * 40,
      height: 120 + Math.random() * 40,
    }];
  }
  return [];
}
