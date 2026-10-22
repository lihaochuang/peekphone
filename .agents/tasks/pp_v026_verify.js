'use strict';
// v0.2.6 验证：mock electron + ./capture + ./llm，跑真实 config/store/server/pipeline/page，
// 按 main.js 方式接线 server.setTrigger，起真 HTTP 服务后用 http 客户端打 /capture 各路径。
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const APP = '/Users/harry/诺亚方舟/任务档案/20261021_PeekPhone桌面App/src/main';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pp026-'));

// —— 可控的假 llm：默认快速返回；release/hold 控制 inFlight —— //
let holdResolve = null;
let holdMode = false;
const fakeLlm = {
  analyze(buffer, mediaType, prompt, conf, onDelta, signal) {
    if (holdMode) {
      return new Promise((resolve, reject) => {
        holdResolve = () => resolve({ text: 'FAKE HELD', via: 'fake' });
        if (signal) {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
      });
    }
    return Promise.resolve({ text: 'FAKE ANALYSIS OK', via: 'fake-model' });
  },
};

const fakeCapture = {
  capture() {
    return Promise.resolve({ buffer: Buffer.from('fakejpegbytes'), mediaType: 'image/jpeg', ext: 'jpg' });
  },
};

const fakeElectron = {
  app: { getPath: () => userData },
  Notification: function () { return { show() {} }; },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === './capture' || request.endsWith('/capture')) {
    if (parent && parent.filename && parent.filename.includes(APP)) return fakeCapture;
  }
  if (request === './llm') {
    if (parent && parent.filename && parent.filename.includes(APP)) return fakeLlm;
  }
  return origLoad(request, parent, isMain);
};

const config = require(path.join(APP, 'config'));
const { createStore } = require(path.join(APP, 'store'));
const server = require(path.join(APP, 'server'));
const pipeline = require(path.join(APP, 'pipeline'));

const prompts = require(path.join(APP, 'prompts'));
prompts.seedDefaults(); // 与 main.js boot 一致，否则 pipeline 读不到提示词会提前 return

const store = createStore(path.join(userData, 'history'));
server.setStore(store);
pipeline.setStore(store);

// 与 main.js 一致的接线
server.setTrigger((force) => {
  const promptName = config.get().currentPrompt;
  if (force) {
    pipeline.runCaptureForce(promptName);
    return { ok: true };
  }
  if (pipeline.isInFlight()) return { skipped: true };
  pipeline.runCapture(promptName);
  return { ok: true };
});

const TOKEN = config.getToken();
const PORT = 8799;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, pathWithQ) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathWithQ }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.end();
  });
}

(async () => {
  const s = await server.start(PORT, () => {});
  if (!s.ok) { console.log('server start failed', s); process.exit(1); }

  console.log('# 1. token 鉴权 + 方法限制');
  let r = await req('POST', '/capture?t=' + TOKEN);
  ok(r.status === 200 && JSON.parse(r.body).ok === true, 'POST /capture 带 token → 200 {ok:true}');
  r = await req('POST', '/capture');
  ok(r.status === 403, 'POST /capture 不带 token → 403');
  r = await req('POST', '/capture?t=wrongtoken');
  ok(r.status === 403, 'POST /capture 错 token → 403');
  r = await req('GET', '/capture?t=' + TOKEN);
  ok(r.status === 405 && (r.headers.allow || '').includes('POST'), 'GET /capture → 405 Allow:POST（不触发）');

  // 等第一次（上面那次 POST）真正触发的分析落 done
  console.log('# 2. 真的触发了一次截图分析（经真实 pipeline + store）');
  let latestKey = '';
  for (let i = 0; i < 40; i++) { latestKey = store.latestKey(); if (/\|done$/.test(latestKey)) break; await sleep(50); }
  ok(/\|done$/.test(latestKey), 'POST /capture 后 store 产生一条 slot 且最终 done: ' + latestKey);
  ok(store.listSlots(50).length >= 1, 'history 至少多了一条 slot');

  console.log('# 3. GET 不触发：history 条数不增');
  const before = store.listSlots(50).length;
  await req('GET', '/capture?t=' + TOKEN);
  await sleep(150);
  ok(store.listSlots(50).length === before, 'GET /capture 未新增 slot（条数不变 ' + before + '）');

  console.log('# 4. inFlight 时返回 {skipped}');
  holdMode = true; // 让分析挂起制造 inFlight
  r = await req('POST', '/capture?t=' + TOKEN); // 触发一次，会挂住
  ok(r.status === 200 && JSON.parse(r.body).ok === true, '触发挂起分析 → {ok:true}');
  await sleep(100);
  ok(pipeline.isInFlight() === true, 'pipeline 处于 inFlight');
  r = await req('POST', '/capture?t=' + TOKEN); // inFlight 再触发
  ok(r.status === 200 && JSON.parse(r.body).skipped === true, 'inFlight 时再 POST /capture → {skipped:true}');

  console.log('# 5. force=1 中止重来');
  r = await req('POST', '/capture?t=' + TOKEN + '&force=1'); // 强制重来：abort 挂起那张
  ok(r.status === 200 && JSON.parse(r.body).ok === true, 'POST /capture?force=1 → {ok:true}');
  holdMode = false; // 之后的分析正常完成
  if (holdResolve) { try { holdResolve(); } catch (e) {} }
  // 等强制重来那张完成
  for (let i = 0; i < 60; i++) { latestKey = store.latestKey(); if (/\|done$/.test(latestKey)) break; await sleep(50); }
  ok(/\|done$/.test(latestKey), 'force 后新一张分析最终 done: ' + latestKey);
  // 被中止的那张：直接读滚动日志证明 force 真的中止了进行中的请求（slot 名按秒取时间戳，
  // 同秒触发会撞同一目录导致 state 读成 done，故用日志而非 state 断言，避免测试时序假象）。
  const logFile = path.join(userData, 'logs', 'peek.log');
  const logTxt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  ok(/FORCE 中止进行中的那张/.test(logTxt) && /ABORT .*已被强制刷新中止/.test(logTxt),
    'force 真正中止了进行中的那张（日志含 FORCE + ABORT）');

  console.log('# 6. 手机页 HTML 按钮存在且指向 /capture');
  const page = require(path.join(APP, 'page'));
  const emptyHtml = page.renderEmpty(TOKEN);
  ok(emptyHtml.includes('id="capBtn"') && emptyHtml.includes('📸 截图分析'), '空状态含 📸 截图分析 按钮');
  const item = { name: '20261021_120000_default', image: 'shot.jpg', state: 'done', text: 'hi' };
  const recHtml = page.renderPage(item, TOKEN, '20261021_120000_default|done', { showSponsor: false, sponsorAvailable: false });
  ok(recHtml.includes('id="capBtn"') && recHtml.includes('📸 截图分析'), '有记录态含 📸 截图分析 按钮');
  ok(recHtml.includes("fetch('/capture?t='+enc(T),{method:'POST'"), 'JS 以 POST 指向 /capture?t=<token>');
  ok(/triggerCapture[\s\S]*3000/.test(recHtml), '按钮触发后 3 秒节流禁用逻辑存在');

  await server.stop();
  console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
