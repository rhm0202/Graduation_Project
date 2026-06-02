/**
 * 녹화 관리 모듈
 * masterStream(마스터 캔버스 출력)을 녹화합니다.
 * displayStreamChanged 이벤트로 스트림 교체 시 자동 갱신합니다.
 */
import { state, isElectron } from './state.js';

/**
 * MediaRecorder를 masterStream으로 초기화합니다.
 * 녹화 중에는 갱신하지 않습니다.
 */
export function setupMediaRecorder() {
  const stream = state.masterStream ?? state.displayStream ?? state.mediaStream;
  if (!stream || state.isRecording) return;

  const startBtn = document.getElementById('start-recording-btn');
  const recStatus = document.getElementById('rec-status');

  if (state.mediaRecorder?.state !== 'inactive') state.mediaRecorder?.stop();

  try {
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9,opus' });
    console.log('[Recording] MediaRecorder 초기화 성공 (VP9 코덱)');
  } catch {
    console.warn('[Recording] VP9 미지원 — 기본 코덱 사용');
    state.mediaRecorder = new MediaRecorder(stream);
    console.log('[Recording] MediaRecorder 초기화 성공 (기본 코덱)');
  }

  state.mediaRecorder.ondataavailable = async e => {
    if (e.data.size > 0 && isElectron) {
      const buf = await e.data.arrayBuffer();
      window.electronAPI.send('video-chunk', new Uint8Array(buf));
    }
  };

  state.mediaRecorder.onstart = () => {
    console.log('[Recording] 녹화가 시작되었습니다.');
    if (isElectron) window.electronAPI.send('start-recording');
    if (startBtn) { startBtn.textContent = '■ STOP'; startBtn.classList.add('recording'); }
    state.isRecording = true;
    state.recStartTime = Date.now();
    recStatus?.classList.add('recording');
    state.recTimer = setInterval(_updateTimer, 1000);
  };

  state.mediaRecorder.onstop = () => {
    console.log('[Recording] 녹화가 중지되었습니다.');
    if (isElectron) window.electronAPI.send('stop-recording');
    if (startBtn) { startBtn.textContent = '● REC'; startBtn.classList.remove('recording'); }
    state.isRecording = false;
    clearInterval(state.recTimer);
    if (recStatus) { recStatus.classList.remove('recording'); recStatus.textContent = 'REC: 00:00:00'; }
  };
}

// masterStream이 바뀔 때 (오디오 트랙 추가 등) 자동 갱신
document.addEventListener('displayStreamChanged', () => {
  if (!state.isRecording) setupMediaRecorder();
});

function _updateTimer() {
  const el = document.getElementById('rec-status');
  if (!el) return;
  const s = Math.floor((Date.now() - state.recStartTime) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  el.textContent = `REC: ${h}:${m}:${sec}`;
}

export function setupRecordingControls() {
  const btn = document.getElementById('start-recording-btn');
  btn?.addEventListener('click', () => {
    if (!state.mediaRecorder) {
      console.log('[Recording] MediaRecorder 미초기화 상태 감지, 초기화 시도...');
      setupMediaRecorder();
      if (!state.mediaRecorder) {
        console.error('[Recording] MediaRecorder 초기화 실패 (스트림 없음)');
        return;
      }
    }

    if (state.isRecording) {
      console.log('[Recording] 녹화 중지 요청');
      state.mediaRecorder.stop();
    } else {
      console.log('[Recording] 녹화 시작 요청 (1000ms 청크)');
      state.mediaRecorder.start(1000);
    }
  });
}
