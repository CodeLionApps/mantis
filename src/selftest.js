// Device-free check of the Mantis runner + JS agent query engine: the real agent.js runs on a fake React fiber
// tree, a fake native agent answers measuring/input calls. usage: npm test
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// agent.js measures through ReactFabric; give it fake boxes instead of the real renderer
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "react-native")
    return {
      Platform: { OS: "android" },
      // the token the native agent read from the launch intent; null at first: no activity yet, the JS agent asks again
      NativeModules: { Mantis: nativeMantis },
      Dimensions: { get: () => ({ width: 400, height: 800 }) },
    };
  // iOS's no-op BackHandler: the agent keeps its listeners for Input.back
  if (request.endsWith("Utilities/Platform")) return { OS: "ios" };
  if (request.endsWith("Utilities/BackHandler")) return { default: backHandler };
  if (request.endsWith("Core/RawEventEmitter"))
    return { default: { addListener: (_type, cb) => (touchStart = cb) } };
  if (request.endsWith("Renderer/shims/ReactFabric")) {
    return {
      getPublicInstanceFromInternalInstanceHandle: (f) => ({
        getBoundingClientRect: () => f.box,
      }),
    };
  }
  return load.call(this, request, ...rest);
};

let runnerToken; // the selftest runner's; fake agents echo it
let tokenAsked = 0;
let nativeMantis = { token: () => (tokenAsked++ ? runnerToken : null) }; // the Mantis native module, if any
const backHandler = { addEventListener() {}, removeEventListener() {} }; // RN 0.76: removeEventListener a no-op too
let keyboard = null; // the fake native agent's keyboard rect
let alert = null; // the fake native agent's alert of the app (focused false, app active): its Input.back result
let nativeBack = { ok: false, reason: "no native navigation stack to pop" };
let screen = () => ({ draws: 0, idleMs: 1000, busy: null }); // the fake native agent's draw clock; null: no Agent.ping
const { App, DETOX_VISIBLE, PROTOCOL, expect } = require("./runner");

let nextTag = 1;
const host = (
  type,
  props,
  children = [],
  box = { x: 0, y: 0, width: 100, height: 20 },
) => {
  const f = {
    tag: 5,
    type,
    memoizedProps: props,
    stateNode: { canonical: { nativeTag: nextTag++ } },
    box,
  };
  let prev = null;
  for (const c of children) {
    c.return = f;
    if (prev) prev.sibling = c;
    else f.child = c;
    prev = c;
  }
  return f;
};
const text = (s, props = {}) =>
  host("RCTText", props, [{ tag: 6, memoizedProps: s }]);

// two "screens": the lower one is mounted in JS but not shown natively (ratio 0)
const lowerBack = host("RCTView", { testID: "back" });
const topBack = host("RCTView", { testID: "back" });
const row = host("RCTView", { testID: "row" }, [text("Lek"), text("1 maja")]);
const cta = host("RCTView", { testID: "cta" });
const minus = host("RCTView", {
  testID: "minus",
  accessibilityState: { disabled: true },
});
const root = host("RCTView", {}, [
  host("RCTView", { testID: "screen-a" }, [lowerBack]),
  host("RCTView", { testID: "screen-b" }, [
    topBack,
    row,
    cta,
    minus,
    text("0", { testID: "qty" }),
  ]),
]);
const ratios = {
  [lowerBack.stateNode.canonical.nativeTag]: 0,
  [cta.stateNode.canonical.nativeTag]: 0.5,
};
const taps = [];
const checks = new Map(); // tag -> the fake native agent's Action.check answer, when not ok
const scrolled = []; // Input.scroll params
let onScroll = () => {};
let touchStart; // the agent's touch listener; the fake native tap feeds it, like RN would
let drop = 0; // next n touches land on a view React already replaced
let silent = false; // touches never reach JS
let typeable = Infinity; // Input.typeText calls that find a focused field
let nativeRects = new Map(); // tag -> the fake native agent's screen rect (else none: the JS layout)
const nativeTexts = new Map(); // tag -> an input's native text
let secretAsked = []; // the secret tags of the last Layout.visibility
const typed = []; // their text
let twice = false; // JS sees two touches for one tap (e.g. a late one of an earlier tap)
let oldAgent = false; // a native agent from before Input.tap reported took
const URL = "ws://127.0.0.1:9199";
const NodeWS = global.WebSocket; // the JS agent's gets replaced below
const hello = (role, extra = {}) =>
  JSON.stringify({
    method: "Agent.hello",
    params: { role, platform: "android", v: PROTOCOL, token: runnerToken, features: ["token"], ...extra },
  });
const closed = (ws) => new Promise((r) => (ws.onclose = r));

// Contract: every method the runner and the Detox layer call natively is implemented by both native agents.
function checkContract() {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const called = new Set(
    [src("src/runner/index.js"), src("src/detox/index.js")]
      .join("\n")
      .match(/(?:native\.call|inject)\(\s*"[^"]+"/g)
      .map((m) => m.match(/"([^"]+)"/)[1]),
  );
  const ios = src("ios/MantisAgent.m");
  const android = src("android/src/mantis/java/com/codelion/mantis/MantisAgent.kt");
  for (const m of called) {
    assert(ios.includes(`isEqualToString:@"${m}"`), `iOS agent lacks ${m}`);
    assert(android.includes(`"${m}" ->`), `Android agent lacks ${m}`);
  }
  // every agent says hello with the runner's protocol version
  assert(ios.includes(`@"v": @${PROTOCOL}`), "iOS agent PROTOCOL");
  assert(android.includes(`put("v", ${PROTOCOL})`), "Android agent PROTOCOL");
  assert(src("src/agent/index.js").includes(`const PROTOCOL = ${PROTOCOL};`), "JS agent PROTOCOL");
  // the shipped types declare every export (the ones no app needs aside)
  for (const [mod, dtsPath, internal] of [
    ["./runner", "src/runner/index.d.ts", []],
    ["./device", "src/device/index.d.ts", ["detoxDevice", "requireDetox"]],
    ["../metro", "metro.d.ts", []],
  ]) {
    const dts = src(dtsPath);
    for (const name of Object.keys(require(mod)))
      if (!internal.includes(name))
        assert(new RegExp(`export (declare )?(class|function|const) ${name}\\b`).test(dts), `${dtsPath} lacks ${name}`);
  }
}

// Cabled iPhone: the runner dials the agents through usbmuxd. A fake usbmuxd on a unix socket answers ListDevices and
// Connect (checking the port's byte order) and hands each tunnel to a fake phone: Runner.attach -> Agent.hello.
async function checkUsbmux() {
  const { isIosDevice } = require("./device");
  for (const [deviceId, phone] of [
    ["00001111-2222333344445555", true],
    ["0123456789abcdef0123456789abcdef01234567", true],
    ["11111111-2222-3333-4444-555555555555", false], // a simulator (and devicectl's identifier)
    ["booted", false],
    [undefined, false],
  ])
    assert.equal(isIosDevice({ platform: "ios", deviceId }), phone, String(deviceId));
  assert.equal(isIosDevice({ platform: "android", deviceId: "00001111-2222333344445555" }), false);

  const http = require("node:http");
  const { WebSocketServer } = require("ws");
  const usbmux = require("./runner/usbmux");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const udid = "00001111-2222333344445555";
  const port = 47213;
  const frame = (dict) => {
    const body = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict>${dict}</dict></plist>`);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + body.length, 0);
    head.writeUInt32LE(1, 4);
    head.writeUInt32LE(8, 8);
    return Buffer.concat([head, body]);
  };
  const props = (id, type) =>
    `<dict><key>DeviceID</key><integer>${id}</integer><key>MessageType</key><string>Attached</string>` +
    `<key>Properties</key><dict><key>ConnectionType</key><string>${type}</string><key>DeviceID</key>` +
    `<integer>${id}</integer><key>EscapedFullServiceName</key><data>AAEC</data>` +
    `<key>SerialNumber</key><string>${udid.replace("-", "")}</string></dict></dict>`;
  let listening = false; // the app on the "phone" runs and listens
  let foreign = false; // ...but it's another app: it closes a Runner.attach with another token unanswered
  let connects = 0;
  const sockets = { native: [], js: [] };
  const phone = new WebSocketServer({ noServer: true });
  phone.on("connection", (ws) =>
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.method === "Runner.attach") {
        if (foreign) return ws.terminate();
        sockets[msg.params.role].push(ws);
        const hello = { role: msg.params.role, platform: "ios", v: PROTOCOL, token: msg.params.token, ctx: "c" };
        return ws.send(JSON.stringify({ method: "Agent.hello", params: hello }));
      }
      if (msg.method === "Layout.visibility") ws.send(JSON.stringify({ id: msg.id, result: { appState: 0, focused: true } }));
      // "Hang": never answers
    }),
  );
  const tunnels = http.createServer();
  tunnels.on("upgrade", (req, sock, head) => phone.handleUpgrade(req, sock, head, (ws) => phone.emit("connection", ws)));
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mantis-")), "usbmuxd");
  const fake = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const req = buf.subarray(16, buf.readUInt32LE(0)).toString();
      const type = /<key>MessageType<\/key><string>(\w+)</.exec(req)[1];
      if (type === "ListDevices")
        return sock.end(frame(`<key>DeviceList</key><array>${props(3, "Network")}${props(7, "USB")}</array>`));
      assert.equal(type, "Connect");
      assert.match(req, /<key>DeviceID<\/key><integer>7</); // the USB one, not the Wi-Fi sync entry
      const swapped = Number(/<key>PortNumber<\/key><integer>(\d+)</.exec(req)[1]);
      assert.equal(swapped, ((port & 0xff) << 8) | (port >> 8)); // network byte order
      connects++;
      sock.off("data", onData);
      sock.write(frame(`<key>MessageType</key><string>Result</string><key>Number</key><integer>${listening ? 0 : 3}</integer>`));
      if (listening) tunnels.emit("connection", sock);
      else sock.end();
    };
    sock.on("data", onData);
  });
  await new Promise((r) => fake.listen(sockPath, r));
  usbmux.socket = sockPath;

  await assert.rejects(new App(port, "ios", { usb: "ffffffff-ffffffffffffffff" }).start(), /no iPhone/);
  const app = new App(port, "ios", { usb: udid });
  // another app holds the port: the launch fails fast with PORT_IN_USE, not NOT_CONNECTED after the timeout
  foreign = true;
  await app.start();
  const t0 = performance.now();
  await assert.rejects(app.relaunch(async () => (listening = true), { timeout: 5000 }), { code: "PORT_IN_USE", message: /held by another app/ });
  assert(performance.now() - t0 < 4000);
  // it's gone, this launch's agent listens: connected, and nothing held any more
  foreign = false;
  await app.relaunch(async () => {});
  assert(app.native.connected && app.js.connected && !app.native.held);
  // the native leg drops (app killed, cable out): the call in flight fails at once, the runner redials
  const hang = app.native.call("Hang");
  sockets.native[0].terminate();
  await assert.rejects(hang, { code: "DISCONNECTED" });
  await app.native.ready(2000);
  assert.equal(sockets.native.length, 2);
  // a close() and start() in quick succession: one dial loop per leg, not two
  await app.close();
  await app.start();
  await app.native.ready(2000);
  await sleep(2200); // past the 2 s backoff of a leg that closed without an accepted hello
  assert.equal(phone.clients.size, 2); // a native and a JS leg, and nothing redials
  const before = connects;
  await app.close();
  for (const ws of phone.clients) ws.terminate();
  listening = false;
  await sleep(200);
  assert.equal(connects, before); // closed: nothing dials
  fake.close();
}

(async () => {
  checkContract();

  // iOS: simulators share the Mac's localhost, so only agents echoing this runner's token become peers
  const iosApp = new App(9198, "ios");
  const sock = { close() {} };
  const refused = (peer) => [...peer.refused].join("; ");
  iosApp.js.greet(sock, { role: "js", platform: "ios", v: PROTOCOL });
  assert.match(refused(iosApp.js), /no token: launch with the runner's launchArgs/);
  iosApp.js.greet(sock, { role: "js", platform: "ios", v: PROTOCOL, token: "another runner's" });
  assert.match(refused(iosApp.js), /wrong token/);
  iosApp.js.greet(sock, { role: "js", platform: "ios", v: PROTOCOL, token: iosApp.launchArgs.mantisToken });
  assert.equal(iosApp.js.hello?.token, iosApp.token);
  // Android without a port: a free one each, so a Mantis app on another device (adb reverse to the default port)
  // can't reach this runner; an explicit port and iOS keep theirs
  delete process.env.MANTIS_PORT;
  const free = [new App(), new App()];
  await Promise.all(free.map((a) => a.start()));
  assert(free[0].port > 0 && free[1].port > 0 && free[0].port !== free[1].port);
  await Promise.all(free.map((a) => a.close()));
  assert.equal(new App(undefined, "ios").port, require("./runner").PORT);
  const app = new App(9199);
  runnerToken = app.launchArgs.mantisToken;
  await app.start();
  assert.equal(app.port, 9199);

  // garbage, unknown roles and old agents don't take the runner down or become a peer
  const junk = new NodeWS(`${URL}/?role=native`);
  junk.onopen = () => junk.send("x");
  await closed(junk);
  await closed(new NodeWS(`${URL}/?role=admin`));
  const old = new NodeWS(`${URL}/?role=native`);
  old.onopen = () => old.send(hello("native", { v: 0 }));
  await closed(old);
  await assert.rejects(app.native.ready(50), { code: "NOT_CONNECTED", message: new RegExp(`protocol v0, runner v${PROTOCOL}`) });

  // a frame ws rejects (RSV1 without permessage-deflate) emits "error" on the socket; the runner must survive it
  await new Promise((resolve) => {
    const raw = net.connect(9199, "127.0.0.1", () =>
      raw.write(
        "GET /?role=native HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      ),
    );
    raw.once("data", () => raw.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])));
    raw.on("close", resolve);
    raw.on("error", resolve);
  });

  // fake native agent
  const nativeHandler = (native) => (e) => {
    const { id, method, params } = JSON.parse(e.data);
    if (method === "Agent.ping" && !screen)
      return native.send(JSON.stringify({ id, error: { message: "MantisAgent: unknown method Agent.ping" } }));
    const result = {
      "Agent.ping": () => screen(),
      "Layout.visibility": () => ({
        ratios: params.tags.map((t) => ratios[t] ?? 0.9),
        // snapshot: cta's centre is covered (e.g. by a sheet backdrop), row's lands on its own text "Lek" (Fabric
        // hoists the text out of row natively), row's texts aren't covered
        ...(params.hit && {
          hit: params.tags.map((t) => ![row, cta].some((f) => f.stateNode.canonical.nativeTag === t)),
          at: params.tags.map((t) =>
            t === row.stateNode.canonical.nativeTag ? row.child.stateNode.canonical.nativeTag
            : t === cta.stateNode.canonical.nativeTag ? topBack.stateNode.canonical.nativeTag : t),
          rects: params.tags.map((t) => nativeRects.get(t) ?? null),
          focused: !alert,
          appState: 0,
          keyboard,
        }),
        // the native agent masks the secret ones
        ...(params.inputs && {
          texts: params.inputs.map((t) =>
            !nativeTexts.has(t) ? null : params.secret.includes(t) ? (nativeTexts.get(t) ? "••••••••" : "") : nativeTexts.get(t)),
        }),
        ...(params.secret && (secretAsked = params.secret) && {}),
      }),
      "Action.check": () => checks.get(params.tag)?.() ?? { ok: true, point: { x: params.tag, y: 0 } },
      "Input.scroll": () => (scrolled.push(params), onScroll(params), { ok: true, from: { x: 200, y: 400 }, to: { x: 200, y: 400 - (params.dy ?? 0) } }),
      "Input.typeText": () =>
        typeable-- > 0 ? (typed.push(params.text), { ok: true, focusedTag: params.tags?.[0] }) : { ok: false, reason: "focused: null" },
      "Input.hideKeyboard": () => ({ ok: true }),
      "Input.back": () => (params.alert ? alert ?? { ok: false, reason: "no alert" } : nativeBack),
      "Input.tap": () => {
        taps.push(params.x);
        if (!silent)
          touchStart({ nativeEvent: { target: drop > 0 ? -1 : params.x } });
        if (twice) touchStart({ nativeEvent: { target: params.x } });
        drop = Math.max(0, drop - 1);
        return oldAgent ? { ok: true } : { ok: true, took: params.x }; // the fake's hit-test: the tag is the x
      },
    }[method]();
    if (result === undefined) return; // a stalled main thread doesn't answer
    native.send(JSON.stringify({ id, result }));
  };
  const connectNative = () => {
    const native = new NodeWS(`${URL}/?role=native`);
    native.onopen = () => native.send(hello("native"));
    native.onmessage = nativeHandler(native);
    return native;
  };
  let native = connectNative();

  // real JS agent; it dials ws://localhost:9123, so point it at this test's port (the app's own sockets go where asked)
  global.WebSocket = class extends NodeWS {
    constructor(url) {
      super(url.includes("?role=js") ? `${URL}/?role=js` : url);
    }
  };
  global.XMLHttpRequest = class extends EventTarget { open() {} send() {} }; // RN's dispatches loadend when done
  // the agent wraps the timer globals; this process's (runner, ws, this test) keep Node's, the app's are its wrappers
  // frames: RN's ids share the timers' space (clearTimeout clears a frame), so a frame is a 16 ms timeout here
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  const timerNames = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"];
  const nodeTimers = timerNames.map((k) => [k, global[k]]);
  require("./agent");
  const appTimers = Object.fromEntries(nodeTimers.map(([k]) => [k, global[k]]));
  for (const [k, f] of nodeTimers) global[k] = f;
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {
    current: { child: root, memoizedState: { element: {} } },
  });
  await Promise.all([app.js.ready(), app.native.ready()]);
  assert.equal(tokenAsked, 2);

  // Android: every Mantis app on a device dials the same port. One without this runner's token (built with an older
  // Mantis, launched without app.launchArgs, or by another runner) is refused and doesn't replace the connected agent.
  // Nothing in a hello may throw before it is accepted (that would kill the test process).
  const peer = app.native.ws;
  const foreignHello = async (extra) => {
    const foreign = new NodeWS(`${URL}/?role=native`);
    foreign.onopen = () => foreign.send(typeof extra === "string" ? extra : hello("native", extra));
    await Promise.race([closed(foreign), new Promise((r) => setTimeout(r, 1000)).then(() => assert.fail(`accepted: ${JSON.stringify(extra)}`))]);
  };
  for (const [extra, why] of [
    [{ token: undefined, features: undefined }, /^no token: an app built with an older Mantis/],
    [{ token: undefined, features: {} }, /^no token: an app built with an older Mantis/],
    [{ token: undefined, features: 5 }, /^no token: an app built with an older Mantis/],
    [{ token: null }, /^no token: launch with the runner's launchArgs/],
    [{ token: "another runner's" }, /^wrong token/],
    [{ role: { toString: 1 } }, /^role {"toString":1}/],
    [{ role: "ż".repeat(200) }, /^role żżż/], // a close reason over 123 bytes throws
    [{ error: { toString: 1 } }, /^{"toString":1}$/],
    ['{"method":"Agent.hello","params":5}', /^role undefined/],
  ]) {
    app.native.refused.clear();
    await foreignHello(extra);
    assert.match(refused(app.native), why);
  }
  assert(app.native.connected && app.native.ws === peer);

  // what "not connected" reports: the distinct reasons refused since the last launch, none from before it
  const solo = new App(9197);
  await solo.start();
  const soloHello = async (extra) => {
    const ws = new NodeWS("ws://127.0.0.1:9197/?role=native");
    ws.onopen = () => ws.send(hello("native", { token: solo.token, ...extra }));
    await closed(ws);
  };
  await soloHello({ v: 0 });
  await soloHello({ token: "another runner's" });
  await soloHello({ token: "another runner's" });
  await assert.rejects(solo.native.ready(50), {
    code: "NOT_CONNECTED",
    message: /hellos refused since the last launch.*: protocol v0, runner v\d+: rebuild [^|]* \| wrong token: [^|]*\)$/,
  });
  await assert.rejects(solo.relaunch(() => {}, { timeout: 50 }), (e) =>
    e.code === "NOT_CONNECTED" && !/refused|protocol v0|wrong token/.test(e.message));
  await assert.rejects(solo.relaunch(() => soloHello({ token: null }), { timeout: 50 }), (e) =>
    e.code === "NOT_CONNECTED" && /refused since the last launch.*: no token: launch with/.test(e.message) && !/v0/.test(e.message));
  await solo.close();

  const id = (t) => app.getByTestId(t);
  const quick = { timeout: 300 };
  const tagOf = (f) => f.stateNode.canonical.nativeTag;

  await expect(id("row").getByText("Lek")).toBeInViewport(DETOX_VISIBLE);
  await expect(id("screen-b").getByText("1 maja")).toBeAttached();
  await expect(id("screen-a").getByText("Lek")).not.toBeAttached();
  await expect(id("qty")).toHaveText("0");
  await expect(id("back")).toHaveCount(2);
  await expect(id("cta")).toBeInViewport(); // ratio 0.5 > 0
  await expect(id("cta")).not.toBeInViewport(DETOX_VISIBLE); // 0.5 < 0.75
  await expect(id("missing")).not.toBeAttached();
  await assert.rejects(expect(id("qty")).toHaveText("1", quick), /got "0"/);
  await assert.rejects(id("back").tap(quick), { code: "STRICT", message: /strict mode violation/ });

  await id("back").filter({ visible: true }).first().tap();
  assert.deepEqual(taps, [topBack.stateNode.canonical.nativeTag]);
  await assert.rejects(id("minus").tap(quick), { code: "NOT_ACTIONABLE", reason: "disabled", message: /last: disabled/ });
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 2);
  drop = 1;
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 4); // dropped touch, tapped again
  drop = 3;
  await assert.rejects(id("minus").tap({ force: true }), { code: "DELIVERED", message: /tap dropped 3 times/ });
  assert.equal(taps.length, 7);
  silent = true; // a late touch is never answered with a second tap
  await assert.rejects(id("minus").tap({ force: true, timeout: 200 }), { code: "DELIVERED", message: /saw no touch/ });
  assert.equal(taps.length, 8);
  silent = false;
  twice = true; // can't tell which touch is this tap's: fail, never tap again
  await assert.rejects(id("minus").tap({ force: true }), { code: "DELIVERED", message: /touch count went from \d+ to \d+/ });
  assert.equal(taps.length, 9);
  twice = false;
  // waits that a frame won don't pile up until the next commit
  assert.equal(app.commitWaiters.length, 0);

  // a call while the agent reconnects (relaunch, reload) waits for it instead of failing...
  native.close();
  await closed(native);
  // ...but idle and mark fail at once: their caller picks another wait
  let gone = performance.now();
  await assert.rejects(app.idle(), { code: "DISCONNECTED", message: /native agent is not connected/ });
  await assert.rejects(app.mark(), { code: "DISCONNECTED" });
  assert(performance.now() - gone < 100);
  setTimeout(() => (native = connectNative()), 100);
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 10);

  // a point in screen dp: settled, the touch JS saw attributed like a locator's tap; never under a system window or keyboard
  taps.length = 0;
  const touches = [];
  app.on("touch", (t) => touches.push(t));
  const sure = { seen: true, took: tagOf(minus) };
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5), sure);
  const [touch] = touches;
  assert.deepEqual({ ...touch, start: 0, end: 0 }, { type: "tap", x: tagOf(minus), y: 5, dx: 0, dy: 0, start: 0, end: 0 });
  assert(touch.start <= touch.end);
  // a listener that throws doesn't fail the tap (the touch happened); its error is uncaught, as Node's
  let uncaught;
  process.once("uncaughtException", (e) => (uncaught = e));
  const boom = () => {
    throw new Error("listener bug");
  };
  app.on("touch", boom);
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5), sure);
  app.off("touch", boom);
  assert.equal(uncaught?.message, "listener bug");
  assert.equal(touches.length, 2);
  drop = 1; // landed on a view React had replaced: nothing pressed, and something else may be there now: no second tap
  await assert.rejects(app.touchscreen.tap(tagOf(minus), 5), { code: "STALE", name: "MantisError", tag: tagOf(minus) });
  assert.equal(taps.length, 3);
  // an agent that doesn't report took: null, and no "tag null" in the message
  oldAgent = true;
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5), { seen: true, took: null });
  drop = 1;
  await assert.rejects(app.touchscreen.tap(tagOf(minus), 5), (e) => e.code === "STALE" && e.tag === null && !/tag null/.test(e.message));
  oldAgent = false;
  silent = true; // unknown: a native view took it, or JS is busy
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5, { timeout: 100 }), { seen: false, took: tagOf(minus) });
  const unseen = performance.now(); // timeout 0: only the settle, no waiting for JS
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5, { timeout: 0 }), { seen: false, took: tagOf(minus) });
  assert(performance.now() - unseen < 100);
  silent = false;
  keyboard = { x: 0, y: 500, width: 400, height: 300 };
  await assert.rejects(app.touchscreen.tap(10, 600), { code: "COVERED", message: /on the keyboard/ });
  keyboard = null;
  alert = { ok: false }; // focused false: a system window over the app on Android, an alert of its own on iOS
  const covered = performance.now();
  await assert.rejects(app.touchscreen.tap(10, 600), { code: "COVERED", message: /not focused/ });
  assert(performance.now() - covered >= 300); // waited for focus first (a window that just opened)
  setTimeout(() => (alert = null), 100); // focus arrives (Android: a Modal's Dialog, ~130 ms after it shows)
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5), sure);
  alert = { ok: false };
  app.platform = "ios";
  assert.deepEqual(await app.touchscreen.tap(tagOf(minus), 5), sure);
  app.platform = "android";
  alert = null;
  assert.equal(taps.length, 9);
  assert.equal(app.tapAt, undefined); // one API: touchscreen / keyboard

  // keyboard.type: one character per Input.typeText into the focused field; partial failure is DELIVERED
  typed.length = 0;
  await app.keyboard.type("12ą");
  assert.deepEqual(typed, ["1", "2", "ą"]);
  typeable = 0;
  await assert.rejects(app.keyboard.type("34", { timeout: 50 }), { code: "NOT_FOCUSED", typed: 0 });
  setTimeout(() => (typeable = Infinity), 50); // the tap that focuses the field is still landing
  await app.keyboard.type("34");
  assert.deepEqual(typed.slice(-2), ["3", "4"]);
  typeable = 2;
  await assert.rejects(app.keyboard.type("5678"), (e) =>
    e.code === "DELIVERED" && e.typed === 2 && /2 of 4 characters typed, then keyboard.type: focused: null/.test(e.message) &&
    e.cause.code === "NOT_FOCUSED");
  typeable = Infinity;

  // getByTag: the exact node of a snapshot
  taps.length = 0;
  await app.getByTag(tagOf(minus)).tap({ force: true });
  assert.deepEqual(taps, [tagOf(minus)]);
  // in the tree, only filtered out (not shown): waits like any locator, no STALE
  await assert.rejects(app.getByTag(tagOf(lowerBack)).filter({ visible: true }).tap(quick), { code: "NOT_ACTIONABLE", reason: "not found" });
  // the app's JS reloaded since the locator was made: tags start over, the same number may be another view
  const minusByTag = app.getByTag(tagOf(minus));
  const ctx = app.js.hello.ctx;
  app.js.hello.ctx = "reloaded";
  await assert.rejects(minusByTag.tap({ force: true }), { code: "STALE", message: /reloaded/, tag: tagOf(minus) });
  await assert.rejects(expect(minusByTag).toBeAttached(), { code: "STALE" });
  app.js.hello.ctx = ctx;
  // an app built with an older Mantis: its JS agent can't match tags
  app.js.hello.features = undefined;
  await assert.rejects(app.getByTag(tagOf(minus)).tap(), { code: "UNSUPPORTED", message: /rebuild the app/ });
  await assert.rejects(app.scroll("down"), { code: "UNSUPPORTED" });
  app.js.hello.features = ["driver"];

  // snapshot: JS lists the screens below and covered nodes too; App.snapshot keeps what's seen (and containers of it)
  const raw = await app.js.call("Tree.snapshot");
  assert.equal(raw.nodes.find((n) => n.testID === "row").name, "Lek1 maja");
  assert.equal(raw.nodes.filter((n) => n.testID === "back").length, 2);
  const snap = await app.snapshot();
  const by = (k, v) => snap.nodes.findIndex((n) => n[k] === v);
  assert.deepEqual(
    snap.nodes.map((n) => n.testID ?? n.text),
    ["screen-a", "screen-b", "back", "row", "Lek", "1 maja", "minus", "qty"],
  );
  assert.equal(snap.nodes[by("text", "Lek")].parent, by("testID", "row"));
  assert.equal(snap.nodes[by("testID", "row")].hit, true); // the touch lands on its own (hoisted) text
  assert.equal(snap.nodes[by("testID", "back")].parent, by("testID", "screen-b"));
  assert.equal(snap.nodes[by("testID", "minus")].enabled, false);
  assert.equal(snap.focused, true);
  assert.deepEqual([snap.complete, snap.reasons], [true, []]);
  // rects as drawn natively (screen dp), not the JS layout (React root origin: a Modal under the status bar, transforms)
  nativeRects = new Map([[tagOf(minus), { x: 0, y: 24, width: 100, height: 20 }]]);
  assert.deepEqual((await app.snapshot()).nodes.find((n) => n.testID === "minus").rect, { x: 0, y: 24, width: 100, height: 20 });
  nativeRects = new Map();
  alert = { ok: false };
  assert.deepEqual((await app.snapshot()).reasons, ["app window not focused: a system window, another app or (iOS) an alert in front"]);
  alert = null;

  // Agent.ping: ms since the last commit, requests in flight (no query string)
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "https://api.example/visits?token=secret");
  xhr.send();
  let ping = await app.js.call("Agent.ping");
  assert(ping.idleMs >= 0 && ping.idleMs < 60_000);
  assert.deepEqual(ping.net.map((r) => r.url), ["https://api.example/visits"]);
  xhr.dispatchEvent(new Event("loadend"));
  ping = await app.js.call("Agent.ping");
  assert.deepEqual(ping.net, []);

  // idle: both clocks quiet for quietMs and nothing in flight; on timeout, what is still busy
  const waited = async (o) => {
    const t = performance.now();
    await app.idle(o);
    return performance.now() - t;
  };
  assert(await waited() < 100); // the last commit was long ago, nothing on screen moves
  const moving = performance.now() + 200; // a transition: the screen changes for 200 ms
  screen = () => ({ draws: 1, idleMs: performance.now() < moving ? 0 : performance.now() - moving, busy: "UIView animating position" });
  assert((await waited()) >= 250); // its end + quietMs
  const commit = () => global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: { child: root, memoizedState: { element: {} } } });
  commit();
  assert((await waited({ quietMs: 50 })) >= 40);
  xhr.send();
  await assert.rejects(app.idle({ timeout: 100 }), /not idle after 100ms: request in flight for \d+ms: https:\/\/api\.example\/visits$/);
  xhr.dispatchEvent(new Event("loadend"));
  screen = () => ({ draws: 2, idleMs: 0, busy: "UIImageView animating contents in a loop" }); // a spinner
  await assert.rejects(app.idle({ timeout: 100 }), /screen changed 0ms ago \(UIImageView animating contents in a loop\)/);
  screen = () => undefined; // the main thread stalls: idle's own timeout, not the RPC's 15 s
  const stalled = performance.now();
  await assert.rejects(app.idle({ timeout: 200 }), (e) =>
    e.constructor.name === "TimeoutError" && /not idle after 200ms: the main thread didn't answer$/.test(e.message));
  assert(performance.now() - stalled < 500);
  await assert.rejects(app.mark({ timeout: 100 }), { code: "TIMEOUT", message: /^mark: the main thread didn't answer in 100ms$/ });
  screen = null; // an iOS agent from before the draw clock: the JS clock alone
  await app.idle();
  // an exception inside an agent comes back with a code too
  await assert.rejects(app.native.call("Agent.ping"), { code: "AGENT_ERROR", name: "MantisError", message: /unknown method/ });
  screen = () => ({ draws: 2, idleMs: 1000, busy: null });
  // idle({ since }): idle counts only once the app reacted to the action (a commit or a draw since the mark)...
  let mark = await app.mark();
  setTimeout(commit, 150); // the app handles it 150 ms later (a back on the JS thread)
  assert((await waited({ since: mark, quietMs: 50 })) >= 190);
  mark = await app.mark();
  screen = () => ({ draws: 3, idleMs: 1000, busy: null }); // a draw, long enough ago
  assert((await waited({ since: mark })) < 100);
  // ...or after reactMs without one
  mark = await app.mark();
  const t = await waited({ since: mark, reactMs: 200 });
  assert(t >= 200 && t < 400);
  await assert.rejects(app.idle({ since: await app.mark(), timeout: 100 }), { code: "TIMEOUT", message: /no commit or draw since the mark yet$/ });
  // netMaxMs: a request older than that no longer holds it (polling, a hung request)
  xhr.send();
  await new Promise((r) => setTimeout(r, 60));
  assert((await waited({ netMaxMs: 50 })) < 100);
  await assert.rejects(app.idle({ timeout: 100 }), /request in flight/);
  xhr.dispatchEvent(new Event("loadend"));

  // JS timers: a one-off timeout of at most timerMaxMs holds idle until it fired (a tap that navigates 150 ms later),
  // and quietMs after it (what it started may show a frame later)...
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  let fired = false;
  appTimers.setTimeout(() => (fired = true), 150);
  assert((await waited()) >= 240 && fired);
  assert.deepEqual((await app.js.call("Agent.ping")).fired.map((f) => f.ms), [150]);
  // ...on timeout err.busy says which, as facts
  const nav = appTimers.setTimeout(() => {}, 1000);
  await assert.rejects(app.idle({ timeout: 100 }), (e) =>
    e.code === "TIMEOUT" && /: setTimeout 1000ms due in \d+ms$/.test(e.message) && !e.busy.react &&
    e.busy.timers.length === 1 && e.busy.timers[0].kind === "timeout" && e.busy.timers[0].ms === 1000 &&
    e.busy.timers[0].fires === 0 && e.busy.timers[0].sinceLastFire === null);
  assert((await waited({ timerMaxMs: 999 })) < 100); // longer than timerMaxMs: not waited for...
  const { timers } = await app.idle({ timerMaxMs: 999 });
  assert.equal(timers[0].ms, 1000); // ...but reported
  appTimers.clearTimeout(nav);
  assert.deepEqual((await app.idle()).timers, []);
  // a frame: held one frame; cancelled with clearTimeout (ids are shared): gone
  appTimers.requestAnimationFrame(() => {});
  assert.deepEqual((await app.js.call("Agent.ping")).timers.map((t) => t.kind), ["frame"]);
  assert((await waited()) >= 10);
  appTimers.clearTimeout(appTimers.requestAnimationFrame(() => {}));
  assert.deepEqual((await app.idle()).timers, []);
  // a timer that just fired holds quietMs, even when a longer one fired after it
  appTimers.setTimeout(() => {}, 20);
  appTimers.setTimeout(() => {}, 30);
  await nap(60);
  const long = appTimers.setTimeout(() => {}, 5000);
  await assert.rejects(app.idle({ timeout: 1, quietMs: 500, timerMaxMs: 6000 }), (e) => {
    const ms = e.busy.timers.filter((t) => t.fired).map((t) => t.ms);
    return ms.includes(20) && ms.includes(30) && /setTimeout 20ms fired \d+ms ago/.test(e.message);
  });
  appTimers.clearTimeout(long);
  // an equal-delay two-step chain (step, then navigate) is one-off: the second step is waited for too
  let steps = 0;
  appTimers.setTimeout(() => appTimers.setTimeout(() => steps++, 60), 60);
  await app.idle();
  assert.equal(steps, 1);
  // never-ending ones don't hold it once their bucket fired twice in a row: an interval, a re-armed timeout, an
  // await-sleep loop, a poll that awaits a request between rounds, a frame loop
  const beat = appTimers.setInterval(() => {}, 50);
  let rearmed = appTimers.setTimeout(function tick() {
    rearmed = appTimers.setTimeout(tick, 40);
  }, 40);
  let looping = true;
  (async () => {
    while (looping) await new Promise((r) => appTimers.setTimeout(r, 30));
  })();
  let poll = appTimers.setTimeout(async function tick() {
    await nap(70); // the request
    if (looping) poll = appTimers.setTimeout(tick, 90);
  }, 90);
  let frame = appTimers.requestAnimationFrame(function draw() {
    frame = appTimers.requestAnimationFrame(draw);
  });
  const t1 = performance.now();
  const { timers: pending } = await app.idle({ quietMs: 50 });
  assert(performance.now() - t1 < 1000);
  for (const x of ["interval 50", "timeout 40", "timeout 30"]) assert(pending.some((t) => `${t.kind} ${t.ms}` === x), x);
  assert(pending.every((t) => t.recurring && t.fires >= 2 && t.sinceLastFire >= 0), JSON.stringify(pending));
  appTimers.clearInterval(beat);
  appTimers.clearTimeout(rearmed);
  appTimers.clearTimeout(poll);
  appTimers.cancelAnimationFrame(frame);
  looping = false;
  await nap(100);
  assert.deepEqual((await app.idle()).timers, []);
  assert.deepEqual(await app.idle(), { network: [], timers: [] });

  // WebSockets: connecting, and a message sent with nothing received since, are in flight; a socket that waits for
  // nothing (or answers the server: a pong) isn't. Either holds idle 1500 ms at most (a push channel, a one-way send),
  // and stays a fact.
  const echo = new (require("ws").WebSocketServer)({ port: 0 });
  echo.on("connection", (s) => s.on("message", (m) =>
    String(m) === "ping?" ? s.send("ping") : ["pong", "fire-and-forget"].includes(String(m)) ? null : setTimeout(() => s.send("re: " + m), 150)));
  await new Promise((r) => echo.on("listening", r));
  const chat = new WebSocket(`ws://127.0.0.1:${echo.address().port}/chat?token=secret`);
  ping = await app.js.call("Agent.ping");
  assert.deepEqual(ping.net.map((r) => [r.url, r.ws]), [[`ws://127.0.0.1:${echo.address().port}/chat`, "connecting"]]);
  await new Promise((r) => chat.addEventListener("open", r));
  assert((await waited()) < 100);
  chat.send("hej");
  await assert.rejects(app.idle({ timeout: 50 }), (e) => /WebSocket waiting \d+ms for a reply: ws:.*\/chat$/.test(e.message) && e.busy.network[0].ws === "reply");
  assert((await waited()) >= 50); // the reply landed
  chat.addEventListener("message", (e) => e.data === "ping" && chat.send("pong"));
  chat.send("ping?");
  await nap(50);
  assert((await waited()) < 100); // the pong answered the server's ping
  chat.send("fire-and-forget"); // never answered: holds 1500 ms, then a fact
  const one = await waited({ timeout: 3000 });
  assert(one >= 1400 && one < 2000, String(one));
  assert.deepEqual((await app.idle()).network.map((r) => r.ws), ["reply"]);
  assert((await waited({ netMaxMs: 0 })) < 100);
  chat.close();
  await nap(50);
  assert.deepEqual((await app.idle()).network, []); // closed: gone
  // a failed connect closes: gone too; a reconnect loop to a backend that's down resolves once its timer recurs
  const port = echo.address().port;
  echo.close();
  await nap(50);
  let reconnecting = true;
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    ws.addEventListener("close", () => reconnecting && appTimers.setTimeout(connect, 100));
  };
  connect();
  const t2 = performance.now();
  const { network: down, timers: again } = await app.idle({ timeout: 3000 });
  // under the 3000 ms timeout; a socket stuck connecting may hold up to the 1500 ms WebSocket cap on a slow host
  assert(performance.now() - t2 < 2500, String(performance.now() - t2));
  assert(again.length === 0 || again[0].recurring, JSON.stringify({ down, again }));
  reconnecting = false;
  await nap(300);
  assert.deepEqual(await app.idle(), { network: [], timers: [] });

  // iOS back, in Android's order: keyboard, the topmost Modal, BackHandler listeners last first, a native pop
  app.platform = "ios";
  let settled = 0; // back settles like tap, only when it was taken
  const settle = app.settle;
  app.settle = () => (settled++, settle.call(app));
  assert.match((await app.back()).reason, /0 registered.*; no native navigation stack/);
  assert.equal(settled, 0);
  const called = [];
  const listen = (name, took) => backHandler.addEventListener("hardwareBackPress", () => (called.push(name), took));
  listen("first", false);
  const second = listen("second", true);
  assert.deepEqual(await app.back(), { ok: true, via: "backHandler" });
  assert.equal(settled, 1);
  assert.deepEqual(called, ["second"]);
  second.remove();
  const third = () => (called.push("third"), true);
  backHandler.addEventListener("hardwareBackPress", third);
  backHandler.removeEventListener("hardwareBackPress", third);
  nativeBack = { ok: true, via: "navigation" };
  assert.equal((await app.back()).via, "navigation");
  assert.deepEqual(called, ["second", "first"]);
  let closes = 0;
  const modal = (props) => host("ModalHostView", props, [host("RCTView", { testID: "sheet" })]);
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {
    current: { child: host("RCTView", {}, [modal({ visible: true }), modal({ visible: true, onRequestClose: () => closes++ }), modal({ visible: false })]) },
  });
  assert.deepEqual(await app.back(), { ok: true, via: "modal", handler: true });
  assert.equal(closes, 1);
  assert.equal(called.length, 2);
  keyboard = { x: 0, y: 500, width: 400, height: 300 };
  assert.deepEqual(await app.back(), { ok: true, via: "keyboard" });
  keyboard = null;
  // an alert of the app's own: the native agent's Input.back (its cancel action), not the JS agent's
  alert = { ok: true, via: "alert", action: "Cancel" };
  assert.deepEqual(await app.back(), alert);
  assert.equal(closes, 1);
  alert = { ok: false, reason: "an alert of the app without a cancel button" };
  settled = 0;
  assert.deepEqual(await app.back(), alert);
  assert.equal(settled, 0);
  // the alert closed between Layout.visibility and Input.back: the usual steps (the Modal), not a native pop
  alert = { ok: false, reason: "no alert" };
  assert.deepEqual(await app.back(), { ok: true, via: "modal", handler: true });
  assert.equal(closes, 2);
  alert = null;
  app.platform = "android";

  // auto-scroll, nested: a horizontal list (Android's host) below the fold of a vertical page. The page first (JS
  // layout: the card is outside it), then the list by the native dx (the card is inside the page by then)
  const card = host("RCTView", { testID: "card" }, [], { x: 900, y: 1000, width: 100, height: 100 });
  const shelf = host("AndroidHorizontalScrollView", {}, [card], { x: 0, y: 1000, width: 400, height: 100 });
  const page = host("RCTScrollView", {}, [shelf], { x: 0, y: 0, width: 400, height: 800 });
  const surface = { current: { child: page } }; // one React root, committed again below
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, surface);
  onScroll = ({ tag, dx = 0, dy = 0 }) => {
    for (const f of tag === tagOf(page) ? [shelf, card] : [card]) (f.box.x -= dx), (f.box.y -= dy);
  };
  checks.set(tagOf(card), () =>
    card.box.x > 400 || card.box.y > 800 ? { ok: false, reason: "not in viewport", delta: 999, dx: 740 } : null,
  );
  await id("card").tap();
  assert.deepEqual(scrolled, [{ tag: tagOf(page), dy: 650 }, { tag: tagOf(shelf), dx: 740 }]);
  // getByTag: a node gone from the tree fails at once, not after the auto-wait
  const stale = performance.now();
  await assert.rejects(app.getByTag(99999).tap(), { code: "STALE", tag: 99999 }); // (the fake keeps every root it saw: no unmounts)
  assert(performance.now() - stale < 100);
  // app.scroll(direction): the main scroll view of that axis, half its size
  scrolled.length = 0;
  assert.deepEqual(await app.scroll("down"), { ok: true, tag: tagOf(page), moved: true });
  // the drag's "touch" event: where the finger went down and how far it moved
  assert.deepEqual({ ...touches.at(-1), start: 0, end: 0 }, { type: "drag", x: 200, y: 400, dx: 0, dy: -400, start: 0, end: 0 });
  assert.deepEqual(await app.scroll("left"), { ok: true, tag: tagOf(shelf), moved: true });
  assert.deepEqual(scrolled, [{ tag: tagOf(page), dy: 400 }, { tag: tagOf(shelf), dx: -200 }]);
  keyboard = { x: 0, y: 500, width: 400, height: 300 };
  assert.deepEqual(await app.scroll("up"), { ok: false, reason: "keyboard on screen" });
  keyboard = null;
  await assert.rejects(app.scroll("sideways"), { code: "INVALID_ARGUMENT" });
  const scrollers = (await app.js.call("Tree.snapshot")).nodes.filter((n) => n.scroll).map((n) => n.type);
  assert.deepEqual(scrollers, ["RCTScrollView", "AndroidHorizontalScrollView"]);
  // iOS: one host for both axes, the axis is the horizontal prop
  shelf.type = "RCTScrollView";
  shelf.memoizedProps = { horizontal: true };
  assert.deepEqual((await id("card").all())[0].scrolls.map((s) => s.horizontal), [false, true]);
  assert.equal((await app.scroll("right")).tag, tagOf(shelf));
  // two vertical ones of about the same size (side by side): which one a swipe means is unclear
  surface.current = { child: host("RCTView", {}, [page, host("RCTScrollView", {}, [], { x: 0, y: 0, width: 380, height: 800 })]) };
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, surface);
  assert.deepEqual(await app.scroll("down"), { ok: false, reason: "no single largest vertical scroll view on screen" });
  // nested in one of about its size: the inner one, a swipe moves it first; not scrollable (scrollEnabled false): none
  const inner = host("RCTScrollView", {}, [], { x: 0, y: 0, width: 400, height: 780 });
  surface.current = { child: host("RCTScrollView", {}, [inner], { x: 0, y: 0, width: 400, height: 800 }) };
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, surface);
  assert.equal((await app.scroll("down")).tag, tagOf(inner));
  inner.memoizedProps = { scrollEnabled: false };
  assert.equal((await app.scroll("down")).tag, tagOf(surface.current.child));

  // text inputs without testIDs: by placeholder (Playwright: case-insensitive substring unless exact), by label, also
  // through accessibilityLabelledBy (a Text's nativeID); the snapshot shows placeholder and value, never a password
  const comp = (props, child) => Object.assign(host("", props, [child]), { tag: 0, stateNode: null }); // a component
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  const email = host("RCTSinglelineTextInputView", { placeholder: "Adres e-mail", value: "ala@example.com", text: "ala@example.com" });
  const password = host("RCTSinglelineTextInputView", { placeholder: "Hasło", accessibilityLabelledBy: "pw", secureTextEntry: true, value: "hunter2", text: "hunter2" });
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {
    current: {
      child: host("RCTView", {}, [
        email,
        text("Hasło konta", { nativeID: "pw" }),
        password,
        // an icon button: its label is its text; a labelled view with a Text inside isn't a second match
        host("RCTView", { accessibilityLabel: "Zamknij", onPress() {} }, [host("RNSVGSvgView", {})]),
        host("RCTView", { accessibilityLabel: "Zapisz", onPress() {} }, [text("Zapisz")]),
        // touch targets without press props: a role, onAccessibilityTap, gesture-handler's GestureDetector (v2 API: a
        // Wrap component around the view; v3 hooks: a display: contents host view in between). A pan is no target.
        host("RCTView", { testID: "role", role: "button" }),
        host("RCTView", { testID: "a11y-tap", accessible: true, onAccessibilityTap() {} }),
        comp({ gesture: { toGestureArray: () => [{ handlerName: "TapGestureHandler" }] } }, comp({}, host("RCTView", { testID: "gh-v2" }))),
        comp(
          { gesture: { type: "RaceGesture", gestures: [{ type: "PanGestureHandler" }, { type: "LongPressGestureHandler" }] } },
          host("RNGestureHandlerDetector", { onStartShouldSetResponder() {} }, [host("RCTView", { testID: "gh-v3" })], zero),
        ),
        comp({ gesture: { type: "PanGestureHandler" } }, host("RNGestureHandlerDetector", {}, [host("RCTView", { testID: "gh-pan" })], zero)),
        // someone else's gesture prop that throws doesn't fail the snapshot
        comp({ get gesture() { throw new Error("getter"); } }, host("RCTView", { testID: "throws" })),
        comp({ gesture: new Proxy({}, { get() { throw new Error("proxy"); } }) }, host("RCTView", { testID: "proxy" })),
        // an icon in a button, both labelled the same: one match, the button
        host("RCTView", { testID: "back-button", accessibilityLabel: "Wróć", onPress() {} }, [host("RNSVGSvgView", { accessibilityLabel: "Wróć" })]),
        // a show-password toggle (secureTextEntry off) and a one-time code: masked by what they are for; the Text RN
        // wraps an input's children in is never listed
        host("RCTSinglelineTextInputView", { testID: "shown-password", textContentType: "password", value: "visible-secret", text: "visible-secret" }, [text("child-secret")]),
        host("RCTSinglelineTextInputView", { testID: "otp", autoComplete: "sms-otp", value: "123456", text: "123456" }),
        // uncontrolled (defaultValue): what was typed since lives natively; a WebView's page isn't React
        host("RCTSinglelineTextInputView", { testID: "uncontrolled", defaultValue: "Jan", text: "Jan" }),
        host("RNCWebView", {}),
        // one nativeID on two screens (pushed twice): the label from the input's own screen
        host("RCTView", {}, [text("Ekran A", { nativeID: "dup" }), host("RCTSinglelineTextInputView", { testID: "in-a", accessibilityLabelledBy: "dup" })]),
        host("RCTView", {}, [text("Ekran B", { nativeID: "dup" }), host("RCTSinglelineTextInputView", { testID: "in-b", "aria-labelledby": "dup" })]),
      ]),
    },
  });
  const tagOfNode = async (l) => (await l.resolve())?.tag;
  assert.equal(await tagOfNode(app.getByPlaceholder("E-MAIL")), tagOf(email));
  assert.equal(await tagOfNode(app.getByPlaceholder(/^Has/)), tagOf(password));
  await expect(app.getByPlaceholder("e-mail", { exact: true })).toHaveCount(0);
  await expect(app.getByPlaceholder("Adres e-mail", { exact: true })).toHaveCount(1);
  await expect(app.getByPlaceholder("a.")).toHaveCount(0); // a string, not a regex
  assert.equal(await tagOfNode(app.getByLabel("Hasło konta")), tagOf(password));
  await app.getByLabel("Hasło konta").fill("nowe");
  await app.getByPlaceholder("e-mail").fill("ola@example.com");
  await expect(app.getByText("Zamknij")).toHaveCount(1);
  assert.equal((await app.getByText("Wróć").resolve()).tag, (await id("back-button").resolve()).tag);
  // Detox by.text sends no labels flag: text only, as before
  assert.equal((await app.js.call("Tree.query", { selector: { text: "Zamknij" } })).count, 0);
  assert.equal((await app.getByLabel("Ekran B").resolve()).tag, (await id("in-b").resolve()).tag);
  await expect(app.getByLabel("Ekran A")).toHaveCount(1);
  await expect(app.getByText("child-secret")).toHaveCount(0);
  assert.equal((await app.getByText("Zapisz").resolve()).type, "RCTText");
  const form = (await app.js.call("Tree.snapshot")).nodes;
  const node = (k, v) => form.find((n) => n[k] === v);
  assert.deepEqual([node("tag", tagOf(email)).placeholder, node("tag", tagOf(email)).value], ["Adres e-mail", "ala@example.com"]);
  assert.deepEqual([node("tag", tagOf(password)).label, node("tag", tagOf(password)).value], ["Hasło konta", "••••••••"]);
  assert.doesNotMatch(JSON.stringify(form), /hunter2|visible-secret|child-secret|123456/);
  assert.deepEqual(["shown-password", "otp"].map((t) => node("testID", t).value), ["••••••••", "••••••••"]);
  assert.equal(node("testID", "uncontrolled").value, null);
  // App.snapshot: the native text (an uncontrolled input's too), masked natively for the secret ones
  const uncontrolled = node("testID", "uncontrolled").tag;
  nativeTexts.set(uncontrolled, "Jan Kowalski").set(tagOf(password), "hunter2");
  const { complete, reasons, nodes: shown } = await app.snapshot();
  assert.equal(shown.find((n) => n.tag === uncontrolled).value, "Jan Kowalski");
  assert.equal(shown.find((n) => n.tag === tagOf(password)).value, "••••••••");
  assert.deepEqual(secretAsked.sort(), [tagOf(password), node("testID", "shown-password").tag, node("testID", "otp").tag].sort());
  assert.equal(complete, false);
  assert.deepEqual(reasons.map((r) => r.split(" (")[0]), ["a WebView on screen"]);
  assert(node("testID", "throws") && node("testID", "proxy"));
  assert.equal(node("label", "Zamknij").name, "Zamknij");
  assert.deepEqual(
    ["role", "a11y-tap", "gh-v2", "gh-v3", "gh-pan"].map((t) => node("testID", t).pressable),
    [true, true, true, true, false],
  );
  assert(!form.some((n) => n.type === "RNGestureHandlerDetector")); // display: contents, no box

  // labelledBy targets: one nativeID map per commit, not a tree walk per labelled node
  let idReads = 0;
  const counted = new Proxy({}, { get: (t, k) => (k === "nativeID" && idReads++, t[k]) });
  const labelled = () => host("RCTSinglelineTextInputView", { accessibilityLabelledBy: "pw" });
  const commitLabelled = () =>
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {
      current: { child: host("RCTView", counted, [labelled(), labelled(), labelled()]) },
    });
  commitLabelled();
  await app.js.call("Tree.snapshot");
  await app.js.call("Tree.snapshot");
  await expect(app.getByLabel("Hasło konta")).toHaveCount(4); // three here, the password input above
  assert.equal(idReads, 1);
  commitLabelled(); // a new commit builds it again
  await app.js.call("Tree.snapshot");
  assert(idReads > 1);

  // MANTIS_TRACE never records typed text (passwords)
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mantis-")), "trace.jsonl");
  process.env.MANTIS_TRACE = traceFile;
  await app.native.call("Input.typeText", { text: "hunter2" });
  delete process.env.MANTIS_TRACE;
  const traced = fs.readFileSync(traceFile, "utf8");
  assert.match(traced, /Input\.typeText/);
  assert.doesNotMatch(traced, /hunter2/);
  await checkUsbmux();

  // Android launch args (read once per JS context): a fresh agent's hello, given the Mantis native module
  const freshHello = async (module) => {
    nativeMantis = module;
    let sent;
    global.WebSocket = class {
      readyState = 1;
      constructor() {
        setImmediate(() => this.onopen());
      }
      send(m) {
        sent = JSON.parse(m).params;
      }
    };
    delete require.cache[require.resolve("./agent")];
    require("./agent");
    while (!sent) await new Promise((r) => setImmediate(r));
    return sent;
  };
  // no module (not an E2E build, TurboModule interop off): said in hello, not a misleading "no token"
  assert.match((await freshHello(undefined)).error, /no Mantis native module/);
  // launched without a token: null, which the runner refuses as "launch with the runner's launchArgs"
  const none = await freshHello({ token: () => "" });
  assert.equal(none.token, null);
  assert.equal(none.error, null);
  assert.deepEqual(none.features, ["driver", "token"]);
  console.log("mantis selftest: ok");
  native.close();
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
