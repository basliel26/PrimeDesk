const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('primeDeskAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),
  sendInput: (command) => ipcRenderer.invoke('send-input', command),
  startInputWorker: () => ipcRenderer.invoke('start-input-worker'),
  stopInputWorker: () => ipcRenderer.invoke('stop-input-worker'),
  setPillMode: () => ipcRenderer.invoke('set-pill-mode'),
  restoreNormalMode: () => ipcRenderer.invoke('restore-normal-mode'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  saveReceivedFile: (payload) => ipcRenderer.invoke('save-received-file', payload),
  setPrivacyMode: (enabled) => ipcRenderer.invoke('set-privacy-mode', enabled),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Enterprise Settings & Media APIs
  setNetworkProxy: (config) => ipcRenderer.invoke('set-network-proxy', config),
  probeAndRecoverCloud: (config) => ipcRenderer.invoke('probe-and-recover-cloud', config),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath),
  getDefaultRecordingsDir: () => ipcRenderer.invoke('get-default-recordings-dir'),
  saveRecording: (payload) => ipcRenderer.invoke('save-recording', payload),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // Support-Giver File Manager & Streaming Disk Engine APIs
  fsListRoots: () => ipcRenderer.invoke('fs-list-roots'),
  fsListDir: (dirPath) => ipcRenderer.invoke('fs-list-dir', dirPath),
  fsMakeDir: (dirPath) => ipcRenderer.invoke('fs-mkdir', dirPath),
  fsTrash: (paths) => ipcRenderer.invoke('fs-trash', paths),
  fsCollectItems: (paths) => ipcRenderer.invoke('fs-collect-items', paths),
  fsOpenRead: (filePath) => ipcRenderer.invoke('fs-open-read', filePath),
  fsReadChunk: (readId, offset, length) => ipcRenderer.invoke('fs-read-chunk', readId, offset, length),
  fsCloseRead: (readId) => ipcRenderer.invoke('fs-close-read', readId),
  fsBeginWrite: (baseDir, relPath) => ipcRenderer.invoke('fs-begin-write', baseDir, relPath),
  fsWriteChunk: (writeId, data) => ipcRenderer.invoke('fs-write-chunk', writeId, data),
  fsEndWrite: (writeId) => ipcRenderer.invoke('fs-end-write', writeId),
  fsAbortWrite: (writeId) => ipcRenderer.invoke('fs-abort-write', writeId),
  fsCreateEmptyDir: (baseDir, relPath) => ipcRenderer.invoke('fs-create-empty-dir', baseDir, relPath),
  fsResolveSafeTarget: (baseDir, relPath) => ipcRenderer.invoke('fs-resolve-safe-target', baseDir, relPath),
  getDownloadsDir: () => ipcRenderer.invoke('get-downloads-dir'),

  // Native Windows CF_HDROP File Copy & Paste APIs
  clipGetFiles: () => ipcRenderer.invoke('clip-get-files'),
  clipSetFiles: (paths) => ipcRenderer.invoke('clip-set-files', paths),
  clipCreateStageDir: () => ipcRenderer.invoke('clip-create-stage-dir'),

  // Frameless Floating Pill Window IPC
  pillResize: (height) => ipcRenderer.invoke('pill-resize', height),
  pillSendChat: (text) => ipcRenderer.invoke('pill-send-chat', text),
  pillTerminate: () => ipcRenderer.invoke('pill-terminate'),
  pillNotifyIncoming: (payload) => ipcRenderer.invoke('pill-notify-incoming', payload),
  onPillChatIncoming: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('pill-chat-message', handler);
    return () => ipcRenderer.removeListener('pill-chat-message', handler);
  },
  onPillChatOutgoing: (cb) => {
    const handler = (_, text) => cb(text);
    ipcRenderer.on('pill-chat-outgoing', handler);
    return () => ipcRenderer.removeListener('pill-chat-outgoing', handler);
  },
  onPillTerminateSession: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('pill-terminate-session', handler);
    return () => ipcRenderer.removeListener('pill-terminate-session', handler);
  }
});
