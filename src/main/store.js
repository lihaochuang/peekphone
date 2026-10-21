'use strict';
// 分析历史 slot 的落盘/读取/清理。移植 serve.py 的 slot 结构 + read_slot/latest + peek.py 的 purge。
// history 根目录作参数注入（默认 userData/history），便于纯 Node 单测。
const fs = require('fs');
const path = require('path');

// 每个 slot 一个目录：shot.jpg|shot.png + analysis.md(done) / error.txt(error)，都没有即 pending。
function createStore(historyRoot) {
  function ensureRoot() {
    fs.mkdirSync(historyRoot, { recursive: true });
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      '_' +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    );
  }

  // 建一个 pending slot，返回 slot 名（目录名）。
  function newSlot(name) {
    ensureRoot();
    const slot = stamp() + '_' + name;
    fs.mkdirSync(path.join(historyRoot, slot), { recursive: true });
    return slot;
  }

  function slotDir(slot) {
    return path.join(historyRoot, slot);
  }

  // ext 为 'jpg' / 'png'，落 shot.<ext>（与 capture 契约联动，不写死）。
  function saveImage(slot, buffer, ext) {
    fs.writeFileSync(path.join(slotDir(slot), 'shot.' + ext), buffer);
  }

  function saveAnalysis(slot, stampName, promptName, via, text) {
    const md =
      '# ' + stampName + '（提示词：' + promptName + '）\n\n来源：' + via + '\n\n' + text + '\n';
    fs.writeFileSync(path.join(slotDir(slot), 'analysis.md'), md, 'utf8');
  }

  function saveError(slot, message) {
    fs.writeFileSync(path.join(slotDir(slot), 'error.txt'), String(message), 'utf8');
  }

  // 找截图：先 shot.jpg 再 shot.png（与原型 read_slot 一致）。
  function findImage(slot) {
    for (const file of ['shot.jpg', 'shot.png']) {
      if (fs.existsSync(path.join(slotDir(slot), file))) return file;
    }
    return null;
  }

  // 读一条记录。state 三态：pending / done / error。
  function readSlot(slot) {
    const dir = slotDir(slot);
    const image = findImage(slot);
    const analysis = path.join(dir, 'analysis.md');
    const error = path.join(dir, 'error.txt');
    let state, text;
    if (fs.existsSync(analysis)) {
      state = 'done';
      text = fs.readFileSync(analysis, 'utf8');
    } else if (fs.existsSync(error)) {
      state = 'error';
      text = '这次没拿到分析\n\n' + fs.readFileSync(error, 'utf8');
    } else {
      state = 'pending';
      text = '正在分析，稍等几秒…';
    }
    return { name: slot, image, state, text };
  }

  // 最新一条：按目录名倒序取第一个。
  function latest() {
    ensureRoot();
    const dirs = fs
      .readdirSync(historyRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    return dirs.length ? readSlot(dirs[0]) : null;
  }

  // 前端轮询比对用。带 state，pending→done 也触发刷新。无记录 'empty'。
  function latestKey() {
    const item = latest();
    return item ? item.name + '|' + item.state : 'empty';
  }

  function purge(keepDays) {
    ensureRoot();
    const deadline = Date.now() - keepDays * 86400 * 1000;
    for (const name of fs.readdirSync(historyRoot)) {
      const dir = path.join(historyRoot, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory() && st.mtimeMs < deadline) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) {
        /* 并发删除/竞态，忽略 */
      }
    }
  }

  // 供 server /img 防穿越：只允许 shot.jpg/shot.png，realpath 必须仍在 history 内，否则 null。
  function resolveImagePath(slot, file) {
    if (file !== 'shot.jpg' && file !== 'shot.png') return null;
    if (!slot || slot.includes('/') || slot.includes('\\') || slot.startsWith('.')) return null;
    const target = path.resolve(historyRoot, slot, file);
    const rootReal = fs.realpathSync(historyRoot);
    // target 可能尚不存在，先判字符串前缀，再对存在的做 realpath 校验
    if (!target.startsWith(path.resolve(historyRoot) + path.sep)) return null;
    if (!fs.existsSync(target)) return null;
    const real = fs.realpathSync(target);
    if (!real.startsWith(rootReal + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  }

  return {
    historyRoot,
    newSlot,
    saveImage,
    saveAnalysis,
    saveError,
    readSlot,
    latest,
    latestKey,
    purge,
    resolveImagePath,
  };
}

module.exports = { createStore };
