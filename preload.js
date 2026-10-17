const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('khi', {
  getPage: (path, opts) => ipcRenderer.invoke('page:get', path, opts),
  resolveSong: (songPath) => ipcRenderer.invoke('song:resolve', songPath),
  enqueueDownloads: (items) => ipcRenderer.invoke('dl:enqueue', items),
  cancelDownload: (id) => ipcRenderer.invoke('dl:cancel', id),
  reveal: (file) => ipcRenderer.invoke('dl:reveal', file),
  onDownloadUpdate: (cb) => ipcRenderer.on('dl:update', (_e, u) => cb(u)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDownloadDir: () => ipcRenderer.invoke('settings:chooseDir'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  searchLyrics: (params) => ipcRenderer.invoke('lyrics:search', params),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  onFullscreen: (cb) => ipcRenderer.on('win:fs', (_e, on) => cb(on)),
  platform: process.platform,
});
