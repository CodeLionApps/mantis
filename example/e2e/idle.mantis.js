// app.idle() on the example app: a spinner on screen keeps it busy, one hidden in a mounted overlay doesn't.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/idle.mantis.js
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
beforeEach(() => app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs })));

const timed = async (o) => {
  const t = performance.now();
  await app.idle(o);
  return performance.now() - t;
};

test('static screen: idle in about quietMs', async () => {
  await app.idle();
  for (let i = 0; i < 3; i++) assert.ok((await timed()) < 400);
});

test('a spinner on screen: times out, naming the loop', async () => {
  await app.getByText('Ładowanie').tap();
  await app.getByText('Załaduj').tap();
  await assert.rejects(app.idle({ timeout: 700 }), /in a loop/);
});

for (const [button, how] of [['Zanikanie', 'faded to opacity 0'], ['Poza ekran', 'moved off screen']])
  test(`a spinner in an overlay ${how}, still mounted: idle returns`, async () => {
    await app.getByText('Nakładka').tap();
    await app.getByText(button).tap();
    await expect(app.getByText('Nakładka: ukryta')).toBeVisible();
    assert.ok((await timed({ timeout: 3000 })) < 1500);
    assert.equal((await app.getByTestId('overlay-spinner').all()).length, 1); // still mounted, still looping natively
  });
