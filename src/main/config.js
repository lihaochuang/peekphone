'use strict';
// 配置唯一读写入口。路径 app.getPath('userData')/config.json。
// 首次无文件写默认形状 + crypto.randomBytes(18).base64url 生成 server.token，写后 chmod 0o600。
// 默认 provider 的 base_url/api_key/model 全空（开源仓库不含任何真实凭证）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

let cachePath = null;

function configPath() {
  if (!cachePath) cachePath = path.join(app.getPath('userData'), 'config.json');
  return cachePath;
}

function defaults() {
  return {
    providers: [
      {
        name: '我的模型',
        enabled: true,
        format: 'openai_chat',
        base_url: '',
        api_key: '',
        model: '',
        timeout: 120,
        retries: 3,
      },
    ],
    maxTokens: 1500,
    shrinkLongEdge: 1200,
    jpegQuality: 70,
    keepDays: 7,
    hotkey: 'CommandOrControl+Alt+P',
    currentPrompt: 'default',
    launchAtLogin: false,
    noticeAcknowledged: false,
    server: { port: 8765, token: '' },
  };
}

function writeFile(data) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(p, 0o600); // Windows 上无效果但无害
  } catch (e) {
    /* ignore */
  }
}

function get() {
  const p = configPath();
  let data;
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      data = defaults();
    }
  } else {
    data = defaults();
  }
  // 补全缺失的 token（首次或被清空）
  if (!data.server) data.server = { port: 8765, token: '' };
  if (!data.server.token) {
    data.server.token = crypto.randomBytes(18).toString('base64url');
    writeFile(data);
  } else if (!fs.existsSync(p)) {
    writeFile(data);
  }
  return data;
}

function update(patch) {
  const data = get();
  const merged = Object.assign({}, data, patch);
  // server 子对象做浅合并，避免 patch 只带 port 时丢掉 token
  if (patch.server) merged.server = Object.assign({}, data.server, patch.server);
  writeFile(merged);
  return merged;
}

function getToken() {
  return get().server.token;
}

// 重置 token：生成新的，旧链接立即失效。
function resetToken() {
  const data = get();
  data.server.token = crypto.randomBytes(18).toString('base64url');
  writeFile(data);
  return data.server.token;
}

module.exports = { get, update, getToken, resetToken, configPath, defaults };
