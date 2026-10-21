'use strict';
// 一次完整「截图问 AI」编排。移植 peek.py main()，去掉钉钉。
// 模块级 inFlight 防并发：上一张没处理完再触发则弹通知 return，不排队不并发。
const fs = require('fs');
const path = require('path');
const { app, Notification } = require('electron');
const config = require('./config');
const prompts = require('./prompts');
const llm = require('./llm');
const { capture } = require('./capture');

let store = null;
let inFlight = false;
let currentAbort = null; // 进行中那张的 AbortController（供总超时/强制刷新中止）
let currentRunPromise = null; // 进行中那张的 promise（强制刷新前 await 它真正释放 inFlight）

// 错误正文分隔：friendly 人话 + 原始详情。page.js 用同一常量解析，两处必须一致。
const DETAIL_SEP = '\n\n────── 详情 ──────\n';

function setStore(s) {
  store = s;
}

// 一律不弹桌面通知（用户明确要求）。所有情况只写滚动日志 + 手机页状态。
function notify(title, body) {
  logEvent('NOTE ' + title + ': ' + String(body).slice(0, 400));
}

// 滚动日志：每次截图/分析的时间、provider/model、成功或失败原因全文写进 userData/logs/peek.log。
// 失败一律不弹桌面通知，只进此日志 + 手机页 error 态，供排查。单文件超 1MB 轮转一份 .1。
function logEvent(line) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'peek.log');
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.1');
    } catch (e) {
      /* 轮转失败不致命 */
    }
    fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch (e) {
    /* 日志失败不致命 */
  }
}

// runCapture(promptName)：正常截图。inFlight 时静默跳过（尊重进行中的那张，⌘⌥P 行为不变）。
function runCapture(promptName) {
  if (inFlight) {
    notify('截图问AI', '正在处理上一张截图，稍等');
    return Promise.resolve({ skipped: true });
  }
  return start(promptName);
}

// runCaptureForce(promptName)：强制重来。若有进行中的那张，先中止它（真正 abort 挂起请求 + 放锁），
// 等它结束后立即开新的一次。任何时候按都有反应，是用户卡住时的解套键（⌘⌥O）。
async function runCaptureForce(promptName) {
  if (inFlight && currentAbort) {
    currentAbort.forced = true;
    try {
      currentAbort.abort();
    } catch (e) {
      /* ignore */
    }
    try {
      await currentRunPromise; // 等旧的 finally 真正把 inFlight 放掉，否则新的会被跳过
    } catch (e) {
      /* 旧的被中止会 settle，忽略 */
    }
    logEvent('FORCE 中止进行中的那张，立即重来');
  }
  return start(promptName);
}

// 装配 AbortController + 总硬超时，跑一次 runOnce；finally 统一释放 inFlight / 清 timer。
function start(promptName) {
  inFlight = true;
  const conf = config.get();
  const ac = new AbortController();
  ac.timedOut = false;
  ac.forced = false;
  currentAbort = ac;
  const totalMs = (parseInt(conf.analyzeTimeout, 10) || 60) * 1000;
  const timer = setTimeout(() => {
    ac.timedOut = true;
    try {
      ac.abort(); // 真正中断挂起的 fetch，而非只逻辑放弃
    } catch (e) {
      /* ignore */
    }
  }, totalMs);
  const p = runOnce(promptName, conf, ac)
    .finally(() => {
      clearTimeout(timer);
      inFlight = false;
      if (currentAbort === ac) currentAbort = null;
      if (currentRunPromise === p) currentRunPromise = null;
    });
  currentRunPromise = p;
  return p;
}

// 单次流程：建 pending slot -> capture -> saveImage -> analyze -> done/error -> purge。
// ac 的总超时/强制中止会把 fetch 真正 abort；中止路径落 error 态并照常走 finally 放锁。
async function runOnce(promptName, conf, ac) {
  const name = (promptName || conf.currentPrompt || 'default').trim();
  let slot = null;
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
    const msg = String(error.message || error);
    store.saveError(slot, msg);
    logEvent('FAIL capture slot=' + slot + ' reason=' + msg);
    return { error: msg };
  }

  try {
    // 流式回调：节流 ≥300ms 写一次部分文本，手机轮询即可看到文本逐步变长。
    // provider 未开 stream 时 llm.analyze 不会调用它，等价于原非流式行为。
    let lastWrite = 0;
    const onDelta = (_delta, full) => {
      const now = Date.now();
      if (now - lastWrite >= 300) {
        lastWrite = now;
        try {
          store.savePartial(slot, full);
        } catch (e) {
          /* 部分文本写失败不致命，done 时仍落最终结果 */
        }
      }
    };
    const { text, via } = await llm.analyze(
      shot.buffer,
      shot.mediaType,
      promptText.trim(),
      conf,
      onDelta,
      ac.signal // 总超时/强制刷新经此真正中断流式与非流式请求
    );
    store.saveAnalysis(slot, stamp, name, via, text);
    store.purge(parseInt(conf.keepDays, 10) || 7);
    // aha 时刻：一次有效分析成功 +1，供手机页在首次成功后低调提一次赞助。
    try {
      config.recordSuccess();
    } catch (e) {
      /* 计数失败不影响主流程 */
    }
    logEvent('OK slot=' + slot + ' via=' + via + ' len=' + text.length);
    return { ok: true, slot, via, head: text.slice(0, 160) };
  } catch (error) {
    // 总超时/强制刷新中止：请求已被真正 abort，写明确的中止态（不弹窗，只日志 + 手机页）
    if (ac.signal.aborted) {
      const friendly = ac.timedOut ? '分析超时，已中止' : '已被强制刷新中止';
      store.saveError(slot, friendly);
      logEvent((ac.timedOut ? 'TIMEOUT' : 'ABORT') + ' slot=' + slot + ' reason=' + friendly);
      return { error: friendly, aborted: true, timedOut: ac.timedOut };
    }
    // 人话优先：friendly 一句 + 可展开详情（DETAIL_SEP 必须与 page.js 常量一致）
    const friendly = error.friendly || String(error.message || error);
    const detail = error.detail || '';
    store.saveError(slot, detail ? friendly + DETAIL_SEP + detail : friendly);
    // 失败不弹桌面通知，只进滚动日志 + 手机页 error 态
    logEvent('FAIL analyze slot=' + slot + ' reason=' + friendly + (detail ? ' | ' + detail.replace(/\n/g, ' ') : ''));
    return { error: friendly };
  }
}

function isInFlight() {
  return inFlight;
}

module.exports = { runCapture, runCaptureForce, setStore, isInFlight };
