// Page.screenshot: the app's own windows as a PNG, a Modal and an AlertDialog (other windows) included.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator / iPhone UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/screenshot.mantis.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { App, expect } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(undefined, target.platform, { usb: isIosDevice(target) ? target.deviceId : undefined });
before(async () => {
  await app.start();
  reversePort(app.port, target);
});
after(() => app.close());
beforeEach(() => app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs })));

const android = target.platform === 'android';
const adb = (...args) => execFileSync('adb', ['-s', target.deviceId, 'shell', ...args], { encoding: 'utf8' });
// the picture is the display (Android: wm size, its override if any; iOS: the screen), in dp at scale 1
const display = async () => {
  const { screen } = await app.snapshot();
  if (!android) return screen;
  const sizes = [...adb('wm', 'size').matchAll(/(\d+)x(\d+)/g)];
  const [, w, h] = sizes[sizes.length - 1];
  return { width: w / screen.density, height: h / screen.density };
};

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

const shoot = async () => {
  const t = Date.now();
  const r = await app.native.call('Page.screenshot');
  const ms = Date.now() - t;
  const img = decodePng(Buffer.from(r.png, 'base64'));
  console.log(`Page.screenshot ${img.width}x${img.height} in ${ms} ms, windows ${r.windows}, fallbacks ${r.fallbacks}`);
  return { ...r, img };
};

test('the screen, then the same screen under a transparent Modal: display-sized, decodable, the backdrop in it', async () => {
  await app.getByText('Formularz').tap();
  await expect(app.getByText('Zapisz')).toBeVisible();
  const size = await display();
  const form = await shoot();
  // scale 1 = 1 px per dp (iOS: point)
  assert.ok(Math.abs(form.img.width - size.width) <= 1, `width ${form.img.width} vs display ${size.width} dp`);
  assert.ok(Math.abs(form.img.height - size.height) <= 1, `height ${form.img.height} vs display ${size.height} dp`);
  // left of the modal box (the backdrop's padding is 24 dp), mid-height: the form's white background...
  const at = [12, Math.round(size.height / 2)];
  assert.deepEqual(form.img.px(...at), [255, 255, 255]);

  await app.getByText('Zapisz').tap();
  await expect(app.getByText('Zamknij')).toBeVisible();
  await app.idle(); // the fade-in
  const modal = await shoot();
  // ...darkened by the backdrop (#0006 over white = 153)
  for (const c of modal.img.px(...at)) assert.ok(Math.abs(c - 153) <= 3, `backdrop pixel ${modal.img.px(...at)}`);
  // API 34+ reads every window by PixelCopy
  if (android && Number(adb('getprop', 'ro.build.version.sdk')) >= 34) assert.equal(modal.fallbacks, 0);

  const scaled = decodePng(Buffer.from((await app.native.call('Page.screenshot', { scale: 2 })).png, 'base64'));
  assert.ok(Math.abs(scaled.width - form.img.width * 2) <= 2, `scale 2 width ${scaled.width}`);
  assert.ok(Math.abs(scaled.height - form.img.height * 2) <= 2, `scale 2 height ${scaled.height}`);
});

test('an AlertDialog: its own window, the screen under it dimmed', { skip: !android && 'Android: a dialog window with FLAG_DIM_BEHIND' }, async () => {
  await app.getByText('Alerty').tap();
  await expect(app.getByText('Info')).toBeVisible();
  const screen = await shoot();
  const corner = [12, 12]; // the screen's white background, away from the dialog
  assert.deepEqual(screen.img.px(...corner), [255, 255, 255]);
  await app.getByText('Info').tap();
  // the dialog's window, then its enter animation (native, outside idle())
  const end = Date.now() + 5000;
  while ((await app.native.call('Page.screenshot')).windows.length === screen.windows.length) assert.ok(Date.now() < end, 'no dialog window');
  await new Promise(r => setTimeout(r, 500));
  const alert = await shoot();
  assert.equal(alert.windows.length, screen.windows.length + 1, `windows ${alert.windows}`);
  for (const c of alert.img.px(...corner)) assert.ok(c < 160, `dimmed corner pixel ${alert.img.px(...corner)}`);
});
