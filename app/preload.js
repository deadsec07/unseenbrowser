const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  // Tabs
  newTab: (opts) => ipcRenderer.invoke('tabs:new', opts || {}),
  activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  // Nav
  goto: (url) => ipcRenderer.invoke('nav:goto', url),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  // Containers
  listContainers: () => ipcRenderer.invoke('containers:list'),
  addContainer: (name, persistent) => ipcRenderer.invoke('containers:add', { name, persistent }),
  setContainerTor: (name, enabled) => ipcRenderer.invoke('containers:setTor', { name, enabled }),
  // Permissions
  getPerm: (host) => ipcRenderer.invoke('perm:get', host),
  setPerm: (host, type, allow) => ipcRenderer.invoke('perm:set', { host, type, allow }),
  // Network probe + Tor control
  probe: (container) => ipcRenderer.invoke('net:probe', container),
  torStart: () => ipcRenderer.invoke('tor:start'),
  torStop:  () => ipcRenderer.invoke('tor:stop'),
  torStatus: () => ipcRenderer.invoke('tor:status'),
  // Events
  onTabState: (fn) => ipcRenderer.on('tab:state', (_e, payload) => fn(payload)),
  onLoading: (fn) => ipcRenderer.on('loading', (_e, payload) => fn(payload)),
  onContainerStatus: (fn) => ipcRenderer.on('container:status', (_e, s) => fn(s)),
  onTorBoot: (fn) => ipcRenderer.on('tor:boot', (_e, s) => fn(s)),
  onTorError: (fn) => ipcRenderer.on('tor:error', (_e, s) => fn(s)),
  onDownloadProgress: (fn) => ipcRenderer.on('download:progress', (_e, p) => fn(p)),
  onDownloadDone: (fn) => ipcRenderer.on('download:done', (_e, p) => fn(p)),
});
