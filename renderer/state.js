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
  sessionBusy: false,
  comparisonMode: false,
  backgroundImage: null,
  backgroundVideo: null,
  processedStream: null,
  backgroundCanvas: null,
  backgroundCtx: null,
  backgroundAnimationFrame: null,
  session: null,

  // 라즈베리파이
  piWebSocket: null,
  piConnected: false,
  piReconnectAttempts: 0,
  piReconnectTimer: null,
  piVideoStream: null,

  // 활성 스트림 (레거시 — masterStream으로 대체됨, 일부 호환용 유지)
  activeStream: null,
  activeCameraSource: 'local',
  displayStream: null,

  // OBS 소스 시스템
  sources: [],                 // Source 객체 배열 (sources[0] = 최상단 레이어)
  selectedSourceId: null,      // 현재 선택된 소스 ID (배경 제거 등 조작 대상)
  masterCanvas: null,          // 컴포지팅 출력 캔버스
  masterCtx: null,             // 마스터 캔버스 2D 컨텍스트
  masterStream: null,          // masterCanvas.captureStream() → 화면 표시 + 녹화 소스
  bgColor: null,               // 배경 제거 후 적용할 단색 (hex)

  // 객체 추적
  autoTrackingEnabled: false,
  yoloModel: null,
  trackingCanvas: null,
  trackingCtx: null,
  detectedObjects: [],
  trackingAnimationFrame: null,
  lastMotorCommand: { pan: 0, tilt: 0 },
  pendingCorrection: { pan: 0, tilt: 0 },  // RPi 보정 완료 응답 수신 전까지 누적되는 보정값
};

export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAY = 3000;
export const MODEL_SIZE = 512;

export const isElectron =
  typeof window.electronAPI !== "undefined" &&
  typeof window.electronAPI.send === "function";
