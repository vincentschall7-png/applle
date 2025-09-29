const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAlwaysOnTop: () => ipcRenderer.invoke('settings:get-always-on-top'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('settings:set-always-on-top', flag),
  // Dateien-APIs entfernt
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winNew: () => ipcRenderer.invoke('win:new'),
  winToggleCompact: () => ipcRenderer.invoke('win:toggle-compact'),
  winClose: () => ipcRenderer.invoke('win:close'),
  resetAll: () => ipcRenderer.invoke('app:reset-all')
});

// Chat events
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.on('chat:message', (_e, data) => {
    window.dispatchEvent(new CustomEvent('lan-chat-message', { detail: data }));
  });
});

contextBridge.exposeInMainWorld('lanChat', {
  send: (payload) => ipcRenderer.invoke('chat:send', payload)
});

contextBridge.exposeInMainWorld('fullscreen', {
  toggle: () => ipcRenderer.invoke('win:toggle-fullscreen')
});

// STT bridge
contextBridge.exposeInMainWorld('stt', {
  transcribe: (arrayBuffer, ext) => ipcRenderer.invoke('stt:transcribe', { data: Buffer.from(arrayBuffer), ext })
});


