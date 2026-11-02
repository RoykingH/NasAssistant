'use strict';
/**
 * 无第三方依赖的 PNG 图标生成器。
 * 生成 assets/icon.png（应用 / 托盘图标）：圆角方块 + 三行"服务器条目"图形。
 * 用法: node tools/gen-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- 最小 PNG 编码器 ---------------- */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 绘制 ---------------- */
const SS = 4;              // 超采样倍数（抗锯齿）
const SIZE = 256;          // 输出尺寸
const W = SIZE * SS;
const H = SIZE * SS;
const buf = Buffer.alloc(W * H * 4, 0);

function inRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function paint(x, y, col) {
  const i = (y * W + x) * 4;
  buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = col[3];
}

const BG = [47, 111, 237, 255];     // #2f6fed
const BAR = [255, 255, 255, 255];   // 白色条目
const DOT = [158, 193, 255, 255];   // 浅蓝指示点

// 以输出像素为单位定义几何（再乘 SS）
const S = (v) => v * SS;
const OUTER = { x: S(8), y: S(8), w: S(240), h: S(240), r: S(56) };
const ROWS = [76, 128, 180].map((cy) => ({
  cy: S(cy),
  barX: S(78), barW: S(124), barH: S(28), barR: S(14),
  dotX: S(54), dotR: S(10),
}));

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!inRoundRect(x, y, OUTER.x, OUTER.y, OUTER.w, OUTER.h, OUTER.r)) continue;
    paint(x, y, BG);
    for (const row of ROWS) {
      if (inCircle(x, y, row.dotX, row.cy, row.dotR)) { paint(x, y, DOT); break; }
      const by = row.cy - row.barH / 2;
      if (inRoundRect(x, y, row.barX, by, row.barW, row.barH, row.barR)) { paint(x, y, BAR); break; }
    }
  }
}

/* ---------------- 下采样（预乘 alpha 平均） ---------------- */
const out = Buffer.alloc(SIZE * SIZE * 4, 0);
const n = SS * SS;
for (let oy = 0; oy < SIZE; oy++) {
  for (let ox = 0; ox < SIZE; ox++) {
    let ar = 0, ag = 0, ab = 0, aa = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((oy * SS + sy) * W + (ox * SS + sx)) * 4;
        const a = buf[i + 3] / 255;
        ar += buf[i] * a; ag += buf[i + 1] * a; ab += buf[i + 2] * a; aa += a;
      }
    }
    const o = (oy * SIZE + ox) * 4;
    if (aa > 0) {
      out[o] = Math.round(ar / aa);
      out[o + 1] = Math.round(ag / aa);
      out[o + 2] = Math.round(ab / aa);
    }
    out[o + 3] = Math.round((aa / n) * 255);
  }
}

const png = encodePNG(SIZE, SIZE, out);
const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'icon.png');
fs.writeFileSync(target, png);
console.log('icon written:', target, png.length, 'bytes');
