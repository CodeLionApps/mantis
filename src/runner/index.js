// Mantis runner: a WebSocket server both in-app agents dial into, plus Playwright-style locators with auto-wait.
// Runs inside Detox's Jest environment: Detox still installs and launches the app (device.launchApp, permissions,
// launch args); Mantis does the actions and assertions instead of element()/expect(). See README.md.
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { WebSocketServer } = require("ws");

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
const PROTOCOL = 1;

/** Detox's toBeVisible threshold (≥ 75% of the view shown), for toBeInViewport. */
const DETOX_VISIBLE = Object.freeze({ ratio: 0.75 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TimeoutError extends Error {}

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
        if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
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
    for (const p of this.pending.values()) p.reject(new Error(reason));
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
          new Error(
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
        throw new Error(`${e.message}: ${method}`);
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
        reject(new Error(`rpc timeout: ${method}`));
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
  constructor(port = PORT, platform = "android") {
    this.port = port;
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
  }

  /** iOS launch args the agents need: simulators share the Mac's localhost, so this runner's port and token. */
  get launchArgs() {
    return { mantisPort: this.port, mantisToken: this.token };
  }

  start() {
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

  close() {
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
      throw new Error(
        `Mantis agents not connected ${timeout}ms after launch (js: ${this.js.connected}, native: ${this.native.connected}): ` +
          `${e.message}. Is this a Mantis build (MANTIS_E2E=1, withMantis() in metro.config.js) and is port ${this.port} ` +
          "reachable from the device (Android: adb reverse)?",
      );
    }
    timing("launch:agents", t0, t0);
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
        throw new Error(
          `touch count went from ${seq} to ${t.seq} during one tap (JS reloaded, or a late touch of an earlier tap)`,
        );
      if (performance.now() > end) return null;
      await this.nextCommitOrFrame();
    }
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

  getByRole(role, { name } = {}) {
    return new Locator(this, { role, name: norm(name) });
  }
  getByText(text) {
    return new Locator(this, { text: norm(text) });
  }
  getByLabel(label) {
    return new Locator(this, { label: norm(label) });
  }
  getByTestId(testId) {
    return new Locator(this, { testId });
  }
}

const norm = (v) =>
  v instanceof RegExp ? { regex: v.source, flags: v.flags } : v;

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
      JSON.stringify(this.selector) +
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
    return new Locator(this.app, { text: norm(text), within: this.selector });
  }
  getByTestId(testId) {
    return new Locator(this.app, { testId, within: this.selector });
  }

  async all() {
    const { nodes } = await this.app.js.call("Tree.query", {
      selector: this.selector,
    });
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
      throw new Error(
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
      `${this}: not actionable after ${timeout}ms, last: ${reason}`,
    );
  }

  // Playwright's scrollIntoViewIfNeeded, done the user's way: a real drag on the nearest scroll view.
  // Returns true if the content moved. ponytail: vertical only; horizontal lists need dx + 'AndroidHorizontalScrollView'.
  async scrollToward(n, c) {
    if (!n.scroll) return false;
    let dy;
    if (c.reason === "not in viewport")
      dy = c.delta; // native: target centre - scroll viewport centre
    else if (c.reason === "not mounted natively") {
      // clipped away (removeClippedSubviews): only the JS layout knows where it is
      dy =
        n.rect.y +
        n.rect.height / 2 -
        (n.scroll.rect.y + n.scroll.rect.height / 2);
      if (Math.abs(dy) < n.scroll.rect.height / 2) return false; // inside the viewport, just not mounted yet
    } else return false;
    const r = await this.app.native.call("Input.scroll", {
      tag: n.scroll.tag,
      dy,
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
      const seq = this.app.touch.seq;
      await this.app.native.call("Input.tap", { ...point, tag: node.tag });
      await this.app.settle();
      const touch = await this.app.touchAfter(seq, timeout);
      if (!touch)
        throw new TimeoutError(
          `${this}: tapped, but the app's JS saw no touch within ${timeout}ms`,
        );
      if (touch.mounted) return timing(`tap ${this}`, t0, iter);
      if (attempt === 3)
        throw new Error(
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
        throw new TimeoutError(`${this}: never focused (${r.reason})`);
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
  const { platform, deviceId } = require("../device").target(target);
  const app = new App(PORT, platform);
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
  PORT,
  PROTOCOL,
  expect,
  setupMantis,
};
