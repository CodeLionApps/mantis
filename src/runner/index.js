// Mantis runner: a WebSocket server both in-app agents dial into, plus Playwright-style locators with auto-wait.
// Runs inside Detox's Jest environment: Detox still installs and launches the app (device.launchApp, permissions,
// launch args); Mantis does the actions and assertions instead of element()/expect(). See README.md.
const { performance } = require("node:perf_hooks");
const { WebSocketServer } = require("ws");

// Host port. iOS agents dial it directly (launch arg mantisPort, which src/detox adds); Android agents always dial
// 9123 on the device and adb reverse maps that to this port (see src/device).
const PORT = Number(process.env.MANTIS_PORT) || 9123;
const DEFAULT_TIMEOUT = 10000;

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
      test: global[Symbol.for("$$jest-matchers-object")].state.currentTestName,
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
  constructor(platform) {
    this.platform = platform;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.hello = null;
    this.waiters = [];
  }

  // a socket becomes current only once it says hello
  attach(ws) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method === "Agent.hello") {
        // iOS simulators share the Mac's localhost, so a Mantis build running there can dial in too
        if (msg.params.platform !== this.platform) return ws.close();
        this.ws = ws;
        this.hello = msg.params;
        this.waiters.splice(0).forEach((w) => w());
      } else {
        trace({ event: msg.method, params: msg.params });
        this.onEvent?.(msg);
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.hello = null;
      for (const p of this.pending.values())
        p.reject(new Error("agent disconnected"));
      this.pending.clear();
    });
  }

  ready() {
    return this.hello && this.ws?.readyState === 1
      ? Promise.resolve()
      : new Promise((r) => this.waiters.push(r));
  }

  call(method, params = {}) {
    if (!this.hello)
      return Promise.reject(new Error(`agent not connected: ${method}`));
    const id = ++this.seq;
    const t0 = performance.now();
    if (process.env.MANTIS_TRACE)
      return this.raw(id, method, params).then((r) => {
        trace({
          method,
          params,
          dt: +(performance.now() - t0).toFixed(1),
          result: r,
        });
        return r;
      });
    return this.raw(id, method, params);
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
    this.js = new Peer(platform);
    this.native = new Peer(platform);
    this.commitWaiters = [];
    this.touch = { seq: 0 }; // last touch start JS saw (Input.touchStart)
    this.js.onEvent = (msg) => {
      if (msg.method === "Tree.committed")
        this.commitWaiters.splice(0).forEach((w) => w());
      if (msg.method === "Input.touchStart") this.touch = msg.params;
    };
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws, req) => {
      const role = new URL(req.url, "ws://x").searchParams.get("role");
      (role === "js" ? this.js : this.native).attach(ws);
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

  /** Runs a (re)launch, e.g. Detox's device.launchApp, and waits until both agents of the new process said hello. */
  async relaunch(launch, { timeout = 15000 } = {}) {
    this.js.hello = null;
    this.native.hello = null;
    this.touch = { seq: 0 };
    const t0 = performance.now();
    await launch();
    timing("launch:started", t0, t0);
    let handle;
    const timer = new Promise((_, reject) => {
      handle = setTimeout(
        () =>
          reject(
            new Error(
              `Mantis agents not connected ${timeout}ms after launch (js: ${!!this.js
                .hello}, native: ${!!this.native.hello}). ` +
                `Is this a Mantis build (MANTIS_E2E=1, withMantis() in metro.config.js) and is port ${this.port} reachable ` +
                "from the device (Android: adb reverse)?",
            ),
          ),
        timeout,
      );
    });
    // cleared, so a finished run doesn't keep Jest alive for the rest of the timeout
    await Promise.race([
      Promise.all([this.js.ready(), this.native.ready()]),
      timer,
    ]).finally(() => clearTimeout(handle));
    timing("launch:agents", t0, t0);
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

  // After a tap: did JS get its touch, on a view still mounted? Under load the touch can reach JS after settle's
  // ping, so wait for it (bounded); none at all means RN dropped it natively.
  async touchLanded(seq, timeout = 2000) {
    const end = performance.now() + timeout;
    while (this.touch.seq === seq && performance.now() < end)
      await this.nextCommitOrFrame();
    return this.touch.seq > seq && this.touch.mounted;
  }

  // retry pacing: next React commit or one frame, whichever first (not blind sleeps)
  nextCommitOrFrame() {
    return Promise.race([
      new Promise((r) => this.commitWaiters.push(r)),
      sleep(16),
    ]);
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
        if (await this.scrollToward(n, c)) continue;
        // soft keyboard over the target: dismiss it, as a user would
        if (
          c.hit?.covered === "keyboard" &&
          (await this.app.native.call("Input.hideKeyboard")).ok
        )
          continue;
      }
      await this.app.nextCommitOrFrame();
    }
    throw new TimeoutError(
      `${this}: not actionable after ${timeout}ms, last: ${reason}`,
    );
  }

  // Playwright's scrollIntoViewIfNeeded, done the user's way: a real drag on the nearest scroll view.
  // Returns true if it scrolled. ponytail: vertical only; horizontal lists need dx + 'AndroidHorizontalScrollView'.
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
    return r.ok;
  }

  // A dropped touch (see touchLanded) never reached a handler, so tapping again is safe. Seen: a sheet re-rendering
  // a few times in a row while session data arrives, its markdown Text remounting each time (fresh keys).
  // ponytail: fixed 5 attempts, not tied to the timeout
  async tap(opts) {
    const t0 = performance.now();
    for (let attempt = 1; ; attempt++) {
      const { node, point, iter } = await this.waitActionable(opts);
      const seq = this.app.touch.seq;
      await this.app.native.call("Input.tap", { ...point, tag: node.tag });
      await this.app.settle();
      if ((await this.app.touchLanded(seq)) || attempt === 5)
        return timing(`tap ${this}`, t0, iter);
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
    const deadline = performance.now() + 5000;
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
 * Call at the top of a Mantis test file: starts the runner before the app is launched and reverses its port.
 * Launch through app.relaunch(() => device.launchApp(...)) so tests start once the agents are connected.
 */
function setupMantis() {
  const app = new App(PORT, device.getPlatform());
  beforeAll(async () => {
    await app.start();
    require("../device").reversePort(PORT);
  });
  afterAll(() => app.close());
  return app;
}

module.exports = { App, DETOX_VISIBLE, Locator, PORT, expect, setupMantis };
