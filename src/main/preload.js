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
  setPrivacyMode: (enabled) => ipcRenderer.invoke('set-privacy-mode', enabled),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window')
});
