const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  selectDirectory: () => ipcRenderer.invoke('select-directory')
});

contextBridge.exposeInMainWorld('hudAPI', {
  onTasksUpdated: (callback) => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('hud-tasks-updated', listener);
    return () => ipcRenderer.removeListener('hud-tasks-updated', listener);
  },
  action: (action) => ipcRenderer.invoke('hud-action', action)
});
