/**
 * 미디어 스트림 관리 모듈
 * 카메라/마이크 장치 목록 조회, 스트림 시작, 오류 처리를 담당합니다.
 * 영상 출력은 sources.js의 마스터 캔버스 컴포지터가 담당합니다.
 */
import { state } from "./state.js";
import { setupAudioProcessing } from "./audio.js";
import { saveSettings } from "./settings.js";
import { addWebcamSource } from "./sources.js";

/**
 * 사용 가능한 비디오/오디오 입력 장치 목록을 가져와 설정 모달 드롭다운에 추가합니다.
 */
export async function getDevices() {
  const videoSelect = document.getElementById("video-source");
  const audioSelect = document.getElementById("audio-source");
  let tempStream = null;

  try {
    tempStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    const devices = await navigator.mediaDevices.enumerateDevices();

    videoSelect.innerHTML = "";
    audioSelect.innerHTML = "";

    const videoDefault = document.createElement("option");
    videoDefault.value = "";
    videoDefault.text = "카메라 선택...";
    videoSelect.appendChild(videoDefault);

    const audioDefault = document.createElement("option");
    audioDefault.value = "";
    audioDefault.text = "마이크 선택...";
    audioSelect.appendChild(audioDefault);

    let vc = 0,
      ac = 0;
    devices.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      if (d.kind === "videoinput") {
        vc++;
        opt.text = d.label || `카메라 ${vc}`;
        videoSelect.appendChild(opt);
      } else if (d.kind === "audioinput") {
        ac++;
        opt.text = d.label || `마이크 ${ac}`;
        audioSelect.appendChild(opt);
      }
    });

    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());

    // 윈도우 환경에서 카메라 하드웨어 버퍼가 완전히 해제될 때까지 잠시 대기
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (err) {
    console.error("장치 목록 조회 오류:", err);
    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    if (videoSelect)
      videoSelect.innerHTML = '<option value="">카메라를 찾을 수 없음</option>';
    if (audioSelect)
      audioSelect.innerHTML = '<option value="">마이크를 찾을 수 없음</option>';
  }
}

/**
 * 선택된 장치로 스트림을 시작합니다.
 * sources.js의 addWebcamSource를 통해 마스터 캔버스에 반영됩니다.
 * @param {string} [videoDeviceId]
 * @param {string} [audioDeviceId]
 */
export async function startStream(videoDeviceId, audioDeviceId) {
  const videoSelect = document.getElementById("video-source");
  const audioSelect = document.getElementById("audio-source");
  const startRecordingBtn = document.getElementById("start-recording-btn");

  // 오디오 전용 스트림 (믹서용)
  try {
    const audioConstraints = audioDeviceId?.trim()
      ? { deviceId: { exact: audioDeviceId } }
      : true;
    const audioStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: audioConstraints,
    });
    setupAudioProcessing(audioStream);
  } catch (e) {
    console.warn("오디오 스트림 초기화 오류:", e);
  }

  // 웹캠 소스 추가 (sources.js — 마스터 캔버스에 합성됨)
  const src = await addWebcamSource(videoDeviceId, null);

  if (src) {
    if (startRecordingBtn) startRecordingBtn.disabled = false;
    const videoTrack = src.stream?.getVideoTracks()[0];
    const audioTrack = src.stream?.getAudioTracks()[0];
    if (videoTrack && videoSelect)
      videoSelect.value = videoTrack.getSettings().deviceId || "";
    if (audioTrack && audioSelect)
      audioSelect.value = audioTrack.getSettings().deviceId || "";
  } else {
    if (startRecordingBtn) startRecordingBtn.disabled = true;
  }
}

/**
 * 현재 화면에 표시되는 스트림을 반환합니다 (= masterStream).
 */
export function getDisplayStream() {
  return state.masterStream ?? state.displayStream;
}

/**
 * 비디오 표시를 업데이트합니다.
 * 마스터 캔버스가 초기화된 경우 항상 masterStream을 사용합니다.
 */
export function updateVideoDisplay() {
  const stream = state.masterStream ?? state.activeStream;
  if (!stream) return;
  state.displayStream = stream;

  const videoFeed = document.getElementById("main-video-feed");
  const comparisonContainer = document.getElementById("comparison-container");

  if (state.comparisonMode && comparisonContainer) {
    comparisonContainer.classList.add("active");
    if (videoFeed) videoFeed.style.display = "none";
    // 비교 모드: 원본(선택 소스 raw) vs 처리 후(masterStream)
    const selected = state.sources?.find(
      (s) => s.id === state.selectedSourceId,
    );
    const originalVideo = document.getElementById("original-video");
    const processedVideo = document.getElementById("processed-video");
    if (originalVideo) {
      if (selected?.stream) {
        originalVideo.srcObject = selected.stream;
      } else if (selected?.videoEl instanceof HTMLCanvasElement) {
        // RPi 소스는 stream 없이 캔버스에 직접 그리므로 captureStream으로 원본 표시
        if (!selected._displayStream) {
          selected._displayStream = selected.videoEl.captureStream(30);
        }
        originalVideo.srcObject = selected._displayStream;
      } else {
        originalVideo.srcObject = stream;
      }
    }
    if (processedVideo) processedVideo.srcObject = stream;
  } else {
    comparisonContainer?.classList.remove("active");
    if (videoFeed) {
      videoFeed.style.display = "block";
      videoFeed.srcObject = stream;
    }
  }

  document.dispatchEvent(new CustomEvent("displayStreamChanged"));
}

/**
 * 미디어 장치 접근 오류를 처리합니다.
 */
export function handleMediaError(error) {
  const videoSelect = document.getElementById("video-source");
  const audioSelect = document.getElementById("audio-source");
  const errorName = error.name || "UnknownError";
  let msg = "";
  let showRetry = true;
  let showSettings = false;

  switch (errorName) {
    case "NotAllowedError":
      msg = "카메라/마이크 접근이 거부되었습니다.";
      showSettings = true;
      break;
    case "NotFoundError":
      msg = "카메라/마이크를 찾을 수 없습니다.";
      break;
    case "NotReadableError":
      msg = "카메라/마이크가 다른 프로그램에서 사용 중입니다.";
      break;
    case "OverconstrainedError":
      msg = "선택한 해상도/프레임레이트를 지원하지 않습니다.";
      showSettings = true;
      showRetry = false;
      break;
    default:
      msg = `카메라/마이크 접근 오류: ${errorName}\n${error.message || ""}`;
  }

  showErrorModal(msg, showRetry, showSettings, () =>
    startStream(videoSelect?.value, audioSelect?.value),
  );
}

/**
 * 에러 모달을 표시합니다.
 */
export function showErrorModal(
  message,
  showRetry,
  showSettings,
  retryCallback,
) {
  const errorModal = document.getElementById("error-modal");
  const errorMessage = document.getElementById("error-message");
  const retryBtn = document.getElementById("error-retry-btn");
  const settingsBtn = document.getElementById("error-settings-btn");
  const closeBtn = document.getElementById("error-close-btn");
  if (!errorModal || !errorMessage) return;

  errorMessage.textContent = message;
  if (retryBtn) {
    retryBtn.style.display = showRetry ? "inline-block" : "none";
    retryBtn.onclick = () => {
      retryCallback?.();
      errorModal.style.display = "none";
    };
  }
  if (settingsBtn) {
    settingsBtn.style.display = showSettings ? "inline-block" : "none";
    settingsBtn.onclick = () => {
      errorModal.style.display = "none";
      document.getElementById("settings-modal")?.classList.add("visible");
    };
  }
  if (closeBtn) {
    closeBtn.onclick = () => {
      errorModal.style.display = "none";
    };
  }
  errorModal.style.display = "flex";
}

/**
 * 비디오/오디오 장치 변경 이벤트 리스너를 초기화합니다.
 */
export function setupMediaControls() {
  const videoSelect = document.getElementById("video-source");
  const audioSelect = document.getElementById("audio-source");
  const resolutionSelect = document.getElementById("video-resolution");
  const framerateSelect = document.getElementById("video-framerate");

  videoSelect?.addEventListener("change", (e) => {
    startStream(e.target.value, audioSelect?.value);
    saveSettings();
  });
  audioSelect?.addEventListener("change", (e) => {
    startStream(videoSelect?.value, e.target.value);
    saveSettings();
  });
  resolutionSelect?.addEventListener("change", () => {
    startStream(videoSelect?.value, audioSelect?.value);
    saveSettings();
  });
  framerateSelect?.addEventListener("change", () => {
    startStream(videoSelect?.value, audioSelect?.value);
    saveSettings();
  });
}

// ─── 이전 버전 호환 (sources.js 없이 media.js만 쓰던 코드용) ───
/** @deprecated sources.js의 addCameraOption 사용 */
export function addCameraOption() {}
/** @deprecated sources.js의 removeCameraOption 사용 */
export function removeCameraOption() {}
/** @deprecated media.js의 populateCameraSelect/setupCameraSelect는 sources.js 패널로 대체됨 */
export function populateCameraSelect() {}
export function setupCameraSelect() {}
