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

const backHandler = { addEventListener() {}, removeEventListener() {} }; // RN 0.76: removeEventListener a no-op too
let keyboard = null; // the fake native agent's keyboard rect
let alert = null; // the fake native agent's alert of the app (focused false, app active): its Input.back result
let nativeBack = { ok: false, reason: "no native navigation stack to pop" };
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
let twice = false; // JS sees two touches for one tap (e.g. a late one of an earlier tap)
const URL = "ws://127.0.0.1:9199";
const NodeWS = global.WebSocket; // the JS agent's gets replaced below
const hello = (role, extra = {}) =>
  JSON.stringify({
    method: "Agent.hello",
    params: { role, platform: "android", v: PROTOCOL, ...extra },
  });
const closed = (ws) => new Promise((r) => (ws.onclose = r));

// Contract: every method the runner and the Detox layer call natively is implemented by both native agents.
function checkContract() {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const called = new Set(
    [src("src/runner/index.js"), src("src/detox/index.js")]
      .join("\n")
      .match(/native\.call\(\s*"[^"]+"/g)
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
}

(async () => {
  checkContract();

  // iOS: simulators share the Mac's localhost, so only agents echoing this runner's token become peers
  const iosApp = new App(9198, "ios");
  const sock = { close() {} };
  iosApp.js.greet(sock, { role: "js", platform: "ios", v: PROTOCOL });
  assert.match(iosApp.js.rejected, /wrong token/);
  iosApp.js.greet(sock, { role: "js", platform: "ios", v: PROTOCOL, token: iosApp.launchArgs.mantisToken });
  assert.equal(iosApp.js.hello?.token, iosApp.token);
  const app = new App(9199);
  await app.start();

  // garbage, unknown roles and old agents don't take the runner down or become a peer
  const junk = new NodeWS(`${URL}/?role=native`);
  junk.onopen = () => junk.send("x");
  await closed(junk);
  await closed(new NodeWS(`${URL}/?role=admin`));
  const old = new NodeWS(`${URL}/?role=native`);
  old.onopen = () => old.send(hello("native", { v: 0 }));
  await closed(old);
  await assert.rejects(app.native.ready(50), new RegExp(`protocol v0, runner v${PROTOCOL}`));

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
    const result = {
      "Layout.visibility": () => ({
        ratios: params.tags.map((t) => ratios[t] ?? 0.9),
        // snapshot: cta's centre is covered (e.g. by a sheet backdrop), row's lands on its own text "Lek" (Fabric
        // hoists the text out of row natively), row's texts aren't covered
        ...(params.hit && {
          hit: params.tags.map((t) => ![row, cta].some((f) => f.stateNode.canonical.nativeTag === t)),
          at: params.tags.map((t) =>
            t === row.stateNode.canonical.nativeTag ? row.child.stateNode.canonical.nativeTag
            : t === cta.stateNode.canonical.nativeTag ? topBack.stateNode.canonical.nativeTag : t),
          focused: !alert,
          appState: 0,
          keyboard,
        }),
      }),
      "Action.check": () => checks.get(params.tag)?.() ?? { ok: true, point: { x: params.tag, y: 0 } },
      "Input.scroll": () => (scrolled.push(params), onScroll(params), { ok: true }),
      "Input.typeText": () => ({ ok: true }),
      "Input.hideKeyboard": () => ({ ok: true }),
      "Input.back": () => alert ?? nativeBack,
      "Input.tap": () => {
        taps.push(params.x);
        if (!silent)
          touchStart({ nativeEvent: { target: drop > 0 ? -1 : params.x } });
        if (twice) touchStart({ nativeEvent: { target: params.x } });
        drop = Math.max(0, drop - 1);
        return { ok: true };
      },
    }[method]();
    native.send(JSON.stringify({ id, result }));
  };
  const connectNative = () => {
    const native = new NodeWS(`${URL}/?role=native`);
    native.onopen = () => native.send(hello("native"));
    native.onmessage = nativeHandler(native);
    return native;
  };
  let native = connectNative();

  // real JS agent; it dials ws://localhost:9123, so point it at this test's port
  global.WebSocket = class extends NodeWS {
    constructor() {
      super(`${URL}/?role=js`);
    }
  };
  global.XMLHttpRequest = class extends EventTarget { open() {} send() {} }; // RN's dispatches loadend when done
  require("./agent");
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, {
    current: { child: root, memoizedState: { element: {} } },
  });
  await Promise.all([app.js.ready(), app.native.ready()]);

  const id = (t) => app.getByTestId(t);
  const quick = { timeout: 300 };

  await expect(id("row").getByText("Lek")).toBeInViewport(DETOX_VISIBLE);
  await expect(id("screen-b").getByText("1 maja")).toBeAttached();
  await expect(id("screen-a").getByText("Lek")).not.toBeAttached();
  await expect(id("qty")).toHaveText("0");
  await expect(id("back")).toHaveCount(2);
  await expect(id("cta")).toBeInViewport(); // ratio 0.5 > 0
  await expect(id("cta")).not.toBeInViewport(DETOX_VISIBLE); // 0.5 < 0.75
  await expect(id("missing")).not.toBeAttached();
  await assert.rejects(expect(id("qty")).toHaveText("1", quick), /got "0"/);
  await assert.rejects(id("back").tap(quick), /strict mode violation/);

  await id("back").filter({ visible: true }).first().tap();
  assert.deepEqual(taps, [topBack.stateNode.canonical.nativeTag]);
  await assert.rejects(id("minus").tap(quick), /last: disabled/);
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 2);
  drop = 1;
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 4); // dropped touch, tapped again
  drop = 3;
  await assert.rejects(id("minus").tap({ force: true }), /tap dropped 3 times/);
  assert.equal(taps.length, 7);
  silent = true; // a late touch is never answered with a second tap
  await assert.rejects(id("minus").tap({ force: true, timeout: 200 }), /saw no touch/);
  assert.equal(taps.length, 8);
  silent = false;
  twice = true; // can't tell which touch is this tap's: fail, never tap again
  await assert.rejects(id("minus").tap({ force: true }), /touch count went from \d+ to \d+/);
  assert.equal(taps.length, 9);
  twice = false;
  // waits that a frame won don't pile up until the next commit
  assert.equal(app.commitWaiters.length, 0);

  // a call while the agent reconnects (relaunch, reload) waits for it instead of failing
  native.close();
  await closed(native);
  setTimeout(() => (native = connectNative()), 100);
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 10);

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
  alert = null;
  app.platform = "android";

  // auto-scroll, nested: a horizontal list (Android's host) below the fold of a vertical page. The page first (JS
  // layout: the card is outside it), then the list by the native dx (the card is inside the page by then)
  const card = host("RCTView", { testID: "card" }, [], { x: 900, y: 1000, width: 100, height: 100 });
  const shelf = host("AndroidHorizontalScrollView", {}, [card], { x: 0, y: 1000, width: 400, height: 100 });
  const page = host("RCTScrollView", {}, [shelf], { x: 0, y: 0, width: 400, height: 800 });
  const tagOf = (f) => f.stateNode.canonical.nativeTag;
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: { child: page } });
  onScroll = ({ tag, dx = 0, dy = 0 }) => {
    for (const f of tag === tagOf(page) ? [shelf, card] : [card]) (f.box.x -= dx), (f.box.y -= dy);
  };
  checks.set(tagOf(card), () =>
    card.box.x > 400 || card.box.y > 800 ? { ok: false, reason: "not in viewport", delta: 999, dx: 740 } : null,
  );
  await id("card").tap();
  assert.deepEqual(scrolled, [{ tag: tagOf(page), dy: 650 }, { tag: tagOf(shelf), dx: 740 }]);
  const scrollers = (await app.js.call("Tree.snapshot")).nodes.filter((n) => n.scroll).map((n) => n.type);
  assert.deepEqual(scrollers, ["RCTScrollView", "AndroidHorizontalScrollView"]);
  // iOS: one host for both axes, the axis is the horizontal prop
  shelf.type = "RCTScrollView";
  shelf.memoizedProps = { horizontal: true };
  assert.deepEqual((await id("card").all())[0].scrolls.map((s) => s.horizontal), [false, true]);

  // MANTIS_TRACE never records typed text (passwords)
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mantis-")), "trace.jsonl");
  process.env.MANTIS_TRACE = traceFile;
  await app.native.call("Input.typeText", { text: "hunter2" });
  delete process.env.MANTIS_TRACE;
  const traced = fs.readFileSync(traceFile, "utf8");
  assert.match(traced, /Input\.typeText/);
  assert.doesNotMatch(traced, /hunter2/);
  console.log("mantis selftest: ok");
  native.close();
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
