'use strict';
// contextBridge 白名单，只暴露 Promise 方法给设置 UI，不暴露 ipcRenderer 原件。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('getConfig'),
  updateConfig: (patch) => ipcRenderer.invoke('updateConfig', patch),
  listPrompts: () => ipcRenderer.invoke('listPrompts'),
  readPrompt: (name) => ipcRenderer.invoke('readPrompt', name),
  savePrompt: (name, text) => ipcRenderer.invoke('savePrompt', { name, text }),
  removePrompt: (name) => ipcRenderer.invoke('removePrompt', name),
  testRecognition: (draftConfig) => ipcRenderer.invoke('testRecognition', draftConfig),
  setHotkey: (accelerator) => ipcRenderer.invoke('setHotkey', accelerator),
  getPhoneConnection: () => ipcRenderer.invoke('getPhoneConnection'),
  resetToken: () => ipcRenderer.invoke('resetToken'),
  setPort: (port) => ipcRenderer.invoke('setPort', port),
  setLoginItem: (enabled) => ipcRenderer.invoke('setLoginItem', enabled),
  // 主进程 -> UI：切标签
  onGotoTab: (cb) => ipcRenderer.on('goto-tab', (_e, tab) => cb(tab)),
});
