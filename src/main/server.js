'use strict';
// 本地 http 服务。移植 serve.py 的 Handler。监听 0.0.0.0:<port>。
// token 每请求现读 config.getToken()（不缓存，保证重置 token 立即生效），timingSafeEqual 等长比较。
// 路由：/latest（轮询 key）、/img/<slot>/<file>（防穿越）、/（页面）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const config = require('./config');
const page = require('./page');

// 赞助码：唯一允许的静态图白名单，走现有鉴权，不走 /img 的 slot 逻辑。
const SPONSOR_PATH = path.join(__dirname, '..', '..', 'assets', 'sponsor-wechat.jpg');

let server = null;
let currentPort = null;
let store = null;

function setStore(s) {
  store = s;
}

function authed(query) {
  const given = query.t || '';
  if (!given) return false;
  const token = config.getToken();
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false; // 等长才比，长度不等直接否
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, type, body, extraHeaders) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = Object.assign(
    { 'Content-Type': type, 'Content-Length': payload.length },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(payload);
}

function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const query = parsed.query || {};
  if (!authed(query)) {
    return send(res, 403, 'text/plain; charset=utf-8', '403 需要带 ?t=<token> 访问');
  }
  const token = config.getToken();
  const pathname = decodeURI(parsed.pathname || '/');

  if (pathname.startsWith('/img/')) {
    const rest = pathname.slice('/img/'.length);
    const parts = rest.split('/').filter((p) => p.length);
    if (parts.length !== 2) return send(res, 404, 'text/plain', 'not found');
    const real = store.resolveImagePath(parts[0], parts[1]);
    if (!real) return send(res, 404, 'text/plain', 'not found');
    const data = fs.readFileSync(real);
    const type = real.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    return send(res, 200, type, data);
  }

  if (pathname === '/latest') {
    const payload = JSON.stringify({
      key: store.latestKey(),
      showSponsor: config.shouldShowSponsor(),
    });
    return send(res, 200, 'application/json; charset=utf-8', payload, { 'Cache-Control': 'no-store' });
  }

  // 用户在手机页点「知道了」关闭 aha 赞助卡片，写回 config 之后不再提（走现有 token 鉴权）。
  if (pathname === '/sponsor/dismiss') {
    config.dismissSponsor();
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }), {
      'Cache-Control': 'no-store',
    });
  }

  // 赞助码图（鉴权后返回，不内联进 HTML）。图缺失（CI 未注入 / fork）返回 404，前端走文字降级。
  if (pathname === '/sponsor') {
    if (!fs.existsSync(SPONSOR_PATH)) return send(res, 404, 'text/plain', 'not found');
    const data = fs.readFileSync(SPONSOR_PATH);
    return send(res, 200, 'image/jpeg', data, { 'Cache-Control': 'no-store' });
  }

  // 历史列表：倒序最近 50 条 {name,state}，供手机翻页
  if (pathname === '/history') {
    const payload = JSON.stringify({ items: store.listSlots(50) });
    return send(res, 200, 'application/json; charset=utf-8', payload, { 'Cache-Control': 'no-store' });
  }

  // 取某条：JSON 返回 page 渲染所需字段（防穿越复用 store.getItem 校验）
  if (pathname === '/item') {
    const item = store.getItem(query.name || '');
    if (!item) return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }));
    const payload = JSON.stringify({
      name: item.name,
      state: item.state,
      text: item.text,
      image: item.image, // 'shot.jpg' | 'shot.png' | null
      pretty: page.pretty(item.name),
    });
    return send(res, 200, 'application/json; charset=utf-8', payload, { 'Cache-Control': 'no-store' });
  }

  // /
  const key = store.latestKey();
  const item = store.latest();
  const html = page.renderPage(item, token, key, {
    showSponsor: config.shouldShowSponsor(),
    sponsorAvailable: fs.existsSync(SPONSOR_PATH),
  });
  return send(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
}

// start/restart 回调 onError(message) 用于 UI/通知反馈 EADDRINUSE 等。
function start(port, onError) {
  return new Promise((resolve) => {
    const srv = http.createServer(handle);
    srv.on('error', (err) => {
      if (onError) onError(err.code === 'EADDRINUSE' ? '端口 ' + port + ' 被占用' : String(err.message));
      resolve({ ok: false, error: err.code || String(err.message) });
    });
    srv.listen(port, '0.0.0.0', () => {
      server = srv;
      currentPort = port;
      resolve({ ok: true, port });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      currentPort = null;
      resolve();
    });
  });
}

// 换端口：先关旧的再在新端口起；新端口起不来则尝试恢复旧端口，回报失败。
async function restart(port, onError) {
  const oldPort = currentPort;
  await stop();
  const r = await start(port, onError);
  if (r.ok) return r;
  // 新端口失败，尝试恢复旧端口
  if (oldPort != null && oldPort !== port) {
    const back = await start(oldPort, onError);
    return { ok: false, error: r.error, restored: back.ok ? oldPort : null };
  }
  return r;
}

function getPort() {
  return currentPort;
}

module.exports = { start, stop, restart, setStore, getPort };
