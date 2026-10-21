'use strict';
// 设置窗口的创建与复用。已存在则 focus，不重复开。
const path = require('path');
const { BrowserWindow } = require('electron');

let win = null;

function openSettings(tab) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (tab) win.webContents.send('goto-tab', tab);
    return win;
  }
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
  win.on('closed', () => {
    win = null;
  });
  return win;
}

module.exports = { openSettings };
