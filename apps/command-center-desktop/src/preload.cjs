const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farmslotDesktop', {
  loadConnection: () => ipcRenderer.invoke('desktop:load-connection'),
  saveConnection: (connection) => ipcRenderer.invoke('desktop:save-connection', connection),
  onResume: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('desktop:resume', handler);
    return () => ipcRenderer.removeListener('desktop:resume', handler);
  },
});
