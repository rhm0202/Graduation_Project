/**
 * AI 배경 제거 모듈
 * ONNX 모델 로드 및 전역 배경 설정을 담당합니다.
 * 실제 배경 제거 루프는 sources.js의 per-source _bgLoop에서 처리됩니다.
 */
import { state } from "./state.js";
import { updateVideoDisplay } from "./media.js";
import { toggleBgRemovalForSelectedSource } from "./sources.js";

/**
 * ONNX AI 모델을 로드합니다.
 */
export async function loadModel() {
  try {
    console.log("AI 모델 로딩 중");
    // 매팅은 wasm 에서 돌기 때문에 스레드 수가 곧 속도입니다. 단일 스레드면
    // 같은 모델이 Node 대비 5 배 느려집니다.
    const threads = typeof SharedArrayBuffer !== "undefined"
      ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.simd = true;
    console.log(`[ORT] wasm threads=${threads} simd=true `
      + `SharedArrayBuffer=${typeof SharedArrayBuffer !== "undefined"} `
      + `crossOriginIsolated=${globalThis.crossOriginIsolated}`);
    const providers = ["webgpu", "webgl", "wasm"];
    // 검출기는 박스와 ID 만 담당합니다. 마스크를 RVM 이 맡으므로 nano 로 충분하고,
    // 같은 프레임에서 person 검출률은 large 와 동일했습니다(15/15).
    state.session = await ort.InferenceSession.create(
      "AI_models//yolo26n-seg.onnx", { executionProviders: providers });
    console.log(`검출 모델 로드 완료. 입력: [${state.session.inputNames}] / 출력: [${state.session.outputNames}]`);

    // RobustVideoMatting: 전경 인물을 통째로 뽑습니다. COCO person 마스크와 달리
    // 들고 있는 물건을 포함하고, 알파가 입력 해상도로 나와 손끝이 뭉개지지 않습니다.
    // WebGPU 백엔드는 RVM 의 AveragePool(ceil_mode) 을 지원하지 않아 추론이
    // 실패하고, 그 실패가 같은 백엔드를 쓰는 검출 세션까지 망가뜨립니다.
    // 매팅은 wasm 에 고정해 백엔드를 분리합니다.
    state.mattingSession = await ort.InferenceSession.create(
      "AI_models//rvm_mobilenetv3_fp32.onnx", { executionProviders: ["wasm"] });
    console.log(`매팅 모델 로드 완료. 입력: [${state.mattingSession.inputNames}]`);

    const pill = document.getElementById('ai-status-pill');
    const pillText = document.getElementById('ai-pill-text');
    if (pillText) pillText.textContent = 'AI Ready';
    if (pill) pill.classList.remove('loading');

  } catch (error) {
    console.error("AI 모델 로드 실패:", error);
    alert(`AI 불러오기 실패:\n${error.message}`);
  }
}

/**
 * 선택된 소스의 배경 제거를 토글합니다.
 * sources.js의 toggleBgRemovalForSelectedSource를 호출합니다.
 */
export function toggleBackgroundRemoval() {
  toggleBgRemovalForSelectedSource();
  // 비교 모드에서 processedVideo가 bgCanvas 스트림을 캐싱하므로,
  // 배경 제거 ON/OFF 시 즉시 갱신해야 후 화면이 정확히 동기화됨
  if (state.comparisonMode) {
    updateVideoDisplay();
  }
}

/**
 * 전/후 비교 모드를 토글합니다.
 */
export function toggleComparison() {
  state.comparisonMode = !state.comparisonMode;
  const btn = document.getElementById("toggle-comparison");
  if (btn) {
    btn.textContent = state.comparisonMode
      ? "전/후 비교 숨기기"
      : "전/후 비교 보기";
    btn.classList.toggle("recording", state.comparisonMode);
  }
  updateVideoDisplay();
}

/**
 * 배경 교체 모달 이벤트 리스너를 초기화합니다.
 * 선택한 배경은 state.backgroundImage / backgroundVideo / bgColor에 저장되며,
 * sources.js의 _bgLoop에서 배경 제거된 소스에 자동 적용됩니다.
 */
export function setupBackgroundReplaceModal() {
  const modal = document.getElementById("background-replace-modal");
  const closeBtn = document.getElementById("background-replace-close");
  const applyBtn = document.getElementById("background-replace-apply");
  const imageFile = document.getElementById("background-image-file");
  const videoFile = document.getElementById("background-video-file");
  const colorPicker = document.getElementById("background-color-picker");
  const imageOption = document.getElementById("background-image-option");
  const videoOption = document.getElementById("background-video-option");
  const colorOption = document.getElementById("background-color-option");

  if (!modal) return;

  document
    .querySelectorAll('input[name="background-type"]')
    .forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const t = e.target.value;
        if (imageOption)
          imageOption.style.display = t === "image" ? "block" : "none";
        if (videoOption)
          videoOption.style.display = t === "video" ? "block" : "none";
        if (colorOption)
          colorOption.style.display = t === "color" ? "block" : "none";
      });
    });

  imageFile?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        state.backgroundImage = img;
        state.backgroundVideo = null;
        state.bgColor = null;
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  videoFile?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const v = document.createElement("video");
    v.src = URL.createObjectURL(file);
    v.autoplay = true;
    v.loop = true;
    v.muted = true;
    state.backgroundVideo = v;
    state.backgroundImage = null;
    state.bgColor = null;
  });

  applyBtn?.addEventListener("click", () => {
    const type = document.querySelector(
      'input[name="background-type"]:checked',
    )?.value;
    if (type === "none") {
      state.backgroundImage = null;
      state.backgroundVideo = null;
      state.bgColor = null;
    } else if (type === "color" && colorPicker) {
      state.bgColor = colorPicker.value;
      state.backgroundImage = null;
      state.backgroundVideo = null;
    }
    modal.classList.remove("visible");
  });

  closeBtn?.addEventListener("click", () => modal.classList.remove("visible"));
}
