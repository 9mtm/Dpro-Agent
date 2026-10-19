'use strict';
// Buttons of the app's own local pages (starting / failed / connect) only.
// Pages from a Dpro server (local or remote) get nothing from here.
const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dproDesktop', {
    discoverData: () => ipcRenderer.invoke('dpro:discover-data'),
    findData: () => ipcRenderer.invoke('dpro:find-data'),
    selectData: dir => ipcRenderer.invoke('dpro:select-data', String(dir)),
    newWorkspace: confirmed => ipcRenderer.invoke('dpro:new-workspace', confirmed === true),
    connect: url => ipcRenderer.invoke('dpro:connect', String(url)),
    useLocal: () => ipcRenderer.invoke('dpro:use-local'),
    retry: () => ipcRenderer.invoke('dpro:retry'),
    openConnect: () => ipcRenderer.invoke('dpro:open-connect'),
  });
}

// Public application metadata and fixed navigation only; never filesystem or authentication access.
contextBridge.exposeInMainWorld('dproApp', {
  chooseProjectFolders: () => ipcRenderer.invoke('dpro:choose-project-folders'),
  info: () => ipcRenderer.invoke('dpro:app-info'),
  onNavigate: callback => {
    const listener = (_event, destination) => { if (['home', 'settings', 'account', 'about'].includes(destination)) callback(destination); };
    ipcRenderer.on('dpro:navigate', listener);
    return () => ipcRenderer.removeListener('dpro:navigate', listener);
  },
});
