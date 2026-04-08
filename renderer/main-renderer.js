/**
 * 렌더러 진입점
 * 모든 모듈을 가져와 애플리케이션을 초기화합니다.
 */
import { getDevices, startStream, setupMediaControls } from './media.js';
import { setupAudioMixerControls } from './audio.js';
import { setupRecordingControls } from './recording.js';
import { setupPiConnectionUI } from './rpi.js';
import { toggleAutoTracking } from './tracking.js';
import { loadModel, toggleBackgroundRemoval, toggleComparison, setupBackgroundReplaceModal } from './background.js';
import { setupSettingsModal, loadSettings } from './settings.js';
import { setupUpdateModal } from './updates.js';
import { setupDropdownMenus, setupPreviewResize, setupAppMenus, setupGpuStatusListeners } from './ui.js';

// GPU 상태 리스너는 DOMContentLoaded와 무관하게 즉시 등록
setupGpuStatusListeners();

/**
 * 애플리케이션 초기화
 */
(async function init() {
  try {
    // 오디오 믹서
    setupAudioMixerControls();

    // 녹화 컨트롤
    setupRecordingControls();

    // 라즈베리파이 연결 UI
    setupPiConnectionUI();

    // 업데이트 모달
    setupUpdateModal();

    // 설정 모달
    setupSettingsModal();

    // 배경 제거 토글
    document.getElementById('toggle-background-removal')?.addEventListener('click', toggleBackgroundRemoval);

    // 전/후 비교 토글
    document.getElementById('toggle-comparison')?.addEventListener('click', toggleComparison);

    // 자동 추적 토글
    document.getElementById('toggle-auto-tracking')?.addEventListener('click', toggleAutoTracking);

    // 배경 교체 버튼
    document.getElementById('toggle-background-replace')?.addEventListener('click', () => {
      document.getElementById('background-replace-modal')?.classList.add('visible');
    });

    // 배경 교체 모달
    setupBackgroundReplaceModal();

    // 앱 메뉴 (종료, 복사 등)
    setupAppMenus();

    // 드롭다운 메뉴
    setupDropdownMenus();

    // 패널 리사이즈
    setupPreviewResize();

    // 미디어 장치 변경 이벤트
    setupMediaControls();

    // 카메라/마이크 장치 목록 로드
    await getDevices();

    // 저장된 설정 불러오기
    const savedSettings = loadSettings();

    // AI 모델 로드
    await loadModel();

    // 스트림 시작
    if (savedSettings?.videoSource && savedSettings?.audioSource) {
      await startStream(savedSettings.videoSource, savedSettings.audioSource);
    } else {
      await startStream();
    }

    // 스트림 시작 후 오디오 믹서 재설정 (스트림 연결 후 gainNode가 갱신됨)
    setupAudioMixerControls();

  } catch (error) {
    console.error('초기화 중 오류 발생:', error);
  }
})();
