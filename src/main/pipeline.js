'use strict';
// 一次完整「截图问 AI」编排。移植 peek.py main()，去掉钉钉。
// 模块级 inFlight 防并发：上一张没处理完再触发则弹通知 return，不排队不并发。
const { Notification } = require('electron');
const config = require('./config');
const prompts = require('./prompts');
const llm = require('./llm');
const { capture } = require('./capture');

let store = null;
let inFlight = false;

function setStore(s) {
  store = s;
}

function notify(title, body) {
  try {
    new Notification({ title, body: String(body).slice(0, 400) }).show();
  } catch (e) {
    /* 通知失败不致命 */
  }
}

// runCapture(promptName)。流程：建 pending slot -> capture -> saveImage -> analyze -> done/error -> purge。
async function runCapture(promptName) {
  if (inFlight) {
    notify('截图问AI', '正在处理上一张截图，稍等');
    return { skipped: true };
  }
  inFlight = true;
  const conf = config.get();
  const name = (promptName || conf.currentPrompt || 'default').trim();
  let slot = null;
  try {
    const promptText = prompts.read(name);
    if (promptText == null) {
      notify('截图问AI 失败', '没有提示词 ' + name + '，现有：' + prompts.list().join(', '));
      return { error: '没有提示词 ' + name };
    }

    slot = store.newSlot(name); // 先 pending，手机下次轮询读到「分析中」
    const stamp = slot.slice(0, slot.length - (name.length + 1));
    store.purge(parseInt(conf.keepDays, 10) || 7);

    let shot;
    try {
      shot = await capture(); // {buffer, mediaType, ext}
      store.saveImage(slot, shot.buffer, shot.ext); // 落 shot.<ext>，此后手机显示 pending+截图
    } catch (error) {
      store.saveError(slot, String(error.message || error));
      notify('截图问AI 失败', String(error.message || error));
      return { error: String(error.message || error) };
    }

    try {
      const { text, via } = await llm.analyze(shot.buffer, shot.mediaType, promptText.trim(), conf);
      store.saveAnalysis(slot, stamp, name, via, text);
      store.purge(parseInt(conf.keepDays, 10) || 7);
      return { ok: true, slot, via, head: text.slice(0, 160) };
    } catch (error) {
      const msg = String(error.message || error);
      store.saveError(slot, msg);
      notify('截图问AI 模型没通', msg.split('\n')[0].slice(0, 200));
      return { error: msg };
    }
  } finally {
    inFlight = false;
  }
}

function isInFlight() {
  return inFlight;
}

module.exports = { runCapture, setStore, isInFlight };
