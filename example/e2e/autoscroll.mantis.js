// Mantis without Detox (Playwright-style API): tap() scrolls its target into view first, along each scroll view's axis,
// an outer one before a list nested in it. Detox's tap needs the target on screen (app.test.js scrolls with whileElement).
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/autoscroll.mantis.js
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
  await app.getByText('Przewijanie').tap();
});

const pick = async (id, text) => {
  await app.getByTestId(id).tap();
  await expect(app.getByText(`Wybrano: ${text}`)).toBeVisible();
};

test('horizontal list', () => pick('tile-25', 'Kafel 25'));
test('vertical list', () => pick('row-30', 'Wiersz 30'));
test('horizontal list in a vertical one', () => pick('shelf-15', 'Półka 15'));

test('snapshot: horizontal scroll views are scroll views too', async () => {
  const { nodes } = await app.snapshot();
  const scrolls = nodes.filter(n => n.scroll).map(n => n.testID);
  assert.deepEqual(scrolls, ['tiles', 'rows']);
});

test('not rendered yet by the virtualized list: not found, no scrolling', async () => {
  await assert.rejects(app.getByTestId('row-190').tap({ timeout: 1000 }), /last: not found/);
});
