// The API an LLM driver acts through: snapshot nodes (getByTag, a point tap), keyboard typing, scrolling by
// direction, idle after an action the app handles later, typed errors, snapshot completeness.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/driver.mantis.js
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

const nodeWithText = async text => {
  await expect(app.getByText(text)).toBeVisible();
  const snap = await app.snapshot();
  return { snap, node: snap.nodes.find(n => n.text === text) };
};
const centre = ({ rect: r }) => [r.x + r.width / 2, r.y + r.height / 2];

test('snapshot nodes: getByTag, a point tap, a stale tag', async () => {
  await app.getByText('Licznik').tap();
  const { snap, node } = await nodeWithText('Dodaj');
  assert.equal(snap.complete, true);
  const button = snap.nodes[node.parent]; // the Pressable around the text
  assert.equal(button.pressable, true);
  await app.getByTag(button.tag).tap();
  await expect(app.getByText('Licznik: 1')).toBeVisible();
  assert.deepEqual(await app.touchscreen.tap(...centre(node)), { seen: true });
  await expect(app.getByText('Licznik: 2')).toBeVisible();
  // the screen unmounted and mounted again: its views have new tags
  await app.getByText('Wstecz').tap();
  await app.getByText('Licznik').tap();
  await assert.rejects(app.getByTag(button.tag).tap(), { code: 'STALE' });
});

test('keyboard.type into the focused field; nothing focused: NOT_FOCUSED', async () => {
  await assert.rejects(app.keyboard.type('x'), { code: 'NOT_FOCUSED' });
  await app.getByText('Logowanie').tap();
  await app.getByPlaceholder('ala@').tap();
  await app.keyboard.type('ala@example.com');
  const { nodes, keyboard } = await app.snapshot();
  assert.equal(nodes.find(n => n.placeholder === 'ala@example.com').value, 'ala@example.com');
  // the simulator shows no soft keyboard with a hardware one attached
  if (keyboard)
    await assert.rejects(app.touchscreen.tap(keyboard.x + keyboard.width / 2, keyboard.y + keyboard.height / 2), { code: 'COVERED' });
});

test('scroll by direction: the main scroll view of each axis', async () => {
  await app.getByText('Przewijanie').tap();
  await expect(app.getByText('Wiersz 1')).toBeInViewport();
  const down = await app.scroll('down');
  assert.equal(down.ok, true, down.reason);
  assert.equal(down.tag, (await app.getByTestId('rows').resolve()).tag);
  await expect(app.getByText('Wiersz 1')).not.toBeInViewport();
  const right = await app.scroll('right');
  assert.equal(right.tag, (await app.getByTestId('tiles').resolve()).tag);
  await expect(app.getByText('Kafel 1')).not.toBeInViewport();
});

test('idle({ since }): after back, idle only once the app reacted', async () => {
  await app.getByText('Licznik').tap();
  await expect(app.getByText('Licznik: 0')).toBeVisible();
  const mark = await app.mark();
  assert.equal((await app.back()).ok, true);
  await app.idle({ since: mark });
  await expect(app.getByText('Menu')).toBeVisible({ timeout: 0 });
});

test('snapshot.complete: an uncontrolled text field', async () => {
  await app.getByText('Formularz').tap();
  await expect(app.getByPlaceholder('Notatka')).toBeVisible();
  const { complete, reasons, nodes } = await app.snapshot();
  assert.equal(complete, false);
  assert.match(reasons.join(), /uncontrolled text field/);
  assert.equal(nodes.find(n => n.testID === 'name-input').value, 'Jan'); // controlled: its value
});
