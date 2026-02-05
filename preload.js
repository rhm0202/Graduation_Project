const { contextBridge, ipcRenderer } = require('electron');

/**
 * 렌더러 프로세스에 안전한 IPC API를 노출합니다.
 * Context Isolation을 통해 보안을 유지하면서 메인 프로세스와 통신할 수 있게 합니다.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 메인 프로세스로 동기 메시지를 전송합니다.
   * @param {string} channel - 허용된 IPC 채널 이름
   * @param {*} data - 전송할 데이터 (Buffer, string, object 등)
   */
  send: (channel, data) => {
    const validChannels = [
      'start-recording', 
      'stop-recording', 
      'video-chunk', 
      'exit-app',
      'menu-copy',
      'menu-paste',
      'menu-toggle-fullscreen',
      'menu-reload',
      'menu-toggle-devtools',
      'download-update'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  /**
   * 메인 프로세스로 비동기 요청을 보내고 응답을 받습니다.
   * @param {string} channel - 허용된 IPC 채널 이름
   * @returns {Promise} 메인 프로세스의 응답
   */
  invoke: (channel, ...args) => {
    const validChannels = [
      'select-save-path', 
      'get-save-path', 
      'show-recordings', 
      'check-for-updates'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel'));
  },
});