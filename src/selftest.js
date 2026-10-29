// Device-free check of the Mantis runner + JS agent query engine: the real agent.js runs on a fake React fiber
// tree, a fake native agent answers measuring/input calls. usage: npm test
const assert = require("node:assert/strict");
const Module = require("node:module");

// agent.js measures through ReactFabric; give it fake boxes instead of the real renderer
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "react-native") return { Platform: { OS: "android" } };
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

const { App, DETOX_VISIBLE, expect } = require("./runner");

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
let touchStart; // the agent's touch listener; the fake native tap feeds it, like RN would
let dropNext = false; // next touch lands on a view React already replaced

(async () => {
  const app = new App(9199);
  await app.start();

  // fake native agent
  const native = new WebSocket("ws://localhost:9199/?role=native");
  native.onopen = () =>
    native.send(
      JSON.stringify({
        method: "Agent.hello",
        params: { role: "native", platform: "android" },
      }),
    );
  native.onmessage = (e) => {
    const { id, method, params } = JSON.parse(e.data);
    const result = {
      "Layout.visibility": () => ({
        ratios: params.tags.map((t) => ratios[t] ?? 0.9),
      }),
      "Action.check": () => ({ ok: true, point: { x: params.tag, y: 0 } }),
      "Input.tap": () => {
        taps.push(params.x);
        touchStart({ nativeEvent: { target: dropNext ? -1 : params.x } });
        dropNext = false;
        return { ok: true };
      },
    }[method]();
    native.send(JSON.stringify({ id, result }));
  };

  // real JS agent; it dials ws://localhost:9123, so point it at this test's port
  const RealWS = global.WebSocket;
  global.WebSocket = class extends RealWS {
    constructor() {
      super("ws://localhost:9199/?role=js");
    }
  };
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
  dropNext = true;
  await id("minus").tap({ force: true });
  assert.equal(taps.length, 4); // dropped touch, tapped again

  console.log("mantis selftest: ok");
  native.close();
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
