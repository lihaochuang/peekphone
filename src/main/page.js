'use strict';
// 手机页面 HTML。逐字移植 serve.py 的 PAGE 模板 / pretty() / 三态文案 / 2s 轮询 JS / 深浅色 / 只显示最新一条。
// 导出 renderPage(item, token) 与 renderEmpty()。token 与 key 经 JSON.stringify 注入脚本，图片 URL 带 ?t=token。

// 自写 HTML escape（Node 侧无 html.escape）。
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// 20261021_125058_default -> 12:50:58 · default
function pretty(name) {
  const parts = name.split('_');
  if (parts.length >= 2 && parts[1].length === 6) {
    const clock = parts[1].slice(0, 2) + ':' + parts[1].slice(2, 4) + ':' + parts[1].slice(4);
    const tail = parts.slice(2).join('_');
    return tail ? clock + ' · ' + tail : clock;
  }
  return name;
}

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>截图问AI</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:10px 12px 28px;font:16px/1.65 -apple-system,"PingFang SC",sans-serif;
     background:#f5f5f7;color:#1d1d1f;-webkit-text-size-adjust:100%}
@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}
  .card{background:#1c1c1e!important}.bar{background:#1c1c1e!important}}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:8px;
     background:#f5f5f7;padding:6px 2px 10px;font-size:13px;color:#86868b}
.bar b{color:inherit;font-weight:600;font-size:14px}
.dot{width:7px;height:7px;border-radius:50%;background:#30d158;flex:none;
     animation:blink 2s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.card{background:#fff;border-radius:14px;padding:12px;margin-bottom:12px}
img{width:100%;border-radius:10px;display:block}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}
.pending{color:#86868b}
.empty{color:#86868b;text-align:center;padding:60px 20px}
</style></head><body>
<div class="bar"><span class="dot"></span><b>__TITLE__</b><span>__NOTE__</span></div>
__CONTENT__
<script>
const T=__TOKEN_JSON__, KEY=__KEY_JSON__;
let busy=false;
async function tick(){
  if(busy||document.hidden)return; busy=true;
  try{
    const r=await fetch('/latest?t='+encodeURIComponent(T),{cache:'no-store'});
    if(r.ok){const d=await r.json(); if(d.key!==KEY)location.reload();}
  }catch(e){}
  busy=false;
}
setInterval(tick,2000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});
</script></body></html>`;

const NOTE = { done: '自动刷新中', pending: '分析中', error: '出错了' };

function fill(title, note, content, token, key) {
  return PAGE.replace('__CONTENT__', content)
    .replace('__TITLE__', escapeHtml(title))
    .replace('__NOTE__', escapeHtml(note))
    .replace('__TOKEN_JSON__', JSON.stringify(token))
    .replace('__KEY_JSON__', JSON.stringify(key));
}

// renderEmpty 的 key 应与 store.latestKey() 对空态的返回一致（'empty'）。
function renderEmpty(token) {
  const content = '<p class="empty">按快捷键截一张，这页会自己刷出来。</p>';
  return fill('还没有截图', '按一下快捷键', content, token, 'empty');
}

// item: {name, image, state, text}；key 由调用方传入（= store.latestKey()，保证与轮询比对一致）。
function renderPage(item, token, key) {
  if (!item) return renderEmpty(token);
  const title = pretty(item.name);
  const note = NOTE[item.state];
  const blocks = [];
  if (item.image) {
    const src =
      '/img/' +
      encodeURIComponent(item.name) +
      '/' +
      encodeURIComponent(item.image) +
      '?t=' +
      encodeURIComponent(token);
    blocks.push(
      '<div class="card"><a href="' + src + '"><img src="' + src + '" alt="截图"></a></div>'
    );
  }
  const cls = item.state === 'pending' ? ' class="pending"' : '';
  blocks.push('<div class="card"><pre' + cls + '>' + escapeHtml(item.text) + '</pre></div>');
  const effectiveKey = key != null ? key : item.name + '|' + item.state;
  return fill(title, note, blocks.join(''), token, effectiveKey);
}

module.exports = { renderPage, renderEmpty, pretty, escapeHtml };
