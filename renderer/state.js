/**
 * 중앙 상태 관리 모듈
 * 모든 모듈이 공유하는 전역 상태를 단일 객체로 관리합니다.
 */
export const state = {
  // 미디어 스트림
  mediaStream: null,
  mediaRecorder: null,
  isRecording: false,
  recTimer: null,
  recStartTime: 0,

  // 오디오
  audioContext: null,
  gainNodes: { desktop: null, mic: null },
  analysers: { desktop: null, mic: null },
  audioMuted: { desktop: false, mic: false },

  // AI 배경 제거
  backgroundRemovalEnabled: false,
  comparisonMode: false,
  backgroundImage: null,
  backgroundVideo: null,
  processedStream: null,
  backgroundCanvas: null,
  backgroundCtx: null,
  backgroundAnimationFrame: null,
  session: null,

  // 장면
  scenes: [{ id: 0, name: 'Scene' }],
  currentSceneId: 0,

  // 소스
  sources: [],
  selectedSourceId: null,
  nextSourceId: 1,

  // 라즈베리파이
  piWebSocket: null,
  piConnected: false,
  piReconnectAttempts: 0,
  piReconnectTimer: null,
  piVideoStream: null,

  // 객체 추적
  autoTrackingEnabled: false,
  yoloModel: null,
  trackingCanvas: null,
  trackingCtx: null,
  detectedObjects: [],
  trackingAnimationFrame: null,
  lastMotorCommand: { pan: 0, tilt: 0 },
};

export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAY = 3000;
export const MODEL_SIZE = 512;

export const isElectron =
  typeof window.electronAPI !== 'undefined' &&
  typeof window.electronAPI.send === 'function';
