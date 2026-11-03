// app.back() on an Alert of the app, iOS: runs its cancel-style button, as back cancels a cancelable dialog on
// Android; an alert without one stays.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/alert.mantis.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { App, PORT, expect } = require('@codelionapps/mantis');
const { launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(PORT, target.platform);
before(async () => {
  await app.start();
  reversePort(app.port, target);
});
after(() => app.close());
beforeEach(async () => {
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  await app.getByText('Alerty').tap();
});

// iOS only: on Android back is a key to the dialog, which RN makes not cancelable by default
const ios = { skip: target.platform !== 'ios' && 'iOS only' };
// an alert of the app on top = the app has no focus (snapshot's focused false)
const focused = async (want) => {
  const end = Date.now() + 3000;
  while ((await app.snapshot()).focused !== want) {
    assert.ok(Date.now() < end, `focused never became ${want}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

test('back on an alert with a cancel button: runs it once, the alert goes', ios, async () => {
  await app.getByText('Usuń').tap();
  await focused(false);
  assert.deepEqual(await app.back(), { ok: true, via: 'alert', action: 'Anuluj' });
  await focused(true);
  await expect(app.getByText('Log: anulowano')).toBeVisible();
});

test('back on an alert without a cancel button: ok false, the alert stays', ios, async () => {
  await app.getByText('Info').tap();
  await focused(false);
  assert.deepEqual(await app.back(), { ok: false, reason: 'an alert of the app without a cancel button' });
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await app.snapshot()).focused, false);
});

test('back with no alert: unchanged (the BackHandler listener goes to the menu)', ios, async () => {
  assert.deepEqual(await app.back(), { ok: true, via: 'backHandler' });
  await expect(app.getByText('Menu')).toBeVisible();
});
