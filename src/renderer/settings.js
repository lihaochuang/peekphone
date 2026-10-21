'use strict';
// 设置 UI 逻辑。经 window.api.*（preload 暴露）调 IPC，全 Promise 化。
const $ = (id) => document.getElementById(id);

const PRESETS = {
  zhipu: { format: 'openai_chat', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
  bailian: { format: 'openai_chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus' },
  openai: { format: 'openai_chat', base_url: '', model: '' },
  anthropic: { format: 'anthropic_messages', base_url: '', model: '' },
};

// 标签切换
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => gotoTab(btn.dataset.tab));
});
function gotoTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.dataset.pane === tab));
  if (tab === 'phone') refreshPhone();
}
if (window.api.onGotoTab) window.api.onGotoTab(gotoTab);

function setFormat(fmt) {
  document.querySelectorAll('input[name=format]').forEach((r) => (r.checked = r.value === fmt));
}
function getFormat() {
  const r = document.querySelector('input[name=format]:checked');
  return r ? r.value : 'openai_chat';
}

$('preset').addEventListener('change', () => {
  const p = PRESETS[$('preset').value];
  if (!p) return;
  setFormat(p.format);
  $('base_url').value = p.base_url;
  $('model').value = p.model;
});

$('toggleKey').addEventListener('click', () => {
  $('api_key').type = $('api_key').type === 'password' ? 'text' : 'password';
});

function draftProvider() {
  return {
    name: '我的模型',
    enabled: true,
    format: getFormat(),
    base_url: $('base_url').value.trim(),
    api_key: $('api_key').value,
    model: $('model').value.trim(),
    timeout: 120,
    retries: 3,
  };
}
function draftConfig() {
  return {
    providers: [draftProvider()],
    maxTokens: parseInt($('maxTokens').value, 10) || 1500,
    currentPrompt: $('currentPrompt').value || 'default',
  };
}

$('saveModel').addEventListener('click', async () => {
  await window.api.updateConfig({
    providers: [draftProvider()],
    maxTokens: parseInt($('maxTokens').value, 10) || 1500,
  });
  flash($('testResult'), '已保存模型配置');
});

$('testBtn').addEventListener('click', async () => {
  $('testResult').textContent = '截屏并调用模型中…';
  const r = await window.api.testRecognition(draftConfig());
  if (r.ok) $('testResult').textContent = '✅ ' + r.via + '\n\n' + r.text;
  else $('testResult').textContent = '❌ ' + r.error;
});

// 提示词
let prompts = [];
async function loadPrompts() {
  prompts = await window.api.listPrompts();
  const cur = (await window.api.getConfig()).currentPrompt;
  fillSelect($('promptList'), prompts);
  fillSelect($('currentPrompt'), prompts, cur);
  if (prompts.length) loadPromptText(prompts[0]);
}
function fillSelect(sel, items, selected) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it;
    o.textContent = it;
    if (it === selected) o.selected = true;
    sel.appendChild(o);
  }
}
async function loadPromptText(name) {
  $('promptText').value = (await window.api.readPrompt(name)) || '';
}
$('promptList').addEventListener('change', () => loadPromptText($('promptList').value));
$('savePromptBtn').addEventListener('click', async () => {
  const name = $('promptList').value;
  if (!name) return;
  await window.api.savePrompt(name, $('promptText').value);
  flash($('promptText'), null, '已保存');
});
$('newPromptBtn').addEventListener('click', async () => {
  const name = $('newPromptName').value.trim();
  if (!name) return;
  await window.api.savePrompt(name, $('promptText').value || '新提示词');
  $('newPromptName').value = '';
  await loadPrompts();
  $('promptList').value = name;
  loadPromptText(name);
});
$('delPromptBtn').addEventListener('click', async () => {
  const name = $('promptList').value;
  if (!name) return;
  await window.api.removePrompt(name);
  await loadPrompts();
});
$('currentPrompt').addEventListener('change', async () => {
  await window.api.updateConfig({ currentPrompt: $('currentPrompt').value });
});

// 快捷键捕获
const mods = { Meta: 'Command', Control: 'Control', Alt: 'Alt', Shift: 'Shift' };
$('hotkeyInput').addEventListener('keydown', (e) => {
  e.preventDefault();
  const parts = [];
  if (e.metaKey) parts.push('Command');
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key;
  if (!(key in mods) && key.length) {
    let k = key.length === 1 ? key.toUpperCase() : key;
    parts.push(k);
    $('hotkeyInput').value = parts.join('+');
  }
});
$('saveHotkey').addEventListener('click', async () => {
  const acc = $('hotkeyInput').value.trim();
  if (!acc) return;
  const r = await window.api.setHotkey(acc);
  $('hotkeyMsg').textContent = r.ok ? '✅ 已生效：' + r.hotkey : '❌ 注册失败（可能被占用/非法），仍用：' + r.hotkey;
});

// 手机连接
async function refreshPhone() {
  const r = await window.api.getPhoneConnection();
  $('qr').src = r.qrDataUrl;
  $('phoneUrl').value = r.url;
  $('port').value = r.port;
}
$('copyUrl').addEventListener('click', () => {
  $('phoneUrl').select();
  navigator.clipboard.writeText($('phoneUrl').value).catch(() => {});
});
$('savePort').addEventListener('click', async () => {
  const r = await window.api.setPort($('port').value);
  if (r.ok) {
    $('phoneMsg').textContent = '✅ 已切换到端口 ' + r.port + '，手机用新二维码重连';
    refreshPhone();
  } else {
    $('phoneMsg').textContent = '❌ ' + r.error + (r.restored ? '（已恢复端口 ' + r.restored + '）' : '');
  }
});
$('resetToken').addEventListener('click', async () => {
  const r = await window.api.resetToken();
  $('qr').src = r.qrDataUrl;
  $('phoneUrl').value = r.url;
  $('phoneMsg').textContent = '✅ token 已重置，旧链接已失效';
});

// 通用
$('launchAtLogin').addEventListener('change', async () => {
  await window.api.setLoginItem($('launchAtLogin').checked);
});
$('saveGeneral').addEventListener('click', async () => {
  await window.api.updateConfig({
    keepDays: parseInt($('keepDays').value, 10) || 7,
    shrinkLongEdge: parseInt($('shrinkLongEdge').value, 10) || 1200,
    jpegQuality: parseInt($('jpegQuality').value, 10) || 70,
  });
  flash($('saveGeneral'), null, '已保存');
});

function flash(el, text, badge) {
  if (text != null) el.textContent = text;
  if (badge) {
    const old = el.textContent;
    el.textContent = badge;
    setTimeout(() => {}, 0);
  }
}

// 初始化
async function init() {
  const c = await window.api.getConfig();
  const p = (c.providers && c.providers[0]) || {};
  setFormat(p.format || 'openai_chat');
  $('base_url').value = p.base_url || '';
  $('api_key').value = p.api_key || '';
  $('model').value = p.model || '';
  $('maxTokens').value = c.maxTokens || 1500;
  $('hotkeyInput').value = c.hotkey || 'CommandOrControl+Alt+P';
  $('keepDays').value = c.keepDays || 7;
  $('shrinkLongEdge').value = c.shrinkLongEdge || 1200;
  $('jpegQuality').value = c.jpegQuality || 70;
  $('launchAtLogin').checked = !!c.launchAtLogin;
  await loadPrompts();
}
init();
