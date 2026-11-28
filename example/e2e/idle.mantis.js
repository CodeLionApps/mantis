// app.idle() on the example app: a spinner on screen keeps it busy, one hidden in a mounted overlay doesn't; work that
// lands after the tap (a timer, a WebSocket reply, an animation, an image) is waited for, work that never ends isn't.
// MANTIS_E2E=1 build installed; DEVICE=<adb serial or simulator / iPhone UDID> [PLATFORM=ios MANTIS_APP_ID=<bundle id>]
//   node --test e2e/idle.mantis.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { App, expect } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');

const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(undefined, target.platform, { usb: isIosDevice(target) ? target.deviceId : undefined });
// the app reaches the test's server at localhost (Android: adb reverse); a cabled iPhone's localhost is the phone
const lab = { skip: isIosDevice(target) && "a cabled iPhone can't reach the host's localhost:9124" };
// the screen "Później"'s server (App.tsx LAB): an image after 800 ms (/slow.png: 5 s; /missing.png: a 404 after
// 800 ms); on a socket, "hej" gets a reply after 600 ms, then a ping every 200 ms
const LAB = 9124;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/missing.png') return setTimeout(() => res.writeHead(404).end(), 800);
  setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG), path === '/slow.png' ? 5000 : 800);
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws =>
  ws.on('message', m => {
    if (String(m) !== 'hej') return;
    setTimeout(() => {
      ws.send('odpowiedź');
      const ping = setInterval(() => ws.send('ping'), 200);
      ws.on('close', () => clearInterval(ping));
    }, 600);
  }),
);
const adb = (...args) => execFileSync('adb', ['-s', target.deviceId, ...args]);
before(async () => {
  await app.start();
  reversePort(app.port, target);
  await new Promise(r => server.listen(LAB, '127.0.0.1', r));
  if (target.platform === 'android') adb('reverse', `tcp:${LAB}`, `tcp:${LAB}`);
});
after(() => {
  if (target.platform === 'android') adb('reverse', '--remove', `tcp:${LAB}`);
  for (const ws of wss.clients) ws.terminate();
  server.closeAllConnections();
  server.close();
  return app.close();
});
beforeEach(() => app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs })));

const timed = async (o) => {
  const t = performance.now();
  await app.idle(o);
  return performance.now() - t;
};

test('static screen: idle in about quietMs', async () => {
  await app.idle();
  for (let i = 0; i < 3; i++) assert.ok((await timed()) < 1000);
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

const shows = async text => (await app.snapshot()).nodes.some(n => n.text === text);
const later = async () => {
  await app.getByText('Później').tap();
  await expect(app.getByText('Stan: nic')).toBeVisible();
  await app.idle();
};

// tap, then idle since a mark taken before it: on a loaded device the press handler may run after tap() returned
const tapIdle = async (text, o) => {
  const since = await app.mark();
  await app.getByText(text).tap();
  return app.idle({ since, ...o });
};

test('a timer the tap set: idle waits for it', async () => {
  await later();
  await tapIdle('Za chwilę');
  assert.ok(await shows('Stan: po czasie'));
});

// the first two rounds of each are waited for (they could be one-off timers), then they recur
test('an interval and timers that re-arm themselves: idle returns, reporting them', async () => {
  await later();
  await app.getByText('W tle').tap();
  await expect(app.getByText('Stan: w tle')).toBeVisible();
  const { timers } = await app.idle({ timeout: 5000 });
  assert.ok(timers.some(x => x.kind === 'interval' && x.ms === 1000), JSON.stringify(timers));
  for (const ms of [300, 700]) assert.ok(timers.some(x => x.ms === ms && x.recurring && x.fires >= 2), JSON.stringify(timers));
});

test('a WebSocket reply: idle waits for it; the server pinging later does not hold it', lab, async () => {
  await later();
  await tapIdle('WebSocket');
  assert.ok(await shows('Stan: WS odpowiedź'));
  // the pongs answer the server: nothing waits for a reply (an unanswered send would hold up to 1.5 s)
  for (let i = 0; i < 3; i++) assert.deepEqual((await app.idle({ timeout: 3000 })).network, []);
});

for (const [button, ms] of [['Ruch', 800], ['Ruch później', 1400]])
  test(`a native-driver animation (${button}): idle waits for its end`, async () => {
    await later();
    const box = async () => (await app.snapshot()).nodes.find(n => n.testID === 'box').rect.x;
    const x0 = await box();
    const t = performance.now();
    await tapIdle(button);
    assert.ok(performance.now() - t >= ms);
    assert.ok(Math.abs((await box()) - x0 - 200) < 2);
  });

test('a looping animation: times out, saying what moves', async () => {
  await later();
  // an emulator's frames stall now and then (over 100 ms without a draw), and its main thread may not answer at all
  // while it animates (busy.thread then)
  await assert.rejects(tapIdle('Pętla', { timeout: 1500, quietMs: 300 }), e => e.code === 'TIMEOUT' && !!(e.busy.screen || e.busy.thread === 'main'));
});

test('an image from the network: idle waits for it, reporting the load', lab, async () => {
  await later();
  const since = await app.mark();
  await app.getByText('Obrazek').tap();
  await assert.rejects(app.idle({ since, timeout: 500 }), e =>
    e.code === 'TIMEOUT' && !!e.busy.network?.some(r => r.image && r.url === 'http://localhost:9124/image.png'));
  await app.idle();
  assert.ok(await shows('Stan: obrazek'));
});

// the image view unmounted while it loads: the load is cancelled and holds nothing (the server would answer in 5 s)
test('an image left before it loaded: idle returns, no load reported', lab, async () => {
  await later();
  const since = await app.mark();
  await app.getByText('Wolny obrazek').tap();
  await assert.rejects(app.idle({ since, timeout: 500 }), e => !!e.busy.network?.some(r => r.image));
  await app.getByText('Wstecz').tap();
  await expect(app.getByText('Później')).toBeVisible();
  const { network } = await app.idle({ timeout: 3000 });
  assert.deepEqual(network.filter(r => r.image), []);
});

// the server answers 404 after 800 ms; onError's commit may land just after the load ended (nothing draws on a failure)
test('an image that fails: idle waits for the failure, then holds nothing', lab, async () => {
  await later();
  const t = performance.now();
  await tapIdle('Zły obrazek');
  assert.ok(performance.now() - t >= 700);
  await expect(app.getByText('Stan: błąd obrazka')).toBeVisible();
  assert.deepEqual((await app.idle()).network.filter(r => r.image), []);
});
