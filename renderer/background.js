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
    state.session = await ort.InferenceSession.create(
      "segformer_person_mask.onnx",
      {
        executionProviders: ["webgpu", "webgl", "wasm"],
      },
    );
    const inputs = state.session.inputNames.join(", ");
    const outputs = state.session.outputNames.join(", ");
    console.log(`AI 모델 로드 완료. 입력: [${inputs}] / 출력: [${outputs}]`);

    let bar = document.getElementById("ai-debug-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ai-debug-bar";
      Object.assign(bar.style, {
        position: "fixed",
        top: "10px",
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "rgba(0,0,0,0.7)",
        color: "#fff",
        padding: "10px 20px",
        borderRadius: "5px",
        zIndex: "9999",
        fontFamily: "monospace",
      });
      document.body.appendChild(bar);
    }
    bar.innerHTML = `✅ AI Ready | In: ${inputs} | Out: ${outputs}`;
  } catch (error) {
    console.error("AI 모델 로드 실패:", error);
    alert(`AI 불러오기 실패:\n${error.message}`);
    let bar = document.getElementById("ai-debug-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ai-debug-bar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = `❌ AI 로드 오류: ${error.message}`;
    bar.style.backgroundColor = "rgba(255,0,0,0.7)";
  }
}

/**
 * 선택된 소스의 배경 제거를 토글합니다.
 * sources.js의 toggleBgRemovalForSelectedSource를 호출합니다.
 */
export function toggleBackgroundRemoval() {
  toggleBgRemovalForSelectedSource();
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
