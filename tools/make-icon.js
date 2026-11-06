'use strict';

/**
 * 生成扩展图标 media/icon.png（128x128，RGBA）。
 * 圆角矩形渐变底 + 白色 "C"（环形缺口）+ 红色断点圆点。
 * 用法: node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function roundedBoxSdf(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - halfW + radius;
  const qy = Math.abs(py) - halfH + radius;
  const outer = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return outer;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const center = (SIZE - 1) / 2;

for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter type 0

  for (let x = 0; x < SIZE; x += 1) {
    const px = x - center;
    const py = y - center;
    const offset = rowStart + 1 + x * 4;

    // 背景圆角矩形
    const sdf = roundedBoxSdf(px, py, SIZE / 2 - 2, SIZE / 2 - 2, 26);
    const bgAlpha = Math.max(0, Math.min(1, 0.5 - sdf));

    // 渐变底色
    const t = (x + y) / (2 * SIZE);
    let r = Math.round(lerp(30, 59, t));
    let g = Math.round(lerp(64, 130, t));
    let b = Math.round(lerp(175, 246, t));

    // "C" 环
    const dist = Math.hypot(px, py);
    const outerR = 42;
    const innerR = 27;
    const inRing = dist <= outerR && dist >= innerR;
    const angle = Math.atan2(py, px); // -PI..PI
    const deg = (angle * 180) / Math.PI;
    const inGap = Math.abs(deg) < 36;
    const ringAlpha = inRing && !inGap ? 1 : 0;

    // 断点圆点（红色，位于缺口中心）
    const dotDist = Math.hypot(px - 34, py);
    const dotAlpha = dotDist <= 11 ? 1 : dotDist <= 12.5 ? 12.5 - dotDist : 0;

    if (ringAlpha > 0) {
      r = lerp(r, 255, ringAlpha);
      g = lerp(g, 255, ringAlpha);
      b = lerp(b, 255, ringAlpha);
    }
    if (dotAlpha > 0) {
      r = lerp(r, 239, dotAlpha);
      g = lerp(g, 68, dotAlpha);
      b = lerp(b, 68, dotAlpha);
    }

    raw[offset] = Math.round(r);
    raw[offset + 1] = Math.round(g);
    raw[offset + 2] = Math.round(b);
    raw[offset + 3] = Math.round(bgAlpha * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = path.join(__dirname, '..', 'media');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, png);
console.log(`已生成 ${outFile} (${png.length} bytes)`);
