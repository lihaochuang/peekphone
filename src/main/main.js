'use strict';
// 应用入口：单实例锁、启动服务/快捷键/托盘、首启一次性安全提示、生命周期清理。
const path = require('path');
const { app, dialog, Notification } = require('electron');
const config = require('./config');
const { createStore } = require('./store');
const server = require('./server');
const shortcut = require('./shortcut');
const pipeline = require('./pipeline');
const tray = require('./tray');
const windows = require('./windows');
const ipc = require('./ipc');

// 单实例：第二次启动直接退出，避免抢端口/快捷键
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let store = null;

function openSettings(tab) {
  windows.openSettings(tab);
}

function quit() {
  app.quit();
}

function refreshTray() {
  tray.refresh(openSettings, quit);
}

async function boot() {
  const conf = config.get();

  // store 落 userData/history
  store = createStore(path.join(app.getPath('userData'), 'history'));
  server.setStore(store);
  pipeline.setStore(store);

  // 内置提示词首启落盘
  const prompts = require('./prompts');
  prompts.seedDefaults();

  // 启动时清理一次历史
  store.purge(parseInt(conf.keepDays, 10) || 7);

  // 本地服务
  const r = await server.start(conf.server.port, (msg) => {
    // 不弹任何桌面通知，只记控制台/日志
    console.warn('[PeekPhone] 服务提示: ' + msg + '，请在设置里换端口');
  });
  if (!r.ok) {
    console.warn('[PeekPhone] 服务启动失败: 端口 ' + conf.server.port + ' 不可用，请在设置里换端口');
  }

  // 全局快捷键
  const ok = shortcut.register(conf.hotkey, () => pipeline.runCapture(config.get().currentPrompt));
  if (!ok) {
    console.warn('[PeekPhone] 快捷键 ' + conf.hotkey + ' 注册失败，请在设置里换一个');
  }

  // IPC
  ipc.register({ onHotkeyChanged: refreshTray, onPromptsChanged: refreshTray });

  // 托盘
  tray.build(openSettings, quit);

  // mac 纯托盘不进 Dock（常规行为，非反检测）
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // 首启一次性安全提示
  if (!conf.noticeAcknowledged) {
    const macNote =
      process.platform === 'darwin'
        ? '\n\n首次截图时 macOS 会请求「屏幕录制」授权，请在 系统设置 > 隐私与安全性 > 屏幕录制 中放行 PeekPhone 后重开本 App。'
        : '';
    dialog.showMessageBox({
      type: 'info',
      title: 'PeekPhone 使用须知',
      message: '截图会发送给你配置的第三方 AI 服务',
      detail: '请勿截取敏感或公司内部内容。本地服务监听局域网，token 是唯一防线，别把带 token 的链接转发出去。' + macNote,
      buttons: ['我知道了'],
    });
    config.update({ noticeAcknowledged: true });
  }
}

app.on('second-instance', () => openSettings());

app.whenReady().then(boot);

// 托盘常驻：所有窗口关闭不退出
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  shortcut.unregisterAll();
  server.stop();
});
