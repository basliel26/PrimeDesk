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
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath),
  getDefaultRecordingsDir: () => ipcRenderer.invoke('get-default-recordings-dir'),
  saveRecording: (payload) => ipcRenderer.invoke('save-recording', payload),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled)
});
