'use strict';
// 主进程侧 ipcMain 处理器。设置变更按 design §7 运行时生效。
const { ipcMain, app } = require('electron');
const QRCode = require('qrcode');
const config = require('./config');
const prompts = require('./prompts');
const llm = require('./llm');
const net = require('./net');
const server = require('./server');
const shortcut = require('./shortcut');
const { capture } = require('./capture');

let testInFlight = false;
let onHotkeyChanged = null; // 主进程注入：重注册成功后刷新托盘「当前提示词」等
let onPromptsChanged = null;

function register(hooks) {
  onHotkeyChanged = hooks && hooks.onHotkeyChanged;
  onPromptsChanged = hooks && hooks.onPromptsChanged;

  ipcMain.handle('getConfig', () => redact(config.get()));

  ipcMain.handle('updateConfig', (_e, patch) => {
    // 允许更新 providers/maxTokens/压缩参数/keepDays/currentPrompt 等；端口/token/hotkey 走各自专用入口
    const safe = Object.assign({}, patch);
    delete safe.server; // 端口经 setPort、token 经 resetToken
    delete safe.hotkey; // 经 setHotkey
    config.update(safe);
    if (onPromptsChanged && 'currentPrompt' in safe) onPromptsChanged();
    return redact(config.get());
  });

  ipcMain.handle('listPrompts', () => prompts.list());
  ipcMain.handle('readPrompt', (_e, name) => prompts.read(name));
  ipcMain.handle('savePrompt', (_e, { name, text }) => {
    prompts.save(name, text);
    if (onPromptsChanged) onPromptsChanged();
    return prompts.list();
  });
  ipcMain.handle('removePrompt', (_e, name) => {
    prompts.remove(name);
    if (onPromptsChanged) onPromptsChanged();
    return prompts.list();
  });

  // 测试识别：用 UI 传入草稿配置，不走 pipeline、不建 slot、不刷新 latest。
  ipcMain.handle('testRecognition', async (_e, draftConfig) => {
    if (testInFlight) return { error: '正在测试上一张，稍等' };
    testInFlight = true;
    try {
      const shot = await capture();
      const conf = mergeDraft(config.get(), draftConfig);
      const promptName = conf.currentPrompt || 'default';
      const promptText = prompts.read(promptName) || prompts.read('default') || '描述这张截图。';
      const { text, via } = await llm.analyze(shot.buffer, shot.mediaType, promptText.trim(), conf);
      return { ok: true, via, text };
    } catch (error) {
      return { error: String(error.message || error) };
    } finally {
      testInFlight = false;
    }
  });

  ipcMain.handle('setHotkey', (_e, accelerator) => {
    const ok = shortcut.reregister(accelerator);
    if (ok) {
      config.update({ hotkey: accelerator });
      if (onHotkeyChanged) onHotkeyChanged();
    }
    return { ok, hotkey: ok ? accelerator : config.get().hotkey };
  });

  ipcMain.handle('getPhoneConnection', async () => {
    const conf = config.get();
    const ip = net.lanIP();
    const port = server.getPort() || conf.server.port;
    const url = net.phoneURL(ip, port, conf.server.token);
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    return { url, qrDataUrl, ip, port };
  });

  ipcMain.handle('resetToken', async () => {
    config.resetToken(); // server 现读 token，旧链接下次请求即 403
    const conf = config.get();
    const ip = net.lanIP();
    const port = server.getPort() || conf.server.port;
    const url = net.phoneURL(ip, port, conf.server.token);
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    return { url, qrDataUrl };
  });

  ipcMain.handle('setPort', async (_e, port) => {
    const p = parseInt(port, 10);
    if (!p || p < 1 || p > 65535) return { ok: false, error: '端口非法' };
    let errMsg = null;
    const r = await server.restart(p, (m) => {
      errMsg = m;
    });
    if (r.ok) {
      config.update({ server: { port: p } });
      return { ok: true, port: p };
    }
    return { ok: false, error: errMsg || r.error, restored: r.restored };
  });

  ipcMain.handle('setLoginItem', (_e, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      config.update({ launchAtLogin: !!enabled });
      return { ok: true, enabled: !!enabled };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });
}

// 合并 UI 草稿到现有 config，用于测试识别（草稿优先）。
function mergeDraft(conf, draft) {
  if (!draft) return conf;
  const merged = Object.assign({}, conf);
  if (draft.providers) merged.providers = draft.providers;
  if (draft.maxTokens != null) merged.maxTokens = draft.maxTokens;
  if (draft.currentPrompt) merged.currentPrompt = draft.currentPrompt;
  return merged;
}

// 发给 UI 的 config 不暴露 token 明文给渲染进程以外（token 只在手机 URL/二维码里用）。
// 这里保留 api_key 以便 UI 回显（password 框），但不额外泄漏；token 仍随 getPhoneConnection 走。
function redact(conf) {
  return conf;
}

module.exports = { register };
