/**
 * 오디오 처리 모듈
 * Web Audio API를 사용한 오디오 분석, 볼륨 제어, 음소거, 믹서 UI를 담당합니다.
 */
import { state } from './state.js';

/**
 * 오디오 스트림을 처리하고 볼륨 미터를 설정합니다.
 * @param {MediaStream} stream
 */
export function setupAudioProcessing(stream) {
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
  }

  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(stream);

  state.gainNodes.mic = state.audioContext.createGain();
  state.gainNodes.desktop = state.audioContext.createGain();
  state.gainNodes.mic.gain.value = 1.0;
  state.gainNodes.desktop.gain.value = 1.0;

  state.analysers.mic = state.audioContext.createAnalyser();
  state.analysers.mic.fftSize = 256;
  state.analysers.desktop = state.audioContext.createAnalyser();
  state.analysers.desktop.fftSize = 256;

  source.connect(state.gainNodes.mic);
  source.connect(state.gainNodes.desktop);
  state.gainNodes.mic.connect(state.analysers.mic);
  state.gainNodes.desktop.connect(state.analysers.desktop);
  state.analysers.mic.connect(state.audioContext.destination);
  state.analysers.desktop.connect(state.audioContext.destination);

  const micBufferLength = state.analysers.mic.frequencyBinCount;
  const micDataArray = new Uint8Array(micBufferLength);
  const desktopBufferLength = state.analysers.desktop.frequencyBinCount;
  const desktopDataArray = new Uint8Array(desktopBufferLength);

  function updateMeter() {
    if (!state.audioContext) return;

    const micMeter = document.querySelector('[data-meter-name="mic"]');
    if (state.analysers.mic && micMeter) {
      if (!state.audioMuted.mic) {
        state.analysers.mic.getByteTimeDomainData(micDataArray);
        let max = 0;
        for (let i = 0; i < micBufferLength; i++) {
          const v = Math.abs(micDataArray[i] - 128);
          if (v > max) max = v;
        }
        micMeter.style.width = Math.min((max / 128) * 100, 100) + '%';
      } else {
        micMeter.style.width = '0%';
      }
    }

    const desktopMeter = document.querySelector('[data-meter-name="desktop"]');
    if (state.analysers.desktop && desktopMeter) {
      if (!state.audioMuted.desktop) {
        state.analysers.desktop.getByteTimeDomainData(desktopDataArray);
        let max = 0;
        for (let i = 0; i < desktopBufferLength; i++) {
          const v = Math.abs(desktopDataArray[i] - 128);
          if (v > max) max = v;
        }
        desktopMeter.style.width = Math.min((max / 128) * 100, 100) + '%';
      } else {
        desktopMeter.style.width = '0%';
      }
    }

    requestAnimationFrame(updateMeter);
  }
  updateMeter();
}

/**
 * 오디오 트랙의 볼륨을 설정합니다.
 * @param {string} trackType - 'desktop' 또는 'mic'
 * @param {number} dbValue - 데시벨 값 (-100 ~ 0)
 */
export function setVolume(trackType, dbValue) {
  if (!state.gainNodes[trackType]) return;
  state.gainNodes[trackType].gain.value = dbValue === -100 ? 0 : Math.pow(10, dbValue / 20);

  const dbDisplay = document.querySelector(`[data-track="${trackType}"] .db-display`);
  if (dbDisplay) dbDisplay.textContent = `${dbValue.toFixed(1)} dB`;
}

/**
 * 오디오 트랙의 음소거 상태를 토글합니다.
 * @param {string} trackType - 'desktop' 또는 'mic'
 */
export function toggleMute(trackType) {
  if (!state.gainNodes[trackType]) return;

  state.audioMuted[trackType] = !state.audioMuted[trackType];
  const muteBtn = document.querySelector(`[data-mute="${trackType}"]`);
  const slider = document.querySelector(`[data-volume="${trackType}"]`);

  if (state.audioMuted[trackType]) {
    state.gainNodes[trackType].gain.value = 0;
    if (slider) slider.dataset.prevVolume = slider.value;
    if (slider) slider.value = -100;
    const dbDisplay = document.querySelector(`[data-track="${trackType}"] .db-display`);
    if (dbDisplay) dbDisplay.textContent = '-100.0 dB';
    if (muteBtn) {
      muteBtn.textContent = '🔇';
      muteBtn.style.opacity = '1';
      muteBtn.setAttribute('data-muted', 'true');
    }
  } else {
    if (slider?.dataset.prevVolume) {
      slider.value = slider.dataset.prevVolume;
      setVolume(trackType, parseFloat(slider.value));
    }
    if (muteBtn) {
      muteBtn.textContent = '🔊';
      muteBtn.style.opacity = '0.5';
      muteBtn.setAttribute('data-muted', 'false');
    }
  }
}

/**
 * 오디오 믹서 컨트롤(볼륨 슬라이더, 음소거 버튼)의 이벤트 리스너를 초기화합니다.
 */
export function setupAudioMixerControls() {
  const audioMixerPanel = document.getElementById('audio-mixer-panel');
  if (!audioMixerPanel) return;

  const newPanel = audioMixerPanel.cloneNode(true);
  audioMixerPanel.parentNode.replaceChild(newPanel, audioMixerPanel);

  newPanel.addEventListener('input', (e) => {
    if (e.target.classList.contains('volume-slider')) {
      const trackType = e.target.dataset.volume;
      const dbValue = parseFloat(e.target.value);
      if (!trackType) return;

      if (state.audioMuted[trackType]) {
        // 음소거 상태에서 슬라이더를 움직이면 음소거 해제
        state.audioMuted[trackType] = false;
        const muteBtn = newPanel.querySelector(`[data-mute="${trackType}"]`);
        if (muteBtn) {
          muteBtn.textContent = '🔊';
          muteBtn.style.opacity = '0.5';
          muteBtn.setAttribute('data-muted', 'false');
        }
      }
      
      setVolume(trackType, dbValue);
    }
  });

  newPanel.addEventListener('click', (e) => {
    const muteBtn = e.target.closest('.mute-btn');
    if (muteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const trackType = muteBtn.dataset.mute;
      if (trackType) toggleMute(trackType);
    }
  });
}
