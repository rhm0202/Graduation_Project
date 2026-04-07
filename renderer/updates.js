/**
 * 업데이트 관리 모듈
 * 수동/자동 업데이트 확인 및 업데이트 모달 초기화를 담당합니다.
 */
import { isElectron } from './state.js';

/**
 * 업데이트 다운로드를 시작합니다.
 * @param {string} downloadUrl - 다운로드 URL
 */
function downloadUpdate(downloadUrl) {
  if (isElectron && window.electronAPI.send) {
    window.electronAPI.send('download-update', downloadUrl);
  } else {
    window.open(downloadUrl, '_blank');
  }
}

/**
 * 업데이트를 수동으로 확인합니다.
 */
export async function checkForUpdatesManually() {
  const updateModal = document.getElementById('update-modal');
  const updateChecking = document.getElementById('update-checking');
  const updateAvailable = document.getElementById('update-available');
  const updateLatest = document.getElementById('update-latest');
  const updateError = document.getElementById('update-error');

  if (!updateModal) return;

  updateModal.classList.add('visible');
  updateChecking.style.display = 'block';
  updateAvailable.style.display = 'none';
  updateLatest.style.display = 'none';
  updateError.style.display = 'none';

  try {
    if (!isElectron || !window.electronAPI.invoke) {
      updateChecking.style.display = 'none';
      updateError.style.display = 'block';
      return;
    }

    const updateInfo = await window.electronAPI.invoke('check-for-updates');
    updateChecking.style.display = 'none';

    if (!updateInfo) {
      updateError.style.display = 'block';
      return;
    }

    if (updateInfo.available) {
      document.getElementById('update-current-version').textContent = updateInfo.currentVersion;
      document.getElementById('update-latest-version').textContent = updateInfo.latestVersion;
      document.getElementById('update-release-date').textContent = updateInfo.releaseDate || '날짜 정보 없음';
      document.getElementById('update-release-notes').textContent = updateInfo.releaseNotes || '업데이트가 사용 가능합니다.';
      updateAvailable.style.display = 'block';
    } else {
      document.getElementById('update-current-version-latest').textContent = updateInfo.currentVersion;
      updateLatest.style.display = 'block';
    }
  } catch (error) {
    console.error('업데이트 확인 오류:', error);
    updateChecking.style.display = 'none';
    updateError.style.display = 'block';

    const errorMessage = document.getElementById('update-error-message');
    if (errorMessage) {
      if (error.message?.includes('network') || error.message?.includes('timeout')) {
        errorMessage.textContent = '업데이트 서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.';
      } else {
        errorMessage.textContent = `업데이트 확인 중 오류가 발생했습니다: ${error.message || '알 수 없는 오류'}`;
      }
    }
  }
}

/**
 * 업데이트 모달 이벤트 리스너를 초기화합니다.
 */
export function setupUpdateModal() {
  const updateModal = document.getElementById('update-modal');
  const updateDownloadBtn = document.getElementById('update-download-btn');
  const updateCloseBtn = document.getElementById('update-close-btn');
  const updateCloseLatestBtn = document.getElementById('update-close-latest-btn');
  const updateRetryBtn = document.getElementById('update-retry-btn');
  const updateCloseErrorBtn = document.getElementById('update-close-error-btn');

  if (updateDownloadBtn) {
    updateDownloadBtn.addEventListener('click', async () => {
      try {
        const updateInfo = await window.electronAPI.invoke('check-for-updates');
        if (updateInfo?.available && updateInfo.downloadUrl) {
          downloadUpdate(updateInfo.downloadUrl);
          updateModal.classList.remove('visible');
        } else {
          alert('다운로드 URL을 가져올 수 없습니다.');
        }
      } catch (error) {
        console.error('다운로드 URL 가져오기 실패:', error);
        alert('업데이트 다운로드에 실패했습니다.');
      }
    });
  }

  updateCloseBtn?.addEventListener('click', () => updateModal.classList.remove('visible'));
  updateCloseLatestBtn?.addEventListener('click', () => updateModal.classList.remove('visible'));
  updateRetryBtn?.addEventListener('click', () => checkForUpdatesManually());
  updateCloseErrorBtn?.addEventListener('click', () => updateModal.classList.remove('visible'));
}
