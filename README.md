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
- **Runner** (`src/runner`, Node): a WebSocket server both agents dial into (`ws://localhost:9123`), plus locators
  with auto-wait. Tap and fill wait until the target is visible, enabled, stable for 2 frames, in the viewport
  (scrolling it there if needed) and receives the touch at its centre (native hit-test).
- **Detox layer** (`src/detox`): replaces Detox's `element` / `by` / `waitFor` / `expect` globals with the runner.
  Detox still builds, installs and launches the app.

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
  `MANTIS_E2E=1` gives `MANTIS_E2E_1`, the `#ifdef` around `MantisAgent.m`. The environment at `pod install` time
  doesn't matter.
- Android: `android/build.gradle` adds the agent sources and the manifest with its `ContentProvider` only with
  `MANTIS_E2E=1`. Without it, the library is an empty `MantisPackage` (autolinking needs one).
- JS: `withMantis` adds the agent only with `MANTIS_E2E=1` at bundle time.

Defence in depth (recommended):

- iOS: limit the pod to your E2E configuration in `react-native.config.js`:
  `dependencies: { "@codelionapps/mantis": { platforms: { ios: { configurations: ["Release-E2E"] } } } }`.
- CI: check that a release build without `MANTIS_E2E` has no agent: `scripts/check-release.sh <apk|app>`.

## Options

| Env                     | Default        | Meaning                                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `MANTIS_E2E=1`           |                | build time: compile in / bundle the agents                                             |
| `MANTIS_PORT`            | 9123           | runner's host port (iOS: passed as launch arg `mantisPort`; Android: `adb reverse`)     |
| `MANTIS_APP_ID`          | from Detox     | package / bundle id; default: Detox app `bundleId`, else read from `binaryPath`        |
| `MANTIS_EXPECT_TIMEOUT`  | 1000           | grace (ms) for Detox's one-shot `expect`, see below                                     |
| `MANTIS_NO_IDLE=1`       |                | start the app with `am start` / `simctl launch` instead of Detox (no "wait for idle")  |
| `MANTIS_TIMING=<file>`   |                | one JSON line per step: wall time and Mantis's own cost                                 |
| `MANTIS_TRACE=<file>`    |                | every RPC and agent event with timestamps                                              |

`MANTIS_NO_IDLE` passes launch args the way Detox does: Android intent extras (`--es`), iOS `-key value`
arguments. An app that reads them through `react-native-launch-arguments` sees them the same way.

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
- `launchApp(params)`: starts the app without Detox (what `MANTIS_NO_IDLE` uses).

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
const app = setupMantis(); // starts the runner; launch through app.relaunch(() => device.launchApp(...))

await app.getByTestId("email").fill("ala@example.com");
await app.getByRole("button", { name: "Zaloguj" }).tap();
await expect(app.getByText(/Cześć/)).toBeVisible();
```

## Supported

- React Native with the New Architecture (Fabric); the agents assume `view.tag` / `View.id` is the React tag.
  Old Architecture: not tested.
- Detox 20 for the Detox layer.
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
