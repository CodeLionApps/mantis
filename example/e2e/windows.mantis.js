// What the app can't see, as facts: the screenshot's focused / state / keyboard / surfaces, the snapshot's state and
// overlays, COVERED's state. Screen "Okna": a native surface, a permission prompt, a native Alert, a Modal, another
// activity (Android).
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator / iPhone UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
// [SYSTEM_PROMPT=1: iOS simulator, the permission prompt test, which restarts SpringBoard]
//   node --test e2e/windows.mantis.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { App, expect } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');
const { decodePng } = require('./png');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(undefined, target.platform, { usb: isIosDevice(target) ? target.deviceId : undefined });
before(async () => {
  await app.start();
  reversePort(app.port, target);
});
after(() => app.close());
beforeEach(async () => {
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  await app.getByText('Okna').tap();
  await expect(app.getByText('Wstecz')).toBeVisible();
});

const android = target.platform === 'android';
const adb = (...args) => execFileSync('adb', ['-s', target.deviceId, 'shell', ...args], { encoding: 'utf8' });
const shoot = async params => {
  const r = await app.native.call('Page.screenshot', params);
  return { ...r, img: decodePng(Buffer.from(r.png, 'base64')) };
};
const until = async (what, check) => {
  const end = Date.now() + 5000;
  for (let v; !(v = await check()); await new Promise(r => setTimeout(r, 50))) assert.ok(Date.now() < end, what);
};
const magenta = ([r, g, b]) => r > 200 && g < 60 && b > 200;
const near = (a, b) => ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= 1);
const centre = r => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];

test('a native surface: on screen, not in the picture, reported with its rect', async () => {
  const { nodes, overlays, state, complete } = await app.snapshot();
  assert.deepEqual([state, overlays, complete], ['active', [], true]);
  const node = nodes.find(n => n.testID === 'surface');
  const shot = await shoot();
  assert.equal(shot.focused, true);
  assert.equal(shot.state, 'active');
  assert.equal(shot.keyboard, null);
  if (android) {
    // PixelCopy reads the window: the SurfaceView's own surface is not in it
    assert.equal(shot.surfaces.length, 1, JSON.stringify(shot.surfaces));
    assert.equal(shot.surfaces[0].tag, node.tag);
    assert.ok(near(shot.surfaces[0].rect, node.rect), `${JSON.stringify(shot.surfaces[0].rect)} vs ${JSON.stringify(node.rect)}`);
    assert.ok(!magenta(shot.img.px(...centre(node.rect))), `${shot.img.px(...centre(node.rect))}`);
  } else {
    // drawViewHierarchy has the Metal layer; renderInContext (fallbacks, render: true) has not, and says so
    assert.deepEqual(shot.surfaces, []);
    assert.ok(magenta(shot.img.px(...centre(node.rect))), `${shot.img.px(...centre(node.rect))}`);
    const rendered = await shoot({ render: true });
    assert.equal(rendered.surfaces.length, 1, JSON.stringify(rendered.surfaces));
    assert.equal(rendered.surfaces[0].tag, node.tag);
    assert.ok(near(rendered.surfaces[0].rect, node.rect));
    assert.ok(!magenta(rendered.img.px(...centre(node.rect))));
  }
});

test('a Modal: an overlay of React content, the snapshot complete', async () => {
  await app.getByText('Okno Modal').tap();
  await expect(app.getByText('Zamknij okno')).toBeVisible();
  // Android: the Modal's window gets the focus a moment after it shows
  let snap;
  await until('never focused', async () => (snap = await app.snapshot()).focused);
  const { overlays, complete, focused } = snap;
  assert.deepEqual([overlays.map(o => [o.type, o.react]), complete, focused], [[['modal', true]], true, true]);
});

test('a native Alert: an overlay that is not React, the nodes under it covered; a tap outside it closes it (Android, cancelable) or does nothing (iOS)', async () => {
  const { nodes } = await app.snapshot();
  const modalButton = nodes.find(n => n.text === 'Okno Modal');
  await app.getByText('Komunikat').tap();
  let snap;
  await until('no alert overlay', async () => (snap = await app.snapshot()).overlays.length);
  // Android: the focus moves from the activity's window to the dialog's (false for a moment in between)
  await app.idle();
  snap = await app.snapshot();
  const [overlay] = snap.overlays;
  assert.deepEqual([overlay.type, overlay.react], [android ? 'modal' : 'alert', false]);
  assert.equal(snap.state, 'active');
  // Android: the dialog has focus (a window of the app); iOS: an alert of the app's own is not focused
  assert.equal(snap.focused, android);
  assert.equal(snap.complete, false);
  assert.ok(snap.reasons.includes(`a native ${overlay.type} of the app's own on screen: its content is not in the tree`), `${snap.reasons}`);
  // a dialog takes every touch, also outside its box: nothing under it is reachable, a tap there doesn't reach the app
  assert.equal(snap.nodes.find(n => n.text === 'Okno Modal'), undefined);
  const [x, y] = centre(modalButton.rect), o = overlay.rect;
  assert.ok(y < o.y || y > o.y + o.height || x < o.x || x > o.x + o.width, 'the button is outside the dialog');
  const shot = await shoot();
  assert.equal(shot.focused, android);
  assert.equal(shot.state, 'active');
  // the tap goes to the dialog, not to the button under it: Android closes a cancelable one, iOS ignores it
  await app.touchscreen.tap(x, y);
  await new Promise(r => setTimeout(r, 500));
  if (android) await until('the dialog is still there', async () => !(await app.snapshot()).overlays.length);
  else assert.equal((await app.snapshot()).overlays[0]?.type, 'alert', 'the alert is still there');
  assert.equal((await app.snapshot()).nodes.find(n => n.text === 'Zamknij okno'), undefined, 'no Modal opened');
});

test('another activity of the app over an Alert: the hidden dialog is not an overlay', { skip: !android && 'Android' }, async () => {
  await app.getByText('Komunikat i aktywność').tap();
  // a plain activity of the app on top: the first one is stopped, its window and its dialog hidden
  // (the Alert alone covers every node too: wait for the windows on screen, the other activity's only)
  await until('the other activity never came', async () => (await app.native.call('Page.screenshot', { scale: 0.1 })).windows.length === 1);
  await app.idle();
  const snap = await app.snapshot();
  assert.deepEqual([snap.state, snap.focused, snap.overlays], ['active', true, []]);
  assert.deepEqual(snap.reasons, ['no nodes: nothing of React\'s on screen (a splash screen)']);
  // back: the other activity goes, the first one comes back with its dialog
  assert.equal((await app.back()).ok, true);
  await until('the dialog never came back', async () => (await app.snapshot()).overlays.length === 1);
});

test('the keyboard: the screenshot reports the one the snapshot sees', async () => {
  await app.getByText('Wstecz').tap();
  await app.getByText('Formularz').tap();
  await app.getByTestId('name-input').tap();
  // the iOS simulator shows no soft keyboard with a hardware one attached
  if (android) await until('no keyboard', async () => (await app.snapshot()).keyboard);
  else await new Promise(r => setTimeout(r, 1000));
  await app.idle();
  const snap = await app.snapshot();
  const shot = await shoot();
  assert.deepEqual(shot.keyboard, snap.keyboard);
  if (snap.keyboard) await assert.rejects(app.touchscreen.tap(...centre(snap.keyboard)), { code: 'COVERED', keyboard: snap.keyboard, state: 'active' });
});

// The permission prompt is device state: reset before, restored after (Android: the permission's grant; iOS
// simulator: contacts reset, and SpringBoard restarted, opt-in with SYSTEM_PROMPT=1: the prompt outlives the app, a
// permission reset and even an uninstall). Not on a physical iPhone (no reset there).
const PERM = 'android.permission.POST_NOTIFICATIONS';
const sim = !android && !isIosDevice(target);
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
const permission = {
  read: () => (android ? /granted=true/.test(adb('dumpsys', 'package', target.appId).split(`${PERM}:`)[1]?.split('\n')[0] ?? '') : null),
  reset: () => {
    if (android) {
      adb('pm', 'revoke', target.appId, PERM);
      adb('pm', 'clear-permission-flags', target.appId, PERM, 'user-set', 'user-fixed');
    } else simctl('privacy', target.deviceId, 'reset', 'contacts', target.appId);
  },
};
const skipPrompt = android
  ? Number(adb('getprop', 'ro.build.version.sdk')) < 33 && 'POST_NOTIFICATIONS needs Android 13'
  : !sim ? 'needs a simulator (a permission reset)'
  : !process.env.SYSTEM_PROMPT && 'restarts SpringBoard to take the prompt away: SYSTEM_PROMPT=1 to run it';
test('a system permission prompt: the app not focused, its state, COVERED, the screenshot says it is not in it', { skip: skipPrompt }, async () => {
  const granted = permission.read();
  permission.reset(); // Android: revoking a permission kills the app
  try {
    await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
    await app.getByText('Okna').tap();
    await app.getByText('Uprawnienie').tap();
    let snap;
    await until('still focused', async () => (snap = await app.snapshot()).focused === false);
    // Android: the prompt is an activity in front of the app's (paused, still visible); iOS: a system alert
    assert.equal(snap.state, 'inactive');
    assert.deepEqual(snap.overlays, []);
    const shot = await shoot();
    assert.deepEqual([shot.focused, shot.state], [false, 'inactive']);
    const title = snap.nodes.find(n => n.text === 'Okna');
    await assert.rejects(app.touchscreen.tap(...centre(title?.rect ?? { x: 100, y: 100, width: 0, height: 0 })), { code: 'COVERED', state: 'inactive' });
  } finally {
    if (android) {
      adb('input', 'keyevent', '4'); // closes the prompt
      permission.reset();
      if (granted) adb('pm', 'grant', target.appId, PERM);
    } else {
      // a system prompt outlives the app (terminate, a permission reset, even an uninstall): restart SpringBoard
      permission.reset();
      const pid = () => simctl('spawn', target.deviceId, 'launchctl', 'list').match(/^(\d+)\s+\S+\s+com\.apple\.SpringBoard$/m)?.[1];
      const before = pid();
      simctl('spawn', target.deviceId, 'launchctl', 'kill', 'TERM', 'user/foreground/com.apple.SpringBoard');
      await until('SpringBoard not restarted', async () => (pid() ?? before) !== before);
      await new Promise(r => setTimeout(r, 5000)); // its home screen
    }
  }
});
