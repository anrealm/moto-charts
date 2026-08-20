/*
 * Generates the extension icons as PNGs with no dependencies: draws into a
 * plain RGBA buffer, then writes a minimal PNG (IHDR/IDAT/IEND) using node's
 * built-in zlib. Run via `node tools/make-icons.js`; output goes to
 * extension/icons/. Re-run only when the artwork changes.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');

/* --- PNG writer ----------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 stay 0: deflate / adaptive filtering / no interlace

  // each scanline is prefixed with its filter type (0 = none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

/* --- artwork -------------------------------------------------------------- */

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;

  function px(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (Math.floor(y) * S + Math.floor(x)) * 4;
    const src = a / 255;
    const dst = buf[i + 3] / 255;
    const out = src + dst * (1 - src);
    if (out <= 0) return;
    buf[i] = Math.round((r * src + buf[i] * dst * (1 - src)) / out);
    buf[i + 1] = Math.round((g * src + buf[i + 1] * dst * (1 - src)) / out);
    buf[i + 2] = Math.round((b * src + buf[i + 2] * dst * (1 - src)) / out);
    buf[i + 3] = Math.round(out * 255);
  }

  // rounded dark tile
  const radius = S * 0.22;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.max(radius - x, x - (S - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (S - 1 - radius), 0);
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = d <= radius ? 255 : (d <= radius + 1 ? Math.round(255 * (radius + 1 - d)) : 0);
      if (a) px(x, y, 13, 17, 28, a);
    }
  }

  // the chart line the bike rides: plateau, cliff, valley, climb
  const verts = [
    [0.10, 0.42], [0.30, 0.42], [0.42, 0.74], [0.58, 0.74], [0.72, 0.36], [0.92, 0.36]
  ].map(([x, y]) => [x * S, y * S]);

  const w = Math.max(1.2, S * 0.075);
  function line(x0, y0, x1, y1, r, g, b, width) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
      const rad = width / 2;
      for (let oy = -Math.ceil(rad); oy <= Math.ceil(rad); oy++) {
        for (let ox = -Math.ceil(rad); ox <= Math.ceil(rad); ox++) {
          const d = Math.hypot(ox, oy);
          if (d > rad + 0.5) continue;
          const a = d <= rad - 0.5 ? 255 : Math.round(255 * (rad + 0.5 - d));
          px(cx + ox, cy + oy, r, g, b, a);
        }
      }
    }
  }

  for (let i = 1; i < verts.length; i++) {
    line(verts[i - 1][0], verts[i - 1][1], verts[i][0], verts[i][1], 126, 231, 135, w);
  }

  // the bike: two wheels on the first plateau
  if (S >= 32) {
    const bx = S * 0.235, by = S * 0.42 - S * 0.05;
    const wr = S * 0.058;
    function ring(cx, cy, r, cr, cg, cb) {
      for (let a = 0; a < 360; a += 4) {
        const rad = a * Math.PI / 180;
        px(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r, cr, cg, cb, 255);
        px(cx + Math.cos(rad) * (r - 0.6), cy + Math.sin(rad) * (r - 0.6), cr, cg, cb, 220);
      }
    }
    ring(bx - S * 0.062, by, wr, 230, 237, 243);
    ring(bx + S * 0.068, by, wr, 230, 237, 243);
    line(bx - S * 0.062, by, bx + S * 0.005, by - S * 0.085, 47, 129, 247, Math.max(1, S * 0.038));
    line(bx + S * 0.005, by - S * 0.085, bx + S * 0.068, by, 47, 129, 247, Math.max(1, S * 0.038));
    // rider
    line(bx - S * 0.005, by - S * 0.095, bx + S * 0.015, by - S * 0.155, 255, 212, 121, Math.max(1, S * 0.04));
    line(bx + S * 0.015, by - S * 0.155, bx + S * 0.017, by - S * 0.163, 255, 212, 121, Math.max(1.5, S * 0.06));
  } else {
    // too small for a bike — a single dot reads better at 16px
    const bx = S * 0.22, by = S * 0.42 - S * 0.09;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (Math.hypot(ox, oy) <= 1.4) px(bx + ox, by + oy, 255, 212, 121, 255);
    }
  }

  return buf;
}

fs.mkdirSync(OUT, { recursive: true });
[16, 32, 48, 128].forEach(function (size) {
  const file = path.join(OUT, 'icon-' + size + '.png');
  writePng(file, size, makeIcon(size));
  console.log('wrote', path.relative(process.cwd(), file), fs.statSync(file).size + ' B');
});
