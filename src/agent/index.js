// Mantis JS agent. Must run before the React renderer loads, so the renderer finds our __REACT_DEVTOOLS_GLOBAL_HOOK__:
// withMantis() (metro.js) adds it to E2E bundles, or import "@codelionapps/mantis/agent" as the first line of index.js.
// Passive until the runner (src/runner) listens.
"use strict";

const roots = new Set();
let commitId = 0;
let commitAt = Date.now(); // of the last commit (agent start before the first), for Agent.ping's idleMs

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
  commitAt = Date.now();
  send({ method: "Tree.committed", params: { commitId } });
}

// ---------- tree / query ----------
const HostComponent = 5;
const HostText = 6;

const isInput = (f) => f.type.includes("TextInput");
// A password or one-time code: never sent to the runner (MANTIS_TRACE logs results). Also with secureTextEntry off
// (a "show password" toggle), by what the input is for.
const SECRET = /password|otp|one-?time/i;
const isSecret = (f) => {
  const p = f.memoizedProps || {};
  return isInput(f) && (!!p.secureTextEntry || SECRET.test(p.textContentType ?? "") || SECRET.test(p.autoComplete ?? ""));
};

// a secret input's children (RN wraps them in a Text) are skipped, here and in hostFibers
function hostChildrenText(fiber) {
  let out = "";
  for (let c = fiber.child; c; c = c.sibling) {
    if (c.tag === HostText) out += c.memoizedProps;
    else if (!(c.tag === HostComponent && isSecret(c))) out += hostChildrenText(c);
  }
  return out;
}

// nativeID -> host fibers, once per commit (labelledBy targets)
let idsOf = { commitId: -1, map: null };
function nativeIds() {
  if (idsOf.commitId === commitId) return idsOf.map;
  const map = new Map();
  for (const root of roots)
    for (const [f] of hostFibers(root.current.child, [])) {
      const id = (f.memoizedProps || {}).nativeID;
      if (id != null) map.set(id, [...(map.get(id) || []), f]);
    }
  idsOf = { commitId, map };
  return map;
}

// of several views with one nativeID (a screen pushed twice, list rows): the one sharing the deepest ancestor with fiber
function nearest(fiber, candidates) {
  if (candidates.length === 1) return candidates[0];
  const up = new Map();
  for (let a = fiber, d = 0; a; a = a.return, d++) up.set(a, d);
  let best = null;
  let bestD = Infinity;
  for (const c of candidates)
    for (let a = c; a; a = a.return)
      if (up.has(a)) {
        if (up.get(a) < bestD) (best = c), (bestD = up.get(a));
        break;
      }
  return best ?? candidates[0];
}

// aria-label / accessibilityLabel, else the text of the views aria-labelledby / accessibilityLabelledBy point to (their
// nativeID; RN takes a string or an array, aria-labelledby comma-separated)
function labelOf(fiber) {
  const p = fiber.memoizedProps || {};
  const own = p["aria-label"] ?? p.accessibilityLabel;
  const by = p["aria-labelledby"] ?? p.accessibilityLabelledBy;
  if (own != null || by == null) return own ?? null;
  const ids = Array.isArray(by) ? by : String(by).split(/\s*,\s*/);
  const texts = [];
  for (const id of ids) {
    const found = nativeIds().get(id);
    if (found) texts.push(hostChildrenText(nearest(fiber, found)));
  }
  return texts.length ? texts.join(" ") : null;
}

function accessibleName(fiber) {
  return labelOf(fiber) ?? hostChildrenText(fiber);
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
  if (sel.label != null) return matchText(labelOf(fiber), sel.label);
  if (sel.placeholder != null) return isInput(fiber) && matchText(p.placeholder, sel.placeholder);
  if (sel.text != null) {
    if (fiber.type === "RCTText") return matchText(hostChildrenText(fiber), sel.text);
    if (!sel.labels || !labelAsText(fiber, sel.text)) return false;
    // an icon inside a labelled button, both labelled the same: the button only
    for (let a = fiber.return; a; a = a.return) if (a.tag === HostComponent && labelAsText(a, sel.text)) return false;
    return true;
  }
  return false;
}

// getByText (not Detox by.text): a view with its own label and no text inside (icon button, labelled image or SVG)
// matches by its label
function labelAsText(fiber, text) {
  const p = fiber.memoizedProps || {};
  const label = p["aria-label"] ?? p.accessibilityLabel;
  return label != null && !isInput(fiber) && !hostChildrenText(fiber) && matchText(label, text);
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
      if (!isSecret(f)) yield* hostFibers(f.child, [...ancestors, f]);
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

// ScrollView's hosts: RCTScrollView (iOS: both axes, `horizontal` prop), Android's horizontal one has its own name.
// FlatList, SectionList and FlashList (v2: JS only) render a ScrollView, so they are these too.
const isScroller = (f) => f.type === "RCTScrollView" || f.type === "AndroidHorizontalScrollView";
const isHorizontal = (f) => f.type === "AndroidHorizontalScrollView" || (f.memoizedProps || {}).horizontal === true;

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
      // scroll containers, outermost first, so the runner can scroll the element into view along each one's axis
      const scrolls = ancestors.filter(isScroller).map((a) => ({
        tag: nativeTagOf(a),
        rect: rectOf(a),
        horizontal: isHorizontal(a),
      }));
      nodes.push({
        scrolls,
        busy: scrolls.length && scrollerAnimating(f) ? "scroll view animating" : null,
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
// <Modal>'s host: "ModalHostView" (its codegen name, Fabric), "RCTModalHostView" before RN dropped the Paper name
const isModal = (f) => f.type === "ModalHostView" || f.type === "RCTModalHostView";
const PRESS_PROPS = ["onPress", "onClick", "onLongPress", "onStartShouldSetResponder", "onResponderRelease"];
const PRESS_ROLES = ["button", "link", "tab", "switch", "checkbox", "menuitem"];
// react-native-gesture-handler's GestureDetector attaches its recognizers natively, by view tag: the view it wraps has
// no handler props. Its gesture prop says what it recognizes: v2 API (Gesture.Tap(), Gesture.Race(...)) toGestureArray()
// with handlerName, v3 hooks (useTapGesture) type, composed ones (useCompetingGestures...) gestures. Pans don't count.
const TAP_GESTURES = ["TapGestureHandler", "LongPressGestureHandler"];
const gestureNames = (g) =>
  typeof g?.toGestureArray === "function" ? g.toGestureArray().map((x) => x.handlerName)
  : Array.isArray(g?.gestures) ? g.gestures.flatMap(gestureNames)
  : [g?.type];
// someone else's gesture prop may throw (a getter, a Proxy): not a detector then, the snapshot goes on
const tapDetector = (p) => {
  try {
    return p.gesture != null && typeof p.gesture === "object" && gestureNames(p.gesture).some((n) => TAP_GESTURES.includes(n));
  } catch (e) {
    return false;
  }
};
// v3's detector is a host view of its own (box-none) around the wrapped one
const DETECTOR = "RNGestureHandlerDetector";
function snapshot() {
  const screen = require("react-native").Dimensions.get("screen");
  const nodes = [];
  // returns the subtree's host text, so accessibleName's fallback costs nothing extra.
  // tap: inside a tap GestureDetector, the next host view below is its target
  const walk = (fiber, parent, tap) => {
    let text = "";
    for (let f = fiber; f; f = f.sibling) {
      if (f.tag === HostText) {
        text += f.memoizedProps;
        continue;
      }
      if (f.tag !== HostComponent) {
        text += walk(f.child, parent, tap || tapDetector(f.memoizedProps || {}));
        continue;
      }
      const p = f.memoizedProps || {};
      const isText = f.type === "RCTText";
      const own = isText ? hostChildrenText(f) : null;
      const input = isInput(f);
      const label = labelOf(f);
      const role = roleOf(p);
      const detector = f.type === DETECTOR;
      // gesture-handler buttons keep their handlers in RNGH, not in the host's props; so do GestureDetector's views
      const pressable =
        f.type === "RNGestureHandlerButton" || (tap && !detector) || PRESS_PROPS.some((k) => typeof p[k] === "function") ||
        PRESS_ROLES.includes(role) || (p.accessible === true && typeof p.onAccessibilityTap === "function");
      const scroll = isScroller(f);
      let i = -1;
      // a Modal's host sits where <Modal> is in the tree, not where its window is: only its content counts
      if (!isModal(f) && (own || p.testID != null || label != null || role != null || input || pressable || scroll)) {
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
            // RN passes value ?? defaultValue as text: an uncontrolled input shows its default, not what was typed since
            // (that lives natively). Never a password or code: a mask when there is one.
            value: !input ? null : isSecret(f) && (p.text ?? p.value) ? "••••••••" : (p.text ?? p.value ?? null),
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
      const sub = isText ? own : isSecret(f) ? "" : walk(f.child, i < 0 ? parent : i, tap && detector);
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

// ---------- network ----------
// Requests in flight, for the runner's idle wait: a screen whose data is still on the way is not done. XMLHttpRequest
// only (RN's fetch is built on it); WebSockets and native SDKs (Firestore, analytics) aren't counted. RN dispatches
// loadend after load, error, timeout and abort alike.
const inFlight = new Map(); // xhr -> { at, url }
try {
  const XHR = global.XMLHttpRequest.prototype;
  const { open, send: xhrSend } = XHR;
  XHR.open = function (method, url, ...rest) {
    this.__mantisUrl = String(url).split("?")[0]; // no query: tokens live there
    return open.call(this, method, url, ...rest);
  };
  XHR.send = function (...args) {
    inFlight.set(this, { at: Date.now(), url: this.__mantisUrl });
    this.addEventListener("loadend", () => inFlight.delete(this));
    try {
      return xhrSend.apply(this, args);
    } catch (e) {
      inFlight.delete(this);
      throw e;
    }
  };
} catch (e) {}

// ---------- back (iOS) ----------
// iOS has no back button, and RN's BackHandler there drops every listener (BackHandler.ios.js is a no-op). Keep them
// as BackHandler.android.js does, so Input.back can run them: react-navigation's container registers one on iOS too
// (useBackButton.native: goBack when canGoBack), and so do apps and other libraries. Nothing calls them but Input.back.
const backListeners = [];
let HardwareBackPressEvent = null;
try {
  const platform = require("react-native/Libraries/Utilities/Platform");
  if ((platform.default || platform).OS === "ios") {
    const m = require("react-native/Libraries/Utilities/BackHandler");
    const bh = m.default || m;
    const remove = (handler) => {
      const i = backListeners.indexOf(handler);
      if (i !== -1) backListeners.splice(i, 1);
    };
    bh.addEventListener = (_eventName, handler) => {
      if (!backListeners.includes(handler)) backListeners.push(handler);
      return { remove: () => remove(handler) };
    };
    // RN 0.76 still has a no-op removeEventListener (removed later): a listener taken off that way must not stay here
    if (bh.removeEventListener) bh.removeEventListener = (_eventName, handler) => remove(handler);
    try {
      HardwareBackPressEvent = require("react-native/Libraries/Utilities/HardwareBackPressEvent").HardwareBackPressEvent;
    } catch (e) {} // older RN: listeners get no argument
  }
} catch (e) {}

// What Android's back does once it reaches the app's JS, in its order. A shown <Modal> first: on Android it is a Dialog,
// the window with focus, and takes the back whether or not it has an onRequestClose (without one nothing happens).
// ponytail: the topmost Modal = the last shown one in tree order (a nested Modal comes after its parent). Sibling
// visible Modals: the last in tree order, not necessarily the one presented last; track presentation order if it matters.
// Then the hardwareBackPress listeners, last registered first, until one returns true. None: Android leaves the app.
function back() {
  let modal = null;
  for (const root of roots)
    for (const [f] of hostFibers(root.current.child, []))
      if (isModal(f) && (f.memoizedProps || {}).visible !== false) modal = f;
  if (modal) {
    const close = modal.memoizedProps.onRequestClose;
    if (typeof close === "function") close({ nativeEvent: {} });
    return { ok: true, via: "modal", handler: typeof close === "function" };
  }
  const event = HardwareBackPressEvent ? new HardwareBackPressEvent() : undefined;
  // ponytail: a listener doing BackHandler.exitApp(); return true reports ok, though iOS's exitApp is a no-op
  for (let i = backListeners.length - 1; i >= 0; i--)
    if (backListeners[i]?.(event)) return { ok: true, via: "backHandler" };
  return { ok: false, reason: `no BackHandler listener took it (${backListeners.length} registered; Android would leave the app)` };
}

// ---------- RPC ----------
const handlers = {
  "Tree.query": (p) => query(p.selector),
  "Tree.snapshot": snapshot,
  "Input.back": back,
  // queued behind any touch events already on the JS thread: the reply means their handlers have run
  // idleMs: since the last commit; net: requests in flight (age in ms, URL without query)
  "Agent.ping": () => {
    const now = Date.now();
    const net = [];
    for (const r of inFlight.values()) net.push({ ms: now - r.at, url: r.url });
    return { commitId, idleMs: now - commitAt, net };
  },
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

const PROTOCOL = 2; // src/runner PROTOCOL
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
