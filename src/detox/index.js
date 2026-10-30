// Detox API on top of Mantis: replaces the element/by/waitFor/expect globals so existing Detox test files run
// unchanged with Mantis doing the actions and assertions. Add to Jest's setupFilesAfterEnv:
// require.resolve("@codelionapps/mantis/detox"). Detox itself still installs and launches the app; device.launchApp and
// device.reloadReactNative are wrapped to wait for the Mantis agents of the new process / JS context.
// Covers: by.id/text/label, withAncestor, atIndex, tap, replaceText, typeText, clearText, scroll, scrollTo,
// getAttributes, toBeVisible/toExist/toHaveText (+ .not), waitFor(...).withTimeout(). See README.md for the limits.
const { performance } = require("node:perf_hooks");
const { App, Locator, PORT, expect: mantisExpect } = require("../runner");
const mantisDevice = require("../device");

// Detox's expect checks once, after the app is idle; it doesn't wait. Mantis has no idle signal, so it polls for a
// short grace instead. Helpers like isVisible() (try/catch around expect) cost this much when the answer is "no".
const EXPECT_TIMEOUT = Number(process.env.MANTIS_EXPECT_TIMEOUT) || 1000;

// the worker, not the globals: works with exposeGlobals: false, and require("detox") reads element/expect/... off it
const { worker } = mantisDevice.requireDetox("detox/internals");
const device = mantisDevice.detoxDevice("the Detox device");
const ios = device.getPlatform() === "ios";
const app = new App(PORT, device.getPlatform());
beforeAll(async () => {
  await app.start();
  mantisDevice.reversePort(PORT);
  // MANTIS_NO_IDLE: Mantis starts the app itself (src/device launchApp), nothing waits for Detox's "app idle"
  const launch = process.env.MANTIS_NO_IDLE ? mantisDevice.launchApp : device.launchApp.bind(device);
  // same signature as Detox (params, bundleId); relaunch keeps the connections when only the running app was
  // brought to the foreground (newInstance: false)
  device.launchApp = (params = {}, ...rest) =>
    app.relaunch(() =>
      // iOS simulators share the Mac's localhost: tell the agents this runner's port and token
      launch(ios ? { ...params, launchArgs: { ...params.launchArgs, ...app.launchArgs } } : params, ...rest),
    );
  // a reload starts a new JS context: the next step waits for its agent instead of hitting the dying one
  const reload = device.reloadReactNative.bind(device);
  device.reloadReactNative = (...args) => app.reloadJs(() => reload(...args));
});
afterAll(() => app.close());

// matchers are plain selectors; methods are dropped when the selector is sent to the agent as JSON
const matcher = (selector) => ({
  ...selector,
  withAncestor: (ancestor) => matcher({ ...selector, within: ancestor }),
});
const by = {
  id: (testId) => matcher({ testId }),
  text: (text) => matcher({ text }),
  label: (label) => matcher({ label }),
};

class Element {
  constructor(selector, index = null) {
    this.selector = selector;
    this.index = index;
    // shown: Detox only sees views shown natively, not the screens React keeps mounted below the top one
    this.locator = new Locator(app, selector, { index, shown: true });
  }

  atIndex(index) {
    return new Element(this.selector, index);
  }

  // Detox taps disabled views too (the tap just does nothing), so skip Mantis's enabled check
  tap() {
    return this.locator.tap({ force: true });
  }

  replaceText(text) {
    return this.locator.fill(text);
  }

  // ponytail: through the IME like replaceText, but appended at the cursor; no per-key events
  typeText(text) {
    return this.locator.fill(text, { append: true });
  }

  clearText() {
    return this.locator.fill("");
  }

  // ponytail: start point ignored (Mantis drags through the scroll view's centre), vertical only
  async scroll(offset, direction = "down") {
    const n = await this.locator.resolve();
    if (!n) throw new Error(`${this.locator}: not found`);
    const r = await app.native.call("Input.scroll", {
      tag: n.tag,
      dy: direction === "up" ? -offset : offset,
    });
    if (!r.ok) throw new Error(`${this.locator}: scroll failed: ${r.reason}`);
    await app.settle();
  }

  async scrollTo(edge) {
    const n = await this.locator.resolve();
    if (!n) throw new Error(`${this.locator}: not found`);
    const r = await app.native.call("Input.scrollToEdge", { tag: n.tag, edge });
    if (!r.ok) throw new Error(`${this.locator}: scrollTo failed: ${r.reason}`);
    await app.settle();
  }

  // Detox: one match -> its attributes, several -> { elements: [...] }
  async getAttributes() {
    const nodes = await this.locator.all();
    if (!nodes.length) throw new Error(`${this.locator}: not found`);
    const attrs = nodes.map((n) => ({
      text: n.text,
      label: n.name,
      enabled: n.enabled,
      visible: n.visible,
    }));
    return attrs.length === 1 ? attrs[0] : { elements: attrs };
  }
}

const assertions = (el, negate, timeout) => {
  const e = () => {
    const x = mantisExpect(el.locator);
    return negate ? x.not : x;
  };
  return {
    get not() {
      return assertions(el, !negate, timeout);
    },
    toBeVisible: (pct = 75) =>
      e().toBeInViewport({ ratio: pct / 100, timeout }),
    toExist: () => e().toBeAttached({ timeout }),
    toHaveText: (text) => e().toHaveText(text, { timeout }),
  };
};

// whileElement(m).scroll(px, dir): check once, else scroll m by px, until the expectation holds (Detox's loop).
// ponytail: fixed 30 s budget; Detox fails as soon as m can't scroll further
const WHILE_TIMEOUT = 30000;

const waitFor = (el, negate = false) => {
  const later = (call) => ({
    withTimeout: (timeout) => call(assertions(el, negate, timeout)),
    whileElement: (m) => ({
      async scroll(px, direction = "down") {
        const deadline = performance.now() + WHILE_TIMEOUT;
        for (;;) {
          try {
            return await call(assertions(el, negate, 0));
          } catch (e) {
            if (performance.now() > deadline) throw e;
          }
          await new Element(m).scroll(px, direction);
        }
      },
    }),
  });
  return {
    get not() {
      return waitFor(el, !negate);
    },
    toBeVisible: (pct) => later((a) => a.toBeVisible(pct)),
    toExist: () => later((a) => a.toExist()),
    toHaveText: (text) => later((a) => a.toHaveText(text)),
  };
};

const api = {
  by,
  element: (m) => new Element(m),
  expect: (el) => assertions(el, false, EXPECT_TIMEOUT),
  waitFor,
};
// require("detox") (its facade reads these off the worker on every call) and, when Detox exposes them, the globals.
// Not the globals otherwise: global expect would be Jest's.
Object.assign(worker, api);
if (global.device === device) Object.assign(global, api);
