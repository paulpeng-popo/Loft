// Desktop features for the page. The page only gets these functions, never Node or the file system.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loft', {
    isApp: true,
    pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
    showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
    openData: () => ipcRenderer.invoke('open-data'),
    info: () => ipcRenderer.invoke('app-info'),
    setAutoStart: (on) => ipcRenderer.invoke('set-auto-start', on),
});
