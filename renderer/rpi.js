/**
 * 라즈베리파이 연결 모듈
 * WebSocket 연결/해제, 재연결, 메시지 처리, 모터 제어, UI 상태 업데이트를 담당합니다.
 */
import { state, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY } from './state.js';
import { showErrorModal } from './media.js';
import { processObjectTracking } from './tracking.js';

/**
 * 라즈베리파이에 WebSocket 연결을 시도합니다.
 * @param {string} ip
 * @param {number} [port=8765]
 */
export function connectToRaspberryPi(ip, port = 8765) {
  if (state.piWebSocket?.readyState === WebSocket.OPEN) return;

  try {
    state.piWebSocket = new WebSocket(`ws://${ip}:${port}`);

    state.piWebSocket.onopen = () => {
      state.piConnected = true;
      state.piReconnectAttempts = 0;
      updatePiConnectionStatus(true);
      state.piWebSocket.send(JSON.stringify({ type: 'client_ready', message: 'Electron 클라이언트 연결됨' }));
    };

    state.piWebSocket.onmessage = (event) => {
      try {
        handlePiMessage(JSON.parse(event.data));
      } catch {
        handlePiVideoFrame(event.data);
      }
    };

    state.piWebSocket.onclose = (event) => {
      state.piConnected = false;
      if (event.code !== 1000) {
        if (state.piReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          attemptReconnect(ip, port);
        } else {
          updatePiConnectionStatus(false, '연결 실패: 재연결 시도 횟수를 초과했습니다.');
          showErrorModal(
            '라즈베리파이 연결이 끊어졌습니다.\n\n재연결을 여러 번 시도했지만 실패했습니다.\n\nIP 주소와 포트를 확인하고 수동으로 다시 연결해주세요.',
            true, true,
            () => connectToRaspberryPi(ip, port),
          );
        }
      } else {
        updatePiConnectionStatus(false, '연결이 종료되었습니다.');
      }
    };

    state.piWebSocket.onerror = () => {
      state.piConnected = false;
      updatePiConnectionStatus(false, '연결 실패: 네트워크 오류가 발생했습니다.');
      showErrorModal(
        '라즈베리파이에 연결할 수 없습니다.\n\n가능한 원인:\n- IP 주소나 포트가 올바르지 않습니다\n- 라즈베리파이가 실행 중이지 않습니다\n- 방화벽이 연결을 차단하고 있습니다\n- 네트워크 연결이 끊어졌습니다',
        true, true,
        () => connectToRaspberryPi(ip, port),
      );
    };
  } catch (error) {
    updatePiConnectionStatus(false, 'WebSocket을 생성할 수 없습니다.');
    showErrorModal(
      `라즈베리파이 연결에 실패했습니다.\n\n오류: ${error.message || '알 수 없는 오류'}\n\nIP 주소와 포트를 확인하고 다시 시도해주세요.`,
      true, true,
      () => connectToRaspberryPi(ip, port),
    );
  }
}

/**
 * 라즈베리파이 WebSocket 연결을 해제합니다.
 */
export function disconnectFromRaspberryPi() {
  if (state.piWebSocket) {
    state.piWebSocket.close(1000, '사용자 요청으로 연결 종료');
    state.piWebSocket = null;
  }
  state.piConnected = false;
  state.piReconnectAttempts = 0;
  if (state.piReconnectTimer) {
    clearTimeout(state.piReconnectTimer);
    state.piReconnectTimer = null;
  }
  updatePiConnectionStatus(false);

  if (state.piVideoStream) {
    state.piVideoStream = null;
    const videoFeed = document.getElementById('main-video-feed');
    if (state.mediaStream && videoFeed) videoFeed.srcObject = state.mediaStream;
  }
}

function attemptReconnect(ip, port) {
  state.piReconnectAttempts++;
  updatePiConnectionStatus(false, `재연결 시도 중... (${state.piReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  state.piReconnectTimer = setTimeout(() => connectToRaspberryPi(ip, port), RECONNECT_DELAY);
}

function handlePiMessage(data) {
  switch (data.type) {
    case 'video_frame': handlePiVideoFrame(data.frame); break;
    case 'motor_status': break;
    case 'system_info': break;
  }
}

function handlePiVideoFrame(frameData) {
  if (!frameData) return;

  const videoFeed = document.getElementById('main-video-feed');

  try {
    if (typeof frameData === 'string') {
      const img = new Image();
      img.onload = () => {
        if (!state.trackingCanvas) {
          state.trackingCanvas = document.createElement('canvas');
          state.trackingCtx = state.trackingCanvas.getContext('2d');
        }
        state.trackingCanvas.width = img.width;
        state.trackingCanvas.height = img.height;
        state.trackingCtx.drawImage(img, 0, 0);

        const stream = state.trackingCanvas.captureStream(30);
        state.mediaStream?.getAudioTracks().forEach((t) => stream.addTrack(t));
        state.piVideoStream = stream;
        if (videoFeed) {
          videoFeed.srcObject = stream;
          if (state.autoTrackingEnabled) processObjectTracking();
        }
      };
      img.src = `data:image/jpeg;base64,${frameData}`;

    } else if (frameData instanceof Blob) {
      const tempVideo = document.createElement('video');
      tempVideo.src = URL.createObjectURL(frameData);
      tempVideo.autoplay = true;
      tempVideo.muted = true;
      tempVideo.playsInline = true;

      tempVideo.addEventListener('loadedmetadata', () => {
        const canvas = document.createElement('canvas');
        canvas.width = tempVideo.videoWidth;
        canvas.height = tempVideo.videoHeight;
        const ctx = canvas.getContext('2d');

        const drawFrame = () => {
          if (tempVideo.readyState >= 2) {
            ctx.drawImage(tempVideo, 0, 0);
            const stream = canvas.captureStream(30);
            state.mediaStream?.getAudioTracks().forEach((t) => stream.addTrack(t));
            state.piVideoStream = stream;
            if (videoFeed) {
              videoFeed.srcObject = stream;
              if (state.autoTrackingEnabled) processObjectTracking();
            }
          } else {
            requestAnimationFrame(drawFrame);
          }
        };
        drawFrame();
      });
    }
  } catch (error) {
    console.error('비디오 프레임 처리 오류:', error);
  }
}

/**
 * 라즈베리파이 연결 상태를 UI에 업데이트합니다.
 */
export function updatePiConnectionStatus(connected, message) {
  const statusIndicator = document.getElementById('pi-status-indicator');
  const statusText = document.getElementById('pi-status-text');
  const connectionStatus = document.getElementById('pi-connection-status');
  const connectBtn = document.getElementById('connect-pi-btn');
  const disconnectBtn = document.getElementById('disconnect-pi-btn');

  if (connected) {
    statusIndicator?.style.setProperty('background-color', 'var(--color-success)');
    statusIndicator?.classList.replace('disconnected', 'connected');
    if (statusText) statusText.textContent = '라즈베리파이: 연결됨';
    if (connectionStatus) {
      connectionStatus.textContent = '연결됨';
      connectionStatus.style.backgroundColor = 'var(--color-success)';
      connectionStatus.style.color = 'white';
    }
    if (connectBtn) connectBtn.style.display = 'none';
    if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
  } else {
    statusIndicator?.style.setProperty('background-color', 'var(--color-danger)');
    statusIndicator?.classList.replace('connected', 'disconnected');
    if (statusText) statusText.textContent = message || '라즈베리파이: 연결 안 됨';
    if (connectionStatus) {
      connectionStatus.textContent = message || '연결 안 됨';
      connectionStatus.style.backgroundColor = 'var(--bg-medium)';
      connectionStatus.style.color = 'var(--text-secondary)';
    }
    if (connectBtn) connectBtn.style.display = 'inline-block';
    if (disconnectBtn) disconnectBtn.style.display = 'none';
  }
}

/**
 * 라즈베리파이로 모터 제어 명령을 전송합니다.
 * @param {number} pan - 팬 각도 (-90 ~ 90)
 * @param {number} tilt - 틸트 각도 (-90 ~ 90)
 */
export function sendMotorControl(pan, tilt) {
  if (!state.piConnected || state.piWebSocket?.readyState !== WebSocket.OPEN) return;

  pan = Math.max(-90, Math.min(90, pan));
  tilt = Math.max(-90, Math.min(90, tilt));

  if (Math.abs(pan - state.lastMotorCommand.pan) < 1 && Math.abs(tilt - state.lastMotorCommand.tilt) < 1) return;

  state.lastMotorCommand = { pan, tilt };
  state.piWebSocket.send(JSON.stringify({ type: 'motor_control', pan, tilt, timestamp: Date.now() }));
}

/**
 * 라즈베리파이 연결 UI 이벤트 리스너를 초기화합니다.
 */
export function setupPiConnectionUI() {
  const connectBtn = document.getElementById('connect-pi-btn');
  const disconnectBtn = document.getElementById('disconnect-pi-btn');
  const piIpInput = document.getElementById('raspberry-pi-ip');
  const piPortInput = document.getElementById('raspberry-pi-port');

  connectBtn?.addEventListener('click', () => {
    const ip = piIpInput?.value.trim();
    const port = parseInt(piPortInput?.value || '8765');

    if (!ip) { alert('라즈베리파이 IP 주소를 입력하세요.'); return; }
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) { alert('올바른 IP 주소 형식을 입력하세요.\n예: 192.168.1.100'); return; }
    connectToRaspberryPi(ip, port);
  });

  disconnectBtn?.addEventListener('click', disconnectFromRaspberryPi);

  const enterToConnect = (e) => { if (e.key === 'Enter') connectBtn?.click(); };
  piIpInput?.addEventListener('keypress', enterToConnect);
  piPortInput?.addEventListener('keypress', enterToConnect);

  updatePiConnectionStatus(false);
}
