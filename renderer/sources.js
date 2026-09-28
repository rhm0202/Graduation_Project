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
  controlPoint, videoFrameKey, TRACKING_POLICY,
} from "./byteTracker.js";

// 검출 좌표가 사는 정사각 좌표계의 한 변. 프레임 전체에 선형 대응합니다.
const TRACKING_FRAME_SIZE = TRACKING_POLICY.modelSize;

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
  src._matteCanvas = null;
  src._matteCtx = null;
  src._matteData = null;
  src._matteBroken = false;
  src._matteReady = false;
  src._matteCount = 0;
  src._alphaPrev = null;
  src._alphaWarm = false;
  _disposeMatteState(src);

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

/**
 * 매팅 알파를 src._maskCanvas 에 채웁니다.
 *
 * 매팅 모델은 화면의 모든 인물을 한 덩어리로 뽑습니다. 선택된 사람만 남기는
 * 것은 ByteTrack 이 준 박스로 알파를 잘라 되살립니다.
 */
const MATTE_LONG_SIDE = 640;   // 알파 계산 해상도 (긴 변). 출력은 여기서 확대됩니다.
// 512 로 줄이면 몇 ms 빨라지지만 메고 있는 가방이 알파에서 빠집니다.

/**
 * RVM 의 downsample_ratio 는 인코더가 볼 해상도를 정합니다. 저자 권장값은
 * 512p 에서 1.0, 720p 0.375, 1080p 0.25, 4K 0.125 — 즉 내부 처리를 512px
 * 언저리로 맞추는 값입니다. 입력을 줄여 놓고 비율까지 낮추면 인코더가 보는
 * 크기가 손가락 틈보다 커져 그 사이 배경이 살아남습니다.
 */
const MATTE_ENCODER_PX = 320;  // 인코더가 볼 긴 변. 낮추면 빠르고 얇은 틈이 뭉갭니다.

/**
 * 알파 시간 평활화 계수. 가방처럼 모델이 애매하게 보는 영역은 프레임마다
 * 포함/제외가 뒤집혀 깜빡입니다. 직전 알파와 섞어 그 진동을 눌러줍니다.
 * 1 이면 평활화 없음, 낮출수록 안정되지만 움직임에 마스크가 뒤처집니다.
 */
// 12fps 에서 0.5 로 섞으면 알파가 자리잡는 데 250ms 가 걸려 잔상이 심하게
// 남습니다. 프레임을 먼저 올린 뒤 다시 볼 값이라 지금은 꺼 둡니다.
const ALPHA_SMOOTHING = 1;

// 깜빡임 원인 분리용. true 면 RVM 순환 상태를 넘기지 않고 매 프레임 독립 추론.
// 순환 상태를 넘기지 않고 매 프레임 독립 추론할지. 측정상 켜나 끄나
// 경계 churn 이 같았지만(0.23 vs 0.24), 모델 본래 사용법대로 둡니다.
const MATTE_STATELESS = false;

function matteRatio(longSide) {
  return Math.min(1, MATTE_ENCODER_PX / longSide);
}

async function _applyMatte(src, source, w, h, targets, people, tracked) {
  const session = state.mattingSession;
  if (!session || src._matteBroken) return false;

  const scale = Math.min(1, MATTE_LONG_SIDE / Math.max(w, h));
  const mw = Math.max(2, Math.round(w * scale));
  const mh = Math.max(2, Math.round(h * scale));

  if (!src._matteCanvas || src._matteCanvas.width !== mw || src._matteCanvas.height !== mh) {
    src._matteCanvas = src._matteCanvas || document.createElement("canvas");
    src._matteCanvas.width = mw;
    src._matteCanvas.height = mh;
    src._matteCtx = src._matteCanvas.getContext("2d", { willReadFrequently: true });
    src._matteData = new Float32Array(3 * mw * mh);
    src._alphaPrev = new Float32Array(mw * mh);
    src._alphaWarm = false;
    // 순환 상태는 공간 크기에 묶여 있으므로 해상도가 바뀌면 버립니다.
    _disposeMatteState(src);
    src._maskCanvas = document.createElement("canvas");
    src._maskCanvas.width = mw;
    src._maskCanvas.height = mh;
    src._maskCtx = src._maskCanvas.getContext("2d");
    src._maskImg = src._maskCtx.createImageData(mw, mh);
    const d = src._maskImg.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
  }

  // 전경 캔버스에서 그립니다. vid 에서 다시 읽으면 추론에 걸린 시간만큼
  // 뒤의 프레임이 들어와 마스크와 전경의 시점이 어긋납니다.
  src._matteCtx.drawImage(source, 0, 0, mw, mh);
  const pixels = src._matteCtx.getImageData(0, 0, mw, mh).data;
  const plane = mw * mh;
  const tensorData = src._matteData;
  const INV_255 = 0.003921568627451;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    tensorData[i] = pixels[p] * INV_255;
    tensorData[plane + i] = pixels[p + 1] * INV_255;
    tensorData[2 * plane + i] = pixels[p + 2] * INV_255;
  }

  const previous = MATTE_STATELESS ? null : src._rvmState;
  const emptyState = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
  const feeds = {
    src: new ort.Tensor("float32", tensorData, [1, 3, mh, mw]),
    r1i: previous ? previous[0] : emptyState(),
    r2i: previous ? previous[1] : emptyState(),
    r3i: previous ? previous[2] : emptyState(),
    r4i: previous ? previous[3] : emptyState(),
    downsample_ratio: new ort.Tensor("float32",
      new Float32Array([matteRatio(Math.max(mw, mh))]), [1]),
  };

  let results;
  const started = performance.now();
  try {
    results = await session.run(feeds);
    src._matteMs = performance.now() - started;
    src._matteCount = (src._matteCount || 0) + 1;
    if (src._matteCount <= 5 || src._matteCount % 30 === 0) {
      console.log(`[Matte] #${src._matteCount} ${mw}x${mh} `
        + `ratio=${matteRatio(Math.max(mw, mh)).toFixed(2)} `
        + `${(performance.now() - started).toFixed(0)}ms state=${previous ? "reuse" : "init"}`);
    }
  } catch (e) {
    // 한 번 실패한 원인은 다음 프레임에도 그대로입니다. 매 프레임 되풀이하면
    // 로그만 쌓이고 같은 백엔드를 쓰는 다른 세션까지 흔들립니다.
    console.error("[Matte] 추론 오류 — 매팅을 끕니다:", e);
    _disposeMatteState(src);
    src._matteBroken = true;
    return false;
  }

  // 순환 상태를 다음 프레임으로 넘깁니다. 단일 프레임으로 돌리면 인물이
  // 반투명해지는데, 상태가 이어지면 프레임이 지날수록 안정됩니다.
  src._rvmState = [results.r1o, results.r2o, results.r3o, results.r4o];
  if (previous) for (const tensor of previous) tensor.dispose?.();

  const alpha = results.pha.data;
  const mask = src._maskImg.data;
  const smoothed = src._alphaPrev;
  const warm = src._alphaWarm;
  // churn = 직전 프레임 대비 알파 변화량. 깜빡임의 크기를 그대로 나타냅니다.
  // edgeChurn 은 경계(0.1~0.9) 픽셀만 본 값으로, 인물 내부의 안정성과
  // 경계의 진동을 분리합니다.
  let churn = 0, edgeChurn = 0, edgeCount = 0;
  for (let i = 0, a = 3; i < plane; i++, a += 4) {
    const raw = alpha[i];
    if (warm) {
      const delta = Math.abs(raw - smoothed[i]);
      churn += delta;
      if ((raw > 0.1 && raw < 0.9) || (smoothed[i] > 0.1 && smoothed[i] < 0.9)) {
        edgeChurn += delta; edgeCount++;
      }
    }
    const value = warm ? smoothed[i] + (raw - smoothed[i]) * ALPHA_SMOOTHING : raw;
    smoothed[i] = value;
    mask[a] = value <= 0 ? 0 : value >= 1 ? 255 : (value * 255) | 0;
  }
  if (warm && src._matteCount % 30 === 0) {
    console.log(`[Churn] 전체 ${(churn / plane).toFixed(4)} `
      + `경계 ${(edgeChurn / Math.max(1, edgeCount)).toFixed(4)} `
      + `경계픽셀 ${(100 * edgeCount / plane).toFixed(1)}% `
      + `stateless=${MATTE_STATELESS}`);
  }
  src._alphaWarm = true;
  // RVM 은 30fps 연속 영상을 가정합니다. 프레임 간격이 들쭉날쭉하면 순환
  // 상태가 서서히 발산해 알파가 0 으로 무너지고, 화면 전체가 깜빡입니다.
  // 사람이 추적되고 있는데 알파가 비면 상태만 버리고 다음 프레임에 새로
  // 시작합니다. 한 프레임만 흐리고 곧 회복됩니다.
  let sum = 0;
  const step = 7;
  for (let i = 0; i < plane; i += step) sum += alpha[i];
  const mean = sum / Math.ceil(plane / step);
  if (src._matteCount % 30 === 0) {
    console.log(`[Alpha] 평균 ${mean.toFixed(3)} 추적 ${tracked}명`);
  }
  if (mean < 0.02 && tracked > 0) {
    src._matteCollapse = (src._matteCollapse || 0) + 1;
    console.warn(`[Alpha] 붕괴 감지 (평균 ${mean.toFixed(4)}) — 순환 상태 초기화 #${src._matteCollapse}`);
    _disposeMatteState(src);
    src._alphaWarm = false;
  }
  src._maskCtx.globalCompositeOperation = "source-over";
  src._maskCtx.putImageData(src._maskImg, 0, 0);

  // 선택된 사람의 박스로 잘라내면 안 됩니다. 추적 박스는 인물보다 작을 때가
  // 있고 프레임마다 흔들리므로, 박스 밖으로 나온 가방이 깜빡이고 경계가
  // 직선으로 잘려 벽처럼 보입니다. 선택되지 않은 사람만 지워서 필요한 것만
  // 덜어냅니다. 혼자 있으면 아무것도 지우지 않습니다.
  if (targets.length === 0) {
    src._maskCtx.globalCompositeOperation = "destination-in";
    src._maskCtx.clearRect(0, 0, mw, mh);
    src._maskCtx.globalCompositeOperation = "source-over";
  } else {
    const keep = new Set(targets.map((target) => target.id));
    const others = (people || []).filter((track) =>
      track.observed && track.detectionBox && !keep.has(track.id));
    if (others.length !== src._lastOthers) {
      src._lastOthers = others.length;
      console.log(`[Clip] 지우는 인물 ${others.length}명 `
        + `(추적 중 ${(people || []).length}명, 선택 ${targets.length}명) `
        + `ids=[${others.map((t) => `${t.id}:${t.score.toFixed(2)}`).join(",")}]`);
    }
    if (others.length) {
      const kx = mw / TRACKING_FRAME_SIZE;
      const ky = mh / TRACKING_FRAME_SIZE;
      src._maskCtx.globalCompositeOperation = "destination-out";
      src._maskCtx.fillStyle = "#000000";
      src._maskCtx.beginPath();
      for (const track of others) {
        const box = track.detectionBox;
        src._maskCtx.rect(box.x1 * kx, box.y1 * ky,
          (box.x2 - box.x1) * kx, (box.y2 - box.y1) * ky);
      }
      src._maskCtx.fill();
      src._maskCtx.globalCompositeOperation = "source-over";
    }
  }

  results.pha.dispose?.();
  results.fgr.dispose?.();
  feeds.src.dispose?.();
  feeds.downsample_ratio.dispose?.();
  return true;
}

function _disposeMatteState(src) {
  if (src._rvmState) for (const tensor of src._rvmState) tensor.dispose?.();
  src._rvmState = null;
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
      const loopStarted = timestampMs;
      const frameId = ++src._aiFrameId;
      src._lastVideoFrameKey = frameKey;
      const MODEL_SIZE = 640;
      // 캔버스 재사용 (매 프레임 생성 방지)
      const tmp = src._tmpCanvas;
      const tmpCtx = src._tmpCtx;
      if (tmp.width !== MODEL_SIZE) tmp.width = MODEL_SIZE;
      if (tmp.height !== MODEL_SIZE) tmp.height = MODEL_SIZE;
      // 비율을 무시하고 정사각으로 늘리면 16:9 입력이 세로로 1.78 배 찌그러집니다.
      // YOLO 는 비율을 유지한 회색 여백(레터박스)으로 학습되어, 찌그러진 입력에서는
      // 손가락 같은 얇은 구조가 뭉치고 작은 물체의 오검출이 늘어납니다.
      const fit = Math.min(MODEL_SIZE / w, MODEL_SIZE / h);
      const fitW = w * fit, fitH = h * fit;
      const padX = (MODEL_SIZE - fitW) / 2, padY = (MODEL_SIZE - fitH) / 2;
      const viewport = { x: padX, y: padY, width: fitW, height: fitH };
      tmpCtx.fillStyle = "#727272"; // YOLO 표준 여백색 (114,114,114)
      tmpCtx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
      tmpCtx.drawImage(vid, padX, padY, fitW, fitH);
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
      const detectStarted = performance.now();
      results = await session.run(feeds);
      src._detectMs = performance.now() - detectStarted;

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

      const detectedPeople = collectPersonDetections(output0, NUM_CHANNELS, viewport);
      const people = globalTracker.update(detectedPeople, { timestampMs, frameId });

      // UI 표시 및 인덱스 매칭을 위해 현재 프레임 기준 X좌표 순(왼쪽부터)으로 정렬
      people.sort((a, b) => a.box.x1 - b.box.x1);

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

      // ── 알파 매트 ────────────────────────────────────────────────
      // COCO 의 person 마스크는 들고 있는 가방을 "사람이 아님" 으로 지웁니다.
      // 확률을 아무리 낮게 잘라도 복구되지 않아(0.40 에서도 그대로) 검출로
      // 보완하려 했지만 가방 자체가 잡히지 않았습니다(최고 score 0.144).
      // 매팅 모델은 전경 인물을 통째로 뽑으므로 소지품이 함께 남고, 알파가
      // 입력 해상도로 나와 proto 160 격자의 손끝 뭉개짐도 사라집니다.
      if (src.bgRemoval) {
        const bgTargets = selectMaskTracks(
          people, state.targetPersonIds, frameId, output0.length / NUM_CHANNELS,
        );
        src._matteReady = await _applyMatte(
          src, fgCv, w, h, bgTargets, people, people.filter((t) => t.observed).length);
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
      if (src.bgRemoval && src._matteReady && src._maskCanvas) {
        // 매트 캔버스는 프레임 전체를 축소한 것이라 그대로 w×h 로 늘리면
        // 정렬됩니다. MATTE_LONG_SIDE 를 바꿔도 이 확대는 그대로입니다.
        fgCtx.imageSmoothingEnabled = true;
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(src._maskCanvas, 0, 0, w, h);
        fgCtx.globalCompositeOperation = "source-over";
      }

      // 예전에는 여기서 blur(1px) contrast(1.3) 으로 proto 160 격자의 계단
      // 패턴을 문질러 가렸습니다. 매팅 알파는 입력 해상도로 나와 계단이 없고,
      // 블러는 되찾은 손끝 디테일만 깎으므로 걷어냈습니다.
      src.bgCtx.drawImage(fgCv, 0, 0);

      src._loopCount = (src._loopCount || 0) + 1;
      if (src._loopCount % 30 === 0) {
        const mem = performance.memory
          ? ` heap=${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB` : "";
        console.log(`[Loop] #${src._loopCount} 총 ${(performance.now() - loopStarted).toFixed(0)}ms`
          + ` (검출 ${(src._detectMs || 0).toFixed(0)}ms + 매팅 ${(src._matteMs || 0).toFixed(0)}ms)${mem}`);
      }

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
