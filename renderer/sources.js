/**
 * OBS 스타일 소스 패널 및 마스터 캔버스 컴포지팅 모듈
 *
 * ─ 아키텍처 ───────────────────────────────────────────────
 *  [Webcam/Display/Window/RPi 소스]
 *        │  각 소스의 videoEl / bgCanvas
 *        ▼
 *  [Master Canvas (rAF 컴포지터)]  ← captureStream(30)
 *        │
 *        ├─▶ <canvas id="main-preview-canvas">  (drawImage 복사, captureStream 없음)
 *        └─▶ MediaRecorder  (captureStream 전용)
 *
 * state.sources[0] = 최상단 레이어 (마지막에 그려짐)
 * state.sources[last] = 최하단 레이어 (처음에 그려짐)
 */
import { state, isElectron } from "./state.js";
import { sendObjectCoords, sendTrackingState } from "./rpi.js";
import {
  ByteTracker, collectPersonDetections, selectMaskTracks, selectControlTrack,
  collectHeldObjectDetections, selectHeldObjects,
  controlPoint, videoFrameKey,
} from "./byteTracker.js";

const globalTracker = new ByteTracker();
let trackerSourceId = null;
let _trackSnapshot = "";

// ─────────────────────────────────────────────────────────
// 마스터 캔버스
// ─────────────────────────────────────────────────────────

const CANVAS_W = 1920;
const CANVAS_H = 1080;

/**
 * 마스터 캔버스를 초기화하고 컴포지팅 루프를 시작합니다.
 * 앱 시작 시 1회 호출합니다.
 */
export function initMasterCanvas() {
  if (state.masterCanvas) return;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  state.masterCanvas = canvas;
  state.masterCtx = canvas.getContext("2d");
  state.masterStream = canvas.captureStream(60);
  state.displayStream = state.masterStream; // recording.js 호환

  const previewCanvas = document.getElementById("main-preview-canvas");
  if (previewCanvas) {
    state.previewCanvas = previewCanvas;
    state.previewCtx = previewCanvas.getContext("2d");
  }

  _startCompositing();
}

function _startCompositing() {
  const loop = () => {
    _compositeFrame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function _drawLetterboxed(ctx, img, canvasW, canvasH) {
  const srcW = img.videoWidth ?? img.width ?? canvasW;
  const srcH = img.videoHeight ?? img.height ?? canvasH;
  if (srcW === 0 || srcH === 0) return;
  const scale = Math.min(canvasW / srcW, canvasH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (canvasW - dw) / 2;
  const dy = (canvasH - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function _compositeFrame() {
  if (!state.masterCtx) return;
  const ctx = state.masterCtx;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const src = state.sources.find((s) => s.id === state.selectedSourceId);
  if (!src || !src.visible) {
    _updatePreviewCanvas();
    return;
  }

  // bgCanvas는 AI 루프가 돌 때(배경 제거 또는 객체 추적) 사용됨
  const aiActive = src.bgRemoval || src.objectTracking;
  if (aiActive && src.bgCanvas && src.bgCanvas.width > 0) {
    _drawLetterboxed(ctx, src.bgCanvas, CANVAS_W, CANVAS_H);
  } else {
    const vid = src.videoEl;
    if (!vid || vid.readyState < 2) {
      _updatePreviewCanvas();
      return;
    }
    _drawLetterboxed(ctx, vid, CANVAS_W, CANVAS_H);
  }

  _updatePreviewCanvas();
}

function _updatePreviewCanvas() {
  const canvas = state.previewCanvas;
  if (!canvas || state.comparisonMode || !state.masterCanvas) return;

  const dw = canvas.clientWidth;
  const dh = canvas.clientHeight;
  if (dw === 0 || dh === 0) return;

  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw;
    canvas.height = dh;
  }

  const ctx = state.previewCtx;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, dw, dh);
  _drawLetterboxed(ctx, state.masterCanvas, dw, dh);
}

// ─────────────────────────────────────────────────────────
// 소스 추가
// ─────────────────────────────────────────────────────────

let _idSeq = 0;
let _webcamRequest = 0;
function _uid() {
  return `src_${++_idSeq}`;
}

/** 새 소스를 처음 추가할 때 기본 transform을 결정합니다. */
function _defaultTransform() {
  const hasFull = state.sources.some(
    (s) =>
      s.transform.x === 0 && s.transform.y === 0 && s.transform.w === CANVAS_W,
  );
  if (!hasFull) return { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };

  // PIP: 우하단 30% 크기
  const pw = Math.round(CANVAS_W * 0.3);
  const ph = Math.round(CANVAS_H * 0.3);
  return { x: CANVAS_W - pw - 20, y: CANVAS_H - ph - 20, w: pw, h: ph };
}

function _makeSource(overrides) {
  return {
    id: _uid(),
    type: "webcam",
    label: "",
    visible: true,
    stream: null,
    videoEl: null,
    transform: _defaultTransform(),
    bgRemoval: false,
    objectTracking: false,
    bgCanvas: null,
    bgCtx: null,
    bgAnimFrame: null,
    ...overrides,
  };
}

/**
 * 웹캠 소스를 추가합니다.
 * 기존 웹캠 소스가 있으면 스트림을 교체합니다.
 */
export async function addWebcamSource(deviceId, label) {
  const request = ++_webcamRequest;
  try {
    // 해상도를 지정하지 않으면 Chromium 이 640x480 으로 잡습니다. RPi 카메라가
    // 1080p 이므로 여기서도 맞춰야 배포 환경과 같은 조건에서 검증됩니다.
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    const constraints = { video, audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (request !== _webcamRequest) {
      stream.getTracks().forEach(track => track.stop());
      return null;
    }
    state.mediaStream = stream;
    _syncAudioToMaster(stream);

    // 기존 웹캠 소스 교체 (같은 장치 재선택 시)
    const existing = state.sources.find((s) => s.type === "webcam");
    if (existing) {
      if (existing.stream) existing.stream.getTracks().forEach((t) => t.stop());
      _clearSourceVideo(existing);
      existing.stream = stream;
      existing.videoEl = _createVideoEl(stream);
      existing.label = label || existing.label;
      if (existing.bgRemoval && state.selectedSourceId === existing.id) _startAiLoop(existing);
      _previewSelectedSource();
      renderSourcesList();
      return existing;
    }

    const src = _makeSource({ type: "webcam", label: label || "웹캠", stream });
    src.videoEl = _createVideoEl(stream);
    state.sources.unshift(src); // 최상단 레이어로 추가
    if (!state.selectedSourceId) state.selectedSourceId = src.id;
    renderSourcesList();
    document.dispatchEvent(new CustomEvent("displayStreamChanged"));
    return src;
  } catch (e) {
    console.error("웹캠 소스 추가 실패:", e);
    return null;
  }
}

/**
 * 전체화면(screen) 캡처 소스를 추가합니다.
 * @param {string} sourceId  desktopCapturer 소스 ID
 * @param {string} label
 */
export async function addDisplaySource(sourceId, label) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      },
    });
    const src = _makeSource({
      type: "display",
      label: label || "전체화면 캡처",
      stream,
    });
    src.videoEl = _createVideoEl(stream);
    state.sources.push(src); // 최하단 레이어로 추가
    renderSourcesList();
    return src;
  } catch (e) {
    console.error("화면 캡처 소스 추가 실패:", e);
    return null;
  }
}

/**
 * 창(window) 캡처 소스를 추가합니다.
 */
export async function addWindowSource(sourceId, label) {
  const src = await addDisplaySource(sourceId, label || "창 캡처");
  if (src) src.type = "window";
  return src;
}

/**
 * RPi 소스를 추가합니다. state.piVideoStream(HTMLVideoElement)이 있어야 합니다.
 */
export function addRpiSource() {
  if (!state.piVideoStream) return null;
  const existing = state.sources.find((s) => s.type === "rpi");
  if (existing) {
    if (existing.videoEl === state.piVideoStream) return existing;
    clearRpiSource();
    existing.videoEl = state.piVideoStream;
    existing.stream = state.piVideoStream.srcObject;
    if (existing.bgRemoval && state.selectedSourceId === existing.id) _startAiLoop(existing);
    _previewSelectedSource();
    return existing;
  }

  const src = _makeSource({
    type: "rpi",
    label: "RPi 카메라",
    videoEl: state.piVideoStream,                  // HTMLVideoElement (WebRTC)
    stream: state.piVideoStream.srcObject,        // MediaStream (비교 모드용)
  });
  state.sources.unshift(src); // 최상단 레이어
  if (!state.selectedSourceId) {
    state.selectedSourceId = src.id;
    _previewSelectedSource();
  }
  renderSourcesList();
  return src;
}

// ─────────────────────────────────────────────────────────
// 소스 제어
// ─────────────────────────────────────────────────────────

// Keep the layout/source ID while invalidating old frames, masks and motor targets.
export function clearRpiSource() {
  const src = state.sources.find(s => s.type === "rpi");
  if (src) _clearSourceVideo(src);
}

function _clearSourceVideo(src) {
  if (trackerSourceId === src.id || state.selectedSourceId === src.id) {
    if (state.autoTrackingEnabled) sendTrackingState(false);
    state.autoTrackingEnabled = false;
    state.objectTrackingEnabled = false;
  }
  src.objectTracking = false;
  _stopAiLoop(src);
  src.videoEl = null;
  src.stream = null;
  _updateObjectTrackingBtn();
  _previewSelectedSource();
}

export function removeSource(id) {
  const idx = state.sources.findIndex((s) => s.id === id);
  if (idx === -1) return;
  if (state.sources[idx].type === "webcam") _webcamRequest++;
  if (trackerSourceId === id || state.selectedSourceId === id) {
    if (state.autoTrackingEnabled) sendTrackingState(false);
    state.autoTrackingEnabled = false;
    state.objectTrackingEnabled = false;
    state.backgroundRemovalEnabled = false;
  }
  _cleanupSource(state.sources[idx]);
  state.sources.splice(idx, 1);
  if (state.selectedSourceId === id) {
    state.selectedSourceId = state.sources[0]?.id ?? null;
  }
  renderSourcesList();
  _updateBgRemovalBtn();
  _updateObjectTrackingBtn();
  _previewSelectedSource();
}

export function toggleSourceVisibility(id) {
  const s = state.sources.find((s) => s.id === id);
  if (s) {
    s.visible = !s.visible;
    renderSourcesList();
  }
}

export function selectSource(id) {
  // 소스 변경 시 AI 처리 강제 종료
  const trackingWasEnabled = state.autoTrackingEnabled;
  const prev = state.sources.find((s) => s.id === state.selectedSourceId);
  if (prev && (prev.bgRemoval || prev.objectTracking)) {
    prev.bgRemoval = false;
    prev.objectTracking = false;
    _stopAiLoop(prev);
  }
  state.backgroundRemovalEnabled = false;
  state.objectTrackingEnabled = false;
  state.autoTrackingEnabled = false;
  if (trackingWasEnabled) sendTrackingState(false);

  state.selectedSourceId = id;
  renderSourcesList();
  _updateBgRemovalBtn();
  _updateObjectTrackingBtn();
  _previewSelectedSource();
}

function _previewSelectedSource() {
  const src = state.sources.find((s) => s.id === state.selectedSourceId);

  if (state.comparisonMode) {
    const originalVideo = document.getElementById("original-video");
    if (originalVideo) {
      if (src?.stream) {
        originalVideo.srcObject = src.stream;
      } else {
        originalVideo.srcObject = state.masterStream;
      }
    }
    return;
  }

}

/**
 * 선택된 소스에 배경 제거를 토글합니다.
 * 웹캠/RPi 소스에만 적용됩니다.
 */
export function toggleBgRemovalForSelectedSource() {
  const src = state.sources.find((s) => s.id === state.selectedSourceId);
  if (!src) {
    alert("소스를 먼저 선택하세요.");
    return;
  }

  state.backgroundRemovalEnabled = !state.backgroundRemovalEnabled;
  src.bgRemoval = state.backgroundRemovalEnabled;

  if (!state.backgroundRemovalEnabled) {
    state.targetPersonIds = [];
    renderObjectList(globalTracker.tracks);
  } else {
    if (state.targetPersonIds.length === 0 && globalTracker.tracks.length > 0) {
      const sorted = [...globalTracker.tracks].sort(
        (a, b) => a.box.x1 - b.box.x1,
      );
      state.targetPersonIds.push(sorted[0].id);
    }
    renderObjectList(globalTracker.tracks);
  }

  // AI 루프 관리: 둘 중 하나라도 켜져 있으면 루프 유지
  const needAi = src.bgRemoval || src.objectTracking;
  if (needAi && !src._aiRunning) {
    _startAiLoop(src);
  } else if (!needAi) {
    _stopAiLoop(src);
  }
  renderSourcesList();
  _updateBgRemovalBtn();
}

/**
 * 선택된 소스에 객체 추적을 토글합니다.
 * tracking.js의 toggleAutoTracking에서 호출됩니다.
 */
export function toggleObjectTrackingForSelectedSource() {
  const src = state.sources.find((s) => s.id === state.selectedSourceId);
  if (!src) return;

  state.objectTrackingEnabled = state.autoTrackingEnabled;
  src.objectTracking = state.objectTrackingEnabled;

  // 객체 추적을 켤 때 이전 선택 초기화 → 라디오 버튼 미선택 상태로 시작
  if (src.objectTracking) {
    state.targetPersonId = null;
    state.targetPersonIds = [];
  }

  // AI 루프 관리: 둘 중 하나라도 켜져 있으면 루프 유지
  const needAi = src.bgRemoval || src.objectTracking;
  if (needAi && !src._aiRunning) {
    _startAiLoop(src);
  } else if (!needAi) {
    _stopAiLoop(src);
  }
  renderSourcesList();
  _updateObjectTrackingBtn();
}

function _updateBgRemovalBtn() {
  const btn = document.getElementById("toggle-background-removal");
  if (!btn) return;
  const on = state.backgroundRemovalEnabled;
  btn.textContent = `배경 제거: ${on ? "ON" : "OFF"}`;
  btn.classList.toggle("recording", on);
}

function _updateObjectTrackingBtn() {
  const btn = document.getElementById("toggle-auto-tracking");
  if (!btn) return;
  const on = state.autoTrackingEnabled;
  btn.textContent = `자동 추적: ${on ? "ON" : "OFF"}`;
  btn.classList.toggle("recording", on);
}

// ─────────────────────────────────────────────────────────
// per-source AI 처리 (배경 제거 + 객체 추적)
// ─────────────────────────────────────────────────────────

function _startAiLoop(src) {
  if (src._aiRunning) return;
  src._aiRunning = true;
  src._aiGeneration = (src._aiGeneration || 0) + 1;
  src._aiFrameId = 0;
  src._lastVideoFrameKey = null;
  trackerSourceId = src.id;
  globalTracker.reset();
  state.targetPersonId = null;
  state.targetPersonIds = [];
  _trackSnapshot = "";
  if (!src.bgCanvas) {
    src.bgCanvas = document.createElement("canvas");
    // 브라우저 기본값(300×150) 대신 0으로 초기화해야 wasEmpty 검사가 올바르게 동작함
    src.bgCanvas.width = 0;
    src.bgCanvas.height = 0;
    src.bgCtx = src.bgCanvas.getContext("2d", { willReadFrequently: true });
  }
  // 재사용할 임시 캔버스 미리 생성 (매 프레임 생성 방지)
  if (!src._tmpCanvas) {
    src._tmpCanvas = document.createElement("canvas");
    src._tmpCtx = src._tmpCanvas.getContext("2d");
  }
  if (!src._fgCanvas) {
    src._fgCanvas = document.createElement("canvas");
    src._fgCtx = src._fgCanvas.getContext("2d");
  }
  // 재사용할 텐서 배열 생성 (CPU 병목/GC 누수 방지)
  if (!src._tensorData) {
    src._tensorData = new Float32Array(3 * 640 * 640);
  }
  _aiLoop(src, src._aiGeneration);
}

function _stopAiLoop(src) {
  src._aiRunning = false;
  src._aiGeneration = (src._aiGeneration || 0) + 1;
  if (src.bgAnimFrame) {
    cancelAnimationFrame(src.bgAnimFrame);
    src.bgAnimFrame = null;
  }
  src.bgCanvas = null;
  src.bgCtx = null;
  src._tmpCanvas = null;
  src._tmpCtx = null;
  src._fgCanvas = null;
  src._fgCtx = null;
  src._tensorData = null;
  src._maskCanvas = null;
  src._maskCtx = null;
  src._maskImg = null;
  src._heldKey = null;

  // Only the owner can clear IDs. Deleting an unrelated source must not do so.
  if (trackerSourceId === src.id) {
    trackerSourceId = null;
    globalTracker.reset();
    state.targetPersonIds = [];
    state.targetPersonId = null;
    _trackSnapshot = "";
    renderObjectList([]);
  }
}

function _isAiCurrent(src, generation) {
  return src._aiRunning && src._aiGeneration === generation
    && trackerSourceId === src.id && state.selectedSourceId === src.id
    && state.sources.includes(src) && !!src.bgCtx
    && (src.bgRemoval || src.objectTracking);
}

function _scheduleAiLoop(src, generation) {
  if (!_isAiCurrent(src, generation)) return;
  src.bgAnimFrame = requestAnimationFrame(() => {
    src.bgAnimFrame = null;
    _aiLoop(src, generation);
  });
}

/**
 * 마스크 격자 기준 침식 깊이입니다. MASK_RES 는 출력의 약 1/3 이므로
 * 1 칸이 출력에서 3px 안팎입니다. 2 로 올리면 손가락처럼 얇은 부분이
 * 같이 깎이기 시작합니다.
 */
const ERODE_CELLS = 1;

/**
 * 경계를 영상의 실제 윤곽에 붙일지 여부입니다.
 *
 * 프로토타입 마스크는 160×160 격자라 확률이 0.1 에서 0.9 로 넘어가는 데만
 * 가로 4 칸(1280 폭 기준 출력 32px)이 걸립니다. 어디를 잘라도 경계선이
 * 실제 윤곽에서 그만큼 벗어날 수 있고, 그래서 사람 주위에 원래 배경이
 * 띠처럼 남습니다. 임계값을 올리거나 더 깎아도 띠가 위치만 옮길 뿐입니다.
 *
 * guided filter 는 영상의 휘도 경계를 마스크에 옮겨 붙여 그 띠를 없앱니다.
 */
const REFINE_EDGE = true;

/**
 * guided filter 반경 (마스크 칸).
 *
 * 마스크가 윤곽에서 벗어난 거리를 덮을 만큼은 되어야 하지만, 크게 잡으면
 * 안 됩니다. guide 에 휘도 경계가 없는 창에서는 a→0 이 되어 보정이
 * prob 를 그 창의 평균으로 바꿔 버리기 때문입니다 — 즉 반경만큼의
 * 박스 블러입니다. 검은 정장 vs 어두운 배경처럼 대비가 없는 구간이
 * 정확히 이 경우라, 반경이 크면 실루엣이 평균으로 뭉개집니다.
 *
 * 반경 8 로 두었더니 어깨 윤곽이 톱니처럼 물어뜯기고, 창보다 얇은
 * 돌출부(펴든 손가락)는 평균이 0.5 밑으로 내려가 통째로 잘렸습니다.
 * 2~4 는 둘 다 깨끗했고, 2 는 보정을 끈 것보다도 낫습니다(손가락 위쪽이
 * 반투명하게 깎이던 것이 실제 윤곽에 붙습니다). 여유를 두고 2 로 둡니다.
 */
const REFINE_RADIUS = 2;

/** 작을수록 휘도 경계에 강하게 붙습니다. 너무 작으면 노이즈까지 따라갑니다. */
const REFINE_EPS = 1e-4;

/**
 * 알파 램프 구간입니다. 중심은 0.5 로 두고 폭만 조절합니다.
 *
 * 좁게 잡습니다. 보정을 거친 확률장은 경계에서 완만하게 눕기 때문입니다.
 * 실제 모델을 돌려 재보니 0.5 를 지날 때의 기울기가 칸당 0.13~0.21 이라,
 * 0 에서 1 까지 5~8 칸(출력 15~24px)에 걸쳐 넘어갑니다. 램프 폭이 곧
 * 반투명 띠의 폭이고, 둘은 거의 정비례합니다(COCO 사진 4장, 출력 둘레로
 * 정규화한 평균 띠 폭):
 *
 *   0.45~0.55  띠 0.9~1.4 칸 (4~5px)   ← 현재
 *   0.30~0.70  띠 4.4~6.3 칸 (12~16px)
 *   0.20~0.80  띠 8.0~9.6 칸 (20~24px)
 *
 * 넓히면 계단이 줄지 않을까 싶어 재봤지만 아니었습니다. 알파 128 등고선의
 * 행당 이동량은 0.34~0.67px 로 거의 변하지 않았고(사진에 따라 오히려
 * 나빠짐), 대신 손·어깨 둘레에 눈에 띄는 번짐 테두리가 생겼습니다. 확률장이
 * 이미 완만해서 0.45~0.55 만으로도 경계 칸이 중간 알파를 갖기 때문입니다 —
 * 즉 이 폭에서 이미 안티에일리어싱이 되고 있고, 더 넓히면 번지기만 합니다.
 *
 * CSS blur 도 답이 아닙니다. Chromium 은 1px 미만 blur() 를 무시해서
 * 0.5px 은 건 것과 안 건 것이 같고, 1px 부터는 계단이 거의 그대로인 채
 * (RMS 0.69→0.65px) 띠만 2px 에서 6px 으로 벌어집니다.
 *
 * 보정을 끄면 확률장이 또 달라지므로 예전 값이 필요합니다.
 *
 * 위 수치는 REFINE_RADIUS 가 8 이던 때 잰 것입니다. 반경을 2 로 줄인 지금은
 * 확률장이 그때만큼 눕지 않으므로 기울기와 띠 폭이 이보다 가파릅니다.
 * 0.45~0.55 는 반경 2 에서도 육안으로 문제없었으나, 폭을 다시 손볼 일이
 * 생기면 수치부터 다시 재야 합니다.
 */
const FADE = REFINE_EDGE ? { lo: 0.45, hi: 0.55 } : { lo: 0.75, hi: 0.85 };

// 물건 박스 안에서만 컷오프를 낮춰 보았으나 철회했습니다. 박스 가장자리에서
// 알파가 불연속으로 튀어 화면에 직선이 보이고, 그 박스가 나타났다 사라지며
// 선이 같이 움직여 오히려 깜빡임이 심해졌습니다. 구간별로 다른 컷오프를 쓰려면
// 경계를 부드럽게 이어야 하는데, 가방은 handbag 으로 0.47~0.78 에 잡혀 마스크가
// 그대로 합쳐지므로 완화 자체가 필요 없었습니다.

/**
 * 박스 필터. 적분영상을 쓰므로 반경과 무관하게 O(n) 입니다.
 *
 * @param {Float32Array} src - 입력 (W*H)
 * @param {Float32Array} dst - 출력 (W*H)
 * @param {number} W - 너비
 * @param {number} H - 높이
 * @param {number} r - 반경
 * @param {Float64Array} integral - (W+1)*(H+1) 이상 크기의 작업용 버퍼
 */
function boxFilter(src, dst, W, H, r, integral) {
  const IW = W + 1;
  for (let x = 0; x <= W; x++) integral[x] = 0;
  for (let y = 0; y < H; y++) {
    let rowsum = 0;
    const so = y * W, io = (y + 1) * IW, po = y * IW;
    integral[io] = 0;
    for (let x = 0; x < W; x++) {
      rowsum += src[so + x];
      integral[io + x + 1] = integral[po + x + 1] + rowsum;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = y - r > 0 ? y - r : 0;
    const y1 = y + r < H - 1 ? y + r : H - 1;
    const top = y0 * IW, bot = (y1 + 1) * IW;
    const rows = y1 - y0 + 1, out = y * W;
    for (let x = 0; x < W; x++) {
      const x0 = x - r > 0 ? x - r : 0;
      const x1 = x + r < W - 1 ? x + r : W - 1;
      dst[out + x] = (integral[bot + x1 + 1] - integral[top + x1 + 1]
        - integral[bot + x0] + integral[top + x0]) / (rows * (x1 - x0 + 1));
    }
  }
}

/**
 * Guided filter (He et al.). guide 의 경계 구조를 prob 에 옮겨 붙입니다.
 *
 * 각 창에서 prob ≈ a·guide + b 인 선형 계수를 구하고, 그 계수를 다시
 * 평활해 되돌립니다. 휘도가 균일한 창에서는 a→0 이라 원래 값이 남고,
 * 경계가 있는 창에서는 a 가 커져 마스크가 그 경계를 따라갑니다.
 *
 * prob 를 제자리에서 갱신합니다.
 *
 * @param {Float32Array} guide - 같은 격자의 휘도 (0..1)
 * @param {Float32Array} prob - 마스크 확률 (0..1), 제자리 갱신
 * @param {number} W - 너비
 * @param {number} H - 높이
 * @param {number} r - 반경
 * @param {number} eps - 정규화 항
 * @param {Object} s - 작업용 버퍼 묶음
 */
function guidedRefine(guide, prob, W, H, r, eps, s) {
  const n = W * H;
  const { t1, t2, meanI, meanP, boxA, boxB, integral } = s;

  for (let i = 0; i < n; i++) {
    const g = guide[i];
    t1[i] = g * g;
    t2[i] = g * prob[i];
  }
  boxFilter(t1, boxA, W, H, r, integral);       // corr(I,I)
  boxFilter(t2, boxB, W, H, r, integral);       // corr(I,p)
  boxFilter(guide, meanI, W, H, r, integral);
  boxFilter(prob, meanP, W, H, r, integral);

  for (let i = 0; i < n; i++) {
    const mI = meanI[i], mP = meanP[i];
    const a = (boxB[i] - mI * mP) / (boxA[i] - mI * mI + eps);
    t1[i] = a;
    t2[i] = mP - a * mI;
  }
  boxFilter(t1, boxA, W, H, r, integral);
  boxFilter(t2, boxB, W, H, r, integral);

  for (let i = 0; i < n; i++) prob[i] = boxA[i] * guide[i] + boxB[i];
}

/**
 * 윤곽 안쪽의 구멍을 메울지 여부입니다.
 *
 * 켜면 사람 윤곽 안의 구멍이 MAX_HOLE_FRACTION 이하인 한 지워지지 않습니다.
 */
const FILL_ENCLOSED_HOLES = true;

/**
 * 메울 구멍의 최대 넓이입니다. 그 구멍을 품은 사람 박스 넓이에 대한 비율이고,
 * 0 이하면 넓이를 따지지 않고 전부 메웁니다.
 *
 * 상한이 필요한 이유는 허리에 손을 얹었을 때 생기는 팔과 몸통 사이 틈입니다.
 * 그 틈도 윤곽 안쪽이라 구멍으로 잡히지만 진짜로 뚫려야 하는 자리여서,
 * 메우면 교체 배경이 아니라 원래 배경이 보입니다. 팔 틈은 손에 든 물건보다
 * 넓으므로 넓이로 갈라냅니다.
 *
 * 모델이 아는 80종(컵·휴대폰·책 등)은 이 단계 전에 마스크를 합쳐 두므로
 * 상한과 무관합니다. 여기서 걸러지는 것은 종이·펜처럼 모델이 모르는
 * 물건뿐이고, A4 를 펼쳐 든 것처럼 큰 것은 상한을 넘어 되살아나지 않습니다.
 * 값을 올리면 그런 것까지 살아나지만 팔 틈도 같이 메워지기 시작합니다.
 *
 * 0.06 에서는 허리에 손을 얹었을 때의 팔 틈이 상한에 걸쳐, 프레임마다 메워졌다
 * 뚫렸다 하며 그 자리에 교체 배경 대신 원래 방이 비쳤습니다. 간헐적이라 더
 * 눈에 띕니다. 0.03 이면 팔 틈이 확실히 남습니다.
 *
 * 다만 넓이만 보면 큰 물건도 함께 못 메웁니다. 아래 두 값이 그 손해를 되돌려
 * 줍니다.
 */
const MAX_HOLE_FRACTION = 0.03;

/**
 * 넓이만으로는 팔 틈과 물건 구멍이 갈리지 않아 모양을 함께 봅니다.
 *
 * 굽힌 팔과 몸통 사이 틈은 길쭉한 삼각형이라 자기 외접 사각형의 절반 남짓만
 * 채웁니다. 손에 든 물건은 덩어리라 대부분을 채웁니다. 꽉 찬 구멍에만 넓이
 * 상한을 몇 배로 늘려, 팔 틈은 좁은 상한에 걸리고 큰 물건은 메워집니다.
 */
const COMPACT_FILL_RATIO = 0.7;
const COMPACT_AREA_BONUS = 3;

/**
 * 사람 윤곽 안쪽의 구멍을 메웁니다.
 *
 * 마스크는 픽셀마다 "사람인가"를 따로 판정하므로, 모델이 모르는 물건이
 * 몸 앞에 오면 그 자리가 알파 0 이 되어 교체 배경이 비칩니다. 바깥과
 * 이어지지 않은 투명 영역은 윤곽 안쪽이라는 뜻이므로 되살립니다.
 *
 * 번져 나가는 조건이 "알파 0" 이 아니라 "완전 불투명이 아님" 인 것이
 * 중요합니다. 알파 0 만 따라가면 구멍 가장자리의 페더 링이 반투명으로
 * 남아 구멍 자리에 테두리가 보입니다. 반대로 인물 내부가 어디서도 255 에
 * 닿지 않을 만큼 얇으면(손가락 끝 등) 그 틈으로 번짐이 새어 들어갑니다.
 *
 * 바깥을 표시한 뒤 남은 덩어리를 하나씩 넓이를 재서, 자기를 품은 사람 박스에
 * 비해 너무 넓은 것은 팔 틈으로 보고 그대로 둡니다.
 *
 * 전체 격자가 아니라 대상 박스 범위만 훑습니다. 박스 밖은 이미 알파 0 이라
 * 결과가 같고, 1080p 기준 훑는 칸 수가 크게 줄어듭니다.
 *
 * @param {Uint8Array} alpha - 입출력 버퍼 (제자리 갱신)
 * @param {Uint8Array} visited - 방문 표시용 같은 크기의 버퍼
 * @param {Int32Array} stack - 칸 인덱스를 담을 작업용 버퍼
 * @param {number} size - 한 변의 칸 수
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect - 검사 범위 (양 끝 포함)
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} boxes - 사람 박스 (마스크 격자 기준)
 * @param {number} maxFraction - 사람 박스 넓이 대비 구멍 넓이 상한 (0 이하면 무제한)
 * @param {(i:number)=>number} [ownerOf] - 칸이 속한 사람 번호 (사람이 아니면 음수)
 */
function fillEnclosedHoles(alpha, visited, stack, size, rect, boxes, maxFraction, ownerOf) {
  const { x1, y1, x2, y2 } = rect;
  if (x2 <= x1 || y2 <= y1) return;

  for (let y = y1; y <= y2; y++) {
    visited.fill(0, y * size + x1, y * size + x2 + 1);
  }

  // ── 1) 바깥과 이어진 투명 영역 표시 (visited = 1) ──────────────
  let top = 0;
  const push = (x, y) => {
    const i = y * size + x;
    if (visited[i] !== 0 || alpha[i] === 255) return;
    visited[i] = 1;
    stack[top++] = i;
  };

  // 범위의 테두리가 시작점입니다. 단, 화면 끝과 겹친 변은 뺍니다.
  // 웹캠에서는 몸이 화면 아래에서 잘리는 게 보통이라, 가슴 앞에 든 물건의
  // 구멍이 화면 아래 끝에 닿기 쉽습니다. 그 변을 시작점으로 두면 구멍이
  // 바깥 배경으로 판정되어 메워지지 않습니다. 진짜 배경은 대부분 화면 끝이
  // 아닌 다른 변을 통해 이어지므로 이 변을 빼도 바깥으로 남습니다.
  // 화면 끝으로만 트인 배경(두 사람 사이, 뻗은 팔 아래)은 2단계에서 가립니다.
  const edge = size - 1;
  for (let x = x1; x <= x2; x++) {
    if (y1 > 0) push(x, y1);
    if (y2 < edge) push(x, y2);
  }
  for (let y = y1; y <= y2; y++) {
    if (x1 > 0) push(x1, y);
    if (x2 < edge) push(x2, y);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % size;
    const y = (i / size) | 0;
    if (x > x1) push(x - 1, y);
    if (x < x2) push(x + 1, y);
    if (y > y1) push(x, y - 1);
    if (y < y2) push(x, y + 1);
  }

  // ── 2) 남은 덩어리를 하나씩 재서 메우기 ─────────────────────────
  // 너비 우선으로 훑으면 큐가 그대로 구성원 목록이 됩니다. 한 덩어리를
  // 다 훑고 나면 stack[0..tail-1] 이 그 덩어리 전체라, 넓이를 보고 메울지
  // 정한 뒤 따로 다시 찾을 필요가 없습니다.
  const rectArea = (x2 - x1 + 1) * (y2 - y1 + 1);
  let head = 0, tail = 0;
  const enqueue = (i) => {
    if (visited[i] !== 0 || alpha[i] === 255) return;
    visited[i] = 2;
    stack[tail++] = i;
  };

  // 덩어리를 훑으면서 테두리(불투명 이웃)가 어느 사람 것인지 모읍니다.
  let owner = -1, mixed = false;
  const visit = (i) => {
    if (alpha[i] !== 255) { enqueue(i); return; }
    if (!ownerOf || mixed) return;
    const o = ownerOf(i);
    if (o < 0) return;
    if (owner < 0) owner = o;
    else if (o !== owner) mixed = true;
  };

  for (let sy = y1; sy <= y2; sy++) {
    const seedRow = sy * size;
    for (let sx = x1; sx <= x2; sx++) {
      const seed = seedRow + sx;
      if (visited[seed] !== 0 || alpha[seed] === 255) continue;

      head = 0;
      tail = 0;
      let sumX = 0, sumY = 0;
      let minX = size, maxX = -1, minY = size, maxY = -1;
      let frameSides = 0;
      owner = -1;
      mixed = false;
      enqueue(seed);
      while (head < tail) {
        const i = stack[head++];
        const x = i % size;
        const y = (i / size) | 0;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x === 0) frameSides |= 1;
        if (x === edge) frameSides |= 2;
        if (y === 0) frameSides |= 4;
        if (y === edge) frameSides |= 8;
        if (x > x1) visit(i - 1);
        if (x < x2) visit(i + 1);
        if (y > y1) visit(i - size);
        if (y < y2) visit(i + size);
      }

      // 화면 끝에 닿은 덩어리는 한 사람 안에 든 것만 메웁니다. 넓이로는
      // 몸 앞에 든 물건과 진짜 배경이 구별되지 않아 모양으로 가립니다.
      // - 두 변 이상에 닿으면 모서리를 끼고 트인 배경입니다. 사람이 화면을
      //   가로로 꽉 채워 시작점이 되는 변이 없을 때 몸 옆 배경이 이렇습니다.
      // - 테두리가 여러 사람이면 두 사람 사이나 뻗은 팔 아래의 배경입니다.
      //   물건 구멍은 한 사람의 마스크 안에 있어 테두리가 모두 같은 사람입니다.
      if (frameSides !== 0 && (mixed || (frameSides & (frameSides - 1)) !== 0)) continue;

      // 기준은 이 덩어리를 품은 사람 박스입니다. 겹쳐 선 두 사람처럼 여러
      // 박스가 품으면 작은 쪽을 씁니다. 어느 박스에도 안 들면 상한을 두지
      // 않습니다 — 물건 박스 안쪽이라 메우는 편이 맞습니다.
      let limit = rectArea;
      if (maxFraction > 0) {
        const cx = sumX / tail, cy = sumY / tail;
        let ref = 0;
        for (const b of boxes) {
          if (cx < b.x1 || cx > b.x2 || cy < b.y1 || cy > b.y2) continue;
          const area = (b.x2 - b.x1) * (b.y2 - b.y1);
          if (ref === 0 || area < ref) ref = area;
        }
        if (ref > 0) limit = ref * maxFraction;
      }

      // 외접 사각형을 얼마나 채웠는지로 팔 틈과 물건을 가릅니다. 길쭉한
      // 틈은 좁은 상한에, 꽉 찬 덩어리는 넉넉한 상한에 걸립니다.
      const boxCells = (maxX - minX + 1) * (maxY - minY + 1);
      const allowed = tail >= boxCells * COMPACT_FILL_RATIO
        ? limit * COMPACT_AREA_BONUS : limit;

      if (tail <= allowed) {
        for (let k = 0; k < tail; k++) alpha[stack[k]] = 255;
      }
    }
  }
}

/**
 * 알파 침식 (분리형 min 필터).
 *
 * 가로·세로로 한 번씩 걸면 (2r+1)² 정사각 침식과 결과가 같으면서 비용은
 * O(n·r) 두 번으로 끝납니다. 격자 밖은 가장자리 값을 연장해서 읽습니다.
 * 0 으로 두면 프레임에 걸친 인물의 잘린 단면까지 깎여 그 변을 따라
 * 얇은 배경 선이 생깁니다.
 *
 * @param {Uint8Array} alpha - 입출력 버퍼 (제자리 갱신)
 * @param {Uint8Array} tmp - 가로 패스 결과를 받을 같은 크기의 버퍼
 * @param {number} size - 한 변의 칸 수
 * @param {number} radius - 침식 깊이 (칸)
 */
function erodeAlpha(alpha, tmp, size, radius) {
  if (radius <= 0) return;
  const lastIdx = size - 1;

  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const x0 = x - radius > 0 ? x - radius : 0;
      const x1 = x + radius < lastIdx ? x + radius : lastIdx;
      let m = 255;
      for (let k = x0; k <= x1; k++) {
        const v = alpha[row + k];
        if (v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }

  for (let y = 0; y < size; y++) {
    const y0 = (y - radius > 0 ? y - radius : 0) * size;
    const y1 = (y + radius < lastIdx ? y + radius : lastIdx) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let m = 255;
      for (let k = y0; k <= y1; k += size) {
        const v = tmp[k + x];
        if (v < m) m = v;
      }
      alpha[row + x] = m;
    }
  }
}

/**
 * 객체 추적을 위한 오버레이를 그립니다.
 * 디버깅용으로 pid_controller.py의 데드존, 바운딩박스, 중심점을 함께 그립니다.
 * @param {CanvasRenderingContext2D} ctx - 그릴 캔버스 컨텍스트
 * @param {Array<Object>} people - 추적 결과 (각 객체에 id, box가 있어야 함)
 * @param {string} targetPersonId - 추적 중인 사람 ID (없으면 모든 사람 표시)
 */
function _drawTrackingOverlay(ctx, people, targetPersonId, w, h) {
  const sx = w / 640;
  const sy = h / 640;
  const fontSize = Math.max(13, Math.round(w * 0.02));

  // PID 데드존 시각화 (config.py: X_DEAD_ZONE=300@1920px, Y_DEAD_ZONE=150@1080px)
  const dzHalfW = (300 * w) / 1920;
  const dzHalfH = (150 * h) / 1080;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 220, 0, 0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 5]);
  ctx.strokeRect(w / 2 - dzHalfW, h / 2 - dzHalfH, dzHalfW * 2, dzHalfH * 2);
  ctx.setLineDash([]);
  ctx.font = `${fontSize - 2}px monospace`;
  ctx.fillStyle = "rgba(255, 220, 0, 0.9)";
  ctx.fillText("DEAD ZONE", w / 2 - dzHalfW + 4, h / 2 - dzHalfH - 5);
  ctx.restore();

  // 각 사람별 바운딩박스 + 중심점 + 라벨
  people.forEach((person) => {
    const { x1, y1, x2, y2 } = person.box;
    const bx = x1 * sx;
    const by = y1 * sy;
    const bw = (x2 - x1) * sx;
    const bh = (y2 - y1) * sy;
    const cx = ((x1 + x2) / 2) * sx;
    const cy = (y1 + (y2 - y1) * 0.2) * sy;

    const isTarget = person.id === targetPersonId;
    const boxColor = isTarget ? "#00ff44" : "#ff9500";
    const labelBg = isTarget
      ? "rgba(0, 150, 40, 0.85)"
      : "rgba(180, 90, 0, 0.85)";

    ctx.save();

    // 바운딩박스
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = isTarget ? 3 : 2;
    if (!person.observed) ctx.setLineDash([6, 4]);
    ctx.strokeRect(bx, by, bw, bh);

    // 중심점 + 십자선
    ctx.fillStyle = boxColor;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();

    // 라벨 배경 + 텍스트
    const label = `ID ${person.id}${person.observed ? "" : " (예측)"}`;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const tw = ctx.measureText(label).width;
    const pad = 4;
    const lh = fontSize + pad * 2;
    const lx = Math.max(0, bx);
    const ly = by > lh ? by : by + lh;
    ctx.fillStyle = labelBg;
    ctx.fillRect(lx, ly - lh, tw + pad * 2, lh);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, lx + pad, ly - pad);

    ctx.restore();
  });
}

async function _aiLoop(src, generation) {
  if (!_isAiCurrent(src, generation)) return;
  const vid = src.videoEl;
  if (!vid || vid.readyState < 2) {
    _scheduleAiLoop(src, generation);
    return;
  }

  const w = vid.videoWidth || vid.width || 640;
  const h = vid.videoHeight || vid.height || 480;
  if (src.bgCanvas.width !== w || src.bgCanvas.height !== h) {
    src.bgCanvas.width = w;
    src.bgCanvas.height = h;
    // 비교 모드에서 bgCanvas 크기가 확정될 때 processed 패널을 재연결
    if (state.comparisonMode) {
      document.dispatchEvent(new CustomEvent("bgCanvasReady"));
    }
  }

  // 출력 캔버스에 직접 그리면 AI 처리 시간 동안 원본 프레임이 1프레임 노출됩니다.
  // 전경 캔버스(_fgCanvas)에 조립한 뒤 성공 시에만 출력 캔버스에 반영합니다.

  if (state.session && !state.sessionBusy) {
    const frameKey = videoFrameKey(vid);
    if (frameKey !== null && frameKey === src._lastVideoFrameKey) {
      _scheduleAiLoop(src, generation);
      return;
    }
    const session = state.session;
    let inputTensor;
    let results;
    try {
      state.sessionBusy = true;
      // Renderer-local sampling time, not the remote camera's exposure time.
      const timestampMs = performance.now();
      const frameId = ++src._aiFrameId;
      src._lastVideoFrameKey = frameKey;
      const MODEL_SIZE = 640;
      // 캔버스 재사용 (매 프레임 생성 방지)
      const tmp = src._tmpCanvas;
      const tmpCtx = src._tmpCtx;
      if (tmp.width !== MODEL_SIZE) tmp.width = MODEL_SIZE;
      if (tmp.height !== MODEL_SIZE) tmp.height = MODEL_SIZE;
      tmpCtx.drawImage(vid, 0, 0, MODEL_SIZE, MODEL_SIZE);
      const tmpData = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

      // 전경 프레임을 여기서 붙잡아 둡니다.
      // 마스크는 지금 이 순간의 프레임에서 계산됩니다. 추론이 끝난 뒤에
      // 최신 프레임을 그리면 그 사이 사람이 움직인 만큼 마스크와 어긋나
      // 사람이 잘리고 이미 지나온 자리의 배경이 드러납니다.
      // GPU 간 복사라 readback 이 없습니다.
      const fgCv = src._fgCanvas;
      const fgCtx = src._fgCtx;
      if (fgCv.width !== w) fgCv.width = w;
      if (fgCv.height !== h) fgCv.height = h;
      fgCtx.globalCompositeOperation = "source-over";
      fgCtx.clearRect(0, 0, w, h);
      fgCtx.drawImage(vid, 0, 0, w, h);

      const tensorData = src._tensorData;
      const INV_255 = 0.003921568627451;
      const totalPixels = MODEL_SIZE * MODEL_SIZE;
      const data = tmpData.data;

      // 단일 루프 및 곱셈 연산으로 CPU 병목 제거
      for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
        tensorData[i] = data[p] * INV_255;
        tensorData[totalPixels + i] = data[p + 1] * INV_255;
        tensorData[2 * totalPixels + i] = data[p + 2] * INV_255;
      }

      inputTensor = new ort.Tensor("float32", tensorData, [
        1,
        3,
        MODEL_SIZE,
        MODEL_SIZE,
      ]);
      const feeds = { [session.inputNames[0]]: inputTensor };
      results = await session.run(feeds);

      // OFF→ON, source replacement and A→B→A invalidate in-flight results too.
      if (!_isAiCurrent(src, generation) || src.videoEl !== vid) return;
      if (state.session !== session) {
        src._lastVideoFrameKey = null;
        _scheduleAiLoop(src, generation);
        return;
      }

      // ── YOLO26-seg detections [1, N, 38] and mask prototypes ─────────
      const out0Tensor = results[session.outputNames[0]];
      const out1Tensor = results[session.outputNames[1]];
      const output0 = out0Tensor.data;
      const protos = out1Tensor.data;

      const NUM_CHANNELS = out0Tensor.dims[2];
      const COEFF_START = 6;

      const detectedPeople = collectPersonDetections(output0, NUM_CHANNELS);
      const people = globalTracker.update(detectedPeople, { timestampMs, frameId });

      // UI 표시 및 인덱스 매칭을 위해 현재 프레임 기준 X좌표 순(왼쪽부터)으로 정렬
      people.sort((a, b) => a.box.x1 - b.box.x1);

      const peopleKey = people
        .map((t) => `${t.id}:${t.score.toFixed(2)}:${t.state[0]}`).join(",");
      if (peopleKey !== src._peopleKey) {
        src._peopleKey = peopleKey;
        const raw = detectedPeople.map((d) => d.score.toFixed(2)).join(",");
        console.log(`[People] 트랙 ${peopleKey || "(없음)"} / 이번 검출 [${raw}]`);
      }

      // 3. 타겟 추적 로직 (ID 기반)
      if (!state.targetPersonIds) state.targetPersonIds = [];

      // 사용자가 직접 라디오 버튼을 클릭하기 전까지 자동 선택하지 않음

      // 죽은 트랙 정리
      state.targetPersonIds = state.targetPersonIds.filter((id) =>
        globalTracker.isTrackAlive(id),
      );

      // 추적 중이던 대상이 트래커에서 완전히 삭제된 경우 → 미선택 상태로 전환
      if (
        state.targetPersonId !== null &&
        !globalTracker.isTrackAlive(state.targetPersonId)
      ) {
        state.targetPersonId = null;
        state.targetPersonIds = state.targetPersonIds.filter(
          (id) => globalTracker.isTrackAlive(id),
        );
      }

      const controlTarget = selectControlTrack(
        globalTracker, people, state.targetPersonId, frameId, performance.now(),
      );

      // Object Panel 목록 갱신 (트래커 상태나 선택 상태가 바뀔 때)
      const _snap =
        globalTracker.tracks
          .map((t) => `${t.id}:${t.missingFrames > 0 ? 1 : 0}`)
          .join(",") +
        `|bg:${state.targetPersonIds.join(",")}|tr:${state.targetPersonId}`;
      if (_snap !== _trackSnapshot) {
        _trackSnapshot = _snap;
        renderObjectList(globalTracker.tracks);
      }

      if (window._deepDiagDone) window._deepDiagDone = false;

      // Low-score observations already passed ByteTrack association. A short
      // missing interval can use the same ID's prediction; never use its mask.
      if (src.objectTracking && state.autoTrackingEnabled && controlTarget) {
        sendObjectCoords({ ...controlPoint(controlTarget.box), observedAtMs: timestampMs });
      }

      // 배경 제거가 켜져 있을 때 다중 객체 마스크 적용
      //
      // Keep segmentation confidence separate from low-score track recovery.
      // 달라진 것은 알파를 어디에 쓰느냐입니다. 이전에는 전체 해상도
      // 프레임을 CPU로 내려(getImageData 8.3MB) 207만 픽셀의 알파를 직접
      // 고치고 다시 올렸습니다(putImageData 8.3MB). 이제는 모델 해상도
      // 알파 캔버스만 만들고 마지막 확대는 destination-in 합성으로
      // 브라우저에 맡깁니다.
      //
      // 램프를 proto 해상도(160)에서 걸면 안 됩니다. 이후 12배 확대에서
      // 클램프 구간이 선형으로 늘어나 경계가 5px → 12px로 뭉개집니다.
      // 모델 해상도(640)에서 걸면 남은 확대가 3배뿐이라 이전 경계가
      // 사실상 그대로 유지됩니다.
      const PROTO = 160;
      const nProto = PROTO * PROTO;

      // 알파를 계산할 격자 크기를 출력 해상도에서 정합니다.
      // 고정값(640)이면 1080p 에는 맞지만 4K 에서는 남은 확대가 6배로 커져
      // 경계가 뭉개지고, VGA 에서는 출력 픽셀보다 많은 셀을 계산해 낭비입니다.
      // 남은 확대를 항상 3배 안팎으로 유지합니다.
      const MASK_RES = Math.max(
        PROTO,
        Math.min(1280, Math.round(Math.max(w, h) / 3)),
      );
      const P2M = PROTO / MASK_RES; // 마스크 격자 → proto 격자

      // 해상도가 바뀌면 격자 크기도 바뀌므로 캔버스를 다시 만듭니다.
      if (!src._maskCanvas || src._maskCanvas.width !== MASK_RES) {
        src._maskCanvas = src._maskCanvas || document.createElement("canvas");
        src._maskCanvas.width = MASK_RES;
        src._maskCanvas.height = MASK_RES;
        src._maskCtx = src._maskCanvas.getContext("2d");
        src._maskImg = src._maskCtx.createImageData(MASK_RES, MASK_RES);
        const d = src._maskImg.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
        }
        // 침식과 구멍 메우기는 이웃 칸을 읽어야 하므로 RGBA 인터리브가 아닌
        // 평면 버퍼가 필요합니다. 매 프레임 할당하지 않도록 여기서 잡습니다.
        src._maskAlpha = new Uint8Array(MASK_RES * MASK_RES);
        src._maskAlphaTmp = new Uint8Array(MASK_RES * MASK_RES);
        src._maskVisited = new Uint8Array(MASK_RES * MASK_RES);
        src._maskStack = new Int32Array(MASK_RES * MASK_RES);
        src._maskProb = new Float32Array(MASK_RES * MASK_RES);
        // 경계 보정용. 대상 박스 범위만 처리하므로 실제로 쓰는 구간은
        // 이보다 작지만, 프레임마다 크기가 달라져 최대 크기로 잡아 둡니다.
        src._refine = REFINE_EDGE ? {
          guide: new Float32Array(MASK_RES * MASK_RES),
          sub: new Float32Array(MASK_RES * MASK_RES),
          t1: new Float32Array(MASK_RES * MASK_RES),
          t2: new Float32Array(MASK_RES * MASK_RES),
          meanI: new Float32Array(MASK_RES * MASK_RES),
          meanP: new Float32Array(MASK_RES * MASK_RES),
          boxA: new Float32Array(MASK_RES * MASK_RES),
          boxB: new Float32Array(MASK_RES * MASK_RES),
          integral: new Float64Array((MASK_RES + 1) * (MASK_RES + 1)),
        } : null;
      }

      if (src.bgRemoval) {
        const md = src._maskImg.data;

        const bgTargets = selectMaskTracks(
          people, state.targetPersonIds, frameId, output0.length / NUM_CHANNELS,
        );

        // 몸 안에 들어와 있는 물건은 person 마스크에 포함되지 않아 구멍이
        // 됩니다. 같은 추론에서 이미 나온 그 물건의 마스크를 함께 살립니다.
        const heldObjects = selectHeldObjects(
          collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets,
        );
        const maskSources = bgTargets.concat(heldObjects);
        const heldKey = heldObjects.map((o) => `${o.classId}:${o.score.toFixed(2)}`).join(",");
        if (heldKey !== src._heldKey) {
          src._heldKey = heldKey;
          console.log(`[Held] 통과 ${heldKey || "(없음)"}`);
        }

        if (bgTargets.length === 0) {
          // 사람 미감지 시 전체 투명
          for (let j = 3; j < md.length; j += 4) md[j] = 0;
        } else {
          const combinedMask = new Float32Array(nProto);
          // 칸마다 가장 높은 확률을 준 사람의 번호입니다. 구멍 메우기가 구멍이
          // 한 사람 안에 있는지 두 사람 사이에 있는지 가를 때 씁니다.
          // 물건은 누구 것도 아니므로 -1 입니다.
          const owner = new Int8Array(nProto).fill(-1);

          for (let t = 0; t < maskSources.length; t++) {
            const target = maskSources[t];
            const who = t < bgTargets.length ? t : -1;
            const coeffs = new Float32Array(32);
            for (let c = 0; c < 32; c++) {
              coeffs[c] = output0[target.anc * NUM_CHANNELS + COEFF_START + c];
            }

            for (let p = 0; p < nProto; p++) {
              let sum = 0;
              for (let c = 0; c < 32; c++) {
                sum += coeffs[c] * protos[c * nProto + p];
              }
              const prob = 1 / (1 + Math.exp(-sum)); // sigmoid
              if (prob > combinedMask[p]) {
                combinedMask[p] = prob;
                owner[p] = who;
              }
            }
          }

          // 각 대상별 바운딩 박스를 160 해상도로 변환하여 배열에 저장
          //
          // 물건 박스도 함께 넣어야 합니다. 사람 박스만으로 자르면 팔 밖으로
          // 나온 부분이 도로 잘려 위에서 합친 물건 마스크가 무의미해집니다.
          const boxes160 = maskSources.map((target) => {
            return {
              x1: Math.floor(target.box.x1 * (PROTO / 640)),
              y1: Math.floor(target.box.y1 * (PROTO / 640)),
              x2: Math.ceil(target.box.x2 * (PROTO / 640)),
              y2: Math.ceil(target.box.y2 * (PROTO / 640)),
            };
          });

          // 대상 박스를 덮는 마스크 칸 범위입니다. 경계 보정과 구멍 메우기가
          // 모두 이 범위만 훑습니다. 박스 밖은 어차피 알파 0 이라 결과가 같고,
          // 1080p 에서 처리량이 크게 줄어듭니다.
          //
          // proto 칸 → 마스크 칸 (아래 램프 루프의 중심 정렬을 되돌린 식).
          // 테두리가 박스 바깥의 투명 구간에 놓이도록 두 칸 넓힙니다.
          let bx1 = PROTO, by1 = PROTO, bx2 = -1, by2 = -1;
          for (const box of boxes160) {
            if (box.x1 < bx1) bx1 = box.x1;
            if (box.y1 < by1) by1 = box.y1;
            if (box.x2 > bx2) bx2 = box.x2;
            if (box.y2 > by2) by2 = box.y2;
          }
          const toMask = (p) => (p + 0.5) / P2M - 0.5;
          const PAD = 2;
          const rect = {
            x1: Math.max(0, Math.floor(toMask(bx1)) - PAD),
            y1: Math.max(0, Math.floor(toMask(by1)) - PAD),
            x2: Math.min(MASK_RES - 1, Math.ceil(toMask(bx2)) + PAD),
            y2: Math.min(MASK_RES - 1, Math.ceil(toMask(by2)) + PAD),
          };

          // 구멍 넓이 상한의 기준이 될 사람 박스입니다(마스크 격자 기준).
          // 물건 박스는 넣지 않습니다. 이미 마스크로 합쳐져 그 안에는 구멍이
          // 남지 않고, 작은 박스가 기준이 되면 상한만 엉뚱하게 좁아집니다.
          const personBoxes = bgTargets.map((t) => ({
            x1: toMask(t.box.x1 * (PROTO / 640)),
            y1: toMask(t.box.y1 * (PROTO / 640)),
            x2: toMask(t.box.x2 * (PROTO / 640)),
            y2: toMask(t.box.y2 * (PROTO / 640)),
          }));

          const FADE_SPAN = FADE.hi - FADE.lo;
          const last = PROTO - 1;
          const alpha = src._maskAlpha;
          const probField = src._maskProb;

          for (let my = 0; my < MASK_RES; my++) {
            // 마스크 격자 → proto 연속 좌표 (픽셀 중심 정렬)
            //
            // proto 한 칸은 여러 출력 픽셀을 덮고, 그 칸의 값은 덮는 구간의
            // 한가운데에 놓입니다. +0.5 / -0.5 없이 mx * P2M 로만 쓰면 칸을
            // 구간 맨 앞에 놓게 되어 마스크 전체가 왼쪽·위로 밀립니다.
            // GPU 의 MASK_RES → 출력 확대는 이미 중심 정렬이므로,
            // 여기서 맞춰주면 종단 매핑이 해상도와 무관하게 정확해집니다.
            let gy = (my + 0.5) * P2M - 0.5;
            if (gy < 0) gy = 0;
            else if (gy > last) gy = last;
            const y0 = gy | 0;
            const fy = gy - y0;
            const r0 = y0 * PROTO;
            const r1 = (y0 + 1 < PROTO ? y0 + 1 : last) * PROTO;
            let rowOut = my * MASK_RES;

            for (let mx = 0; mx < MASK_RES; mx++, rowOut++) {
              let gx = (mx + 0.5) * P2M - 0.5;
              if (gx < 0) gx = 0;
              else if (gx > last) gx = last;
              const x0 = gx | 0;

              // 박스 절단 (이전과 동일하게 proto 격자 기준으로 판정)
              let inAnyBox = false;
              for (const box of boxes160) {
                if (
                  x0 >= box.x1 &&
                  x0 <= box.x2 &&
                  y0 >= box.y1 &&
                  y0 <= box.y2
                ) {
                  inAnyBox = true;
                  break;
                }
              }
              if (!inAnyBox) {
                probField[rowOut] = 0;
                continue;
              }

              // 이중선형 보간으로 마스크 확률값 획득 (이전과 동일)
              const fx = gx - x0;
              const x1 = x0 + 1 < PROTO ? x0 + 1 : last;
              const top =
                combinedMask[r0 + x0] * (1 - fx) + combinedMask[r0 + x1] * fx;
              const bot =
                combinedMask[r1 + x0] * (1 - fx) + combinedMask[r1 + x1] * fx;
              probField[rowOut] = top * (1 - fy) + bot * fy;
            }
          }

          // ── 경계를 영상의 실제 윤곽에 붙이기 ─────────────────────────
          // 램프보다 먼저입니다. guided filter 는 연속적인 확률장을 받아야
          // 하고, 알파로 자른 뒤에는 되돌릴 정보가 남아 있지 않습니다.
          if (REFINE_EDGE) {
            const rf = src._refine;
            const rw = rect.x2 - rect.x1 + 1;
            const rh = rect.y2 - rect.y1 + 1;

            // guide 는 모델 입력 캔버스에서 만듭니다. 이미 CPU 에 올라와 있는
            // 픽셀이라 GPU readback 이 추가로 들지 않고, 마스크와 같은
            // 정사각 격자라 좌표계도 그대로 맞습니다.
            const gScale = MODEL_SIZE / MASK_RES;
            for (let y = 0; y < rh; y++) {
              let sy = ((y + rect.y1) * gScale) | 0;
              if (sy > MODEL_SIZE - 1) sy = MODEL_SIZE - 1;
              const srcRow = sy * MODEL_SIZE;
              const dstRow = y * rw;
              const probRow = (y + rect.y1) * MASK_RES + rect.x1;
              for (let x = 0; x < rw; x++) {
                let sx = ((x + rect.x1) * gScale) | 0;
                if (sx > MODEL_SIZE - 1) sx = MODEL_SIZE - 1;
                const p = (srcRow + sx) * 4;
                rf.guide[dstRow + x] =
                  (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
                rf.sub[dstRow + x] = probField[probRow + x];
              }
            }

            guidedRefine(rf.guide, rf.sub, rw, rh, REFINE_RADIUS, REFINE_EPS, rf);

            for (let y = 0; y < rh; y++) {
              const dstRow = (y + rect.y1) * MASK_RES + rect.x1;
              const subRow = y * rw;
              for (let x = 0; x < rw; x++) probField[dstRow + x] = rf.sub[subRow + x];
            }
          }

          // ── 소프트 알파 페더링 ──────────────────────────────────────
          // 하한이 컷오프입니다. 이 확률 이하는 완전 투명입니다. 상한을 1.0
          // 으로 둘 수는 없습니다. sigmoid 는 1 에 도달하지 못하므로 인물
          // 내부가 영구히 반투명해집니다.
          for (let i = 0; i < probField.length; i++) {
            const a = (probField[i] - FADE.lo) / FADE_SPAN;
            alpha[i] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
          }

          // ── 윤곽 안쪽 구멍 메우기 ────────────────────────────────────
          // 침식보다 먼저 해야 합니다. 침식은 min 필터라 구멍을 오히려
          // 넓히므로, 구멍을 먼저 없애야 침식이 바깥 경계에만 작용합니다.
          // 경계 보정이 어두운 옷 안쪽 같은 저대비 구간에서 알파를 끌어내려
          // 몸통에 점처럼 구멍을 남기는 일이 있는데, 그것도 여기서 메워집니다.
          if (FILL_ENCLOSED_HOLES) {
            // 마스크 칸 → 가장 가까운 proto 칸의 주인 (램프 루프와 같은 중심 정렬)
            const ownerOf = (i) => {
              let gx = Math.round(((i % MASK_RES) + 0.5) * P2M - 0.5);
              let gy = Math.round((((i / MASK_RES) | 0) + 0.5) * P2M - 0.5);
              if (gx < 0) gx = 0; else if (gx > last) gx = last;
              if (gy < 0) gy = 0; else if (gy > last) gy = last;
              return owner[gy * PROTO + gx];
            };
            fillEnclosedHoles(
              alpha, src._maskVisited, src._maskStack, MASK_RES, rect,
              personBoxes, MAX_HOLE_FRACTION, ownerOf,
            );
          }

          // ── 경계 침식 ────────────────────────────────────────────────
          // 카메라가 찍은 윤곽선 1~2px 는 인물 색과 원래 배경색이 이미 섞인
          // 픽셀입니다. 마스크가 완벽해도 그대로 얹으면 교체 배경 위에
          // 원래 배경색 테두리가 남습니다. 알파를 한 칸 깎아 그 구간을
          // 잘라냅니다. 마스크 한 칸은 출력에서 3px 안팎입니다.
          erodeAlpha(alpha, src._maskAlphaTmp, MASK_RES, ERODE_CELLS);

          for (let i = 0, j = 3; i < alpha.length; i++, j += 4) md[j] = alpha[i];
        }
        src._maskCtx.putImageData(src._maskImg, 0, 0);
      }

      // 배경 이미지/영상/색 합성 (배경 제거 ON일 때만 배경 교체)
      src.bgCtx.clearRect(0, 0, w, h);
      if (src.bgRemoval) {
        if (state.backgroundImage) {
          src.bgCtx.drawImage(state.backgroundImage, 0, 0, w, h);
        } else if (state.backgroundVideo) {
          src.bgCtx.drawImage(state.backgroundVideo, 0, 0, w, h);
        } else if (state.bgColor) {
          src.bgCtx.fillStyle = state.bgColor;
          src.bgCtx.fillRect(0, 0, w, h);
        } else {
          src.bgCtx.fillStyle = "#000000";
          src.bgCtx.fillRect(0, 0, w, h);
        }
      }

      // ── 전경 합성 ────────────────────────────────────────────────
      // fgCanvas 에는 추론 직전에 붙잡아 둔 프레임이 이미 들어 있습니다.
      // 여기서 다시 그리면 마스크와 시점이 어긋납니다.
      if (src.bgRemoval) {
        // 마스크 캔버스는 MASK_RES×MASK_RES 정사각이고, 전처리가 원본을
        // 비율 보정 없이 정사각으로 늘려 넣었으므로 여기서 w×h 로 되돌려
        // 늘리면 원본 프레임과 정렬됩니다. 전처리의 종횡비 처리를 바꾸면
        // 이 확대도 함께 바꿔야 합니다.
        fgCtx.imageSmoothingEnabled = true;
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(src._maskCanvas, 0, 0, w, h);
        fgCtx.globalCompositeOperation = "source-over";
      }

      // 여기에 blur(1px) contrast(1.3) 을 걸면 안 됩니다.
      //
      // 블러는 RGB 뿐 아니라 알파까지 번지게 해서 경계 양옆으로 3px 가까운
      // 반투명 띠를 만듭니다. 그리고 CSS contrast 는 프리멀티플라이드가 아닌
      // RGB 에 적용되므로, 하필 그 띠에서만 색이 0.5 기준으로 밀려나
      // 윤곽을 따라 밝거나 어두운 링이 생깁니다. 인물 전체도 함께 흐려지고
      // 대비가 올라갑니다.
      //
      // 마스크에만 거는 방법도 재봤지만 소용이 없었습니다. 자세한 수치는
      // FADE 주석에 있습니다. 계단 억제는 페더링과 침식이 대신합니다.
      src.bgCtx.drawImage(fgCv, 0, 0);

      // 바운딩박스, 데드존, 중심점 디버그 그리기
      if (src.objectTracking) {
        const overlayPeople = controlTarget && !controlTarget.observed
          ? [...people, controlTarget] : people;
        _drawTrackingOverlay(src.bgCtx, overlayPeople, state.targetPersonId, w, h);
      }
    } catch (e) {
      console.error("[BG] 추론 오류:", e);
    } finally {
      state.sessionBusy = false;
      inputTensor?.dispose?.();
      for (const tensor of Object.values(results || {})) tensor.dispose?.();
    }
  }

  // 세션 로드 전에는 원본 그대로 출력
  if (!state.session) {
    src.bgCtx.drawImage(vid, 0, 0, w, h);
  }

  _scheduleAiLoop(src, generation);
}

// ─────────────────────────────────────────────────────────
// 오디오 동기화
// ─────────────────────────────────────────────────────────

function _syncAudioToMaster(stream) {
  if (!state.masterStream) return;
  state.masterStream
    .getAudioTracks()
    .forEach((t) => state.masterStream.removeTrack(t));
  stream.getAudioTracks().forEach((t) => state.masterStream.addTrack(t));
  document.dispatchEvent(new CustomEvent("displayStreamChanged"));
}

// ─────────────────────────────────────────────────────────
// 내부 유틸
// ─────────────────────────────────────────────────────────

function _createVideoEl(stream) {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  v.play().catch(() => { });
  return v;
}

function _cleanupSource(src) {
  src.bgRemoval = false;
  src.objectTracking = false;
  _stopAiLoop(src);
  if (src.stream && src.type !== "rpi")
    src.stream.getTracks().forEach((t) => t.stop());
  src.videoEl = null;
  src.stream = null;
}

// ─────────────────────────────────────────────────────────
// Object Panel 목록 UI 렌더링
// ─────────────────────────────────────────────────────────

function renderObjectList(tracks) {
  const list = document.getElementById("object-list");
  if (!list) return;
  list.innerHTML = "";

  if (tracks.length === 0) {
    const li = document.createElement("li");
    li.className = "object-item object-item-empty";
    li.textContent = "감지된 사람 없음";
    list.appendChild(li);
    return;
  }

  // ID 기준 정렬 (UI 목록 순서 고정)
  const sorted = [...tracks].sort((a, b) => a.id - b.id);

  sorted.forEach((track, idx) => {
    const missing = !track.observed;

    if (!state.targetPersonIds) state.targetPersonIds = [];
    const isBgSelected = state.targetPersonIds.includes(track.id);
    const isTracked = track.id === state.targetPersonId;

    const li = document.createElement("li");
    li.className = "object-item" + (isBgSelected ? " selected" : "");
    li.style.display = "flex";
    li.style.justifyContent = "space-between";
    li.style.alignItems = "center";

    if (missing) {
      li.style.opacity = "0.45";
      li.style.fontStyle = "italic";
    }

    li.addEventListener("click", (e) => {
      if (e.target.closest("input, label")) return;

      const idIdx = state.targetPersonIds.indexOf(track.id);
      if (idIdx > -1) {
        state.targetPersonIds.splice(idIdx, 1);
        li.classList.remove("selected");
      } else {
        state.targetPersonIds.push(track.id);
        li.classList.add("selected");
      }
    });

    const labelSpan = document.createElement("span");
    labelSpan.textContent = `사람 ${track.id}` + (missing ? " (잠시 놓침)" : "");

    const trackLabel = document.createElement("label");
    trackLabel.style.display = "flex";
    trackLabel.style.alignItems = "center";
    trackLabel.style.gap = "4px";
    trackLabel.style.cursor = "pointer";
    trackLabel.title = "이 객체 추적";

    const trackRadio = document.createElement("input");
    trackRadio.type = "radio";
    trackRadio.name = "track_target";
    trackRadio.checked = isTracked;
    trackRadio.style.cursor = "pointer";
    trackRadio.addEventListener("change", () => {
      if (trackRadio.checked) {
        state.targetPersonId = track.id;
        if (!state.targetPersonIds.includes(track.id)) {
          state.targetPersonIds.push(track.id);
          li.classList.add("selected");
        }
      }
    });

    const trackText = document.createElement("span");
    trackText.textContent = "추적";
    trackText.style.fontSize = "11px";

    trackLabel.appendChild(trackRadio);
    trackLabel.appendChild(trackText);

    li.appendChild(labelSpan);
    li.appendChild(trackLabel);

    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────────────────
// Sources 목록 UI 렌더링
// ─────────────────────────────────────────────────────────

let _dragId = null;

export function renderSourcesList() {
  const list = document.getElementById("sources-list");
  if (!list) return;
  list.innerHTML = "";

  state.sources.forEach((src) => {
    const li = document.createElement("li");
    li.className =
      "source-item" + (src.id === state.selectedSourceId ? " selected" : "");
    li.dataset.id = src.id;
    li.draggable = true;

    const typeIcon =
      { webcam: "📷", display: "🖥", window: "🪟", rpi: "📡" }[src.type] ||
      "📷";
    const eyeTitle = src.visible ? "가리기" : "표시";
    const eyeOpacity = src.visible ? "1" : "0.35";
    const aiBadge = src.bgRemoval ? '<span class="src-ai-badge">AI</span>' : "";

    li.innerHTML = `
      <span class="src-drag">⠿</span>
      <span class="src-eye" title="${eyeTitle}" style="opacity:${eyeOpacity}">👁</span>
      <span class="src-label">${typeIcon} ${src.label}${aiBadge}</span>
      <button class="src-del" title="삭제">✕</button>
    `;

    li.querySelector(".src-label").addEventListener("click", () =>
      selectSource(src.id),
    );
    li.querySelector(".src-eye").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSourceVisibility(src.id);
    });
    li.querySelector(".src-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeSource(src.id);
    });

    // 드래그 앤 드롭
    li.addEventListener("dragstart", (e) => {
      _dragId = src.id;
      e.currentTarget.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.currentTarget.classList.add("drag-over");
    });
    li.addEventListener("dragleave", (e) => {
      e.currentTarget.classList.remove("drag-over");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drag-over");
      const toId = e.currentTarget.dataset.id;
      if (!_dragId || _dragId === toId) return;
      const fromIdx = state.sources.findIndex((s) => s.id === _dragId);
      const toIdx = state.sources.findIndex((s) => s.id === toId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = state.sources.splice(fromIdx, 1);
      state.sources.splice(toIdx, 0, moved);
      renderSourcesList();
    });
    li.addEventListener("dragend", (e) => {
      e.currentTarget.classList.remove("dragging");
      document
        .querySelectorAll(".source-item.drag-over")
        .forEach((el) => el.classList.remove("drag-over"));
      _dragId = null;
    });

    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────────────────
// Sources 패널 이벤트 설정
// ─────────────────────────────────────────────────────────

export function setupSourcesPanel() {
  const addBtn = document.getElementById("add-source-btn");
  const addMenu = document.getElementById("add-source-menu");

  addBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!addMenu) return;
    const isOpen = addMenu.style.display === "block";
    if (isOpen) {
      addMenu.style.display = "none";
      return;
    }

    // fixed 위치: + 버튼 바로 아래
    const rect = addBtn.getBoundingClientRect();
    const menuW = 160;
    const left = rect.left + rect.width / 2 - menuW / 2;
    addMenu.style.left = `${Math.max(4, left)}px`;
    addMenu.style.top = `${rect.bottom + 4}px`;
    addMenu.style.display = "block";
  });

  document.addEventListener("click", () => {
    if (addMenu) addMenu.style.display = "none";
  });

  document.querySelectorAll("[data-add-source]").forEach((item) => {
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (addMenu) addMenu.style.display = "none";
      await _handleAddType(item.dataset.addSource);
    });
  });
}

async function _handleAddType(type) {
  switch (type) {
    case "webcam":
      await _pickWebcam();
      break;
    case "display":
      await _pickDesktop(["screen"]);
      break;
    case "window":
      await _pickDesktop(["window"]);
      break;
    case "rpi": {
      if (!state.piConnected) {
        alert("먼저 RPi를 연결하세요. (설정 모달 → 연결)");
        return;
      }
      if (!state.piVideoStream) {
        alert("RPi 영상 수신 대기 중입니다. 잠시 후 다시 시도하세요.");
        return;
      }
      addRpiSource();
      break;
    }
  }
}

async function _pickWebcam() {
  let tmp = null;
  try {
    tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput",
    );
    tmp.getTracks().forEach((t) => t.stop());

    // 카메라 하드웨어 반환(버퍼 정리)을 기다리기 위한 대기 시간 추가
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (!devices.length) {
      alert("웹캠을 찾을 수 없습니다.");
      return;
    }
    if (devices.length === 1) {
      await addWebcamSource(devices[0].deviceId, devices[0].label || "웹캠");
      return;
    }
    _showPickerModal(
      "웹캠 선택",
      devices.map((d, i) => ({
        id: d.deviceId,
        name: d.label || `카메라 ${i + 1}`,
        thumbnail: null,
      })),
      (sel) => addWebcamSource(sel.id, sel.name),
    );
  } catch (e) {
    if (tmp) tmp.getTracks().forEach((t) => t.stop());
    alert(`웹캠 목록 조회 실패: ${e.message}`);
  }
}

async function _pickDesktop(types) {
  if (!isElectron || !window.electronAPI?.invoke) {
    alert("Electron 환경에서만 사용 가능합니다.");
    return;
  }
  try {
    const srcs = await window.electronAPI.invoke("get-desktop-sources", types);
    if (!srcs?.length) {
      alert("캡처 가능한 소스가 없습니다.");
      return;
    }
    const title = types.includes("screen") ? "화면 캡처 선택" : "창 캡처 선택";
    _showPickerModal(
      title,
      srcs.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail })),
      (sel) =>
        types.includes("screen")
          ? addDisplaySource(sel.id, sel.name)
          : addWindowSource(sel.id, sel.name),
    );
  } catch (e) {
    alert(`소스 목록 조회 실패: ${e.message}`);
  }
}

function _showPickerModal(title, items, onSelect) {
  let modal = document.getElementById("source-picker-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "source-picker-modal";
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-content">
      <h2>${title}</h2>
      <div class="src-picker-grid" id="spg"></div>
      <div class="modal-buttons">
        <button class="control-btn" id="spc-cancel">취소</button>
      </div>
    </div>`;
  const grid = document.getElementById("spg");
  items.forEach((item) => {
    const d = document.createElement("div");
    d.className = "src-picker-item";
    d.innerHTML = item.thumbnail
      ? `<img src="${item.thumbnail}" alt="${item.name}"><p>${item.name}</p>`
      : `<div class="src-picker-ph">${item.name.slice(0, 2)}</div><p>${item.name}</p>`;
    d.addEventListener("click", () => {
      modal.style.display = "none";
      onSelect(item);
    });
    grid.appendChild(d);
  });
  document.getElementById("spc-cancel")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  modal.style.display = "flex";
}
