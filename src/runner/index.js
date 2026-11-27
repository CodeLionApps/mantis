// Mantis runner: a WebSocket server both in-app agents dial into, plus Playwright-style locators with auto-wait.
// Runs inside Detox's Jest environment: Detox still installs and launches the app (device.launchApp, permissions,
// launch args); Mantis does the actions and assertions instead of element()/expect(). See README.md.
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { WebSocket, WebSocketServer } = require("ws");
const usbmux = require("./usbmux");

// Host port. iOS agents dial it directly (launch arg mantisPort, which src/detox adds); Android agents always dial
// 9123 on the device and adb reverse maps that to this port (see src/device). One port per Jest worker, so parallel
// workers (one device each) don't collide: MANTIS_PORT is the first worker's.
const PORT =
  (Number(process.env.MANTIS_PORT) || 9123) +
  (Number(process.env.JEST_WORKER_ID) || 1) -
  1;
const DEFAULT_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 15000;
// bumped on incompatible changes; agents send it in Agent.hello (an app built with another Mantis version)
const PROTOCOL = 2;

/** Detox's toBeVisible threshold (≥ 75% of the view shown), for toBeInViewport. */
const DETOX_VISIBLE = Object.freeze({ ratio: 0.75 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mantis's own errors carry a stable code; messages may change (README, Errors). TIMEOUT: a wait ran out (idle, expect,
 * a read-only RPC). NOT_ACTIONABLE: a tap / fill target never became actionable (reason: the last check's).
 * NOT_FOCUSED: no text field took the text. DELIVERED: the action reached the app or may have (an Input.* RPC timed out):
 * don't retry it blindly. STRICT: a locator matched several elements. STALE: what the snapshot showed is gone (a
 * getByTag node, a view under a point tap): snapshot again. COVERED: a point tap would land under a system window or the
 * keyboard. UNSUPPORTED: the app's agent is older than this runner. INVALID_ARGUMENT. NOT_CONNECTED: an agent didn't
 * connect in time. DISCONNECTED: it went away during a call (which may or may not have run), or is gone when idle / mark
 * ping it. AGENT_ERROR: the call threw inside the app's agent.
 */
class MantisError extends Error {
  constructor(code, message, props) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.assign(this, props);
  }
}
class TimeoutError extends MantisError {}

// a window that just opened (Android: a Modal's Dialog) gets focus ~130 ms after it shows: how long a point tap or a
// scroll waits for focus before giving up
const FOCUS_WAIT = 300;

// MANTIS_TIMING=<file>: one JSON line per step. total = step wall time, last = its final, successful iteration
// (query + checks + action) = Mantis's own cost; total - last = waiting for the app.
const timing = (step, t0, tLast) => {
  if (!process.env.MANTIS_TIMING) return;
  const now = performance.now();
  require("node:fs").appendFileSync(
    process.env.MANTIS_TIMING,
    JSON.stringify({
      // Jest's current test, when run under Jest
      test: global[Symbol.for("$$jest-matchers-object")]?.state.currentTestName,
      step,
      total: now - t0,
      last: now - tLast,
    }) + "\n",
  );
};

// MANTIS_TRACE=<file>: every RPC and agent event with host timestamps, for debugging races
const trace = (row) =>
  process.env.MANTIS_TRACE &&
  require("node:fs").appendFileSync(
    process.env.MANTIS_TRACE,
    JSON.stringify({ t: +performance.now().toFixed(1), ...row }) + "\n",
  );

class Peer {
  constructor(role, platform, token) {
    this.role = role;
    this.platform = platform;
    this.token = token;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.hello = null;
    this.rejected = null; // why the last hello was refused, for the "not connected" error
    this.waiters = [];
  }

  get connected() {
    return !!this.hello && this.ws?.readyState === 1;
  }

  // A socket becomes current only once its hello checks out; only the current socket may answer RPCs or send events.
  attach(ws) {
    // a bad frame (invalid UTF-8, RSV bits) emits error, then close; unhandled, it would kill the test process
    ws.on("error", (e) =>
      trace({ event: "socket error", role: this.role, message: e.message }),
    );
    // agents say hello right after connecting; a socket that doesn't is not one of them
    const helloTimer = setTimeout(() => ws !== this.ws && ws.terminate(), 5000).unref();
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return ws.close(1007, "not JSON");
      }
      if (msg?.method === "Agent.hello") return this.greet(ws, msg.params || {});
      if (ws !== this.ws) return;
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new MantisError("AGENT_ERROR", String(msg.error.message ?? JSON.stringify(msg.error))));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        trace({ event: msg.method, params: msg.params });
        this.onEvent?.(msg);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.ws !== ws) return;
      this.hello = null;
      this.failPending("agent disconnected");
    });
  }

  greet(ws, p) {
    const why =
      p.role !== this.role
        ? `role ${p.role} on the ${this.role} socket`
        : // iOS simulators share the Mac's localhost, so another platform's Mantis build can dial in too
          p.platform !== this.platform
          ? `platform ${p.platform}, runner ${this.platform}`
          : p.v !== PROTOCOL
            ? `protocol v${p.v}, runner v${PROTOCOL}: rebuild the app with this Mantis version`
            : p.error
              ? p.error
              : // ...and other runners' apps: iOS agents must echo this runner's token (launch arg mantisToken)
                this.platform === "ios" && p.token !== this.token
                ? "wrong token: launch with the runner's launchArgs (app.launchArgs)"
                : null;
    if (why) {
      this.rejected = `${this.role} agent rejected: ${why}`;
      trace({ event: "hello rejected", role: this.role, why });
      return ws.close(1008, why.slice(0, 120));
    }
    if (this.ws !== ws) this.failPending("agent reconnected");
    this.ws = ws;
    this.hello = p;
    this.rejected = null;
    this.onHello?.(p);
    this.waiters.splice(0).forEach((w) => w());
  }

  failPending(reason) {
    for (const p of this.pending.values()) p.reject(new MantisError("DISCONNECTED", reason));
    this.pending.clear();
  }

  /** Resolves once this agent is connected (e.g. reconnecting after a relaunch or a JS reload), else rejects. */
  ready(timeout = CONNECT_TIMEOUT) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(
          new MantisError(
            "NOT_CONNECTED",
            `${this.role} agent not connected after ${timeout}ms` +
              (this.rejected ? ` (${this.rejected})` : ""),
          ),
        );
      }, timeout);
      this.waiters.push(done);
    });
  }

  async call(method, params = {}) {
    if (!this.connected)
      await this.ready().catch((e) => {
        throw new MantisError("NOT_CONNECTED", `${e.message}: ${method}`);
      });
    const id = ++this.seq;
    const t0 = performance.now();
    const r = await this.raw(id, method, params);
    trace({
      method,
      // typed text can be a password; the trace file is a CI artifact
      params: params.text == null ? params : { ...params, text: `<${params.text.length} chars>` },
      dt: +(performance.now() - t0).toFixed(1),
      result: r,
    });
    return r;
  }

  raw(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // an action that never answered may still have run
        reject(
          method.startsWith("Input.")
            ? new MantisError("DELIVERED", `rpc timeout: ${method} (it may have run)`)
            : new TimeoutError("TIMEOUT", `rpc timeout: ${method}`),
        );
      }, 15000);
      const done = (f) => (v) => {
        clearTimeout(timer);
        f(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

class App {
  /** usb: hardware UDID of a cabled iPhone: its agents listen on the phone, the runner dials them through usbmuxd. */
  constructor(port = PORT, platform = "android", { usb } = {}) {
    this.port = port;
    this.usb = usb;
    this.platform = platform;
    this.token = randomUUID();
    this.js = new Peer("js", platform, this.token);
    this.native = new Peer("native", platform, this.token);
    this.commitWaiters = [];
    this.touch = { seq: 0 }; // last touch start JS saw (Input.touchStart)
    this.js.onHello = () => (this.touch = { seq: 0 }); // a new JS context counts touches from 0
    this.js.onEvent = (msg) => {
      if (msg.method === "Tree.committed")
        this.commitWaiters.splice(0).forEach((w) => w());
      if (msg.method === "Input.touchStart") this.touch = msg.params;
    };
    /** Playwright's page.touchscreen: a tap at a point in screen dp. */
    this.touchscreen = { tap: (x, y, opts) => this.#tapAt(x, y, opts) };
    /** Playwright's page.keyboard: types into the text field that has focus. */
    this.keyboard = { type: (text, opts) => this.#type(text, opts) };
  }

  /**
   * iOS launch args the agents need: simulators share the Mac's localhost, so this runner's port and token. An iPhone
   * listens on that port (on the phone), and only with the token, which it accepts the runner's connections with.
   */
  get launchArgs() {
    return { mantisPort: this.port, mantisToken: this.token };
  }

  start() {
    if (this.usb) return this.#dial();
    // loopback only: nothing else on the network may drive the app (Android reaches it through adb reverse)
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    this.wss.on("error", (e) => trace({ event: "server error", message: e.message }));
    this.wss.on("connection", (ws, req) => {
      const role = new URL(req.url, "ws://x").searchParams.get("role");
      const peer = { js: this.js, native: this.native }[role];
      if (!peer) {
        ws.on("error", () => {});
        return ws.close(1008, "unknown role");
      }
      peer.attach(ws);
    });
    return new Promise((resolve, reject) => {
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
    });
  }

  // Cabled iPhone: one usbmux connection per agent ("leg"), each opened with Runner.attach {role, token}; the native
  // agent answers the native leg itself and relays the JS agent on the JS leg. Redialed whenever it drops (app
  // relaunched or not started yet, cable out: calls in flight fail with DISCONNECTED), until close().
  async #dial() {
    const legs = (this.legs = new Set()); // a close() and start() in between must not leave this loop running
    // fail early on a wrong UDID or an iPhone that isn't cabled; later dials just retry
    await usbmux.deviceId(this.usb);
    const leg = async (peer) => {
      let last;
      while (this.legs === legs) {
        let wait = 50; // ponytail: fixed 50 ms; a refused connect (the app isn't listening yet) costs ~1 ms on the Mac
        try {
          const sock = await usbmux.connect(this.usb, this.port);
          if (this.legs !== legs) {
            sock.destroy();
            break;
          }
          const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`, { createConnection: () => sock });
          legs.add(ws);
          ws.once("open", () =>
            ws.send(JSON.stringify({ method: "Runner.attach", params: { role: peer.role, token: this.token } })),
          );
          peer.attach(ws);
          await new Promise((r) => ws.once("close", r));
          legs.delete(ws);
          // closed before an accepted hello: an app launched by someone else (another token), another platform's or
          // version's agent, or no JS agent within the hello timeout. Don't hammer it.
          if (peer.ws !== ws) {
            wait = 2000;
            if (last !== "no hello") trace({ event: "usbmux leg closed without an accepted hello", role: peer.role });
            last = "no hello";
          }
        } catch (e) {
          // refused (result 3) while the app isn't listening is the normal wait; trace anything else once
          if (e.result === undefined && e.message !== last)
            trace({ event: "usbmux error", role: peer.role, message: e.message });
          last = e.message;
        }
        await sleep(wait);
      }
    };
    leg(this.native);
    leg(this.js);
  }

  close() {
    if (this.legs) {
      for (const ws of this.legs) ws.terminate();
      this.legs = null;
      return Promise.resolve();
    }
    if (!this.wss) return Promise.resolve();
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(r));
  }

  /**
   * Runs a (re)launch, e.g. Detox's device.launchApp, and waits until both agents of the new process said hello.
   * A launch that only brings the running app to the foreground (Detox newInstance: false) keeps its connections.
   */
  async relaunch(launch, { timeout = CONNECT_TIMEOUT } = {}) {
    const before = [this.js.ws, this.native.ws];
    const t0 = performance.now();
    await launch();
    timing("launch:started", t0, t0);
    // let socket closes of a killed process land first (a launch made of sync execs blocks the event loop)
    await sleep(50);
    if (
      this.js.connected &&
      this.native.connected &&
      this.js.ws === before[0] &&
      this.native.ws === before[1]
    )
      return;
    try {
      await Promise.all([this.js.ready(timeout), this.native.ready(timeout)]);
    } catch (e) {
      throw new MantisError(
        "NOT_CONNECTED",
        `Mantis agents not connected ${timeout}ms after launch (js: ${this.js.connected}, native: ${this.native.connected}): ` +
          `${e.message}. Is this a Mantis build (MANTIS_E2E=1, withMantis() in metro.config.js) and is port ${this.port} ` +
          "reachable from the device (Android: adb reverse; iPhone: cabled, launched with app.launchArgs)?",
      );
    }
    timing("launch:agents", t0, t0);
    // A cabled iPhone's agents connect ~0.4 s before the app is active (its launch animation; a simulator's app is
    // active by then), and until then back / point taps / scroll report a system window in front. Wait for it, but not
    // for an alert that keeps it inactive. ponytail: fixed 1 s ceiling
    if (!this.usb) return;
    let state;
    for (const end = performance.now() + 1000; performance.now() < end; await sleep(20))
      if ((state = (await this.native.call("Layout.visibility", { tags: [], hit: true })).appState) === 0) break;
    if (state !== 0) trace({ event: "launch: app not active after 1000ms", appState: state });
    timing(state === 0 ? "launch:active" : "launch:inactive", t0, t0);
  }

  /** Runs a JS reload (Detox device.reloadReactNative) and waits until the new JS context's agent said hello. */
  async reloadJs(reload, { timeout = CONNECT_TIMEOUT } = {}) {
    this.js.hello = null;
    await reload();
    await this.js.ready(timeout);
  }

  // After an action: let the app consume it before the next step. A tap that lands while JS is still handling the
  // previous one can be lost (seen: terms checkbox right after the health one, both rects stable). One frame for
  // the event to reach JS, a ping queued behind it (= its handler and sync re-render ran), one frame to mount.
  // ponytail: doesn't wait for async follow-ups (fetches, timers); the next step's auto-wait covers those.
  async settle() {
    await sleep(16);
    await this.js.call("Agent.ping");
    await sleep(16);
  }

  // After a tap: the touch JS saw for it (the next one after seq), or null if none within timeout. Under load it can
  // reach JS long after settle's ping (a stalled JS thread), so missing it early proves nothing. Any other count (a
  // new JS context restarts at 0, a late touch of an earlier tap came first) can't be attributed: fail, never retry.
  async touchAfter(seq, timeout) {
    const end = performance.now() + timeout;
    for (;;) {
      const t = this.touch;
      if (t.seq === seq + 1) return t;
      if (t.seq !== seq)
        throw new MantisError(
          "DELIVERED",
          `touch count went from ${seq} to ${t.seq} during one tap (JS reloaded, or a late touch of an earlier tap)`,
        );
      if (performance.now() > end) return null;
      await this.nextCommitOrFrame();
    }
  }

  // One Input.tap, settled; then the touch JS saw for it (touchAfter).
  async tapOnce(params, timeout) {
    const seq = this.touch.seq;
    await this.native.call("Input.tap", params);
    await this.settle();
    return this.touchAfter(seq, timeout);
  }

  /**
   * app.touchscreen.tap(x, y): a tap at a point in screen dp (snapshot rects), settled like Locator.tap.
   * { seen: true }: JS saw the touch. { seen: false }: unknown, JS saw none within timeout: a native view RN doesn't
   * handle took it (WebView, map), or JS is busy and may still handle it, so tapping again may tap twice.
   * STALE: the touch reached a view React had already replaced (nothing was pressed; something else may be under the
   * point now): snapshot again. Not retried here, unlike Locator.tap, which finds its target again.
   * COVERED, before tapping: the app's window has no focus (a system window or another app in front; an alert of the
   * app's own on iOS is fine, the touch is in-process) or the point is on the keyboard. The native agent injects into
   * the app's own windows, so such a tap would land in the app beneath, which no user can do.
   */
  async #tapAt(x, y, { timeout = 1000 } = {}) {
    const t0 = performance.now();
    const at = `tap at (${x}, ${y})`;
    const away = (v) => v.focused === false && !(this.platform === "ios" && v.appState === 0);
    let v = await this.native.call("Layout.visibility", { tags: [], hit: true });
    for (const end = t0 + FOCUS_WAIT; away(v) && performance.now() < end; ) {
      await this.nextCommitOrFrame();
      v = await this.native.call("Layout.visibility", { tags: [], hit: true });
    }
    if (away(v)) throw new MantisError("COVERED", `${at}: app window not focused (a system window or another app in front)`);
    const kb = v.keyboard;
    if (kb && x >= kb.x && x < kb.x + kb.width && y >= kb.y && y < kb.y + kb.height)
      throw new MantisError("COVERED", `${at}: on the keyboard`);
    const touch = await this.tapOnce({ x, y }, timeout);
    if (touch && !touch.mounted)
      throw new MantisError("STALE", `${at}: the view under the point was replaced before the touch reached it, nothing was pressed: take a new snapshot`);
    timing(at, t0, t0);
    return { seen: !!touch };
  }

  /**
   * app.keyboard.type(text): one character (code point) at a time into the text field that has focus, through the IME
   * like a key press (inserted at the cursor), each settled, so a per-character onChangeText (a code input moving focus
   * to the next box) sees every character apart. Waits up to timeout for a field to take the first one (a tap that
   * focuses it is still landing). Errors: NOT_FOCUSED = nothing typed; DELIVERED = err.typed characters went in first
   * (typing again would double them), err.cause = what stopped it.
   */
  async #type(text, { timeout = 1000 } = {}) {
    const t0 = performance.now();
    const chars = [...text];
    let typed = 0;
    try {
      for (const ch of chars) {
        for (;;) {
          // key: as a key press (iOS: through the field's delegate, so onKeyPress fires and maxLength holds)
          const r = await this.native.call("Input.typeText", { text: ch, key: true });
          if (r.ok) break;
          if (typed || performance.now() > t0 + timeout)
            throw new MantisError("NOT_FOCUSED", `keyboard.type: ${typed ? "" : "nothing typed: "}${r.reason}`, { typed });
          await this.nextCommitOrFrame();
        }
        typed++;
        await this.settle();
      }
    } catch (e) {
      if (!typed) throw e;
      throw new MantisError("DELIVERED", `keyboard.type: ${typed} of ${chars.length} characters typed, then ${e.message}`, { typed, cause: e });
    }
    timing("keyboard.type", t0, t0);
  }

  // retry pacing: next React commit or one frame, whichever first (not blind sleeps)
  nextCommitOrFrame() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        // the frame won: don't leave this waiter for the next commit (60 a second pile up on a static screen)
        const i = this.commitWaiters.indexOf(done);
        if (i >= 0) this.commitWaiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(done, 16);
      this.commitWaiters.push(done);
    });
  }

  /**
   * Whole-screen snapshot for an LLM driver: Tree.snapshot (JS agent) joined with Layout.visibility {hit}
   * (native). Keeps the nodes a user can see: visible ratio > 0 (drops screens below, clipped and off-screen ones)
   * and a touch at their visible centre isn't caught by another view (both platforms; hit null = can't tell, no
   * resumed activity on Android), or something inside them is kept. parent is re-pointed past dropped nodes. Tree
   * order = paint order (later siblings drawn on top; zIndex/elevation aside). rect: screen dp as drawn natively
   * (transforms in flight included), what touchscreen.tap takes. value: a text input's native text.
   * focused false = a system dialog (permission prompt, Samsung Pass), or on iOS an alert of the app's own, is over
   * the app; keyboard = IME rect or null.
   * complete false = the nodes don't show all a user sees; reasons say why (incompleteness).
   */
  async snapshot() {
    const { commitId, nodes } = await this.js.call("Tree.snapshot");
    // text inputs' text as it is natively (uncontrolled ones too); the native agent masks the secret ones
    const inputs = nodes.filter((n) => /TextInput/.test(n.type));
    const vis = await this.native.call("Layout.visibility", {
      tags: nodes.map((n) => n.tag),
      hit: true,
      inputs: inputs.map((n) => n.tag),
      secret: inputs.filter((n) => n.secret).map((n) => n.tag),
    });
    const texts = new Map(inputs.map((n, k) => [n, vis.texts?.[k]]));
    // Fabric mounts the children of a View that only forms a view (a testID, no stacking context) on the nearest
    // ancestor that forms one: natively its own Text is a sibling drawn over it and takes the touch. A touch that lands
    // on a node's React descendant reaches it (events bubble the React tree). ponytail: the landing tag must be a listed
    // node; an unlisted wrapper with a background, say, still reads as covering.
    const index = new Map(nodes.map((n, i) => [n.tag, i]));
    const inside = (j, i) => {
      while (j != null && j > i) j = nodes[j].parent;
      return j === i;
    };
    const hits = nodes.map((_, i) => (vis.hit?.[i] === false && inside(index.get(vis.at?.[i]), i) ? true : vis.hit?.[i]));
    const seen = nodes.map((_, i) => vis.ratios[i] > 0 && hits[i] !== false);
    // a container is hit-tested at its centre only (e.g. a scroll view whose centre is under the keyboard): it stays
    // when anything in it is seen (its hit stays false). Nodes come in tree order, so parents before children.
    for (let i = nodes.length - 1; i >= 0; i--)
      for (let p = seen[i] ? nodes[i].parent : -1; p >= 0 && !seen[p] && vis.ratios[p] > 0; p = nodes[p].parent)
        seen[p] = true;
    const kept = new Map(); // index in nodes -> index in out
    const out = [];
    nodes.forEach((n, i) => {
      const hit = hits[i] ?? null;
      if (!seen[i]) return;
      let p = n.parent;
      while (p >= 0 && !kept.has(p)) p = nodes[p].parent;
      kept.set(i, out.length);
      out.push({
        ...n,
        parent: p < 0 ? -1 : kept.get(p),
        // as drawn natively, in screen dp; an agent without rects: the JS layout (React root origin)
        rect: vis.rects?.[i] ?? n.rect,
        value: texts.get(n) ?? n.value,
        ratio: vis.ratios[i],
        hit,
      });
    });
    const { focused = null, keyboard = null, screen = null } = vis;
    const reasons = incompleteness(out, focused);
    return { commitId, nodes: out, focused, keyboard, screen, complete: !reasons.length, reasons };
  }

  /**
   * Scrolls the screen's main scroll view, as a swipe would: the largest one of the axis on screen (by its on-screen
   * area), none when another is at least 80% as large (lists side by side). down / right = reveal what is below / to the
   * right; the content moves by half the scroll view's size. { ok, tag, moved } (moved false: already at the end), or
   * { ok: false, reason } when the app's window has no focus, the keyboard is up, or no scroll view qualifies.
   */
  async scroll(direction) {
    const [key, sign] = { up: ["dy", -1], down: ["dy", 1], left: ["dx", -1], right: ["dx", 1] }[direction] ?? [];
    if (!key) throw new MantisError("INVALID_ARGUMENT", `scroll: direction must be up, down, left or right, got ${direction}`);
    const t0 = performance.now();
    let snap = await this.snapshot();
    this.requireDriver("scroll");
    while (snap.focused === false && performance.now() < t0 + FOCUS_WAIT) {
      await this.nextCommitOrFrame();
      snap = await this.snapshot();
    }
    if (snap.focused === false) return { ok: false, reason: "app window not focused (a system window, another app or an alert in front)" };
    if (snap.keyboard) return { ok: false, reason: "keyboard on screen" };
    const horizontal = key === "dx";
    const sv = mainScrollView(snap, horizontal);
    if (!sv) return { ok: false, reason: `no single largest ${horizontal ? "horizontal" : "vertical"} scroll view on screen` };
    const r = await this.native.call("Input.scroll", {
      tag: sv.tag,
      [key]: (sign * (horizontal ? sv.rect.width : sv.rect.height)) / 2,
    });
    if (!r.ok) return { ok: false, reason: r.reason, tag: sv.tag };
    await this.settle();
    return { ok: true, tag: sv.tag, moved: r.moved !== false };
  }

  /**
   * The back button, as on Android: { ok, via, reason }. Android: the native agent's Input.back (a back key to the window
   * with focus). iOS has none, so the steps of Android's in its order: no back when the app is not active (the caller
   * does it another way); the keyboard closes (a first back closes the IME); else an alert of the app's own on top
   * (focused false) runs its cancel-style action, as back cancels a cancelable AlertDialog; else the JS agent's
   * Input.back (the topmost Modal's onRequestClose, then the BackHandler listeners, last first); else a native
   * navigation controller pops (a native stack no BackHandler listener knows). ok: false = nothing took it
   * (Android would leave the app). Settles after a back that was taken, as tap and fill do.
   */
  async back() {
    let r;
    if (this.platform !== "ios") r = await this.native.call("Input.back");
    else {
      const { focused, keyboard, appState } = await this.native.call("Layout.visibility", { tags: [], hit: true });
      if (!focused && appState) return { ok: false, reason: "app not active (a system alert or another app in front)" };
      if (keyboard)
        r = (await this.native.call("Input.hideKeyboard")).ok ? { ok: true, via: "keyboard" } : { ok: false, reason: "keyboard on screen" };
      else {
        // an alert of the app's own: the native agent runs its cancel-style action (Android's back on a cancelable
        // dialog); "no alert" = it closed since Layout.visibility: the usual steps, no pop in its place
        if (!focused) r = await this.native.call("Input.back", { alert: true });
        if (!r || r.reason === "no alert") {
          r = await this.js.call("Input.back");
          if (!r.ok) {
            const nav = await this.native.call("Input.back");
            r = nav.ok ? nav : { ok: false, reason: `${r.reason}; ${nav.reason}` };
          }
        }
      }
    }
    if (r.ok) await this.settle();
    return r;
  }

  /** Both agents' clocks now, for idle({ since }): take it before an action. */
  async mark({ timeout = DEFAULT_TIMEOUT } = {}) {
    const msg = (thread) => `mark: the ${thread} thread didn't answer in ${timeout}ms`;
    const [js, ui] = await Promise.all([
      this.#ping(this.js, timeout, msg("JS")),
      nativePing(this.#ping(this.native, timeout, msg("main"))),
    ]);
    return { commitId: js.commitId, draws: ui.draws };
  }

  // Agent.ping within ms: a stalled thread is a TimeoutError(message), not the RPC's after 15 s. An agent that's gone
  // is DISCONNECTED at once: a plain call would wait up to 15 s for it to come back (a waiter picks its own fallback).
  #ping(peer, ms, message) {
    if (!peer.connected) return Promise.reject(new MantisError("DISCONNECTED", `the ${peer.role} agent is not connected`));
    let timer;
    return Promise.race([
      peer.call("Agent.ping").finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError("TIMEOUT", message)), ms);
      }),
    ]);
  }

  /**
   * Waits until the app stands still: no React commit and nothing changed on screen for quietMs, no request in flight.
   * Screen: Android, a window of the app drew; iOS, a layer changed or an animation runs (transitions, native-driver
   * and Reanimated frames, scrolling). Throws on timeout, naming what is still busy (a spinner never stops).
   * since (app.mark() taken before an action): idle counts only once the app reacted to it (a commit or a draw since),
   * or reactMs passed without one; for actions the app handles a while later (back, a tap whose handler awaits).
   * netMaxMs: a request in flight longer than this no longer holds the wait (polling, a hung request).
   * ponytail: Android's clock can't tell which view drew, so a focused text field's caret (a draw every 500 ms) keeps
   * quietMs >= 500 from ever passing; blur the field first.
   * An agent that's gone (or goes) fails it at once with DISCONNECTED, not at timeout.
   */
  async idle({ quietMs = 100, timeout = DEFAULT_TIMEOUT, since, reactMs = 1000, netMaxMs = Infinity } = {}) {
    const t0 = performance.now();
    // a ping waits for what's left of timeout (at least 100 ms, so one sent at the end can still answer)
    const ping = (peer, thread) =>
      this.#ping(peer, Math.max(100, t0 + timeout - performance.now()), `app not idle after ${timeout}ms: the ${thread} thread didn't answer`);
    let reacted = !since;
    for (;;) {
      const iter = performance.now();
      const [js, ui] = await Promise.all([ping(this.js, "JS"), nativePing(ping(this.native, "main"))]);
      reacted ||= js.commitId !== since.commitId || (ui.draws != null && ui.draws !== since.draws) || iter - t0 >= reactMs;
      const busy = (js.net ?? []).filter((r) => r.ms < netMaxMs).map((r) => `request in flight for ${r.ms}ms: ${r.url}`);
      if (js.idleMs < quietMs) busy.push(`React committed ${js.idleMs}ms ago`);
      if (ui.idleMs < quietMs) busy.push(`screen changed ${Math.round(ui.idleMs)}ms ago${ui.busy ? ` (${ui.busy})` : ""}`);
      if (!reacted) busy.push("no commit or draw since the mark yet");
      if (!busy.length) return timing("idle", t0, iter);
      if (performance.now() - t0 > timeout)
        throw new TimeoutError("TIMEOUT", `app not idle after ${timeout}ms: ${busy.join("; ")}`);
      // until both clocks can be quiet; a frame at a time while waiting for the app to react
      await sleep(reacted ? Math.max(16, quietMs - Math.min(js.idleMs ?? quietMs, ui.idleMs ?? quietMs)) : 16);
    }
  }

  getByRole(role, { name } = {}) {
    return new Locator(this, { role, name: norm(name) });
  }
  /** Text, or a labelled view with no text inside by its own label (icon button); Detox by.text is text only. */
  getByText(text) {
    return new Locator(this, { text: norm(text), labels: true });
  }
  getByLabel(label) {
    return new Locator(this, { label: norm(label) });
  }
  getByTestId(testId) {
    return new Locator(this, { testId });
  }
  /**
   * The node of app.snapshot() with this tag (node.tag), auto-waiting like any locator. Tags live as long as the native
   * view: tap / fill on a node React re-mounted (a new key, a screen rebuilt) or unmounted fail at once with STALE
   * (expect sees it as absent); after a JS reload every use throws STALE (tags start over). Snapshot again then.
   */
  getByTag(tag) {
    // ctx: the JS context the tag belongs to (tags start over after a reload)
    return new Locator(this, { tag, ctx: this.js.hello?.ctx });
  }

  // getByTag and scroll need a JS agent of this version (tag selector, snapshot horizontal / secret)
  requireDriver(what) {
    if (!this.js.hello?.features?.includes("driver"))
      throw new MantisError("UNSUPPORTED", `${what}: the app's JS agent is older than this runner: rebuild the app with this Mantis version`);
  }
  /** A text input by its placeholder, as Playwright: a case-insensitive substring unless exact (getByText is exact). */
  getByPlaceholder(text, { exact = false } = {}) {
    return new Locator(this, { placeholder: exact ? norm(text) : loose(text) });
  }
}

// an iOS agent older than the draw clock: the JS clock alone
const nativePing = (p) =>
  p.catch((e) => {
    if (/unknown method/.test(e.message)) return {};
    throw e;
  });

// Why a snapshot's nodes don't show all a user sees (App.snapshot complete / reasons).
// ponytail: WebViews by host name (react-native-webview's RNCWebView); other native content (maps, video) isn't flagged.
function incompleteness(nodes, focused) {
  const reasons = [];
  if (focused !== true) reasons.push("app window not focused: a system window, another app or (iOS) an alert in front");
  if (!nodes.length) reasons.push("no nodes: nothing of React's on screen (a splash screen)");
  const web = nodes.find((n) => /webview/i.test(n.type));
  if (web) reasons.push(`a WebView on screen (${web.type}): its page is not in the tree`);
  return reasons;
}

// The scroll view a swipe on the screen means (App.scroll): of the axis, scrollable, its centre not covered (a list
// under a sheet), the largest by on-screen area. Another one at least 80% as large: side by side, which one a swipe
// moves is unclear (none); nested in it, the inner one (a swipe moves it first).
function mainScrollView({ nodes, screen }, horizontal) {
  const w = screen?.width ?? Infinity;
  const h = screen?.height ?? Infinity;
  const area = ({ x, y, width, height }) =>
    Math.max(0, Math.min(x + width, w) - Math.max(x, 0)) * Math.max(0, Math.min(y + height, h) - Math.max(y, 0));
  const inside = (j, i) => {
    for (let p = nodes[j].parent; p >= 0; p = nodes[p].parent) if (p === i) return true;
    return false;
  };
  const [top, ...rest] = nodes
    .map((n, i) => ({ n, i, a: area(n.rect) }))
    .filter(({ n, a }) => n.scroll && !!n.horizontal === horizontal && n.hit !== false && a > 0)
    .sort((p, q) => q.a - p.a);
  let best = top;
  for (const c of rest) {
    if (c.a < 0.8 * top.a) break;
    if (!inside(c.i, best.i)) return undefined;
    best = c;
  }
  return best?.n;
}

const norm = (v) =>
  v instanceof RegExp ? { regex: v.source, flags: v.flags } : v;
const loose = (v) =>
  typeof v === "string" ? { regex: v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags: "i" } : norm(v);

class Locator {
  // visible: only matches with some part on screen natively; shown: only matches in a window and not hidden
  // natively (what Detox can match: screens below the top one are mounted in React but not shown)
  constructor(
    app,
    selector,
    { index = null, visible = false, shown = false } = {},
  ) {
    this.app = app;
    this.selector = selector;
    this.index = index;
    this.visible = visible;
    this.shown = shown;
  }

  get opts() {
    return { index: this.index, visible: this.visible, shown: this.shown };
  }

  toString() {
    return (
      JSON.stringify(this.selector, (k, v) => (k === "ctx" ? undefined : v)) +
      (this.visible ? ".filter(visible)" : "") +
      (this.shown ? ".filter(shown)" : "") +
      (this.index != null ? `.nth(${this.index})` : "")
    );
  }

  /** n-th match in tree order (Detox atIndex). */
  nth(index) {
    return new Locator(this.app, this.selector, { ...this.opts, index });
  }
  first() {
    return this.nth(0);
  }
  /** { visible: true }: only matches shown natively (e.g. the header of the top screen, not of the ones below). */
  filter({ visible = this.visible, shown = this.shown }) {
    return new Locator(this.app, this.selector, {
      ...this.opts,
      visible: !!visible,
      shown: !!shown,
    });
  }

  // chaining = descendant of this locator's selector (Detox withAncestor). ponytail: ignores this locator's
  // nth/filter, the ancestor is matched by selector only.
  getByText(text) {
    return new Locator(this.app, { text: norm(text), labels: true, within: this.selector });
  }
  getByTestId(testId) {
    return new Locator(this.app, { testId, within: this.selector });
  }

  async all() {
    const { nodes } = await this.app.js.call("Tree.query", {
      selector: this.selector,
    });
    const { tag, ctx } = this.selector;
    if (tag != null) {
      this.app.requireDriver(String(this));
      if (ctx != null && ctx !== this.app.js.hello?.ctx)
        throw new MantisError("STALE", `${this}: the app's JS reloaded since (tags start over): take a new snapshot`);
    }
    if ((!this.visible && !this.shown) || !nodes.length) return nodes;
    const { ratios, shown } = await this.visibility(nodes);
    return nodes.filter(
      (_, i) => (!this.visible || ratios[i] > 0) && (!this.shown || shown[i]),
    );
  }

  visibility(nodes) {
    return this.app.native.call("Layout.visibility", {
      tags: nodes.map((n) => n.tag),
    });
  }

  async ratios(nodes) {
    return (await this.visibility(nodes)).ratios;
  }

  async resolve() {
    const nodes = await this.all();
    if (this.index != null) return nodes.at(this.index);
    if (nodes.length > 1)
      throw new MantisError(
        "STRICT",
        `strict mode violation: ${this} matched ${nodes.length} elements`,
      );
    return nodes[0];
  }

  // Playwright model: visible, enabled, stable (2 native frames), receives events (hit-test).
  // force: skip the enabled check only (tapping a disabled button on purpose, like Detox does).
  // focus (fill): a text input no tap can reach (iOS: alpha 0) is fine too; returns no point then.
  async waitActionable({
    timeout = DEFAULT_TIMEOUT,
    force = false,
    focus = false,
  } = {}) {
    const deadline = performance.now() + timeout;
    let reason;
    while (performance.now() < deadline) {
      const iter = performance.now();
      const n = await this.resolve();
      // a tag never comes back once its view is gone (filters aside: a node merely hidden may come back)
      if (!n && this.selector.tag != null && !(await this.app.js.call("Tree.query", { selector: this.selector })).count)
        throw new MantisError("STALE", `${this}: no longer in the React tree (re-mounted or unmounted): take a new snapshot`);
      if (!n) reason = "not found";
      else if (!n.visible) reason = "not visible";
      else if (!n.enabled && !force) reason = "disabled";
      else if (n.busy) reason = n.busy;
      else {
        const c = await this.app.native.call("Action.check", {
          tag: n.tag,
          tags: n.tags,
        });
        if (c.ok) return { node: n, point: c.point, iter };
        if (focus && c.focusable) return { node: n, point: null, iter };
        reason = c.reason;
        // soft keyboard over the target: dismiss it, as a user would. Either way the next check waits a frame
        // (pacing below), so a scroll that didn't move anything can't spin RPC after RPC.
        if (!(await this.scrollToward(n, c)) && c.hit?.covered === "keyboard")
          await this.app.native.call("Input.hideKeyboard");
      }
      await this.app.nextCommitOrFrame();
    }
    throw new TimeoutError(
      "NOT_ACTIONABLE",
      `${this}: not actionable after ${timeout}ms, last: ${reason}`,
      { reason },
    );
  }

  // Playwright's scrollIntoViewIfNeeded, done the user's way: a real drag on a scroll view, along its axis.
  // Returns true if the content moved. Nested (a horizontal list in a vertical page): the outermost scroll view the
  // target lies outside of (JS layout), so the inner list is brought on screen before it is scrolled; else the nearest,
  // by the native delta (target centre - its visible centre).
  // ponytail: an item a virtualized list hasn't rendered yet isn't in the tree at all: "not found", no scrolling.
  async scrollToward(n, c) {
    const inViewport = c.reason === "not in viewport";
    n.scrolls ??= n.scroll ? [n.scroll] : []; // an app built with an older Mantis: only the nearest, vertical
    if (!n.scrolls.length ||(!inViewport && c.reason !== "not mounted natively")) return false;
    const mid = (r, h) => (h ? r.x + r.width / 2 : r.y + r.height / 2);
    // how far the target's centre is outside sc's box along sc's axis (0 = inside)
    const outside = (sc) => {
      const d = mid(n.rect, sc.horizontal) - mid(sc.rect, sc.horizontal);
      return Math.abs(d) < (sc.horizontal ? sc.rect.width : sc.rect.height) / 2 ? 0 : d;
    };
    const nearest = n.scrolls.at(-1);
    const sc = n.scrolls.find(outside) ?? nearest;
    // clipped away (removeClippedSubviews) or an outer scroll view: only the JS layout knows where it is
    const d = sc === nearest && inViewport ? (sc.horizontal ? c.dx : c.delta) : outside(sc);
    if (!d) return false; // inside the viewport, just not mounted yet
    const r = await this.app.native.call("Input.scroll", {
      tag: sc.tag,
      ...(sc.horizontal ? { dx: d } : { dy: d }),
    });
    return r.ok && r.moved !== false;
  }

  // A touch JS saw on a view React already replaced (mounted: false) never reached a handler, so tapping again is
  // safe. Seen: a sheet re-rendering a few times in a row while session data arrives, its markdown Text remounting
  // each time (fresh keys). Nothing else is retried: a touch that is merely late (JS busy) would be handled twice.
  async tap(opts = {}) {
    const t0 = performance.now();
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    for (let attempt = 1; ; attempt++) {
      const { node, point, iter } = await this.waitActionable(opts);
      const touch = await this.app.tapOnce({ ...point, tag: node.tag }, timeout);
      if (!touch)
        throw new MantisError(
          "DELIVERED",
          `${this}: tapped, but the app's JS saw no touch within ${timeout}ms`,
        );
      if (touch.mounted) return timing(`tap ${this}`, t0, iter);
      if (attempt === 3)
        throw new MantisError(
          "DELIVERED",
          `${this}: tap dropped ${attempt} times (target re-mounted under the finger each time)`,
        );
      trace({ event: "tap dropped, tapping again", locator: String(this) });
    }
  }

  /** Playwright fill = replace the whole value through the IME (select all + commit). append: insert at the cursor. */
  async fill(text, { append = false, ...opts } = {}) {
    const t0 = performance.now();
    const { node, point, iter } = await this.waitActionable({
      ...opts,
      focus: true,
    });
    if (point) await this.app.native.call("Input.tap", point);
    else await this.app.native.call("Input.focus", { tag: node.tag });
    const deadline = performance.now() + (opts.timeout ?? DEFAULT_TIMEOUT);
    for (;;) {
      const r = await this.app.native.call("Input.typeText", {
        text,
        replace: !append,
        tags: node.tags,
      });
      if (r.ok && node.tags.includes(r.focusedTag)) {
        await this.app.settle();
        return timing(`fill ${this}`, t0, iter);
      }
      if (performance.now() > deadline)
        throw new TimeoutError("NOT_FOCUSED", `${this}: never focused (${r.reason})`);
      await this.app.nextCommitOrFrame();
    }
  }
}

/** Auto-retrying assertions (Playwright expect): poll until the condition holds or the timeout passes. */
function expect(locator, negate = false) {
  const poll = (label, pred, { timeout = DEFAULT_TIMEOUT } = {}) =>
    (async () => {
      const t0 = performance.now();
      const deadline = t0 + timeout;
      let last;
      for (;;) {
        const iter = performance.now();
        last = await pred();
        if (!!last.pass !== negate)
          return timing(
            `expect ${locator} ${negate ? "not." : ""}${label}`,
            t0,
            iter,
          );
        if (performance.now() > deadline) {
          throw new TimeoutError(
            "TIMEOUT",
            `expect ${locator} ${
              negate ? "not." : ""
            }${label} timed out after ${timeout}ms${
              last.got !== undefined ? `, got ${JSON.stringify(last.got)}` : ""
            }`,
          );
        }
        await locator.app.nextCommitOrFrame();
      }
    })();
  const one = async (f) => f(await locator.resolve());
  return {
    get not() {
      return expect(locator, !negate);
    },
    toBeAttached: (o) =>
      poll("toBeAttached", () => one((n) => ({ pass: !!n })), o),
    toBeVisible: (o) =>
      poll("toBeVisible", () => one((n) => ({ pass: !!n?.visible })), o),
    toBeHidden: (o) =>
      poll("toBeHidden", () => one((n) => ({ pass: !n?.visible })), o),
    // Playwright toBeInViewport, measured natively (Detox's visibility math); ratio 0 = any part on screen.
    // Pass DETOX_VISIBLE for Detox's toBeVisible semantics.
    toBeInViewport: ({ ratio = 0, ...o } = {}) =>
      poll(
        `toBeInViewport(${ratio})`,
        () =>
          one(async (n) => {
            if (!n?.visible)
              return { pass: false, got: n ? "empty box" : "not found" };
            const [r] = await locator.ratios([n]);
            return {
              pass: ratio === 0 ? r > 0 : r >= ratio,
              got: +r.toFixed(2),
            };
          }),
        o,
      ),
    toHaveText: (text, o) =>
      poll(
        `toHaveText(${JSON.stringify(text)})`,
        () => one((n) => ({ pass: n?.text?.trim() === text, got: n?.text })),
        o,
      ),
    toHaveCount: (count, o) =>
      poll(
        `toHaveCount(${count})`,
        async () => {
          const nodes = await locator.all();
          return { pass: nodes.length === count, got: nodes.length };
        },
        o,
      ),
  };
}

/**
 * Call at the top of a test file: starts the runner before the app is launched and reverses its port, in the test
 * framework's suite hooks (beforeAll/afterAll: Jest, Vitest globals, Jasmine; before/after: Mocha).
 * Target: { platform, deviceId }, left out = Detox's current device. Launch through app.relaunch(() => launch(...))
 * so tests start once the agents are connected; pass launchArgs: app.launchArgs (iOS: the runner's port and token).
 */
function setupMantis(target = {}) {
  const device = require("../device");
  const { platform, deviceId } = device.target(target);
  const app = new App(PORT, platform, { usb: device.isIosDevice({ platform, deviceId }) ? deviceId : undefined });
  const before = global.beforeAll ?? global.before;
  const after = global.afterAll ?? global.after;
  if (!before || !after)
    throw new Error(
      "setupMantis needs beforeAll/afterAll (or before/after) globals; otherwise call app.start(), reversePort() and app.close() yourself",
    );
  before(async () => {
    await app.start();
    require("../device").reversePort(app.port, { platform, deviceId });
  });
  after(() => app.close());
  return app;
}

module.exports = {
  App,
  DETOX_VISIBLE,
  Locator,
  MantisError,
  PORT,
  PROTOCOL,
  TimeoutError,
  expect,
  setupMantis,
};
