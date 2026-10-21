'use strict';
/*
 * PeekPhone 图标生成器（零第三方依赖）。
 * 本机无 SVG 光栅化工具链（qlmanage 渲染失败，无 rsvg/magick/sharp），
 * 故按 icon.svg 的同一组形状参数在 Node 里程序化渲染 RGBA，再用内置 zlib 编码 PNG，
 * iconutil 打 icns，自写 ICO 封装器打 ico。可重复、无手绘依赖。
 *
 * 产物：
 *   assets/icon.png            512 主图（electron-builder/展示用）
 *   assets/icon.icns           mac 应用图标（iconutil 从 iconset 生成）
 *   assets/icon.ico            Windows 应用图标（多尺寸 PNG 封装）
 *   assets/tray/trayTemplate.png / @2x  mac 托盘单色 Template（黑+alpha）
 *   assets/tray/tray.ico       Windows 托盘图标
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');

const ASSETS = path.join(__dirname, '..');
const TRAY = path.join(ASSETS, 'tray');

// ---- 形状参数（归一化 0..1，与 icon.svg 对应）----
const BG_RADIUS = 0.22;
const INSET = 0.16;
const ARM = 0.20;
const THICK = 0.0547;
const LENS_R1 = 0.17; // 白环外径
const LENS_R2 = 0.1104; // 内蓝半径
const LENS_R3 = 0.045; // 中心白点
const C1 = [0x3a, 0x9b, 0xff]; // 渐变上
const C2 = [0x00, 0x60, 0xdf]; // 渐变下 / 内蓝
const WHITE = [0xff, 0xff, 0xff];

function inRoundedRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inBrackets(x, y) {
  // 把坐标折叠到左上角象限，四角对称
  const fx = x < 0.5 ? x : 1 - x;
  const fy = y < 0.5 ? y : 1 - y;
  const i = INSET;
  const horiz = fy >= i && fy <= i + THICK && fx >= i && fx <= i + ARM;
  const vert = fx >= i && fx <= i + THICK && fy >= i && fy <= i + ARM;
  return horiz || vert;
}

// 返回某子采样点的 RGBA（彩色图标）
function colorSample(x, y) {
  if (!inRoundedRect(x, y, BG_RADIUS)) return [0, 0, 0, 0];
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= LENS_R3) return [...WHITE, 255];
  if (d <= LENS_R2) return [...C2, 255];
  if (d <= LENS_R1) return [...WHITE, 255];
  if (inBrackets(x, y)) return [...WHITE, 255];
  // 背景竖直渐变
  const t = y;
  const r = Math.round(C1[0] + (C2[0] - C1[0]) * t);
  const g = Math.round(C1[1] + (C2[1] - C1[1]) * t);
  const b = Math.round(C1[2] + (C2[2] - C1[2]) * t);
  return [r, g, b, 255];
}

// 托盘单色：黑色 + alpha（macOS Template 只看 alpha）。括号 + 镜头环，不填背景。
function traySample(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  const ring = d <= LENS_R1 && d >= LENS_R2; // 只画环
  const dot = d <= LENS_R3;
  if (ring || dot || inBrackets(x, y)) return [0, 0, 0, 255];
  return [0, 0, 0, 0];
}

// 渲染一张 size×size 的 RGBA（超采样抗锯齿）
function render(size, sampler, ss) {
  ss = ss || (size >= 512 ? 2 : 4);
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const s = sampler(x, y);
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const n = ss * ss;
      const o = (py * size + px) * 4;
      // 预乘颜色按 alpha 归一，避免边缘发黑
      buf[o] = a ? Math.round(r / a) : 0;
      buf[o + 1] = a ? Math.round(g / a) : 0;
      buf[o + 2] = a ? Math.round(b / a) : 0;
      buf[o + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// ---- 最小 PNG 编码（RGBA，无交错）----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 每行前置 filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO 封装（每个条目放 PNG 数据）----
function encodeICO(entries) {
  // entries: [{size, png}]
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const datas = [];
  entries.forEach((e, i) => {
    const b = 6 + i * 16;
    header[b] = e.size >= 256 ? 0 : e.size; // width (0=256)
    header[b + 1] = e.size >= 256 ? 0 : e.size; // height
    header[b + 2] = 0; // palette
    header[b + 3] = 0; // reserved
    header.writeUInt16LE(1, b + 4); // planes
    header.writeUInt16LE(32, b + 6); // bpp
    header.writeUInt32LE(e.png.length, b + 8); // bytes
    header.writeUInt32LE(offset, b + 12); // offset
    offset += e.png.length;
    datas.push(e.png);
  });
  return Buffer.concat([header, ...datas]);
}

function writePNG(file, size, sampler) {
  const png = encodePNG(size, render(size, sampler));
  fs.writeFileSync(file, png);
  return png;
}

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(TRAY, { recursive: true });

  // 主 PNG
  writePNG(path.join(ASSETS, 'icon.png'), 512, colorSample);

  // icns：构建 iconset 再 iconutil
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peekicon_'));
  const iconset = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const icnsSizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  const cache = {};
  for (const [sz, name] of icnsSizes) {
    if (!cache[sz]) cache[sz] = render(sz, colorSample);
    fs.writeFileSync(path.join(iconset, name), encodePNG(sz, cache[sz]));
  }
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')]);
    console.log('icon.icns ✓');
  } catch (e) {
    console.error('iconutil 失败：' + e.message);
  }

  // ICO（应用 + 托盘）
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const appEntries = icoSizes.map((s) => ({ size: s, png: encodePNG(s, render(s, colorSample)) }));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeICO(appEntries));
  console.log('icon.ico ✓');
  const trayIcoEntries = [16, 32, 48].map((s) => ({ size: s, png: encodePNG(s, render(s, traySample)) }));
  fs.writeFileSync(path.join(TRAY, 'tray.ico'), encodeICO(trayIcoEntries));
  console.log('tray.ico ✓');

  // mac 托盘 Template（22 @1x, 44 @2x）
  writePNG(path.join(TRAY, 'trayTemplate.png'), 22, traySample);
  writePNG(path.join(TRAY, 'trayTemplate@2x.png'), 44, traySample);
  console.log('trayTemplate.png / @2x ✓');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('全部图标已生成到 assets/');
}

main();
