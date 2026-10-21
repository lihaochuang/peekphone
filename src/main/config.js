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
        stream: false,
        timeout: 120,
        retries: 3,
      },
    ],
    // 自动选模型的候选池（model 留空时按此顺序挑上游支持的视觉模型）。
    model_priority: [
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'kimi-k3',
      'gpt-4o',
      'qwen-vl-max',
      'qwen-vl-plus',
      'glm-4v',
      'glm-4.5v',
    ],
    maxTokens: 800,
    shrinkLongEdge: 1200,
    jpegQuality: 70,
    keepDays: 7,
    // 整个 runCapture（截图→分析出文本）的总硬超时（秒）。超过即中止挂起的请求、写 error、放锁。
    // 比单 provider 的 timeout/重试累计更短，用于防「上游挂起 → inFlight 一直占着像卡死」。
    analyzeTimeout: 60,
    hotkey: 'CommandOrControl+Alt+P',
    // 强制刷新键：中止进行中的那张并立即重来，任何时候按都有反应（卡住时的解套键）。
    hotkeyForce: 'CommandOrControl+Alt+O',
    currentPrompt: 'default',
    launchAtLogin: false,
    noticeAcknowledged: false,
    // aha 时刻赞助：successCount 累计成功分析次数；sponsorShown 置真后手机页不再提赞助。
    successCount: 0,
    sponsorShown: false,
    server: { port: 8765, token: '' },
  };
}

// 阈值：第 1 次成功分析即算 aha 时刻。觉得第 3 次更稳可改这里（连带注释）。
const SPONSOR_SUCCESS_THRESHOLD = 1;

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

// 一次有效分析成功后 +1（pipeline 调用）。
function recordSuccess() {
  const d = get();
  return update({ successCount: (parseInt(d.successCount, 10) || 0) + 1 });
}

// 手机页该不该低调提一次赞助：到阈值且还没提过。
function shouldShowSponsor() {
  const d = get();
  return !d.sponsorShown && (parseInt(d.successCount, 10) || 0) >= SPONSOR_SUCCESS_THRESHOLD;
}

// 用户点「知道了」后置真，之后不再提。
function dismissSponsor() {
  return update({ sponsorShown: true });
}

module.exports = {
  get,
  update,
  getToken,
  resetToken,
  configPath,
  defaults,
  recordSuccess,
  shouldShowSponsor,
  dismissSponsor,
};
