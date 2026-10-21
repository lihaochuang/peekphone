'use strict';
// 手机页面 HTML。移植 serve.py 的 PAGE 模板 / pretty() / 三态文案 / 2s 轮询 JS / 深浅色。
// v0.2：默认仍只渲染最新一条 + 2s 轮询；底部加「查看更早」历史翻页（客户端拉 /history、/item，
//   翻页态暂停轮询、显示「回到最新」）；空状态默认展示赞助二维码；有截图时底部放不显眼赞助入口。
// 导出 renderPage(item, token, key) 与 renderEmpty(token)。token/key 经 JSON.stringify 注入脚本。

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
.err{color:#ff453a;font-weight:600}
details{margin-top:8px}
summary{color:#86868b;font-size:13px;cursor:pointer}
.detail{color:#86868b;font-size:13px;margin-top:6px}
.empty{color:#86868b;text-align:center;padding:30px 20px}
.sponsor-card{text-align:center;padding:18px 16px}
.sponsor-card img{width:220px;max-width:70%;margin:0 auto 10px;border-radius:12px}
.sponsor-card .tip{color:#86868b;font-size:14px}
/* 大按钮：移动端友好，非桌面小链接 */
.btn{display:block;width:100%;padding:14px;border:none;border-radius:12px;
     background:#0a84ff;color:#fff;font:600 16px/1 inherit;cursor:pointer;margin:8px 0}
.btn.ghost{background:rgba(127,127,127,.14);color:inherit}
.histnav{display:flex;gap:8px;margin:8px 0}
.histnav .btn{margin:0;flex:1}
.histnav .btn:disabled{opacity:.4}
.sponsor-foot{text-align:center;margin-top:18px}
.sponsor-foot a{color:#86868b;font-size:13px;text-decoration:none}
.hist-meta{color:#86868b;font-size:13px;text-align:center;margin:4px 0 10px}
</style></head><body>
<div class="bar"><span class="dot"></span><b>__TITLE__</b><span>__NOTE__</span></div>
<div id="live">__CONTENT__</div>
<div id="foot">__FOOTER__</div>
<div id="hist" style="display:none">
  <div class="hist-meta" id="histMeta"></div>
  <div id="histBody"></div>
  <div class="histnav">
    <button class="btn ghost" id="histOlder" type="button">← 更早</button>
    <button class="btn ghost" id="histNewer" type="button">更新 →</button>
  </div>
  <button class="btn" id="histBack" type="button">回到最新</button>
</div>
<script>
const T=__TOKEN_JSON__, KEY=__KEY_JSON__, HAS_ITEMS=__HAS_ITEMS__;
const SEP="\\n\\n────── 详情 ──────\\n";
const enc=encodeURIComponent;
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');}
const NOTE={done:'自动刷新中',pending:'分析中',error:'出错了'};
function textCard(state,text){
  if(state==='error'){
    const i=text.indexOf(SEP);
    const f=i>=0?text.slice(0,i):text, d=i>=0?text.slice(i+SEP.length):'';
    let h='<div class="card"><pre class="err">'+esc(f)+'</pre>';
    if(d)h+='<details><summary>点开看详情</summary><pre class="detail">'+esc(d)+'</pre></details>';
    return h+'</div>';
  }
  const cls=state==='pending'?' class="pending"':'';
  return '<div class="card"><pre'+cls+'>'+esc(text)+'</pre></div>';
}
let busy=false, histMode=false, histList=[], histIdx=0;

// 轮询：翻页态暂停，避免被 2s 自动刷新打断
async function tick(){
  if(histMode||busy||document.hidden)return; busy=true;
  try{
    const r=await fetch('/latest?t='+enc(T),{cache:'no-store'});
    if(r.ok){const d=await r.json(); if(d.key!==KEY)location.reload();}
  }catch(e){}
  busy=false;
}
setInterval(tick,2000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});

// 客户端渲染一条记录（与服务端 renderPage 的卡片结构一致）
function itemHtml(d){
  let h='';
  if(d.image){
    const src='/img/'+enc(d.name)+'/'+enc(d.image)+'?t='+enc(T);
    h+='<div class="card"><a href="'+src+'"><img src="'+src+'" alt="截图"></a></div>';
  }
  h+=textCard(d.state,d.text);
  return h;
}

async function enterHistory(){
  try{
    const r=await fetch('/history?t='+enc(T),{cache:'no-store'});
    if(!r.ok)return;
    const d=await r.json();
    histList=(d.items||[]);
    if(!histList.length)return;
    histMode=true; histIdx=0;
    document.getElementById('live').style.display='none';
    document.getElementById('foot').style.display='none';
    document.getElementById('hist').style.display='block';
    await showHist();
    window.scrollTo(0,0);
  }catch(e){}
}
async function showHist(){
  const it=histList[histIdx];
  document.getElementById('histMeta').textContent=
    '第 '+(histIdx+1)+' / '+histList.length+' 条';
  try{
    const r=await fetch('/item?t='+enc(T)+'&name='+enc(it.name),{cache:'no-store'});
    if(r.ok){const d=await r.json(); document.getElementById('histBody').innerHTML=itemHtml(d);}
  }catch(e){}
  document.getElementById('histOlder').disabled=(histIdx>=histList.length-1);
  document.getElementById('histNewer').disabled=(histIdx<=0);
}
function backToLive(){location.reload();}

if(document.getElementById('showHist'))
  document.getElementById('showHist').addEventListener('click',enterHistory);
document.getElementById('histOlder').addEventListener('click',()=>{if(histIdx<histList.length-1){histIdx++;showHist();window.scrollTo(0,0);}});
document.getElementById('histNewer').addEventListener('click',()=>{if(histIdx>0){histIdx--;showHist();window.scrollTo(0,0);}});
document.getElementById('histBack').addEventListener('click',backToLive);
</script></body></html>`;

const NOTE = { done: '自动刷新中', pending: '分析中', error: '出错了' };

// error.txt 的 friendly 人话 + 原始详情分隔符，必须与 pipeline.js 的 DETAIL_SEP 一致。
const DETAIL_SEP = '\n\n────── 详情 ──────\n';

// 文本卡片：error 态拆成「人话 + 可折叠详情」，其余态照常。
function textCardHtml(state, text) {
  if (state === 'error') {
    const i = text.indexOf(DETAIL_SEP);
    const friendly = i >= 0 ? text.slice(0, i) : text;
    const detail = i >= 0 ? text.slice(i + DETAIL_SEP.length) : '';
    let h = '<div class="card"><pre class="err">' + escapeHtml(friendly) + '</pre>';
    if (detail) {
      h +=
        '<details><summary>点开看详情</summary><pre class="detail">' +
        escapeHtml(detail) +
        '</pre></details>';
    }
    return h + '</div>';
  }
  const cls = state === 'pending' ? ' class="pending"' : '';
  return '<div class="card"><pre' + cls + '>' + escapeHtml(text) + '</pre></div>';
}

function fill(title, note, content, footer, token, key, hasItems) {
  return PAGE.replace('__CONTENT__', content)
    .replace('__FOOTER__', footer)
    .replace('__TITLE__', escapeHtml(title))
    .replace('__NOTE__', escapeHtml(note))
    .replace('__TOKEN_JSON__', JSON.stringify(token))
    .replace('__KEY_JSON__', JSON.stringify(key))
    .replace('__HAS_ITEMS__', JSON.stringify(!!hasItems));
}

// 空状态：默认展示赞助二维码 + 文案 + 截图提示。key 与 store.latestKey() 空态一致（'empty'）。
function renderEmpty(token) {
  const qr =
    '/sponsor?t=' + encodeURIComponent(token);
  const content =
    '<div class="card sponsor-card">' +
    '<img src="' + qr + '" alt="赞助二维码">' +
    '<div class="tip">喜欢的话可以扫码请我喝咖啡 ☕</div>' +
    '</div>' +
    '<p class="empty">按一下快捷键截张图，这页会自己刷出来。</p>';
  return fill('还没有截图', '按一下快捷键', content, '', token, 'empty', false);
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
  blocks.push(textCardHtml(item.state, item.text));
  // 有记录时底部：查看更早大按钮 + 不显眼赞助入口
  const footer =
    '<button class="btn ghost" id="showHist" type="button">查看更早</button>' +
    '<div class="sponsor-foot"><a href="/sponsor?t=' +
    encodeURIComponent(token) +
    '" target="_blank" rel="noopener">☕ 赞助作者</a></div>';
  const effectiveKey = key != null ? key : item.name + '|' + item.state;
  return fill(title, note, blocks.join(''), footer, token, effectiveKey, true);
}

module.exports = { renderPage, renderEmpty, pretty, escapeHtml };
