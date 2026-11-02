'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  platform: 'electron',
  onBack: (cb) => ipcRenderer.on('back', () => cb()),
  onAskExit: (cb) => ipcRenderer.on('ask-exit', () => cb()),
  toggleFullscreen: () => ipcRenderer.send('fullscreen'),
  quit: () => ipcRenderer.send('quit'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  http: (o) => ipcRenderer.invoke('http', o),
  netDiag: (url) => ipcRenderer.invoke('net-diag', url),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  update: {
    info: () => ipcRenderer.invoke('upd-info'),
    check: () => ipcRenderer.invoke('upd-check'),
    restart: () => ipcRenderer.send('upd-restart'),
    onEvent: (cb) => ipcRenderer.on('upd', (e, st) => cb(st))
  }
});
