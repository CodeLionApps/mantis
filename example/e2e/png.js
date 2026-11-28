// PNG decoding for the screenshot tests (no image library in the example)
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

// 8- or 16-bit (iOS, wide colour) RGB / RGBA PNG -> { width, height, px(x, y) = [r, g, b] } (8-bit); throws on anything
// it can't decode
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let width, height, bpp, depth;
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] / 8;
      assert.ok(depth === 1 || depth === 2, `bit depth ${data[8]}`);
      bpp = { 2: 3, 6: 4 }[data[9]] * depth; // bytes per pixel
      assert.ok(bpp, `color type ${data[9]}`);
    }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  assert.equal(raw.length, height * (stride + 1), 'image data size');
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0, b = y ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y ? out[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + i] = (x + pred) & 0xff;
    }
  }
  // a 16-bit sample's high byte is its 8-bit value
  return { width, height, px: (x, y) => [0, 1, 2].map(c => out[(y * width + x) * bpp + c * depth]) };
}

module.exports = { decodePng };
