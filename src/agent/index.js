// Mantis JS agent. Must run before the React renderer loads, so the renderer finds our __REACT_DEVTOOLS_GLOBAL_HOOK__:
// withMantis() (metro.js) adds it to E2E bundles, or import "@codelionapps/mantis/agent" as the first line of index.js.
// Passive until the runner (src/runner) listens.
"use strict";

const roots = new Set();
let commitId = 0;

const prev = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (prev) {
  // dev: another hook exists already, chain into it
  const onCommit = prev.onCommitFiberRoot && prev.onCommitFiberRoot.bind(prev);
  prev.onCommitFiberRoot = (id, root, ...rest) => {
    handleCommit(root);
    return onCommit && onCommit(id, root, ...rest);
  };
} else {
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(internals) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, internals);
      return id;
    },
    onCommitFiberRoot(_id, root) {
      handleCommit(root);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
}

function handleCommit(root) {
  if (
    root.current &&
    root.current.memoizedState &&
    root.current.memoizedState.element == null
  )
    roots.delete(root);
  else roots.add(root);
  commitId++;
  send({ method: "Tree.committed", params: { commitId } });
}

// ---------- tree / query ----------
const HostComponent = 5;
const HostText = 6;

function hostChildrenText(fiber) {
  let out = "";
  for (let c = fiber.child; c; c = c.sibling) {
    if (c.tag === HostText) out += c.memoizedProps;
    else out += hostChildrenText(c);
  }
  return out;
}

function accessibleName(fiber) {
  const p = fiber.memoizedProps || {};
  return p["aria-label"] ?? p.accessibilityLabel ?? hostChildrenText(fiber);
}

function roleOf(p) {
  return p.role ?? p.accessibilityRole;
}

function disabledOf(p) {
  const s = p.accessibilityState || {};
  return !!(
    s.disabled ||
    p["aria-disabled"] ||
    p.disabled ||
    p.editable === false
  );
}

function matchText(actual, expected) {
  if (expected == null) return true;
  if (typeof actual !== "string") return false;
  if (expected.regex)
    return new RegExp(expected.regex, expected.flags).test(actual);
  return actual.trim() === expected;
}

function matchesSelf(fiber, sel) {
  const p = fiber.memoizedProps || {};
  if (sel.testId != null) return p.testID === sel.testId;
  if (sel.role != null)
    return roleOf(p) === sel.role && matchText(accessibleName(fiber), sel.name);
  if (sel.label != null)
    return matchText(p["aria-label"] ?? p.accessibilityLabel, sel.label);
  if (sel.text != null)
    return (
      fiber.type === "RCTText" && matchText(hostChildrenText(fiber), sel.text)
    );
  return false;
}

// `within` = some host ancestor matches that selector (Detox withAncestor, Playwright locator chaining); nests.
function matches(fiber, ancestors, sel) {
  if (!matchesSelf(fiber, sel)) return false;
  if (!sel.within) return true;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (matches(ancestors[i], ancestors.slice(0, i), sel.within)) return true;
  }
  return false;
}

function* hostFibers(fiber, ancestors) {
  for (let f = fiber; f; f = f.sibling) {
    if (f.tag === HostComponent) {
      yield [f, ancestors];
      yield* hostFibers(f.child, [...ancestors, f]);
    } else {
      yield* hostFibers(f.child, ancestors);
    }
  }
}

// RN's JS ScrollView captures the next touch while it is "animating" (momentum, or < 16 ms after momentum end),
// so a tap on its content would only stop the scroll. Part of "receives events", invisible to the native hit-test.
function scrollerAnimating(fiber) {
  for (let a = fiber.return; a; a = a.return) {
    const s = a.stateNode;
    if (s && typeof s._isAnimating === "function" && s._isAnimating())
      return true;
  }
  return false;
}

function nativeTagOf(fiber) {
  return fiber.stateNode && fiber.stateNode.canonical
    ? fiber.stateNode.canonical.nativeTag
    : null;
}

function descendantTags(fiber) {
  const tags = [];
  for (const [f] of hostFibers(fiber.child, [])) tags.push(nativeTagOf(f));
  return tags;
}

let ReactFabric;
function loadFabric() {
  if (!ReactFabric) {
    const m = require("react-native/Libraries/Renderer/shims/ReactFabric");
    ReactFabric = m.default || m;
  }
  return ReactFabric;
}
function rectOf(fiber) {
  const el = loadFabric().getPublicInstanceFromInternalInstanceHandle(fiber);
  // DOM Node APIs on refs (ReactNativeElement); older RN versions hand out an instance without them
  if (typeof el?.getBoundingClientRect !== "function")
    throw new Error(
      "this React Native version has no getBoundingClientRect on host instances (DOM Node APIs); Mantis is tested on RN 0.88",
    );
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function query(sel) {
  const nodes = [];
  for (const root of roots) {
    for (const [f, ancestors] of hostFibers(root.current.child, [])) {
      if (!matches(f, ancestors, sel)) continue;
      const rect = rectOf(f);
      // Playwright semantics: non-empty box. Viewport/overlap is the native side's job
      // (JS rect lags native-driver transforms).
      const visible = rect.width > 0 && rect.height > 0;
      // RN: only the element's own state; a disabled parent (e.g. a non-pressable card) doesn't block children
      const enabled = !disabledOf(f.memoizedProps || {});
      // nearest scroll container, so the runner can scroll the element into view (vertical only for now)
      const sc = ancestors.findLast((a) => a.type === "RCTScrollView");
      nodes.push({
        scroll: sc ? { tag: nativeTagOf(sc), rect: rectOf(sc) } : null,
        busy: sc && scrollerAnimating(f) ? "scroll view animating" : null,
        tag: nativeTagOf(f),
        type: f.type,
        name: accessibleName(f),
        text: hostChildrenText(f),
        rect,
        visible,
        enabled,
        state: (f.memoizedProps || {}).accessibilityState,
        tags: [nativeTagOf(f), ...descendantTags(f)],
      });
    }
  }
  return { commitId, count: nodes.length, nodes };
}

// Whole-screen snapshot for an LLM driver: one pass over the fibers, host nodes worth showing (text,
// testID, label, role, text input, touch handler, scroll view). parent = index of the nearest included host
// ancestor. rect = getBoundingClientRect: dp from the React root's origin (= screen dp for an edge-to-edge root).
// Empty boxes and boxes fully outside the screen are dropped; what's covered or on screens below is the native
// half's job (App.snapshot joins both). ponytail: a <Text> is one node, links nested in it aren't listed.
const PRESS_PROPS = ["onPress", "onClick", "onLongPress", "onStartShouldSetResponder", "onResponderRelease"];
function snapshot() {
  const screen = require("react-native").Dimensions.get("screen");
  const nodes = [];
  // returns the subtree's host text, so accessibleName's fallback costs nothing extra
  const walk = (fiber, parent) => {
    let text = "";
    for (let f = fiber; f; f = f.sibling) {
      if (f.tag === HostText) {
        text += f.memoizedProps;
        continue;
      }
      if (f.tag !== HostComponent) {
        text += walk(f.child, parent);
        continue;
      }
      const p = f.memoizedProps || {};
      const isText = f.type === "RCTText";
      const own = isText ? hostChildrenText(f) : null;
      const input = f.type.includes("TextInput");
      const label = p["aria-label"] ?? p.accessibilityLabel;
      const role = roleOf(p);
      // gesture-handler buttons keep their handlers in RNGH, not in the host's props
      const pressable =
        f.type === "RNGestureHandlerButton" || PRESS_PROPS.some((k) => typeof p[k] === "function");
      const scroll = f.type === "RCTScrollView";
      let i = -1;
      // a Modal's host sits where <Modal> is in the tree, not where its window is: only its content counts
      if (f.type !== "RCTModalHostView" && (own || p.testID != null || label != null || role != null || input || pressable || scroll)) {
        const rect = rectOf(f);
        const onScreen =
          rect.width > 0 && rect.height > 0 && rect.x < screen.width && rect.y < screen.height &&
          rect.x + rect.width > 0 && rect.y + rect.height > 0;
        if (onScreen) {
          const s = p.accessibilityState || {};
          i = nodes.push({
            tag: nativeTagOf(f),
            parent,
            type: f.type,
            testID: p.testID ?? null,
            label: label ?? null,
            name: null, // below, once the subtree's text is known
            text: own,
            role: role ?? null,
            value: input ? (p.text ?? p.value ?? null) : null,
            placeholder: input ? (p.placeholder ?? null) : null,
            editable: input && p.editable !== false,
            pressable,
            enabled: !disabledOf(p),
            selected: s.selected ?? p["aria-selected"] ?? null,
            checked: s.checked ?? p["aria-checked"] ?? null,
            scroll,
            rect,
          }) - 1;
        }
      }
      const sub = isText ? own : walk(f.child, i < 0 ? parent : i);
      if (i >= 0) nodes[i].name = label ?? sub;
      text += sub;
    }
    return text;
  };
  for (const root of roots) walk(root.current.child, -1);
  return { commitId, nodes };
}

// ---------- touches ----------
// RN drops a touch whose target view React already replaced by the time the (busy) JS thread gets to it, e.g. a
// re-render with late session data right as the tap lands. Report each touch start and whether its target was
// still mounted, so the runner taps again only then. RawEventEmitter sees events before React handles them.
let touchSeq = 0;
function isMounted(tag) {
  for (const root of roots)
    for (const [f] of hostFibers(root.current.child, []))
      if (nativeTagOf(f) === tag) return true;
  return false;
}
let unsupported = null; // why this RN version can't be driven, reported in hello
try {
  require("react-native/Libraries/Core/RawEventEmitter").default.addListener(
    "topTouchStart",
    (e) =>
      send({
        method: "Input.touchStart",
        params: { seq: ++touchSeq, mounted: isMounted(e.nativeEvent.target) },
      }),
  );
} catch (e) {
  unsupported = "RawEventEmitter: " + e.message;
}

// RN internals the agent relies on (no public API exists for them). One missing = a React Native version Mantis
// doesn't support: the runner fails with this instead of finding 0 nodes forever. Checked after the entry module
// ran (the renderer is loaded by then).
function checkInternals() {
  if (unsupported) return unsupported;
  try {
    if (typeof loadFabric().getPublicInstanceFromInternalInstanceHandle !== "function")
      return "ReactFabric.getPublicInstanceFromInternalInstanceHandle missing";
  } catch (e) {
    return "ReactFabric: " + e.message;
  }
  return null;
}

// ---------- RPC ----------
const handlers = {
  "Tree.query": (p) => query(p.selector),
  "Tree.snapshot": snapshot,
  // queued behind any touch events already on the JS thread: the reply means their handlers have run
  "Agent.ping": () => ({ commitId }),
};

// Runner port: 9123; on iOS the launch argument `-mantisPort N` (NSUserDefaults argument domain, read through RN
// Settings) overrides it, since simulators share the Mac's localhost. Android always dials 9123 on the device; the
// runner maps it to its own port with adb reverse.
// The token (launch argument -mantisToken, iOS only) proves to the runner that this app was launched by it.
let launchArgs;
function getLaunchArgs() {
  if (launchArgs) return launchArgs;
  launchArgs = { port: 9123, token: null };
  try {
    if (require("react-native").Platform.OS === "ios") {
      const m = require("react-native/Libraries/Settings/Settings"); // Android: a fallback that only warns
      const settings = m.default || m;
      launchArgs.port = Number(settings.get("mantisPort")) || 9123;
      launchArgs.token = settings.get("mantisToken") || null;
    }
  } catch (e) {}
  return launchArgs;
}

const PROTOCOL = 1; // src/runner PROTOCOL
let ws = null;
let retries = 0;
const CTX = Math.random().toString(36).slice(2); // JS context identity
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect() {
  const { port, token } = getLaunchArgs();
  ws = new WebSocket(`ws://localhost:${port}/?role=js`);
  ws.onopen = () => {
    touchSeq = 0; // the runner counts this connection's touches from 0 (App.js.onHello), also when it attaches late
    // react-native is loaded by now (connect runs after the entry module), not when this file is evaluated
    const platform = require("react-native").Platform.OS;
    send({
      method: "Agent.hello",
      params: {
        role: "js",
        platform,
        v: PROTOCOL,
        token,
        error: checkInternals(),
        ctx: CTX,
        commitId,
      },
    });
  };
  ws.onmessage = async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      return; // not a runner frame; nothing to answer
    }
    const { id, method, params } = msg || {};
    if (id == null) return;
    // a call = the runner accepted our hello; not on open: a runner that refuses us (other platform / token) would
    // otherwise get an immediate reconnect after every refusal, a busy loop
    retries = 0;
    try {
      const h = handlers[method];
      if (!h) throw new Error("unknown method " + method);
      send({ id, result: await h(params || {}) });
    } catch (err) {
      send({ id, error: { message: String((err && err.stack) || err) } });
    }
  };
  // Passive until a runner shows up; retry quietly. 2000 ms, not less: Detox's timer idling resource treats JS
  // timers < 1500 ms as "app busy", so a faster retry loop would stall Detox runs of the same build.
  // The first retry is immediate (setImmediate, not a 0 ms timer, which Detox also counts as busy).
  ws.onclose = () =>
    retries++ ? setTimeout(connect, 2000) : setImmediate(connect);
  ws.onerror = () => {};
}
setImmediate(connect);
