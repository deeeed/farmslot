const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farmslotDesktop', {
  loadConnection: () => ipcRenderer.invoke('desktop:load-connection'),
  saveConnection: (connection) => ipcRenderer.invoke('desktop:save-connection', connection),
  loadPreferences: () => ipcRenderer.invoke('desktop:load-preferences'),
  saveShortcut: (shortcut) => ipcRenderer.invoke('desktop:save-shortcut', shortcut),
  updateAttention: (state) => ipcRenderer.invoke('desktop:update-attention', state),
  onResume: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('desktop:resume', handler);
    return () => ipcRenderer.removeListener('desktop:resume', handler);
  },
});
