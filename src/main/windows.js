'use strict';
// 设置窗口的创建与复用。已存在则 focus，不重复开。
const path = require('path');
const { BrowserWindow, ipcMain, dialog } = require('electron');

let win = null;
let dirty = false; // 渲染进程同步过来的「有未保存改动」
let forceClose = false; // 保存/放弃后放行关闭

// 模块级注册一次，避免每次开窗重复挂监听
ipcMain.on('settings:dirty', (_e, b) => {
  dirty = !!b;
});
ipcMain.on('settings:closing-after-save', () => {
  dirty = false;
  forceClose = true;
  if (win && !win.isDestroyed()) win.close();
});

async function handleCloseConfirm() {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['保存', '放弃', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: '有改动未保存',
    detail: '关闭前是否保存这些改动？',
  });
  if (r.response === 2) return; // 取消：留在窗口
  if (r.response === 1) {
    // 放弃
    dirty = false;
    forceClose = true;
    if (win && !win.isDestroyed()) win.close();
    return;
  }
  // 保存：让渲染进程存完再由 closing-after-save 关闭
  if (win && !win.isDestroyed()) win.webContents.send('settings:save-all');
}

function openSettings(tab) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (tab) win.webContents.send('goto-tab', tab);
    return win;
  }
  dirty = false;
  forceClose = false;
  win = new BrowserWindow({
    width: 760,
    height: 680,
    title: 'PeekPhone 设置',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (tab) win.webContents.send('goto-tab', tab);
  });
  win.on('close', (e) => {
    if (dirty && !forceClose) {
      e.preventDefault();
      handleCloseConfirm();
    }
  });
  win.on('closed', () => {
    win = null;
    dirty = false;
    forceClose = false;
  });
  return win;
}

module.exports = { openSettings };
