// A thread of the app that runs nothing (screen "Zawieszenie", 9 s): a call waiting on it fails with err.stuck once it
// has been stuck for 5 s, not at the RPC's 15 s timeout, the next ones at once; once it runs again calls work. A long
// call whose thread keeps running is not stuck.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator / iPhone UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/stuck.mantis.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { App, expect } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(undefined, target.platform, { usb: isIosDevice(target) ? target.deviceId : undefined });
const HANG = 9000; // how long the screen's buttons block a thread
const STUCK_MS = 5000; // the runner's
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const adb = (...args) => execFileSync('adb', ['-s', target.deviceId, ...args]).toString().trim();

before(async () => {
  await app.start();
  reversePort(app.port, target);
});
after(() => app.close());
beforeEach(() => app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs })));

// the error a call ends with, and how long it took
const failed = async p => {
  const t = performance.now();
  const e = await p.then(() => assert.fail('no error'), e => e);
  return [e, performance.now() - t];
};
const stuck = (e, thread) => {
  assert.equal(e.stuck?.thread, thread, e.stack);
  assert.ok(e.stuck.forMs >= STUCK_MS, String(e.stuck.forMs));
};
const block = async button => {
  // the last menu item: below the fold on a phone
  await app.scroll('down');
  await app.idle();
  await app.getByText('Zawieszenie').tap();
  await app.getByText(button).tap();
  const t0 = performance.now();
  await sleep(1000); // the hang has started (main: the app opens its own URL; JS: 300 ms after the tap)
  return t0;
};

test('main thread stuck: native calls fail with the fact before it runs again, then work', async t => {
  const t0 = await block('Wątek główny');
  const [first] = await failed(app.native.call('Layout.visibility', { tags: [] }));
  assert.equal(first.code, 'TIMEOUT');
  stuck(first, 'main');
  t.diagnostic(`first call failed ${Math.round(performance.now() - t0)}ms after the tap, forMs ${first.stuck.forMs}`);
  assert.ok(performance.now() - t0 < 8000, `${performance.now() - t0}ms`); // ~5.5 s, not 15 s
  // the next ones about at once: the snapshot's native part (iOS: its JS part already, the JS agent's socket is on main)
  const [snap, ms] = await failed(app.snapshot());
  stuck(snap, 'main');
  t.diagnostic(`next call failed in ${Math.round(ms)}ms`);
  assert.ok(ms < 1500, `${ms}ms`);
  const [idle] = await failed(app.idle());
  assert.deepEqual([idle.code, idle.busy?.thread], ['TIMEOUT', 'main']);
  stuck(idle, 'main');
  assert.ok(performance.now() - t0 < HANG, `${performance.now() - t0}ms`);
  await sleep(t0 + HANG + 500 - performance.now());
  await expect(app.getByText('Wątek JS')).toBeVisible();
  await app.idle();
});

test('JS thread stuck: JS calls fail with the fact, native calls work, then JS calls too', async t => {
  const t0 = await block('Wątek JS');
  const [first] = await failed(app.js.call('Tree.query', { selector: { text: 'Wątek JS' } }));
  assert.equal(first.code, 'TIMEOUT');
  stuck(first, 'JS');
  t.diagnostic(`first call failed ${Math.round(performance.now() - t0)}ms after the tap, forMs ${first.stuck.forMs}`);
  assert.ok(performance.now() - t0 < 8000, `${performance.now() - t0}ms`);
  const [snap, ms] = await failed(app.snapshot());
  stuck(snap, 'JS');
  t.diagnostic(`next call failed in ${Math.round(ms)}ms`);
  assert.ok(ms < 1500, `${ms}ms`);
  await app.native.call('Layout.visibility', { tags: [] });
  await sleep(t0 + HANG + 500 - performance.now());
  await expect(app.getByText('Wątek JS')).toBeVisible();
});

test('a long drag (main draws its frames): not stuck', async ctx => {
  await app.getByText('Lista').tap();
  await expect(app.getByTestId('list')).toBeVisible();
  const list = await app.getByTestId('list').resolve();
  // one move per frame: ~7 s whatever the refresh rate (a gesture is cancelled after 10 s); a frame's time from two
  // short drags, without their fixed cost (the finger held still, the frames after it)
  const drag = async moves => {
    const t = performance.now();
    await app.native.call('Input.scroll', { tag: list.tag, dy: 100, moves });
    return performance.now() - t;
  };
  const frame = Math.max(1, ((await drag(40)) - (await drag(10))) / 30);
  const moves = Math.round(7000 / frame);
  const t = performance.now();
  // a slow emulator's frames come late: the agent may cancel the drag at 10 s, which is not stuck either
  const r = await app.native.call('Input.scroll', { tag: list.tag, dy: 300, moves }).catch(e => e);
  assert.equal(r.stuck, undefined);
  assert.ok(r.ok === true || /gesture still down after 10 s/.test(r.message), r.stack);
  ctx.diagnostic(`drag of ${moves} frames took ${Math.round(performance.now() - t)}ms`);
  assert.ok(performance.now() - t > STUCK_MS, `${performance.now() - t}ms`);
});

// Android: the system's crash dialog keeps the crashed thread (main) waiting until it is dismissed, so the app stays
// connected. The dialog shows on a first crash only with a developer option: set for the test, restored after. An app
// that crashes again within a minute gets no dialog: the system kills it (the agents disconnect).
test('a crash behind the system dialog: main stuck', { skip: target.platform === 'ios' && 'iOS: a crash ends the process' }, async t => {
  const option = ['secure', 'show_first_crash_dialog_dev_option'];
  const was = adb('shell', 'settings', 'get', ...option);
  adb('shell', 'settings', 'put', ...option, '1');
  try {
    await block('Awaria');
    const [e, ms] = await failed(app.native.call('Layout.visibility', { tags: [] }));
    if (e.code === 'NOT_CONNECTED') return t.skip('killed without a dialog: crashed again within a minute');
    stuck(e, 'main');
    t.diagnostic(`failed in ${Math.round(ms)}ms, forMs ${e.stuck.forMs}`);
    const js = await app.js.call('Agent.ping').then(() => 'answers', e => e.code);
    t.diagnostic(`JS thread: ${js}`);
  } finally {
    if (was === 'null') adb('shell', 'settings', 'delete', ...option);
    else adb('shell', 'settings', 'put', ...option, was);
    adb('shell', 'am', 'force-stop', target.appId);
  }
});
