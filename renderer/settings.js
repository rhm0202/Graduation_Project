/**
 * 설정 관리 모듈
 * localStorage를 통한 설정 저장/불러오기 및 설정 모달 초기화를 담당합니다.
 */
import { isElectron } from './state.js';
import { getDevices } from './media.js';

/**
 * 현재 설정을 localStorage에 저장합니다.
 */
export function saveSettings() {
  try {
    const settings = {
      videoSource: document.getElementById('video-source')?.value || '',
      audioSource: document.getElementById('audio-source')?.value || '',
      videoResolution: document.getElementById('video-resolution')?.value || 'auto',
      videoFramerate: document.getElementById('video-framerate')?.value || 'auto',
      // [구버전] RPi 직접 연결 시 IP/Port 저장 — spotlight_core.py 방식에서는 localhost 고정이므로 불필요
      // raspberryPiIp: document.getElementById('raspberry-pi-ip')?.value || '',
      // raspberryPiPort: document.getElementById('raspberry-pi-port')?.value || '8765',
      fileFormat: document.getElementById('file-format')?.value || 'webm',
      savePath: document.getElementById('save-path-display')?.value || 'C:\\VideoRecoding',
      timestamp: Date.now(),
    };
    localStorage.setItem('spotlightCamSettings', JSON.stringify(settings));
  } catch (error) {
    console.error('설정 저장 실패:', error);
  }
}

/**
 * localStorage에서 설정을 불러와 UI에 적용합니다.
 * @returns {Object|null} 불러온 설정 객체 또는 null
 */
export function loadSettings() {
  try {
    const saved = localStorage.getItem('spotlightCamSettings');
    if (!saved) return null;

    const settings = JSON.parse(saved);

    const videoSelect = document.getElementById('video-source');
    const audioSelect = document.getElementById('audio-source');
    const resolutionSelect = document.getElementById('video-resolution');
    const framerateSelect = document.getElementById('video-framerate');
    // [구버전] RPi 직접 연결 시 IP/Port 복원 — spotlight_core.py 방식에서는 불필요
    // const piIpInput = document.getElementById('raspberry-pi-ip');
    // const piPortInput = document.getElementById('raspberry-pi-port');
    const fileFormatSelect = document.getElementById('file-format');

    if (settings.videoSource && videoSelect) videoSelect.value = settings.videoSource;
    if (settings.audioSource && audioSelect) audioSelect.value = settings.audioSource;
    if (settings.videoResolution && resolutionSelect) resolutionSelect.value = settings.videoResolution;
    if (settings.videoFramerate && framerateSelect) framerateSelect.value = settings.videoFramerate;
    // [구버전] if (settings.raspberryPiIp && piIpInput) piIpInput.value = settings.raspberryPiIp;
    // [구버전] if (settings.raspberryPiPort && piPortInput) piPortInput.value = settings.raspberryPiPort;
    if (settings.fileFormat && fileFormatSelect) fileFormatSelect.value = settings.fileFormat;

    return settings;
  } catch (error) {
    console.error('설정 불러오기 실패:', error);
    return null;
  }
}

/**
 * 설정 모달 이벤트 리스너 및 GPU 선택 기능을 초기화합니다.
 */
export function setupSettingsModal() {
  const openSettingsBtn = document.getElementById('open-settings');
  const closeSettingsBtn = document.getElementById('close-settings');
  const settingsModal = document.getElementById('settings-modal');
  const setSavePathBtn = document.getElementById('set-save-path');
  const savePathDisplay = document.getElementById('save-path-display');
  // [구버전] RPi 직접 연결 시 IP/Port 입력 요소 — spotlight_core.py 방식에서는 불필요
  // const piIpInput = document.getElementById('raspberry-pi-ip');
  // const piPortInput = document.getElementById('raspberry-pi-port');
  const fileFormatSelect = document.getElementById('file-format');

  // GPU 목록 로드 및 선택 처리
  const gpuSelect = document.getElementById('gpu-select');
  if (isElectron && window.electronAPI.invoke && gpuSelect) {
    window.electronAPI.invoke('get-gpu-list').then((gpus) => {
      gpuSelect.innerHTML = '';
      gpus.forEach(({ index, name }) => {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = name;
        gpuSelect.appendChild(opt);
      });
      const saved = localStorage.getItem('selectedGpuIndex');
      if (saved !== null) gpuSelect.value = saved;
      const selectedGpu = gpus[parseInt(gpuSelect.value) || 0];
      if (selectedGpu) window.electronAPI.send('set-selected-gpu', selectedGpu.name);
    }).catch(() => {
      gpuSelect.innerHTML = '<option value="0">GPU 목록 불러오기 실패</option>';
    });

    gpuSelect.addEventListener('change', () => {
      const idx = parseInt(gpuSelect.value);
      const name = gpuSelect.options[gpuSelect.selectedIndex]?.textContent || '';
      localStorage.setItem('selectedGpuIndex', idx);
      window.electronAPI.send('set-selected-gpu', name);
    });
  }

  openSettingsBtn?.addEventListener('click', async () => {
    settingsModal.classList.add('visible');
    await getDevices();
    const savedSettings = loadSettings();

    if (isElectron && window.electronAPI.invoke) {
      try {
        const currentPath = await window.electronAPI.invoke('get-save-path');
        if (savePathDisplay) {
          savePathDisplay.value = savedSettings?.savePath || currentPath || 'C:\\VideoRecoding';
        }
      } catch {
        if (savePathDisplay) {
          savePathDisplay.value = savedSettings?.savePath || 'C:\\VideoRecoding';
        }
      }
    } else {
      if (savePathDisplay) {
        savePathDisplay.value = savedSettings?.savePath || 'C:\\VideoRecoding';
      }
    }
  });

  closeSettingsBtn?.addEventListener('click', () => {
    saveSettings();
    settingsModal.classList.remove('visible');
  });

  setSavePathBtn?.addEventListener('click', async () => {
    if (isElectron && window.electronAPI.invoke) {
      try {
        const selectedPath = await window.electronAPI.invoke('select-save-path');
        if (selectedPath && savePathDisplay) {
          savePathDisplay.value = selectedPath;
          saveSettings();
        }
      } catch (err) {
        console.error('저장 경로 선택 실패:', err);
      }
    } else {
      alert('Electron 환경에서만 사용 가능합니다.');
    }
  });

  // [구버전] IP/Port 변경 시 자동 저장 — spotlight_core.py 방식에서는 불필요
  // if (piIpInput) {
  //   piIpInput.addEventListener('change', saveSettings);
  //   piIpInput.addEventListener('blur', saveSettings);
  // }
  // if (piPortInput) {
  //   piPortInput.addEventListener('change', saveSettings);
  //   piPortInput.addEventListener('blur', saveSettings);
  // }
  if (fileFormatSelect) {
    fileFormatSelect.addEventListener('change', saveSettings);
  }
}
