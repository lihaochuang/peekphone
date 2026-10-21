'use strict';
// globalShortcut 注册/重注册。注册失败（被占/非法）返回 false，由设置 UI 提示换键。
const { globalShortcut } = require('electron');

let current = null;
let currentHandler = null;

function register(accelerator, handler) {
  try {
    const ok = globalShortcut.register(accelerator, handler);
    // register 返回 false，或注册后 isRegistered 为 false，都视为失败
    if (!ok || !globalShortcut.isRegistered(accelerator)) return false;
    current = accelerator;
    currentHandler = handler;
    return true;
  } catch (e) {
    return false;
  }
}

// 换键：先注册新的，成功才注销旧的（避免新键非法时把旧键也丢了）。
function reregister(newAccelerator) {
  if (!currentHandler) return false;
  if (newAccelerator === current) return true;
  const handler = currentHandler;
  let ok = false;
  try {
    ok = globalShortcut.register(newAccelerator, handler) && globalShortcut.isRegistered(newAccelerator);
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // 新键失败，确保旧键仍在
    try {
      globalShortcut.unregister(newAccelerator);
    } catch (e) {
      /* ignore */
    }
    return false;
  }
  if (current && current !== newAccelerator) {
    try {
      globalShortcut.unregister(current);
    } catch (e) {
      /* ignore */
    }
  }
  current = newAccelerator;
  return true;
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  current = null;
}

module.exports = { register, reregister, unregisterAll };
