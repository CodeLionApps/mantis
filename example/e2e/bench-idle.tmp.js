// local only (not committed): idle() and Agent.ping cost on the static menu. DEVICE=... [PLATFORM=ios MANTIS_APP_ID=...]
const { App } = require('@codelionapps/mantis');
const { isIosDevice, launchApp, reversePort } = require('@codelionapps/mantis/device');
const target = { platform: process.env.PLATFORM || 'android', deviceId: process.env.DEVICE, appId: process.env.MANTIS_APP_ID || 'com.probespike' };
const app = new App(undefined, target.platform, { usb: isIosDevice(target) ? target.deviceId : undefined });
const stats = a => { a.sort((x, y) => x - y); return `${a[a.length >> 1].toFixed(1)}/${a[Math.floor(a.length * 0.9)].toFixed(1)}`; };
(async () => {
  await app.start();
  reversePort(app.port, target);
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  await app.idle({ timeout: 20000 });
  await new Promise(r => setTimeout(r, 1000));
  for (let round = 0; round < 2; round++) {
    const idle = [], ping = [];
    for (let i = 0; i < 40; i++) {
      let t = performance.now(); await app.idle(); idle.push(performance.now() - t);
      t = performance.now(); await app.native.call('Agent.ping'); ping.push(performance.now() - t);
    }
    console.log(`idle ${stats(idle)} ping ${stats(ping)}`);
  }
  console.log(JSON.stringify(await app.native.call('Agent.ping')));
  await app.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
