/**
 * OBS 스타일 소스 패널 및 마스터 캔버스 컴포지팅 모듈
 *
 * ─ 아키텍처 ───────────────────────────────────────────────
 *  [Webcam/Display/Window/RPi 소스]
 *        │  각 소스의 videoEl / bgCanvas
 *        ▼
 *  [Master Canvas (rAF 컴포지터)]  ← captureStream(30)
 *        │
 *        ├─▶ <video id="main-video-feed">
 *        └─▶ MediaRecorder
 *
 * state.sources[0] = 최상단 레이어 (마지막에 그려짐)
 * state.sources[last] = 최하단 레이어 (처음에 그려짐)
 */
import { state, isElectron } from "./state.js";
import { sendObjectCoords } from "./rpi.js";
import { HybridTracker } from "./hybridTracker.js";

const globalTracker = new HybridTracker();

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
  state.masterStream = canvas.captureStream(30);
  state.displayStream = state.masterStream; // recording.js 호환

  const videoFeed = document.getElementById("main-video-feed");
  if (videoFeed) videoFeed.srcObject = state.masterStream;

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
  if (!src || !src.visible) return;

  // bgCanvas는 AI 루프가 돌 때(배경 제거 또는 객체 추적) 사용됨
  const aiActive = src.bgRemoval || src.objectTracking;
  if (aiActive && src.bgCanvas && src.bgCanvas.width > 0) {
    _drawLetterboxed(ctx, src.bgCanvas, CANVAS_W, CANVAS_H);
  } else {
    const vid = src.videoEl;
    if (!vid || vid.readyState < 2) return;
    _drawLetterboxed(ctx, vid, CANVAS_W, CANVAS_H);
  }
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
 * RPi 소스를 추가합니다. state.trackingCanvas가 있어야 합니다.
 */
export function addRpiSource() {
  if (!state.trackingCanvas) return null;
  if (state.sources.find((s) => s.type === "rpi")) return null; // 중복 방지

  const src = _makeSource({
    type: "rpi",
    label: "RPi 카메라",
    videoEl: state.trackingCanvas,
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
  const prev = state.sources.find((s) => s.id === state.selectedSourceId);
  if (prev && (prev.bgRemoval || prev.objectTracking)) {
    prev.bgRemoval = false;
    prev.objectTracking = false;
    _stopAiLoop(prev);
  }
  state.backgroundRemovalEnabled = false;
  state.objectTrackingEnabled = false;
  state.autoTrackingEnabled = false;

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
      } else if (src?.videoEl instanceof HTMLCanvasElement) {
        if (!src._displayStream) {
          src._displayStream = src.videoEl.captureStream(60);
        }
        originalVideo.srcObject = src._displayStream;
      } else {
        originalVideo.srcObject = state.masterStream;
      }
    }
    return;
  }

  const videoFeed = document.getElementById("main-video-feed");
  if (!videoFeed) return;
  videoFeed.srcObject = state.masterStream;
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
    src.bgCtx = src.bgCanvas.getContext("2d", { willReadFrequently: true });
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
  src.hiddenCanvas = null;
  src.hiddenCtx = null;
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

  // PID 데드존 시각화 (pid_controller.py: x_dead_zone=200@1280px, y_dead_zone=100@720px)
  const dzHalfW = 200 * w / 1280;
  const dzHalfH = 100 * h / 720;
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
  people.forEach((person, idx) => {
    const { x1, y1, x2, y2 } = person.box;
    const bx = x1 * sx;
    const by = y1 * sy;
    const bw = (x2 - x1) * sx;
    const bh = (y2 - y1) * sy;
    const cx = ((x1 + x2) / 2) * sx;
    const cy = ((y1 + y2) / 2) * sy;

    const isTarget = person.id === targetPersonId;
    const boxColor = isTarget ? "#00ff44" : "#ff9500";
    const labelBg = isTarget ? "rgba(0, 150, 40, 0.85)" : "rgba(180, 90, 0, 0.85)";

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
    const label = `사람 ${idx + 1}`;
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
  }

  // 출력 캔버스에 직접 그리면 AI 처리 시간 동안 원본 프레임이 1프레임 노출됩니다.
  // 임시 캔버스에 그려서 처리 성공 시에만 출력 캔버스에 반영합니다.
  if (!src.hiddenCanvas) {
    src.hiddenCanvas = document.createElement("canvas");
    src.hiddenCtx = src.hiddenCanvas.getContext("2d", { willReadFrequently: true, });
  }
  if (src.hiddenCanvas.width !== w || src.hiddenCanvas.height !== h) {
    src.hiddenCanvas.width = w;
    src.hiddenCanvas.height = h;
  }
  src.hiddenCtx.drawImage(vid, 0, 0, w, h);

  if (state.session && !state.sessionBusy) {
    try {
      state.sessionBusy = true;
      const MODEL_SIZE = 640;
      const tmp = document.createElement("canvas");
      tmp.width = MODEL_SIZE;
      tmp.height = MODEL_SIZE;
      tmp.getContext("2d").drawImage(vid, 0, 0, MODEL_SIZE, MODEL_SIZE);
      const tmpData = tmp.getContext("2d").getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

      const tensorData = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
      for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
        tensorData[i] = tmpData.data[i * 4] / 255;
        tensorData[MODEL_SIZE * MODEL_SIZE + i] = tmpData.data[i * 4 + 1] / 255;
        tensorData[2 * MODEL_SIZE * MODEL_SIZE + i] = tmpData.data[i * 4 + 2] / 255;
      }

      const inputTensor = new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE,]);
      const feeds = { [state.session.inputNames[0]]: inputTensor };
      const results = await state.session.run(feeds);

      // 추론 대기 중 소스가 변경되어 AI 처리가 중단된 경우 조기 종료
      if ((!src.bgRemoval && !src.objectTracking) || !src.bgCtx) {
        state.sessionBusy = false;
        return;
      }

      const frame = src.hiddenCtx.getImageData(0, 0, w, h);
      const imageData = frame;

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

        if (classId === 0 && score > 0.55) {
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

      // Object Panel 목록 갱신 (감지된 인원 수가 바뀔 때만)
      if (people.length !== state.detectedPeopleCount) {
        state.detectedPeopleCount = people.length;
        renderObjectList(people.length);
      }

      const TARGET_INDEX = state.targetPersonIndex;

      // 3. 타겟 추적 로직 (ID 기반)
      if (people.length > 0) {
        // UI에서 새 인덱스를 클릭해서 타겟 ID가 초기화되었거나 아직 설정되지 않은 경우
        if (state.targetPersonId === undefined || state.targetPersonId === null) {
          const idx = Math.min(TARGET_INDEX, people.length - 1);
          state.targetPersonId = people[idx].id; // 해당 위치(인덱스)에 있는 사람의 고유 ID를 캡처하여 고정
        }
      } else {
        // 화면에 아무도 없으면 타겟 ID 초기화
        state.targetPersonId = null;
      }

      let bestScore = -Infinity;
      let bestAnc = -1;
      let bestBox = null;

      // 고정된 targetPersonId와 일치하는 사람 찾기 (순서가 뒤바뀌어도 ID를 따라감)
      const targetPerson = people.find(p => p.id === state.targetPersonId);

      if (targetPerson) {
        bestScore = targetPerson.score;
        bestAnc = targetPerson.anc;
        bestBox = targetPerson.box;
      } else if (people.length > 0) {
        if (!globalTracker.isTrackAlive(state.targetPersonId)) {
          // 트래커가 완전히 삭제한 경우에만 fallback — ID 스왑 방지
          const fallbackIdx = Math.min(TARGET_INDEX, people.length - 1);
          bestScore = people[fallbackIdx].score;
          bestAnc = people[fallbackIdx].anc;
          bestBox = people[fallbackIdx].box;
          state.targetPersonId = people[fallbackIdx].id;
        }
        // 트래커가 아직 해당 ID를 기억 중(일시 소실)이면 이 프레임은 생략
      }

      const bestProb = bestScore;

      if (window._deepDiagDone) window._deepDiagDone = false;

      // 확률이 50% 이상이고 유효한 사람이 감지되었을 때만 처리
      if (bestProb > 0.5 && bestAnc >= 0) {
        // 객체추적이 켜져 있으면 좌표 전송
        if (state.autoTrackingEnabled) {
          const obj_x = ((bestBox.x1 + bestBox.x2) / 2) * (w / 640);
          const obj_y = ((bestBox.y1 + bestBox.y2) / 2) * (h / 640);
          sendObjectCoords(obj_x, obj_y);
        }

        // 배경 제거가 켜져 있을 때만 마스크 적용
        if (src.bgRemoval) {
          const bestCoeffs = new Float32Array(32);
          for (let c = 0; c < 32; c++) {
            bestCoeffs[c] = output0[bestAnc * NUM_CHANNELS + COEFF_START + c];
          }

          const mask160 = new Float32Array(160 * 160);
          for (let p = 0; p < 160 * 160; p++) {
            let sum = 0;
            for (let c = 0; c < 32; c++) {
              sum += bestCoeffs[c] * protos[c * 160 * 160 + p];
            }
            mask160[p] = 1 / (1 + Math.exp(-sum)); // sigmoid
          }

          // 박스 좌표를 160x160 마스크 스케일로 변환
          const bx1 = Math.floor(bestBox.x1 * (160 / 640));
          const by1 = Math.floor(bestBox.y1 * (160 / 640));
          const bx2 = Math.ceil(bestBox.x2 * (160 / 640));
          const by2 = Math.ceil(bestBox.y2 * (160 / 640));

          const imgW = imageData.width;
          const imgH = imageData.height;

          for (let y = 0; y < imgH; y++) {
            for (let x = 0; x < imgW; x++) {
              const mx = Math.floor((x / imgW) * 160);
              const my = Math.floor((y / imgH) * 160);

              if (mx < bx1 || mx > bx2 || my < by1 || my > by2 || mask160[my * 160 + mx] < 0.75) {
                imageData.data[(y * imgW + x) * 4 + 3] = 0;
              }
            }
          }
        }
      } else if (src.bgRemoval) {
        // 배경 제거 ON인데 사람 미감지 시 전체 투명
        const total = imageData.width * imageData.height;
        for (let i = 0; i < total; i++) {
          imageData.data[i * 4 + 3] = 0;
        }
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
      const fgCv = document.createElement("canvas");
      fgCv.width = w;
      fgCv.height = h;
      fgCv.getContext("2d").putImageData(frame, 0, 0);
      src.bgCtx.drawImage(fgCv, 0, 0);

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

function renderObjectList(count) {
  const list = document.getElementById("object-list");
  if (!list) return;
  list.innerHTML = "";

  if (count === 0) {
    const li = document.createElement("li");
    li.className = "object-item object-item-empty";
    li.textContent = "감지된 사람 없음";
    list.appendChild(li);
    return;
  }

  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.className =
      "object-item" + (i === state.targetPersonIndex ? " selected" : "");
    li.textContent = `사람 ${i + 1}`;
    li.addEventListener("click", () => {
      if (state.targetPersonIndex === i) return;
      state.targetPersonIndex = i;
      state.targetPersonId = null; // 인덱스가 변경되면 기존 ID 추적을 풀고, 다음 프레임에서 새로 ID를 캡처하게 함
      list.querySelectorAll(".object-item").forEach((el, idx) => el.classList.toggle("selected", idx === i));
    });
    list.appendChild(li);
  }
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
      if (!state.trackingCanvas) {
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
