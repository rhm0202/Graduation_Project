/**
 * 객체 추적 모듈
 * 자동 추적 모드 토글 및 spotlight_core.py로 상태 전송을 담당합니다.
 * 실제 YOLO 추론은 sources.js의 _bgLoop에서 수행하고,
 * 감지된 좌표는 sendObjectCoords를 통해 spotlight_core로 전달됩니다.
 */
import { state } from './state.js';
import { sendTrackingState } from './rpi.js';

/**
 * 자동 추적 모드를 토글합니다.
 * spotlight_core.py에 tracking on/off 상태를 전송합니다.
 */
export function toggleAutoTracking() {
  state.autoTrackingEnabled = !state.autoTrackingEnabled;
  const btn = document.getElementById('toggle-auto-tracking');
  if (btn) {
    btn.textContent = `자동 추적: ${state.autoTrackingEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('recording', state.autoTrackingEnabled);
  }
  sendTrackingState(state.autoTrackingEnabled);
}
