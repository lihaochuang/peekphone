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
  getSponsorImage: () => ipcRenderer.invoke('getSponsorImage'),
  // 未保存改动确认（3 按钮：保存/放弃/取消），返回 'save' | 'discard' | 'cancel'
  confirmUnsaved: () => ipcRenderer.invoke('confirmUnsaved'),
  // 脏状态同步给主进程（供关窗口确认）
  setDirty: (b) => ipcRenderer.send('settings:dirty', b),
  // 主进程 -> UI：要求「保存并关闭」
  onSaveAll: (cb) => ipcRenderer.on('settings:save-all', () => cb()),
  closingAfterSave: () => ipcRenderer.send('settings:closing-after-save'),
  // 主进程 -> UI：切标签
  onGotoTab: (cb) => ipcRenderer.on('goto-tab', (_e, tab) => cb(tab)),
});
