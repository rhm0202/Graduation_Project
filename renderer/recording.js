/**
 * 녹화 관리 모듈
 * MediaRecorder 초기화, 녹화 시작/중지, 타이머 업데이트를 담당합니다.
 */
import { state, isElectron } from './state.js';

/**
 * MediaRecorder를 초기화하고 이벤트 핸들러를 설정합니다.
 */
export function setupMediaRecorder() {
  if (!state.mediaStream) return;

  const startRecordingBtn = document.getElementById('start-recording-btn');
  const recStatus = document.getElementById('rec-status');

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  try {
    state.mediaRecorder = new MediaRecorder(state.mediaStream, {
      mimeType: 'video/webm; codecs=vp9,opus',
    });
  } catch {
    console.warn('VP9 미지원, 기본 코덱으로 대체합니다.');
    state.mediaRecorder = new MediaRecorder(state.mediaStream);
  }

  state.mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0 && isElectron) {
      const buffer = await event.data.arrayBuffer();
      window.electronAPI.send('video-chunk', new Uint8Array(buffer));
    }
  };

  state.mediaRecorder.onstart = () => {
    if (isElectron) window.electronAPI.send('start-recording');
    if (startRecordingBtn) {
      startRecordingBtn.textContent = 'Stop Recording';
      startRecordingBtn.classList.add('recording');
    }
    state.isRecording = true;
    state.recStartTime = Date.now();
    if (recStatus) recStatus.classList.add('recording');
    state.recTimer = setInterval(updateRecTimer, 1000);
  };

  state.mediaRecorder.onstop = () => {
    if (isElectron) window.electronAPI.send('stop-recording');
    if (startRecordingBtn) {
      startRecordingBtn.textContent = 'Start Recording';
      startRecordingBtn.classList.remove('recording');
    }
    state.isRecording = false;
    clearInterval(state.recTimer);
    if (recStatus) {
      recStatus.classList.remove('recording');
      recStatus.textContent = 'REC: 00:00:00';
    }
  };
}

function updateRecTimer() {
  const recStatus = document.getElementById('rec-status');
  if (!recStatus) return;
  const seconds = Math.floor((Date.now() - state.recStartTime) / 1000);
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  recStatus.textContent = `REC: ${h}:${m}:${s}`;
}

/**
 * 녹화 버튼 이벤트 리스너를 초기화합니다.
 */
export function setupRecordingControls() {
  const startRecordingBtn = document.getElementById('start-recording-btn');
  startRecordingBtn?.addEventListener('click', () => {
    if (!state.mediaRecorder) { console.error('MediaRecorder 초기화 실패'); return; }
    if (state.isRecording) state.mediaRecorder.stop();
    else state.mediaRecorder.start(1000);
  });
}
