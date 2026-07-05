'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let logSeq = 0;

contextBridge.exposeInMainWorld('wslc', {
  listContainers: () => ipcRenderer.invoke('wslc:listContainers'),
  listImages: () => ipcRenderer.invoke('wslc:listImages'),
  listVolumes: () => ipcRenderer.invoke('wslc:listVolumes'),
  listNetworks: () => ipcRenderer.invoke('wslc:listNetworks'),
  containerAction: (name, action) => ipcRenderer.invoke('wslc:containerAction', name, action),
  inspect: (name) => ipcRenderer.invoke('wslc:inspect', name),
  pullImage: (ref) => ipcRenderer.invoke('wslc:pullImage', ref),
  removeImage: (ref) => ipcRenderer.invoke('wslc:removeImage', ref),
  runContainer: (opts) => ipcRenderer.invoke('wslc:runContainer', opts),
  createVolume: (name) => ipcRenderer.invoke('wslc:createVolume', name),
  removeVolume: (name) => ipcRenderer.invoke('wslc:removeVolume', name),
  createNetwork: (name) => ipcRenderer.invoke('wslc:createNetwork', name),
  removeNetwork: (name) => ipcRenderer.invoke('wslc:removeNetwork', name),
  version: () => ipcRenderer.invoke('wslc:version'),
  sessionInfo: () => ipcRenderer.invoke('wslc:sessionInfo'),
  isMock: () => ipcRenderer.invoke('wslc:isMock'),

  // returns a stop() function; onData/onEnd fire until then
  streamLogs: (name, onData, onEnd) => {
    logSeq += 1;
    const id = `s${logSeq}`;
    const dataCh = `logs:data:${id}`;
    const endCh = `logs:end:${id}`;
    const dataFn = (_ev, chunk) => onData(chunk);
    const endFn = () => { cleanup(); onEnd(); };
    function cleanup() {
      ipcRenderer.removeListener(dataCh, dataFn);
      ipcRenderer.removeListener(endCh, endFn);
    }
    ipcRenderer.on(dataCh, dataFn);
    ipcRenderer.once(endCh, endFn);
    ipcRenderer.send('logs:start', id, name);
    return () => { ipcRenderer.send('logs:stop', id); cleanup(); };
  },
});

contextBridge.exposeInMainWorld('host', {
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('app:saveSettings', s),
  isDark: () => ipcRenderer.invoke('app:isDark'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openTerminal: (name) => ipcRenderer.invoke('app:openTerminal', name),
  onThemeChanged: (fn) => ipcRenderer.on('theme:changed', (_ev, dark) => fn(dark)),
});
