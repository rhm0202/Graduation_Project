/**
 * 미디어 스트림 관리 모듈
 * 카메라/마이크 장치 목록 조회, 스트림 시작/중지, 오류 처리를 담당합니다.
 */
import { state } from './state.js';
import { setupAudioProcessing } from './audio.js';
import { setupMediaRecorder } from './recording.js';
import { saveSettings } from './settings.js';

/**
 * 사용 가능한 비디오/오디오 입력 장치 목록을 가져와 드롭다운에 추가합니다.
 */
export async function getDevices() {
  const videoSelect = document.getElementById('video-source');
  const audioSelect = document.getElementById('audio-source');
  let tempStream = null;

  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();

    videoSelect.innerHTML = '';
    audioSelect.innerHTML = '';

    const videoDefault = document.createElement('option');
    videoDefault.value = '';
    videoDefault.text = '카메라 선택...';
    videoSelect.appendChild(videoDefault);

    const audioDefault = document.createElement('option');
    audioDefault.value = '';
    audioDefault.text = '마이크 선택...';
    audioSelect.appendChild(audioDefault);

    let videoCount = 0;
    let audioCount = 0;

    devices.forEach((device) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      if (device.kind === 'videoinput') {
        videoCount++;
        option.text = device.label || `카메라 ${videoCount}`;
        videoSelect.appendChild(option);
      } else if (device.kind === 'audioinput') {
        audioCount++;
        option.text = device.label || `마이크 ${audioCount}`;
        audioSelect.appendChild(option);
      }
    });

    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    console.log(`장치 목록 로드 완료: 카메라 ${videoCount}개, 마이크 ${audioCount}개`);
  } catch (err) {
    console.error('장치 목록을 가져오는 중 오류 발생:', err);
    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    videoSelect.innerHTML = '<option value="">카메라를 찾을 수 없음</option>';
    audioSelect.innerHTML = '<option value="">마이크를 찾을 수 없음</option>';
  }
}

/**
 * 선택된 비디오/오디오 장치로 미디어 스트림을 시작합니다.
 * @param {string} [videoDeviceId]
 * @param {string} [audioDeviceId]
 */
export async function startStream(videoDeviceId, audioDeviceId) {
  const startRecordingBtn = document.getElementById('start-recording-btn');
  const videoSelect = document.getElementById('video-source');
  const audioSelect = document.getElementById('audio-source');

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
  }

  const resolution = document.getElementById('video-resolution')?.value || 'auto';
  const framerate = document.getElementById('video-framerate')?.value || 'auto';

  let videoConstraints = {};
  if (videoDeviceId?.trim()) videoConstraints.deviceId = { exact: videoDeviceId };
  if (resolution === '1080p') { videoConstraints.width = { ideal: 1920 }; videoConstraints.height = { ideal: 1080 }; }
  else if (resolution === '720p') { videoConstraints.width = { ideal: 1280 }; videoConstraints.height = { ideal: 720 }; }
  if (framerate !== 'auto') videoConstraints.frameRate = { ideal: parseInt(framerate, 10) };

  let audioConstraints = {};
  if (audioDeviceId?.trim()) audioConstraints.deviceId = { exact: audioDeviceId };

  const constraints = {
    video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true,
    audio: Object.keys(audioConstraints).length > 0 ? audioConstraints : true,
  };

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    updateVideoDisplay(state.mediaStream);
    setupAudioProcessing(state.mediaStream);
    setupMediaRecorder();
    if (startRecordingBtn) startRecordingBtn.disabled = false;

    const videoTrack = state.mediaStream.getVideoTracks()[0];
    const audioTrack = state.mediaStream.getAudioTracks()[0];
    if (videoTrack && videoSelect) videoSelect.value = videoTrack.getSettings().deviceId || '';
    if (audioTrack && audioSelect) audioSelect.value = audioTrack.getSettings().deviceId || '';
  } catch (err) {
    console.error('미디어 장치 접근 오류:', err);
    handleMediaError(err);
    if (startRecordingBtn) startRecordingBtn.disabled = true;
  }
}

/**
 * 비디오 표시를 업데이트합니다 (일반 모드 또는 비교 모드).
 * @param {MediaStream} stream
 */
export function updateVideoDisplay(stream) {
  const videoFeed = document.getElementById('main-video-feed');
  const comparisonContainer = document.getElementById('comparison-container');
  const originalVideo = document.getElementById('original-video');
  const processedVideo = document.getElementById('processed-video');

  if (state.comparisonMode && comparisonContainer) {
    comparisonContainer.classList.add('active');
    if (videoFeed) videoFeed.style.display = 'none';
    if (originalVideo) originalVideo.srcObject = stream.clone();
    if (processedVideo) {
      processedVideo.srcObject =
        state.backgroundRemovalEnabled && state.processedStream
          ? state.processedStream
          : stream;
    }
  } else {
    comparisonContainer?.classList.remove('active');
    if (videoFeed) {
      videoFeed.style.display = 'block';
      videoFeed.srcObject =
        state.backgroundRemovalEnabled && state.processedStream
          ? state.processedStream
          : stream;
    }
  }
}

/**
 * 미디어 장치 접근 오류를 처리합니다.
 * @param {Error} error
 */
export function handleMediaError(error) {
  const videoSelect = document.getElementById('video-source');
  const audioSelect = document.getElementById('audio-source');
  const errorName = error.name || 'UnknownError';
  let errorMessage = '';
  let showRetry = true;
  let showSettings = false;

  switch (errorName) {
    case 'NotAllowedError':
      errorMessage = '카메라/마이크 접근이 거부되었습니다.\n\n브라우저 설정에서 권한을 허용해주세요.\n(주소창 왼쪽 자물쇠 아이콘 클릭 → 권한 허용)';
      showSettings = true;
      break;
    case 'NotFoundError':
      errorMessage = '카메라/마이크를 찾을 수 없습니다.\n\n장치가 연결되어 있는지 확인해주세요.';
      break;
    case 'NotReadableError':
      errorMessage = '카메라/마이크가 다른 프로그램에서 사용 중입니다.\n\n다른 프로그램을 종료한 후 다시 시도해주세요.';
      break;
    case 'OverconstrainedError':
      errorMessage = '선택한 해상도/프레임레이트를 지원하지 않습니다.\n\n설정에서 다른 해상도나 프레임레이트를 선택해주세요.';
      showSettings = true;
      showRetry = false;
      break;
    case 'TypeError':
      errorMessage = '미디어 장치에 접근할 수 없습니다.\n\n장치가 올바르게 연결되어 있는지 확인해주세요.';
      break;
    default:
      errorMessage = `카메라/마이크 접근 중 오류가 발생했습니다.\n\n오류 코드: ${errorName}\n${error.message || ''}`;
  }

  const videoFeed = document.getElementById('main-video-feed');
  if (videoFeed) videoFeed.style.backgroundColor = '#330000';

  const sourcesContent = document.getElementById('sources-content');
  if (sourcesContent) {
    sourcesContent.innerHTML = `<p style="color: #f44; padding: 20px; text-align: center;">${errorMessage.replace(/\n/g, '<br>')}</p>`;
  }

  showErrorModal(errorMessage, showRetry, showSettings, () => {
    startStream(videoSelect?.value, audioSelect?.value);
  });
}

/**
 * 에러 모달을 표시합니다.
 */
export function showErrorModal(message, showRetry, showSettings, retryCallback) {
  const errorModal = document.getElementById('error-modal');
  const errorMessage = document.getElementById('error-message');
  const retryBtn = document.getElementById('error-retry-btn');
  const settingsBtn = document.getElementById('error-settings-btn');
  const closeBtn = document.getElementById('error-close-btn');

  if (!errorModal || !errorMessage) return;

  errorMessage.textContent = message;

  if (retryBtn) {
    retryBtn.style.display = showRetry ? 'inline-block' : 'none';
    retryBtn.onclick = () => { retryCallback?.(); errorModal.style.display = 'none'; };
  }
  if (settingsBtn) {
    settingsBtn.style.display = showSettings ? 'inline-block' : 'none';
    settingsBtn.onclick = () => {
      errorModal.style.display = 'none';
      document.getElementById('settings-modal')?.classList.add('visible');
    };
  }
  if (closeBtn) {
    closeBtn.onclick = () => { errorModal.style.display = 'none'; };
  }

  errorModal.style.display = 'flex';
}

/**
 * 비디오/오디오 장치 변경 이벤트 리스너를 초기화합니다.
 */
export function setupMediaControls() {
  const videoSelect = document.getElementById('video-source');
  const audioSelect = document.getElementById('audio-source');
  const resolutionSelect = document.getElementById('video-resolution');
  const framerateSelect = document.getElementById('video-framerate');

  videoSelect?.addEventListener('change', (e) => {
    startStream(e.target.value, audioSelect?.value);
    saveSettings();
  });

  audioSelect?.addEventListener('change', (e) => {
    startStream(videoSelect?.value, e.target.value);
    saveSettings();
  });

  resolutionSelect?.addEventListener('change', () => {
    startStream(videoSelect?.value, audioSelect?.value);
    saveSettings();
  });

  framerateSelect?.addEventListener('change', () => {
    startStream(videoSelect?.value, audioSelect?.value);
    saveSettings();
  });
}
