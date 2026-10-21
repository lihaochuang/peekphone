'use strict';
// globalShortcut 注册/重注册，按「角色」管理多个快捷键（capture=截图 / force=强制刷新）。
// 注册失败（被占/非法/与另一角色冲突）返回 false，由设置 UI / 主进程日志提示换键。
const { globalShortcut } = require('electron');

// role -> { accelerator, handler }
const slots = {};

function register(role, accelerator, handler) {
  try {
    const ok = globalShortcut.register(accelerator, handler);
    // register 返回 false，或注册后 isRegistered 为 false，都视为失败
    if (!ok || !globalShortcut.isRegistered(accelerator)) return false;
    slots[role] = { accelerator, handler };
    return true;
  } catch (e) {
    return false;
  }
}

// 换某角色的键：先注册新的，成功才注销旧的（避免新键非法时把旧键也丢了）。
// 两个角色不能用同一个键：新键若已被另一角色占用，直接失败，不动现状。
function reregister(role, newAccelerator) {
  const slot = slots[role];
  if (!slot) return false;
  if (newAccelerator === slot.accelerator) return true;
  for (const r of Object.keys(slots)) {
    if (r !== role && slots[r].accelerator === newAccelerator) return false; // 与另一键冲突
  }
  const handler = slot.handler;
  let ok = false;
  try {
    ok = globalShortcut.register(newAccelerator, handler) && globalShortcut.isRegistered(newAccelerator);
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // 新键失败：清掉可能的半注册（新键不属于任何现存角色，此 unregister 安全），旧键保持不动
    try {
      globalShortcut.unregister(newAccelerator);
    } catch (e) {
      /* ignore */
    }
    return false;
  }
  if (slot.accelerator && slot.accelerator !== newAccelerator) {
    try {
      globalShortcut.unregister(slot.accelerator);
    } catch (e) {
      /* ignore */
    }
  }
  slots[role] = { accelerator: newAccelerator, handler };
  return true;
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  for (const k of Object.keys(slots)) delete slots[k];
}

module.exports = { register, reregister, unregisterAll };
