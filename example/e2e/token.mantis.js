// The channel takes only this runner's launch: an app launched with another token is refused (NOT_CONNECTED says
// why), then the same app launched with app.launchArgs connects.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator / iPhone UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/token.mantis.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { App, expect } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const usb = isIosDevice(target);
const app = new App(undefined, target.platform, { usb: usb ? target.deviceId : undefined });
before(async () => {
  await app.start();
  reversePort(app.port, target);
});
after(() => app.close());

// a cabled iPhone's agent refuses the runner instead (its listener takes only its launch's token): PORT_IN_USE
test('another token: refused, then this runner\'s launch connects', { skip: usb && 'cabled iPhone' }, async () => {
  await assert.rejects(app.relaunch(() => launchApp({ ...target, launchArgs: { ...app.launchArgs, mantisToken: 'x' } }), { timeout: 5000 }), {
    code: 'NOT_CONNECTED',
    message: /wrong token/,
  });
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  await expect(app.getByText('Licznik')).toBeVisible();
});
