const { contextBridge, ipcRenderer } = require('electron');

// Main-process navigation changes only the current document's fragment.
ipcRenderer.on('desktop:navigate', (_event, route) => {
  if (typeof route === 'string' && route.startsWith('#') && location.pathname === '/cc/') {
    location.hash = route;
  }
});

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
