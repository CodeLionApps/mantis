// Mantis without Detox, no testIDs: fill the login form by placeholder and by label (a Text the input's
// accessibilityLabelledBy points to); the snapshot shows inputs' placeholder and value, never the password.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/locators.mantis.js
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

test('login by placeholder and label', async () => {
  await app.getByText('Logowanie').tap();
  await app.getByPlaceholder('ALA@').fill('ala@example.com'); // case-insensitive substring
  await app.getByLabel('Hasło do konta').fill('sekret');
  const { nodes } = await app.snapshot();
  const email = nodes.find(n => n.placeholder === 'ala@example.com');
  const password = nodes.find(n => n.placeholder === 'Hasło');
  assert.equal(email.value, 'ala@example.com');
  assert.equal(email.label, 'E-mail');
  assert.equal(password.label, 'Hasło do konta');
  assert.equal(password.value, '••••••••');
  assert.doesNotMatch(JSON.stringify(nodes), /sekret/);
  await app.getByRole('button', { name: 'Zaloguj' }).tap();
  await expect(app.getByText('Cześć, Ala')).toBeVisible();
});

test('snapshot: gesture-handler views are touch targets, a pan is not', async () => {
  await app.getByText('Gesty').tap();
  await expect(app.getByLabel('GH tap')).toBeVisible();
  const { nodes } = await app.snapshot();
  const by = label => nodes.find(n => n.label === label);
  assert.equal(by('GH tap').pressable, true);
  assert.equal(by('GH pan').pressable, false);
});
