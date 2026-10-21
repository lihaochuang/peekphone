'use strict';
// 设置 UI 逻辑。经 window.api.*（preload 暴露）调 IPC，全 Promise 化。
const $ = (id) => document.getElementById(id);

const PRESETS = {
  zhipu: { format: 'openai_chat', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
  bailian: { format: 'openai_chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus' },
  openai: { format: 'openai_chat', base_url: '', model: '' },
  anthropic: { format: 'anthropic_messages', base_url: '', model: '' },
};

// ---- 未保存改动跟踪（A）----
// 模型区与通用区是「改了要点保存」的延迟保存；其余（提示词/快捷键/端口/开机自启/当前提示词）各自即时保存。
const MODEL_KEYS = ['format', 'base_url', 'api_key', 'model', 'stream', 'maxTokens'];
const GENERAL_KEYS = ['keepDays', 'shrinkLongEdge', 'jpegQuality'];
let savedState = null; // 已落盘配置快照，用于按「实际差异」判脏

function captureState() {
  return {
    format: getFormat(),
    base_url: $('base_url').value.trim(),
    api_key: $('api_key').value,
    model: $('model').value.trim(),
    stream: $('stream').checked,
    maxTokens: parseInt($('maxTokens').value, 10) || 800,
    keepDays: parseInt($('keepDays').value, 10) || 7,
    shrinkLongEdge: parseInt($('shrinkLongEdge').value, 10) || 1200,
    jpegQuality: parseInt($('jpegQuality').value, 10) || 70,
  };
}
function applyState(s) {
  setFormat(s.format);
  $('base_url').value = s.base_url;
  $('api_key').value = s.api_key;
  $('model').value = s.model;
  $('stream').checked = s.stream;
  $('maxTokens').value = s.maxTokens;
  $('keepDays').value = s.keepDays;
  $('shrinkLongEdge').value = s.shrinkLongEdge;
  $('jpegQuality').value = s.jpegQuality;
}
function isDirty() {
  if (!savedState) return false;
  const cur = captureState();
  return [...MODEL_KEYS, ...GENERAL_KEYS].some((k) => cur[k] !== savedState[k]);
}
function updateDirtyUI() {
  const dirty = isDirty();
  $('dirtyBar').style.display = dirty ? 'block' : 'none';
  $('saveModel').classList.toggle('dirty', dirty);
  $('saveGeneral').classList.toggle('dirty', dirty);
  document.title = (dirty ? '● 未保存 — ' : '') + 'PeekPhone 设置';
  if (window.api.setDirty) window.api.setDirty(dirty);
}
// 存模型区：持久化 providers + maxTokens，并把模型键并入 savedState
async function saveModelConfig() {
  await window.api.updateConfig({ providers: [draftProvider()], maxTokens: captureState().maxTokens });
  const cur = captureState();
  MODEL_KEYS.forEach((k) => (savedState[k] = cur[k]));
  updateDirtyUI();
}
async function saveGeneralConfig() {
  await window.api.updateConfig({
    keepDays: parseInt($('keepDays').value, 10) || 7,
    shrinkLongEdge: parseInt($('shrinkLongEdge').value, 10) || 1200,
    jpegQuality: parseInt($('jpegQuality').value, 10) || 70,
  });
  const cur = captureState();
  GENERAL_KEYS.forEach((k) => (savedState[k] = cur[k]));
  updateDirtyUI();
}
async function saveAll() {
  await saveModelConfig();
  await saveGeneralConfig();
}

// 标签切换（有脏则先确认 保存/放弃/取消）
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => requestTab(btn.dataset.tab));
});
async function requestTab(tab) {
  const active = document.querySelector('.tabs button.active');
  if (active && active.dataset.tab === tab) return;
  if (isDirty()) {
    const choice = await window.api.confirmUnsaved();
    if (choice === 'cancel') return;
    if (choice === 'save') await saveAll();
    else {
      applyState(savedState);
      updateDirtyUI();
    }
  }
  gotoTab(tab);
}

// 主进程要求「保存并关闭」：保存后通知主进程销毁窗口
if (window.api.onSaveAll)
  window.api.onSaveAll(async () => {
    await saveAll();
    if (window.api.closingAfterSave) window.api.closingAfterSave();
  });
function gotoTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.dataset.pane === tab));
  if (tab === 'phone') refreshPhone();
  if (tab === 'sponsor') refreshSponsor();
}

let sponsorLoaded = false;
async function refreshSponsor() {
  if (sponsorLoaded) return;
  const dataUri = await window.api.getSponsorImage();
  if (dataUri) {
    $('sponsorImg').src = dataUri;
    $('sponsorImg').style.display = 'block';
    $('sponsorFallback').style.display = 'none';
  } else {
    // 收款码缺失（本地开发 / fork）：隐藏碎图，显示文字 + 项目主页降级。
    $('sponsorImg').style.display = 'none';
    $('sponsorFallback').style.display = 'block';
  }
  sponsorLoaded = true;
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
    model: $('model').value.trim(), // 留空 = 自动
    stream: $('stream').checked,
    timeout: 120,
    retries: 3,
  };
}

// 展示上游可用模型清单（测试识图拿到 supportedModels 时）
function showSupported(list) {
  if (list && list.length) $('supportedModels').textContent = '上游可用模型：' + list.join('、');
}
function draftConfig() {
  return {
    providers: [draftProvider()],
    maxTokens: parseInt($('maxTokens').value, 10) || 800,
    currentPrompt: $('currentPrompt').value || 'default',
  };
}

$('saveModel').addEventListener('click', async () => {
  await saveModelConfig();
  flash($('testResult'), '已保存模型配置');
});

$('testBtn').addEventListener('click', async () => {
  $('testResult').textContent = '截屏并调用模型中…';
  const r = await window.api.testRecognition(draftConfig());
  if (r.supportedModels) showSupported(r.supportedModels);
  if (r.ok) {
    // A：测试通过即自动落盘，消除「测了没保存」脱节；给轻量成功反馈
    await saveModelConfig();
    $('testResult').textContent = '✅ 已测试并保存 ✓  ' + r.via + '\n\n' + r.text;
  } else {
    // 人话优先，原始详情折叠在后
    let out = '❌ ' + (r.error || '调用失败');
    if (r.detail) out += '\n\n────── 详情 ──────\n' + r.detail;
    $('testResult').textContent = out;
  }
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
  await saveGeneralConfig();
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
  $('stream').checked = p.stream === true;
  $('maxTokens').value = c.maxTokens || 800;
  $('hotkeyInput').value = c.hotkey || 'CommandOrControl+Alt+P';
  $('keepDays').value = c.keepDays || 7;
  $('shrinkLongEdge').value = c.shrinkLongEdge || 1200;
  $('jpegQuality').value = c.jpegQuality || 70;
  $('launchAtLogin').checked = !!c.launchAtLogin;
  if (c.supportedModels) showSupported(c.supportedModels);
  await loadPrompts();
  // 快照 + 脏检测布线
  savedState = captureState();
  ['base_url', 'api_key', 'model', 'maxTokens', 'keepDays', 'shrinkLongEdge', 'jpegQuality'].forEach(
    (id) => {
      $(id).addEventListener('input', updateDirtyUI);
    }
  );
  $('stream').addEventListener('change', updateDirtyUI);
  $('preset').addEventListener('change', updateDirtyUI);
  document.querySelectorAll('input[name=format]').forEach((r) => r.addEventListener('change', updateDirtyUI));
  updateDirtyUI();
}
init();
