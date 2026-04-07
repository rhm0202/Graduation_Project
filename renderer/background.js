/**
 * AI 배경 제거 모듈
 * ONNX Runtime을 사용한 SegFormer 기반 실시간 배경 제거 및 배경 교체를 담당합니다.
 */
import { state, MODEL_SIZE } from './state.js';
import { updateVideoDisplay } from './media.js';

// 배경 제거용 오프스크린 캔버스 (MODEL_SIZE x MODEL_SIZE)
const modelCanvas = document.createElement('canvas');
modelCanvas.width = MODEL_SIZE;
modelCanvas.height = MODEL_SIZE;

/**
 * ONNX AI 모델을 로드합니다.
 */
export async function loadModel() {
  try {
    console.log('AI 모델 로딩 중');
    state.session = await ort.InferenceSession.create('segformer_person_mask.onnx', {
      executionProviders: ['webgpu', 'webgl', 'wasm'],
    });

    const inputs = state.session.inputNames.join(', ');
    const outputs = state.session.outputNames.join(', ');
    console.log(`AI 모델 로드 성공! 입력: [${inputs}] / 출력: [${outputs}]`);

    let debugBar = document.getElementById('ai-debug-bar');
    if (!debugBar) {
      debugBar = document.createElement('div');
      debugBar.id = 'ai-debug-bar';
      Object.assign(debugBar.style, {
        position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)',
        backgroundColor: 'rgba(0,0,0,0.7)', color: '#fff', padding: '10px 20px',
        borderRadius: '5px', zIndex: '9999', fontFamily: 'monospace',
      });
      document.body.appendChild(debugBar);
    }
    debugBar.innerHTML = `✅ AI Ready (GPU Enabled) | In: ${inputs} | Out: ${outputs}`;
  } catch (error) {
    console.error('AI 모델 로드 실패:', error);
    alert(`AI 불러오기 실패:\n${error.message}`);

    let debugBar = document.getElementById('ai-debug-bar');
    if (!debugBar) {
      debugBar = document.createElement('div');
      debugBar.id = 'ai-debug-bar';
      document.body.appendChild(debugBar);
    }
    debugBar.innerHTML = `❌ AI 로드 오류: ${error.message}`;
    debugBar.style.backgroundColor = 'rgba(255,0,0,0.7)';
  }
}

/**
 * 배경 제거 기능을 토글합니다.
 */
export function toggleBackgroundRemoval() {
  state.backgroundRemovalEnabled = !state.backgroundRemovalEnabled;
  const btn = document.getElementById('toggle-background-removal');
  if (btn) {
    btn.textContent = `배경 제거: ${state.backgroundRemovalEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('recording', state.backgroundRemovalEnabled);
  }

  if (state.backgroundRemovalEnabled) {
    startBackgroundRemoval();
  } else {
    stopBackgroundRemoval();
    if (state.mediaStream) updateVideoDisplay(state.mediaStream);
  }
}

function startBackgroundRemoval() {
  if (!state.mediaStream) return;

  if (!state.backgroundCanvas) {
    state.backgroundCanvas = modelCanvas;
    state.backgroundCtx = state.backgroundCanvas.getContext('2d', { willReadFrequently: true });
  }

  const videoTrack = state.mediaStream.getVideoTracks()[0];
  if (!videoTrack) return;

  const tempVideo = document.createElement('video');
  tempVideo.srcObject = state.mediaStream;
  tempVideo.autoplay = true;
  tempVideo.muted = true;
  tempVideo.playsInline = true;

  tempVideo.addEventListener('loadedmetadata', () => {
    state.backgroundCanvas.width = tempVideo.videoWidth || 640;
    state.backgroundCanvas.height = tempVideo.videoHeight || 480;
    state.processedStream = state.backgroundCanvas.captureStream(30);
    state.mediaStream.getAudioTracks().forEach((t) => state.processedStream.addTrack(t));
    AiProcessBackgroundRemoval(tempVideo);
    if (state.mediaStream) updateVideoDisplay(state.mediaStream);
  });
}

function stopBackgroundRemoval() {
  if (state.backgroundAnimationFrame) {
    cancelAnimationFrame(state.backgroundAnimationFrame);
    state.backgroundAnimationFrame = null;
  }
  if (state.processedStream) {
    state.processedStream.getTracks().forEach((track) => {
      if (!state.mediaStream?.getTracks().find((t) => t.id === track.id)) track.stop();
    });
    state.processedStream = null;
  }
}

async function AiProcessBackgroundRemoval(video) {
  if (!state.backgroundRemovalEnabled || !state.backgroundCtx) return;

  if (!window.hiddenProcessCanvas) {
    window.hiddenProcessCanvas = document.createElement('canvas');
    window.hiddenProcessCtx = window.hiddenProcessCanvas.getContext('2d', { willReadFrequently: true });
  }
  const hCanvas = window.hiddenProcessCanvas;
  const hCtx = window.hiddenProcessCtx;

  if (hCanvas.width !== state.backgroundCanvas.width || hCanvas.height !== state.backgroundCanvas.height) {
    hCanvas.width = state.backgroundCanvas.width;
    hCanvas.height = state.backgroundCanvas.height;
  }

  hCtx.drawImage(video, 0, 0, hCanvas.width, hCanvas.height);
  let imageData = hCtx.getImageData(0, 0, hCanvas.width, hCanvas.height);
  let processSuccess = false;

  if (state.session) {
    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = MODEL_SIZE;
      tempCanvas.height = MODEL_SIZE;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.drawImage(video, 0, 0, MODEL_SIZE, MODEL_SIZE);
      const imgData = tempCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

      const tensorData = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
      for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
        tensorData[i] = imgData.data[i * 4] / 255.0;
        tensorData[MODEL_SIZE * MODEL_SIZE + i] = imgData.data[i * 4 + 1] / 255.0;
        tensorData[2 * MODEL_SIZE * MODEL_SIZE + i] = imgData.data[i * 4 + 2] / 255.0;
      }

      const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
      const feeds = { [state.session.inputNames[0]]: inputTensor };
      const output = await state.session.run(feeds);
      const outputData = output[state.session.outputNames[0]].data;

      for (let y = 0; y < state.backgroundCanvas.height; y++) {
        for (let x = 0; x < state.backgroundCanvas.width; x++) {
          const maskX = Math.floor((x / state.backgroundCanvas.width) * MODEL_SIZE);
          const maskY = Math.floor((y / state.backgroundCanvas.height) * MODEL_SIZE);
          if (outputData[maskY * MODEL_SIZE + maskX] < 0.5) {
            imageData.data[(y * state.backgroundCanvas.width + x) * 4 + 3] = 0;
          }
        }
      }
      processSuccess = true;
    } catch (error) {
      console.error('AI 세그멘테이션 추론 오류:', error);
      const debugBar = document.getElementById('ai-debug-bar');
      if (debugBar) {
        debugBar.innerHTML = `❌ 추론 오류: ${error.message}`;
        debugBar.style.backgroundColor = 'rgba(255,0,0,0.7)';
      }
    }
  }

  if (processSuccess || !state.session) {
    if (state.backgroundImage || state.backgroundVideo) {
      state.backgroundCtx.clearRect(0, 0, state.backgroundCanvas.width, state.backgroundCanvas.height);
      if (state.backgroundImage) {
        state.backgroundCtx.drawImage(state.backgroundImage, 0, 0, state.backgroundCanvas.width, state.backgroundCanvas.height);
      } else if (state.backgroundVideo) {
        state.backgroundCtx.drawImage(state.backgroundVideo, 0, 0, state.backgroundCanvas.width, state.backgroundCanvas.height);
      }
      const fgCanvas = document.createElement('canvas');
      fgCanvas.width = state.backgroundCanvas.width;
      fgCanvas.height = state.backgroundCanvas.height;
      fgCanvas.getContext('2d').putImageData(imageData, 0, 0);
      state.backgroundCtx.drawImage(fgCanvas, 0, 0);
    } else {
      state.backgroundCtx.putImageData(imageData, 0, 0);
    }
  }

  state.backgroundAnimationFrame = requestAnimationFrame(() => AiProcessBackgroundRemoval(video));
}

/**
 * 전/후 비교 모드를 토글합니다.
 */
export function toggleComparison() {
  state.comparisonMode = !state.comparisonMode;
  const btn = document.getElementById('toggle-comparison');
  if (btn) {
    btn.textContent = state.comparisonMode ? '전/후 비교 숨기기' : '전/후 비교 보기';
    btn.classList.toggle('recording', state.comparisonMode);
  }
  if (state.mediaStream) updateVideoDisplay(state.mediaStream);
}

/**
 * 배경 교체 모달 이벤트 리스너를 초기화합니다.
 */
export function setupBackgroundReplaceModal() {
  const modal = document.getElementById('background-replace-modal');
  const closeBtn = document.getElementById('background-replace-close');
  const applyBtn = document.getElementById('background-replace-apply');
  const imageFile = document.getElementById('background-image-file');
  const videoFile = document.getElementById('background-video-file');
  const colorPicker = document.getElementById('background-color-picker');
  const imageOption = document.getElementById('background-image-option');
  const videoOption = document.getElementById('background-video-option');
  const colorOption = document.getElementById('background-color-option');

  if (!modal) return;

  document.querySelectorAll('input[name="background-type"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const type = e.target.value;
      if (imageOption) imageOption.style.display = type === 'image' ? 'block' : 'none';
      if (videoOption) videoOption.style.display = type === 'video' ? 'block' : 'none';
      if (colorOption) colorOption.style.display = type === 'color' ? 'block' : 'none';
    });
  });

  imageFile?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => { state.backgroundImage = img; };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  videoFile?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    state.backgroundVideo = video;
  });

  applyBtn?.addEventListener('click', () => {
    const selectedType = document.querySelector('input[name="background-type"]:checked')?.value;
    if (selectedType === 'none') {
      state.backgroundImage = null;
      state.backgroundVideo = null;
    } else if (selectedType === 'color' && colorPicker && state.backgroundCanvas && state.backgroundCtx) {
      state.backgroundCtx.fillStyle = colorPicker.value;
      state.backgroundCtx.fillRect(0, 0, state.backgroundCanvas.width, state.backgroundCanvas.height);
    }
    modal.classList.remove('visible');
  });

  closeBtn?.addEventListener('click', () => modal.classList.remove('visible'));
}
