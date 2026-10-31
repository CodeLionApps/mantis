# @codelionapps/mantis

Lightning fast React Native test driver. It runs inside the app. Existing Detox tests run unchanged and 2–3× faster
(on a production app: Android 2.23×, iOS 3.39×). You can also drive the app through a
Playwright-style API (`getByTestId`, `expect(...).toBeVisible()`, auto-wait).

## How it works

- **JS agent** (`src/agent`): hooks React through `__REACT_DEVTOOLS_GLOBAL_HOOK__`, tracks commits and answers
  queries over the fiber tree (testID, text, role, label). It has to load before the React renderer.
- **Native agent** (`android/`, `ios/`): measuring, visibility, hit-test, touch injection (Android `MotionEvent`,
  iOS synthesized `UITouch` + `IOHIDEvent`), scroll, text input, keyboard. Runs on its own socket, so it keeps
  working while JS is busy.
- **Runner** (`src/runner`, Node): a WebSocket server on `127.0.0.1` both agents dial into (port 9123), plus locators
  with auto-wait. Tap and fill wait until the target is visible, enabled, stable for 2 frames, in the viewport
  (scrolling it there if needed) and receives the touch at its centre (native hit-test).
- **Detox layer** (`src/detox`): replaces Detox's `element` / `by` / `waitFor` / `expect` globals with the runner.
  Detox still builds, installs and launches the app. Optional: the runner and the agents don't need Detox (see
  [Without Detox](#without-detox)).

Both agents stay passive until a runner listens. Their reconnect loops wait 2 s, so they don't keep Detox's
synchronization busy, and Detox runs of the same build are unaffected.

## Setup

```sh
yarn add -D @codelionapps/mantis
```

1. **Metro** (`metro.config.js`): adds the JS agent to bundles built with `MANTIS_E2E=1`. Other bundles are unchanged.

   ```js
   const { withMantis } = require("@codelionapps/mantis/metro");
   module.exports = withMantis(mergeConfig(getDefaultConfig(__dirname), config));
   ```

   If you can't change the Metro config, the fallback is `import "@codelionapps/mantis/agent"` as the first line of
   `index.js`. That import is not gated, so wrap it yourself (e.g. a platform-specific file for E2E builds only).

2. **Native**: autolinked. No changes to `MainApplication`, Gradle or the Xcode project.
3. **E2E build**: set `MANTIS_E2E=1` for the whole build (Gradle / `xcodebuild`; it reaches the Metro bundling step
   too):

   ```sh
   cd android && MANTIS_E2E=1 ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release
   MANTIS_E2E=1 xcodebuild -workspace ios/App.xcworkspace -scheme App -configuration Release -sdk iphonesimulator ...
   ```

4. **Android, release builds**: the app must allow cleartext traffic to `localhost` (the agents dial
   `ws://localhost`), e.g. a network security config for the E2E variant:

   ```xml
   <network-security-config>
     <domain-config cleartextTrafficPermitted="true">
       <domain includeSubdomains="false">localhost</domain>
     </domain-config>
   </network-security-config>
   ```

5. **Jest** (Detox's `e2e/jest.config.js`):

   ```js
   setupFilesAfterEnv: process.env.E2E_RUNNER === "mantis" ? [require.resolve("@codelionapps/mantis/detox")] : [],
   ```

   Then `E2E_RUNNER=mantis detox test -c <configuration>`.

## Production gate

The iOS agent uses private API (`UITouch` / `IOHIDEvent` setters) and **must not reach an App Store build**. The
Android agent lets any process on the host drive the app through the port. Both are compiled in only when
`MANTIS_E2E=1` is set **at build time**:

- iOS: the podspec defines `MANTIS_E2E_$(MANTIS_E2E)`, and Xcode expands it from the build environment. Only
  `MANTIS_E2E=1` gives `MANTIS_E2E_1`, the `#if` around `MantisAgent.m`, and only for the **simulator** SDK. A device
  build (what the App Store gets) with `MANTIS_E2E=1` fails to compile, so a variable leaked into a release job
  breaks the build instead of shipping the agent. The environment at `pod install` time doesn't matter.
- Android: `android/build.gradle` adds the agent sources and the manifest with its `ContentProvider` only with
  `MANTIS_E2E=1`. Without it, the library is an empty `MantisPackage` (autolinking needs one). With it, building an
  app bundle (`.aab`, what Play gets) fails. Any value other than `1`, `0`, empty or unset fails the build (iOS
  too: `MANTIS_E2E=true` is a compile error, not a build without the agent).
- JS: `withMantis` adds the agent only with `MANTIS_E2E=1` at bundle time (other values except `0` throw).

Defence in depth (recommended):

- iOS: limit the pod to your E2E configuration in `react-native.config.js`:
  `dependencies: { "@codelionapps/mantis": { platforms: { ios: { configurations: ["Release-E2E"] } } } }`.
- CI: check the build you ship:
  `bash node_modules/@codelionapps/mantis/scripts/check-release.sh <apk|aab|app>`. It reads every file of the build as
  raw bytes. Exit 0 = no agent, 1 = agent found, 2 = could not check (no native code or JS bundle found, unreadable
  archive): treat 2 as a failure too.

## Options

| Env                     | Default        | Meaning                                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `MANTIS_E2E=1`           |                | build time: compile in / bundle the agents                                             |
| `MANTIS_PORT`            | 9123           | first Jest worker's host port; worker N uses `MANTIS_PORT + N - 1` (iOS: launch arg `mantisPort`; Android: `adb reverse`) |
| `MANTIS_APP_ID`          | from Detox     | package / bundle id; default: Detox app `bundleId`, else read from `binaryPath`        |
| `MANTIS_EXPECT_TIMEOUT`  | 1000           | grace (ms) for Detox's one-shot `expect`, see below                                     |
| `MANTIS_NO_IDLE=1`       |                | start the app with `am start` / `simctl launch` instead of Detox (no "wait for idle")  |
| `MANTIS_TIMING=<file>`   |                | one JSON line per step: wall time and Mantis's own cost                                 |
| `MANTIS_TRACE=<file>`    |                | every RPC and agent event with timestamps                                              |

`MANTIS_NO_IDLE` passes launch args the way Detox does: Android intent extras (`--es`), iOS `-key value`
arguments. An app that reads them through `react-native-launch-arguments` sees them the same way. It always starts a
fresh process and takes only `delete`, `launchArgs` and `permissions`; other Detox options (`url`,
`userNotification`, `languageAndLocale`, `newInstance: false`, ...) throw instead of being dropped. Detox's own
`device.*` calls that need its instrumentation in the app (`reloadReactNative`, ...) don't work in this mode.

## Fast resets (`@codelionapps/mantis/device`)

Reinstalling the app before each test costs seconds. Wiping its data gives the same start state:

```js
const { clearAppData } = require("@codelionapps/mantis/device");
await clearAppData({ permissions: { notifications: "YES" } }); // then device.launchApp({ delete: false, ... })
```

- Android: `pm clear`, then grants back every runtime permission the app requests (like `pm install -g`).
- iOS simulator: stops the app, kills `cfprefsd`, empties `Documents` / `Library` / `tmp`. iOS permissions
  (`applesimutils`) are set once per install, not on every wipe.
- `require.resolve("@codelionapps/mantis/reset")` in `setupFilesAfterEnv` wipes at the start of every test file, for
  `detox test --reuse`.
- `launchApp(params)`: starts the app without Detox (what `MANTIS_NO_IDLE` uses). iOS permissions: once per install,
  as for `clearAppData`.
- Every helper takes the target too: `{ platform, deviceId, appId }`. Left out, it comes from Detox (its `device`
  global and app config) or `MANTIS_APP_ID`.

## Detox API on Mantis

| Detox                                          | Mantis                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `element(by.id(x))`, `by.text`, `by.label`     | locator, limited to views shown natively (Detox doesn't see screens below) |
| `.atIndex(i)`, `.withAncestor(m)`              | `.nth(i)`, descendant of `m`                                               |
| `tap()`                                        | `tap({ force: true })`: Detox taps disabled views too                      |
| `replaceText(t)`, `clearText()`, `typeText(t)` | through the IME (`typeText` appends, no per-key events)                    |
| `scroll(px, dir)`, `scrollTo(edge)`            | a real drag on the scroll view; programmatic jump to the edge              |
| `getAttributes()`                              | `{ text, label, enabled, visible }`, `{ elements }` for several matches    |
| `toBeVisible(pct = 75)`                        | `toBeInViewport({ ratio })`, measured natively with Detox's formula        |
| `toExist()`, `toHaveText(t)`, `.not`           | `toBeAttached()`, `toHaveText(t)`                                          |
| `waitFor(e)....withTimeout(t)`                 | the same assertion, auto-waiting up to `t`                                 |
| `waitFor(e)....whileElement(m).scroll(px, d)`  | check, scroll `m`, repeat (30 s budget)                                    |
| `expect(e)....`                                | auto-waits up to `MANTIS_EXPECT_TIMEOUT`                                    |

Not covered: `longPress`, `swipe`, `multiTap`, `tapAtPoint`, `pinch`, `by.type`, `by.traits`, `toHaveValue`,
`toBeFocused`, `takeScreenshot`, Detox's `device.*` beyond `launchApp` (the rest still goes to Detox).

`element` / `by` / `expect` / `waitFor` are replaced both as globals and on `require("detox")`, so files that import
them (or a config with `exposeGlobals: false`) run on Mantis too.

Known differences from Detox:

- Detox's `expect` checks once after the app is idle. Mantis has no idle signal, so it polls for a short grace.
  Helpers like `isVisible()` (try/catch around `expect`) cost that grace when the answer is "no".
- Scroll is vertical only; `scroll()` ignores Detox's start point.
- `toExist` sees views React keeps mounted but RN flattened away natively; Detox doesn't.
- iOS visibility doesn't render the window to find occlusion like Detox does; only clipping by ancestors and the
  screen counts.

## Playwright-style API

```js
const { setupMantis, expect } = require("@codelionapps/mantis");
const app = setupMantis(); // starts the runner
await app.relaunch(() => device.launchApp({ launchArgs: app.launchArgs })); // iOS needs the runner's port + token

await app.getByTestId("email").fill("ala@example.com");
await app.getByRole("button", { name: "Zaloguj" }).tap();
await expect(app.getByText(/Cześć/)).toBeVisible();
```

`await app.snapshot()` returns the whole screen for an LLM driver: `{ commitId, nodes, focused, keyboard, screen }`.
Nodes are host views with text, testID, label, role, a text input, a touch handler or a scroll view, in tree (paint)
order with `parent` indices, kept only when shown natively and not covered (another window, sheet backdrop, keyboard).
Rects are dp. `focused: false` = a system window (permission dialog, notification shade) is over the app. Android
reports `hit`, `focused`, `keyboard` and `screen`; iOS only the visible ratio so far.

## Channel

The runner listens on `127.0.0.1` only (Android reaches it through `adb reverse`). Agents say hello with the
protocol version; an app built with another Mantis version is refused with an error that says so. iOS simulators share
the Mac's localhost, so iOS agents must also echo the runner's token (launch arg `mantisToken`, which the Detox layer
adds; `app.launchArgs` for the Playwright-style API). Only the greeted socket of each agent may answer calls or send
events. Each Jest worker gets its own port, so parallel workers (one device each) work.

What the channel does not protect against:

- Other processes on the test host. Android agents send no token: anything that can reach `127.0.0.1` there can
  reach the adb server too (`127.0.0.1:5037`, no authentication), which already controls the device.
- Other apps on the device. The agents trust whatever listens on the device's `localhost` port, so an app that binds
  it could read the UI tree and drive the E2E build. Install `MANTIS_E2E=1` builds only on emulators, simulators and
  test devices.
- `MANTIS_TRACE` records RPCs, but typed text only as its length.

## Without Detox

The agents only dial a WebSocket and the runner is plain Node, so any test framework works. Launch the app (an
`MANTIS_E2E=1` build, installed) with anything; `@codelionapps/mantis/device` has adb / simctl helpers:

```js
const { test, before, after } = require("node:test");
const { App, PORT, expect } = require("@codelionapps/mantis");
const { launchApp, reversePort } = require("@codelionapps/mantis/device");

const target = { platform: "ios", deviceId: "<simulator UDID>", appId: "com.example.app" };
const app = new App(PORT, target.platform);
before(async () => {
  await app.start();
  reversePort(app.port, target); // Android only; no-op on iOS
});
after(() => app.close());

test("login", async () => {
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  await app.getByText("Logowanie").tap();
  await expect(app.getByText("Cześć, Ala")).toBeVisible();
});
```

With `beforeAll` / `afterAll` (Jest, Vitest globals) or Mocha's `before` / `after`, `setupMantis(target)` does the
`before` / `after` part. Not without Detox: `launchApp({ delete: true })` (install the app yourself).

## Supported

- React Native with the New Architecture (Fabric); the agents assume `view.tag` / `View.id` is the React tag.
  Old Architecture: not tested. Tested on RN 0.88. The JS agent uses RN internals (`ReactFabric`, `RawEventEmitter`,
  DOM Node APIs on refs); a version without them fails with an error that names the missing piece.
- Actions on one `App` run one at a time (await each; no `Promise.all` of taps / scrolls). A second gesture while one
  is in progress fails. A gesture that fails midway, or is still down after 10 s (app sent to the background), is
  cancelled, so the next one starts clean. The agents turn Objective-C / Java exceptions into errors of the call;
  a C++ exception (Fabric) still crashes the app.
- Detox 20 for the Detox layer; any Node test framework without it. Node 22+.
- Android emulator (API 29+ for Modals: `WindowInspector`), iOS simulator. Physical iPhone: not tested (the spike
  measured XCTest as a fallback, ~254 ms per tap).

## License

MIT

## Development

- `npm test`: runner + the agent's query engine against a fake tree and a fake native agent, no device.
- `example/`: the spike's test app wired to this package (`file:..`). `npm run e2e:build:android` /
  `e2e:build:ios`, then `npm run e2e:android` / `e2e:ios`.
- `docs/spike`: results and decisions of the spike.
  Mantis was called Probe then, so the docs use that name.
