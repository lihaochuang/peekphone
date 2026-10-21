'use strict';
// 托盘图标 + 菜单。mac 用 trayTemplate.png + setTemplateImage(true)，win 用 tray.ico。
const path = require('path');
const fs = require('fs');
const { Tray, Menu, nativeImage } = require('electron');
const config = require('./config');
const prompts = require('./prompts');
const pipeline = require('./pipeline');

let tray = null;

function iconPath() {
  const base = path.join(__dirname, '..', '..', 'build', 'tray');
  if (process.platform === 'win32') return path.join(base, 'tray.ico');
  return path.join(base, 'trayTemplate.png');
}

function loadIcon() {
  const p = iconPath();
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  }
  // 占位：1x1 透明，避免无图标崩溃（打包期补真实图标）
  return nativeImage.createEmpty();
}

// onOpenSettings(tab) 打开设置窗口并切到指定标签
function build(onOpenSettings, onQuit) {
  if (!tray) tray = new Tray(loadIcon());
  rebuild(onOpenSettings, onQuit);
  tray.setToolTip('PeekPhone');
  return tray;
}

function rebuild(onOpenSettings, onQuit) {
  const conf = config.get();
  const cur = conf.currentPrompt || 'default';
  const promptItems = prompts.list().map((name) => ({
    label: name,
    type: 'radio',
    checked: name === cur,
    click: () => {
      config.update({ currentPrompt: name });
      rebuild(onOpenSettings, onQuit); // 刷新「当前提示词」显示
    },
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: '立即截图（当前提示词：' + cur + '）',
      click: () => pipeline.runCapture(config.get().currentPrompt),
    },
    { label: '切换提示词', submenu: promptItems.length ? promptItems : [{ label: '（无）', enabled: false }] },
    { type: 'separator' },
    { label: '显示手机二维码', click: () => onOpenSettings('phone') },
    { label: '打开设置', click: () => onOpenSettings() },
    { type: 'separator' },
    { label: '退出', click: () => onQuit() },
  ]);
  tray.setContextMenu(menu);
}

function refresh(onOpenSettings, onQuit) {
  if (tray) rebuild(onOpenSettings, onQuit);
}

function destroy() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { build, refresh, destroy };
