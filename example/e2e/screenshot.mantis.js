// Page.screenshot: the app's own windows as a PNG, a Modal (another window) included.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/screenshot.mantis.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { App, PORT, expect } = require('@codelionapps/mantis');
const { launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(PORT, target.platform);
before(async () => {
  await app.start();
  reversePort(app.port, target);
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
});
after(() => app.close());

// 8-bit RGB / RGBA PNG -> { width, height, px(x, y) = [r, g, b] }; throws on anything it can't decode
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let width, height, bpp;
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth');
      bpp = { 2: 3, 6: 4 }[data[9]];
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
  return { width, height, px: (x, y) => [...out.subarray((y * width + x) * bpp, (y * width + x) * bpp + 3)] };
}

const shoot = async () => {
  const t = Date.now();
  const r = await app.native.call('Page.screenshot');
  const ms = Date.now() - t;
  const img = decodePng(Buffer.from(r.png, 'base64'));
  console.log(`Page.screenshot ${img.width}x${img.height} in ${ms} ms, windows ${r.windows}, fallbacks ${r.fallbacks}`);
  return { ...r, img };
};

test('the screen, then the same screen under a transparent Modal: screen-sized, decodable, the backdrop in it', async () => {
  await app.getByText('Formularz').tap();
  await expect(app.getByText('Zapisz')).toBeVisible();
  const { screen } = await app.snapshot();
  const before = await shoot();
  // scale 1 = 1 px per dp (iOS: point)
  assert.ok(Math.abs(before.img.width - screen.width) <= 1, `width ${before.img.width} vs screen ${screen.width} dp`);
  assert.ok(Math.abs(before.img.height - screen.height) <= 1, `height ${before.img.height} vs screen ${screen.height} dp`);
  // left of the modal box (the backdrop's padding is 24 dp), mid-height: the form's white background...
  const at = [12, Math.round(screen.height / 2)];
  assert.deepEqual(before.img.px(...at), [255, 255, 255]);

  await app.getByText('Zapisz').tap();
  await expect(app.getByText('Zamknij')).toBeVisible();
  await app.idle(); // the fade-in
  const modal = await shoot();
  // ...darkened by the backdrop (#0006 over white = 153)
  for (const c of modal.img.px(...at)) assert.ok(Math.abs(c - 153) <= 3, `backdrop pixel ${modal.img.px(...at)}`);

  const scaled = await app.native.call('Page.screenshot', { scale: 2 });
  assert.ok(Math.abs(decodePng(Buffer.from(scaled.png, 'base64')).width - before.img.width * 2) <= 2);
});
