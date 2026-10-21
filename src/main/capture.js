'use strict';
// 截图：平台分流（design §5）。capture() -> {buffer, mediaType, ext}，三者随真实格式联动（契约铁律，禁写死）。
// mac：screencapture -x -D 1 -> sips 压 JPEG；取不到真图（空/黑帧）则降级 desktopCapturer（进程内，TCC 归属干净）。
// win：直接 desktopCapturer。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { desktopCapturer, screen, nativeImage } = require('electron');

const LONG_EDGE = 1200;
const QUALITY = 70;

// 廉价全黑检测：读像素，统计是否几乎全为 (0,0,0)。纯黑帧 -> 判失败触发降级。
function isAllBlack(img) {
  try {
    const bmp = img.toBitmap(); // BGRA
    if (!bmp || bmp.length === 0) return true;
    let nonBlack = 0;
    const step = Math.max(4, Math.floor(bmp.length / 4 / 2000) * 4); // 抽样约 2000 点
    for (let i = 0; i + 2 < bmp.length; i += step) {
      if (bmp[i] > 8 || bmp[i + 1] > 8 || bmp[i + 2] > 8) {
        nonBlack++;
        if (nonBlack > 5) return false;
      }
    }
    return nonBlack <= 5;
  } catch (e) {
    return false; // 读不了像素就别误判成黑，交给后续流程
  }
}

function captureMacScreencapture() {
  const tmpPng = path.join(os.tmpdir(), 'peek_' + crypto.randomBytes(6).toString('hex') + '.png');
  const tmpJpg = tmpPng.replace(/\.png$/, '.jpg');
  const cleanup = () => {
    for (const f of [tmpPng, tmpJpg]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {
        /* ignore */
      }
    }
  };
  try {
    try {
      execFileSync('screencapture', ['-x', '-D', '1', tmpPng], { timeout: 30000 });
    } catch (e) {
      cleanup();
      return null; // returncode != 0 -> 交上层降级
    }
    if (!fs.existsSync(tmpPng) || fs.statSync(tmpPng).size === 0) {
      cleanup();
      return null;
    }
    // 全黑检测（TCC 子进程常见黑帧）
    const probe = nativeImage.createFromPath(tmpPng);
    if (!probe.isEmpty() && isAllBlack(probe)) {
      cleanup();
      return null;
    }
    // sips 压 JPEG
    let jpegOk = false;
    try {
      execFileSync(
        'sips',
        ['-Z', String(LONG_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(QUALITY), tmpPng, '--out', tmpJpg],
        { timeout: 60000 }
      );
      jpegOk = fs.existsSync(tmpJpg) && fs.statSync(tmpJpg).size > 0;
    } catch (e) {
      jpegOk = false;
    }
    if (jpegOk) {
      const buffer = fs.readFileSync(tmpJpg);
      cleanup();
      return { buffer, mediaType: 'image/jpeg', ext: 'jpg' };
    }
    // sips 失败 -> PNG 兜底，格式如实标注
    const buffer = fs.readFileSync(tmpPng);
    cleanup();
    return { buffer, mediaType: 'image/png', ext: 'png' };
  } catch (e) {
    cleanup();
    return null;
  }
}

async function captureViaDesktopCapturer() {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;
  const size = {
    width: Math.round(primary.size.width * scale),
    height: Math.round(primary.size.height * scale),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (!sources || !sources.length) return null;
  // 优先主屏对应的 source；拿不到对应就取第一个
  let src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty() || isAllBlack(img)) return null;
  // NIT-2：长边 1200，先判宽高谁大再决定传 width 还是 height，保持比例
  const { width: w, height: h } = img.getSize();
  const opt = w >= h ? { width: LONG_EDGE } : { height: LONG_EDGE };
  const resized = w > LONG_EDGE || h > LONG_EDGE ? img.resize(opt) : img;
  const buffer = resized.toJPEG(QUALITY);
  if (!buffer || buffer.length === 0) return null;
  return { buffer, mediaType: 'image/jpeg', ext: 'jpg' };
}

async function capture() {
  if (process.platform === 'darwin') {
    const shot = captureMacScreencapture(); // 首选
    if (shot) return shot;
    const fallback = await captureViaDesktopCapturer(); // 降级，同 win 路径
    if (fallback) return fallback;
    throw new Error(
      '截图失败：screencapture 与 desktopCapturer 均未取得屏幕内容，' +
        '检查 系统设置 > 隐私与安全性 > 屏幕录制 是否放行本 App'
    );
  }
  const shot = await captureViaDesktopCapturer();
  if (shot) return shot;
  throw new Error('截图失败：desktopCapturer 未取得屏幕内容，检查屏幕录制权限');
}

module.exports = { capture };
