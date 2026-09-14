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
import { HybridTracker } from "./hybridTracker.js";

const globalTracker = new HybridTracker();
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
  try {
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: true,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.mediaStream = stream;
    _syncAudioToMaster(stream);

    // 기존 웹캠 소스 교체 (같은 장치 재선택 시)
    const existing = state.sources.find((s) => s.type === "webcam");
    if (existing) {
      if (existing.stream) existing.stream.getTracks().forEach((t) => t.stop());
      existing.stream = stream;
      existing.videoEl = _createVideoEl(stream);
      existing.label = label || existing.label;
      if (existing.bgRemoval || existing.objectTracking) {
        _stopAiLoop(existing);
        _startAiLoop(existing);
      }
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
  if (state.sources.find((s) => s.type === "rpi")) return null; // 중복 방지

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

export function removeSource(id) {
  const idx = state.sources.findIndex((s) => s.id === id);
  if (idx === -1) return;
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
  if (needAi && !src.bgAnimFrame) {
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
  if (needAi && !src.bgAnimFrame) {
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
  _aiLoop(src);
}

function _stopAiLoop(src) {
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
  src._alpha160 = null;

  // 배경 제거 + 객체 추적이 모두 꺼졌을 때 객체 번호 초기화
  if (!src.bgRemoval && !src.objectTracking) {
    globalTracker.reset();
    state.targetPersonIds = [];
    state.targetPersonId = null;
    _trackSnapshot = "";
    renderObjectList([]);
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
    const label = `ID ${person.id}`;
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

async function _aiLoop(src) {
  if ((!src.bgRemoval && !src.objectTracking) || !src.bgCtx) return;
  const vid = src.videoEl;
  if (!vid || vid.readyState < 2) {
    src.bgAnimFrame = requestAnimationFrame(() => _aiLoop(src));
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
    try {
      state.sessionBusy = true;
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

      const inputTensor = new ort.Tensor("float32", tensorData, [
        1,
        3,
        MODEL_SIZE,
        MODEL_SIZE,
      ]);
      const feeds = { [state.session.inputNames[0]]: inputTensor };
      const results = await state.session.run(feeds);

      // 추론 대기 중 소스가 변경되어 AI 처리가 중단된 경우 조기 종료
      if ((!src.bgRemoval && !src.objectTracking) || !src.bgCtx) {
        state.sessionBusy = false;
        return;
      }

      // 트래커 색상 표본은 모델 입력(640×640)에서 뽑습니다.
      // 박스가 이미 같은 좌표계라 변환이 필요 없고, 전체 해상도 프레임을
      // CPU로 내리지 않아도 됩니다.
      const imageData = tmpData;

      // ── 기본 모델 출력 파싱 (출력 형태 [1, 300, 38] 고정) ──────────────
      const out0Tensor = results[state.session.outputNames[0]];
      const out1Tensor = results[state.session.outputNames[1]];
      const output0 = out0Tensor.data;
      const protos = out1Tensor.data;

      const NUM_ANCHORS = 300;
      const NUM_CHANNELS = 38;

      const SCORE_CH = 4;
      const COEFF_START = 6;

      // 1. 감지된 "사람(classId=0)" 앵커들을 모두 수집
      let detectedPeople = [];
      for (let a = 0; a < NUM_ANCHORS; a++) {
        const score = output0[a * NUM_CHANNELS + SCORE_CH];
        const classId = output0[a * NUM_CHANNELS + 5];

        if (classId === 0 && score > 0.40) {
          detectedPeople.push({
            anc: a,
            score: score,
            box: {
              x1: output0[a * NUM_CHANNELS + 0],
              y1: output0[a * NUM_CHANNELS + 1],
              x2: output0[a * NUM_CHANNELS + 2],
              y2: output0[a * NUM_CHANNELS + 3],
            },
          });
        }
      }

      // 2. 하이브리드 트래커 적용 (고유 ID 부여 및 객체 추적)
      let people = globalTracker.update(detectedPeople, imageData);

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

      let bestScore = -Infinity;
      let bestAnc = -1;
      let bestBox = null;

      // 고정된 targetPersonId와 일치하는 사람 찾기 (순서가 뒤바뀌어도 ID를 따라감)
      const targetPerson = people.find((p) => p.id === state.targetPersonId);

      if (targetPerson) {
        bestScore = targetPerson.score;
        bestAnc = targetPerson.anc;
        bestBox = targetPerson.box;
      }
      // targetPersonId가 null이면 사용자가 아직 선택하지 않은 상태 → 자동 선택 안 함
      // 트래커가 아직 해당 ID를 기억 중(일시 소실)이면 이 프레임은 생략

      const bestProb = bestScore;

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

      // 확률이 50% 이상이고 유효한 추적 대상이 감지되었을 때만 처리
      if (bestProb > 0.5 && bestAnc >= 0) {
        // 객체추적이 켜져 있으면 좌표 전송
        if (state.autoTrackingEnabled) {
          const obj_x = ((bestBox.x1 + bestBox.x2) / 2) * (w / 640);
          const obj_y = (bestBox.y1 + (bestBox.y2 - bestBox.y1) * 0.2) * (h / 640);
          sendObjectCoords({
            x: obj_x,
            y: obj_y,
            frameWidth: w,
            frameHeight: h,
          });
        }
      }

      // 배경 제거가 켜져 있을 때 다중 객체 마스크 적용
      //
      // 마스크 확률·박스 절단·페이드 기준(0.40~0.65)은 이전과 동일합니다.
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
      }

      if (src.bgRemoval) {
        const md = src._maskImg.data;

        const bgTargets = people.filter(
          (p) => state.targetPersonIds.includes(p.id) && p.score > 0.5,
        );

        if (bgTargets.length === 0) {
          // 사람 미감지 시 전체 투명
          for (let j = 3; j < md.length; j += 4) md[j] = 0;
        } else {
          const combinedMask = new Float32Array(nProto);

          for (const target of bgTargets) {
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
              }
            }
          }

          // 각 대상별 바운딩 박스를 160 해상도로 변환하여 배열에 저장
          const boxes160 = bgTargets.map((target) => {
            return {
              x1: Math.floor(target.box.x1 * (PROTO / 640)),
              y1: Math.floor(target.box.y1 * (PROTO / 640)),
              x2: Math.ceil(target.box.x2 * (PROTO / 640)),
              y2: Math.ceil(target.box.y2 * (PROTO / 640)),
            };
          });

          // ── 소프트 알파 페더링 ──────────────────────────────────────
          // 하한이 컷오프입니다. 이 확률 이하는 완전 투명입니다.
          //
          // 0.40 으로 두면 모델이 "배경 쪽에 가깝다"고 본 0.40~0.50 구간까지
          // 알파 0.2~0.4 로 남아, 검어야 할 곳에 배경이 어렴풋이 비칩니다.
          // 원래의 하드 이진화 기준이던 0.75 로 되돌립니다.
          //
          // 상한은 1.0 으로 둘 수 없습니다. sigmoid 는 1 에 도달하지 못하므로
          // 인물 내부가 영구히 반투명해집니다. 0.85 면 그 위는 모두 불투명입니다.
          const FADE_LO = 0.75;
          const FADE_HI = 0.85;
          const FADE_SPAN = FADE_HI - FADE_LO;
          const last = PROTO - 1;

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
            const my160 = gy | 0;
            let rowOut = my * MASK_RES * 4 + 3;

            for (let mx = 0; mx < MASK_RES; mx++, rowOut += 4) {
              let gx = (mx + 0.5) * P2M - 0.5;
              if (gx < 0) gx = 0;
              else if (gx > last) gx = last;
              const mx160 = gx | 0;

              // 박스 절단 (이전과 동일하게 proto 격자 기준으로 판정)
              let inAnyBox = false;
              for (const box of boxes160) {
                if (
                  mx160 >= box.x1 &&
                  mx160 <= box.x2 &&
                  my160 >= box.y1 &&
                  my160 <= box.y2
                ) {
                  inAnyBox = true;
                  break;
                }
              }
              if (!inAnyBox) {
                md[rowOut] = 0;
                continue;
              }

              // 이중선형 보간으로 마스크 확률값 획득 (이전과 동일)
              const x0 = gx | 0;
              const fx = gx - x0;
              const x1 = x0 + 1 < PROTO ? x0 + 1 : last;
              const top =
                combinedMask[r0 + x0] * (1 - fx) + combinedMask[r0 + x1] * fx;
              const bot =
                combinedMask[r1 + x0] * (1 - fx) + combinedMask[r1 + x1] * fx;
              const prob = top * (1 - fy) + bot * fy;

              const a = (prob - FADE_LO) / FADE_SPAN;
              md[rowOut] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
            }
          }
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
        // 마스크 캔버스는 모델 좌표계(640×640)이고 전처리가 원본을 그대로
        // 늘려 넣었으므로, 여기서 되돌려 늘리면 원본 프레임과 정렬됩니다.
        fgCtx.imageSmoothingEnabled = true;
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(src._maskCanvas, 0, 0, w, h);
        fgCtx.globalCompositeOperation = "source-over";
      }

      // ── blur+contrast 메타볼 이펙트 ─────────────────────────────────
      // 전경 합성 직전 미세 블러로 엣지 픽셀을 번지게 한 뒤
      // contrast로 다시 당겨줌으로써 잔여 계단 패턴을 추가로 억제합니다.
      if (src.bgRemoval) {
        src.bgCtx.filter = "blur(1px) contrast(1.3)";
      }
      src.bgCtx.drawImage(fgCv, 0, 0);
      src.bgCtx.filter = "none";

      // 바운딩박스, 데드존, 중심점 디버그 그리기
      if (src.objectTracking) {
        _drawTrackingOverlay(src.bgCtx, people, state.targetPersonId, w, h);
      }
    } catch (e) {
      console.error("[BG] 추론 오류:", e);
    } finally {
      state.sessionBusy = false;
    }
  }

  // 세션 로드 전에는 원본 그대로 출력
  if (!state.session) {
    src.bgCtx.drawImage(vid, 0, 0, w, h);
  }

  src.bgAnimFrame = requestAnimationFrame(() => _aiLoop(src));
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
    const missing = track.missingFrames > 0;

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
      if (e.target.tagName.toLowerCase() === "input") return;

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
    labelSpan.textContent = `사람 ${track.id}` + (missing ? " (사라짐)" : "");

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
