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
- **Runner** (`src/runner`, Node): a WebSocket server on `127.0.0.1` both agents dial into, plus locators
  with auto-wait. Tap and fill wait until the target is visible, enabled, stable for 2 frames, in the viewport
  (scrolling it there if needed) and receives the touch at its centre (native hit-test).
- **Detox layer** (`src/detox`): replaces Detox's `element` / `by` / `waitFor` / `expect` globals with the runner.
  Detox still builds, installs and launches the app. Optional: the runner and the agents don't need Detox (see
  [Without Detox](#without-detox)).

Both agents stay passive until a runner listens. Their reconnect loops wait 2 s, so they don't keep Detox's
synchronization busy, and Detox runs of the same build are unaffected.

## Scope

Mantis drives React Native apps in general. Core keeps only what holds for any RN app and can be done
deterministically: locators, actions, waiting (idle, stability), the app snapshot, back, scroll, typed errors. It
assumes React Native and nothing else: any navigation library, any language, any design system.

Not in core, but in the tool built on top of Mantis:

- knowledge of a particular app: its testIDs, labels, wording, screens, login flow, launch arguments;
- agent logic: deciding what to do next, retry and fallback policy, judging results, prompts;
- reporting: video, metrics, test management.

Core returns facts (`moved: false`, `seen: false`, an error `code`) and leaves the decision to the caller. When a tool
on top has to work around something missing in core, the fix belongs in core, stated as a generic problem, with a
test in `example/`.

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
  `MANTIS_E2E=1` gives `MANTIS_E2E_1`, the `#if` around `MantisAgent.m`. A device build (what the App Store gets) with
  `MANTIS_E2E=1` fails to compile unless its configuration allows device builds (`MANTIS_DEVICE=YES` on the mantis pod
  target, see [Physical iPhone](#physical-iphone)), so a variable leaked into a release job breaks the build instead of
  shipping the agent. `MANTIS_DEVICE` can't come from the environment: the podspec pins it to `NO`, and a pod target's
  xcconfig outranks the environment. The environment at `pod install` time doesn't matter.
- Android: `android/build.gradle` adds the agent sources and the manifest with its `ContentProvider` only with
  `MANTIS_E2E=1`. Without it, the library is an empty `MantisPackage` (autolinking needs one). With it, building an
  app bundle (`.aab`, what Play gets) fails. Any value other than `1`, `0`, empty or unset fails the build (iOS
  too: `MANTIS_E2E=true` is a compile error, not a build without the agent).
- JS: `withMantis` adds the agent only with `MANTIS_E2E=1` at bundle time (other values except `0` throw).

Defence in depth (recommended):

- iOS: limit the pod to your E2E configuration in `react-native.config.js`:
  `dependencies: { "@codelionapps/mantis": { platforms: { ios: { configurations: ["Release-E2E"] } } } }`.
- CI: check the build you ship:
  `bash node_modules/@codelionapps/mantis/scripts/check-release.sh <apk|aab|ipa|app>`. It reads every file of the build as
  raw bytes. Exit 0 = no agent, 1 = agent found, 2 = could not check (no native code or JS bundle found, unreadable
  archive): treat 2 as a failure too.

## Options

| Env                     | Default        | Meaning                                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `MANTIS_E2E=1`           |                | build time: compile in / bundle the agents                                             |
| `MANTIS_DEVICE=YES`      | `NO`           | iOS build setting of the mantis pod target, per configuration: allow device builds (Podfile, see [Physical iPhone](#physical-iphone)) |
| `MANTIS_PORT`            | 9123 (iOS), free port (Android) | first Jest worker's host port; worker N uses `MANTIS_PORT + N - 1` (iOS: launch arg `mantisPort`; Android: `adb reverse`) |
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
- `scroll()` ignores Detox's start point (Mantis drags through the scroll view's visible centre).
- `toExist` sees views React keeps mounted but RN flattened away natively; Detox doesn't.
- iOS visibility doesn't render the window to find occlusion like Detox does; only clipping by ancestors and the
  screen counts.

## Playwright-style API

```js
const { setupMantis, expect } = require("@codelionapps/mantis");
const app = setupMantis(); // starts the runner
await app.relaunch(() => device.launchApp({ launchArgs: app.launchArgs })); // the runner's token (+ port on iOS)

await app.getByTestId("email").fill("ala@example.com");
await app.getByRole("button", { name: "Zaloguj" }).tap();
await expect(app.getByText(/Cześć/)).toBeVisible();
```

Without testIDs: `getByLabel` matches `aria-label` / `accessibilityLabel`, or the text of the views `aria-labelledby` /
`accessibilityLabelledBy` point to (by `nativeID`). `getByPlaceholder` matches a text input's placeholder, as in
Playwright: a case-insensitive substring, `{ exact: true }` for the whole string, or a RegExp. `getByText`, `getByLabel`
and `getByRole`'s `name` match the whole string (trimmed) or a RegExp. `getByText` also matches a view with no text
inside (an icon button, a labelled image or SVG) by its own label (not a labelledBy one), the outermost of nested ones
labelled the same; Detox's `by.text` stays text only. An icon font draws its glyph in a Text, so such a button has text:
find it with `getByLabel`.

Auto-scroll: tap and fill drag the target's scroll views (`ScrollView`, `FlatList`, `SectionList`, FlashList; vertical
or horizontal) until it is in view; nested ones outermost first (a horizontal list in a vertical page). An item a
virtualized list hasn't rendered yet isn't in the tree at all: the locator waits, then fails with "not found". Scroll
the list there first: Detox's `waitFor(...).whileElement(list).scroll(...)`, or a drag of `dy` (or `dx`) dp with
`app.native.call("Input.scroll", { tag: (await list.resolve()).tag, dy })`.

`await app.snapshot()` returns the whole screen for an LLM driver:
`{ commitId, nodes, focused, state, overlays, keyboard, screen, complete, reasons }`.
Nodes are host views with text, testID, label, role, a text input, a touch handler, a scroll view (`scroll`,
`horizontal`; not one with `scrollEnabled={false}`) or a WebView, in tree (paint) order with `parent` indices, kept only when shown natively and not covered
(another window, sheet backdrop, keyboard).
Text inputs carry `placeholder`, `secret` and `value`: the text as it is natively (an uncontrolled input's too), a mask
for a password or one-time code (`secret`: `secureTextEntry`, or a `textContentType` / `autoComplete` for one, so also
with a "show password" toggle on; the native agent masks it, the text never leaves the device). `pressable`: a press handler prop, a role of button, link, tab, switch, checkbox or menuitem,
`onAccessibilityTap`, a gesture-handler button, or a view a gesture-handler `GestureDetector` with a tap or long press
wraps.
`complete: false` when the nodes don't show all a user sees, with `reasons`: the app's window has no focus (a system
window, another app, or on iOS an alert of the app's own), a native overlay of the app's own (below), no nodes (a splash
screen), a WebView on screen (its page is not React). A driver that needs the whole screen takes a screenshot or an accessibility
dump then. `screen.density` is the app's own; comparing it with the device's (`adb shell wm density`) is up to you.
Rects are screen dp as drawn natively (iOS: points), transforms in flight included: what `touchscreen.tap` takes, also
for a Modal whose React root doesn't start at the top of the screen. `focused: false` = a system window (permission dialog, notification shade) is over the app, or on iOS
an alert of the app's own. Both platforms report `hit`, `focused`, `keyboard` and `screen` (iOS: points, `density` =
screen scale).

What is in front of the app, as far as the app itself can tell (no permissions, no other process's windows):

- `state`: the app's lifecycle. iOS: `UIApplicationState`: `"inactive"` while a system alert (a permission prompt),
  Control Center, Notification Center or the app switcher is over the app. Android, the same words: `"active"` = an
  activity of the app is resumed, `"inactive"` = one is visible but none resumed (an activity of the system or another
  app in front without hiding it: a permission prompt), `"background"` = none visible. It follows the last activity
  resumed: briefly `"inactive"` while the app goes from one of its activities to another, and with two resumed at once
  (split screen) pausing the later one reads `"inactive"` while the other is still resumed.
- `focused: false` with `state: "active"`: Android, a system window that doesn't pause the app has the focus (the
  notification shade, a system dialog); iOS, an alert of the app's own (it is in `overlays`).
- `overlays`: the app's own windows (Android) or presented view controllers (iOS) over its main one, topmost first:
  `{ type, react, rect }`. `type`: `"modal"` (Android: a `Dialog`, which RN's `Modal` and `Alert` are; iOS: a
  presented controller, RN's `Modal` too), `"alert"` (iOS: a `UIAlertController`: RN's `Alert`, `ActionSheetIOS`),
  `"popup"` (Android: a `PopupWindow` or another sub-window), `"window"` (any other). `react: true`: a React root is
  in it (its React content is in the nodes); `react: false`: native content, in a screenshot but not in the nodes
  (`complete: false`). That includes short-lived windows of the app's own process: a toast with a custom view, RN's
  dev "Loading from Metro" popup (`{ type: "window", react: false }` for as long as they show). Only windows on
  screen: those of an activity under another one of the app are hidden and not listed. Android below API 29: `null`
  (only the activity window is known there), not "none". iOS lists presented controllers, not one being dismissed (a
  closing alert is gone at once), nor a window of the app's own without one (a native SDK's overlay window).
- Not knowable in-process, so not reported: windows of other processes that don't take the focus (a toast, a
  heads-up notification, an autofill dropdown, another app's overlay), and what any other window shows.

Behaviour change (Android): a focusable window that isn't `FLAG_NOT_TOUCH_MODAL` (a `Dialog`, a focusable popup)
takes every touch, outside its box too, as the window manager gives it, so nothing under an `Alert`, a `DatePicker` or
a popup menu is in the nodes or reachable, as on iOS. A locator tap on a view beside such a dialog now waits and times out (`NOT_ACTIONABLE`, `covered by window ...`)
instead of tapping under it; a point tap there goes to the dialog, which closes when it is cancelable, instead of
pressing the app. A window with `FLAG_NOT_TOUCHABLE` (an overlay touches go through) takes none.

`app.native.call("Page.screenshot", { scale })` returns `{ png, windows, fallbacks, focused, state, keyboard, surfaces }`: a PNG (base64) of the app's own
windows composed as on screen, in-process (no XCTest, no `adb screencap`). Screen-sized, `scale` px per dp (iOS: per
point; default 1). No status bar, navigation bar, keyboard or system dialogs: they are not the app's. `windows`: the
windows drawn, bottom-up. Android: activity, Modals, dialogs and popups, read back by `PixelCopy` (hardware layers and
`TextureView` included, a `SurfaceView` such as video or a map is not); a dialog that dims what is under it
(`AlertDialog`) dims it in the picture too. PixelCopy reads any window on API 34+, only the activity's on 26–33; a window
it can't read is drawn by `View.draw` (`fallbacks`: how many), which fails on a hardware `Bitmap` (Coil, Glide,
expo-image): on API 29–33 a Modal showing one makes the call fail. Below API 29: the activity window only (Modals,
dialogs and popups are not in the picture), on 24–25 by `View.draw`. iOS: `drawViewHierarchy`, `layer.renderInContext` for a
window that can't (`fallbacks`; `render: true` forces it).

What is on screen but not in the picture, as of the call's start (the picture alone can't tell "the screen is like
this" from "this part is missing"):

- `focused: false` or `state` other than `"active"`: a window of another process is over the app (a permission prompt,
  the notification shade, a system alert), as in the snapshot. iOS, `focused: false` with `state: "active"`: an alert
  of the app's own, which is in the picture.
- `keyboard`: the soft keyboard's rect (screen dp), or `null`; it is another process's.
- `surfaces`: `{ rect, tag, window }` for content drawn outside the windows' own pixels: Android, every shown
  `SurfaceView` (video, camera preview, maps, GL; black or what is under it in the picture); iOS, the Metal, OpenGL
  and video layers (`CAMetalLayer`, `CAEAGLLayer`, `AVPlayerLayer`, `AVSampleBufferDisplayLayer`) of a window drawn
  by `renderInContext` (`drawViewHierarchy` has them: Metal checked on a simulator and an iPhone). `tag`: the nearest
  React view, `window`: the index in `windows` (a window over it may hide it on screen too). `rect`: Android, the part
  not clipped by its ancestors; iOS, the layer's whole rect on screen (clipping ancestors not applied). Such content
  also doesn't draw through the app's windows, so `idle()`'s draw clock doesn't see it change (a playing video doesn't
  keep the app busy).
- Never reported: the status and navigation bars, windows of other processes that don't take the focus (a toast, a
  heads-up notification, an autofill dropdown), DRM-protected video.

`await app.back()` is the back button: `{ ok, via, reason }`, ~ms, in-process, settled like `tap`.

- Android: a back key to the window with focus (`via: "key"`, or `"dispatcher"` under predictive back). `ok: false`
  when a system dialog has focus or the keyboard is up: press back the system's way then. An RN Activity always takes
  the key, so a back no JS listener takes is still `ok: true, via: "key"` while the app leaves, as a real back would.
- iOS has no back button, so Android's steps in Android's order: the keyboard closes (`via: "keyboard"`); an `Alert`
  of the app's own runs its `style: "cancel"` button as a tap would (`via: "alert"`, `action`: its text), as back cancels
  a cancelable dialog on Android; without one it stays (`ok: false`, as on a dialog that is not cancelable). RN gives
  `Alert.alert(title)` without buttons a cancel-style OK, so back closes it on iOS while on Android (not cancelable by
  default) it stays. `ActionSheetIOS` and any `UIAlertController` the app presents natively count too. Then the topmost
  visible `<Modal>` gets `onRequestClose` (`via: "modal"`; without one the back is swallowed, as on Android); the
  `BackHandler` `hardwareBackPress` listeners run last first until one returns `true` (`via: "backHandler"`;
  react-navigation registers one); a native `UINavigationController` pops (`via: "navigation"`). `ok: false` when a
  system alert is over the app, a native push or pop is still animating, or nothing took it (Android would leave the app). RN's `BackHandler` is a no-op on iOS; the
  JS agent keeps the listeners, but only for `app.back()`.

`await app.idle({ quietMs = 100, timeout, since, reactMs = 1000, netMaxMs = Infinity })` waits until the app stands still: no React commit and nothing changed on
screen for `quietMs`, and no XHR / `fetch` in flight. On screen: Android, a window of the app drew or a drawable animates
on the render thread where no draw is seen (an `ActivityIndicator`); iOS, a layer changed or an animation runs (stack
transitions, native-driver and Reanimated frames, scrolling, Modal fades; not the keyboard or a text cursor). A spinner
that is mounted but hidden, transparent or off screen doesn't count, on either platform; one covered by another view
still does (occlusion isn't checked). `tap()` and `back()` don't wait for it: call it before `snapshot()` when the action starts a
transition. On timeout it throws, naming what is still busy: a spinner or a looping animation never stops. JS timers
are not tracked. On Android a focused text field's caret draws every 500 ms, so `quietMs` of 500 or more never passes
while a field is focused.

- `since`: `await app.mark({ timeout })` taken before an action. The app may handle it a while later (a back on the JS thread, a
  handler that awaits first) and look idle until then; with `since`, idle counts only once a commit or a draw happened
  after the mark, or `reactMs` passed without one (the action changed nothing).
- `netMaxMs`: a request in flight longer than this no longer holds the wait (polling, a request that hangs).
- An agent that's gone (relaunch, crash, JS reload) fails `idle` and `mark` at once with `DISCONNECTED`, not at
  `timeout`.

```js
const mark = await app.mark();
await app.back();
await app.idle({ since: mark, netMaxMs: 3000 });
```

### Driving from a snapshot

For a driver that decides from `app.snapshot()` (an LLM) rather than from selectors:

- `app.getByTag(node.tag)`: a locator for exactly that node, with the usual auto-wait (`tap`, `fill`, `expect`). Tags
  live as long as the native view. `tap` / `fill` on a node React re-mounted (a new `key`, a screen rebuilt) or
  unmounted fail at once with `STALE` (a node only hidden or filtered out waits as usual); `expect` treats it as absent,
  so `expect(app.getByTag(t)).not.toBeAttached()` works. After a JS reload tags start over, so every use of a locator
  made before it throws `STALE`. The error says which: `err.tag` (look it up in the snapshot you took it from,
  to find the node again by its `testID`, `label`, `text`). An app built with an older Mantis: `UNSUPPORTED` (rebuild it).
- `await app.touchscreen.tap(x, y, { timeout = 1000 })`: a tap at a point in screen dp (snapshot rects), settled like
  `Locator.tap`. `{ seen, took }`. `took`: the tag of the innermost React view the native hit-test found under the
  point when the finger went down (`null`: none, or an app built with an older Mantis); look it up in the snapshot (a
  WebView, a map, the button you meant). `seen: true`: the app's JS saw the touch. `seen: false` is unknown: a native
  view RN doesn't handle took it (WebView, map), or JS is busy and may still handle it, so tapping again may tap twice.
  `seen` waits up to `timeout` after the tap settled; `timeout: 0` doesn't wait. `STALE`: the touch reached a view
  React had already replaced, nothing was pressed; it is not tapped again (something else may be under the point now):
  snapshot again (`err.tag` = `took`). `COVERED` instead of tapping when the app's window has no focus (after waiting
  300 ms for it: a window that just opened gets focus a little later) or the point is on the keyboard: the touch would
  land in the app beneath. `err.state`: the app's `state` then; `err.keyboard`: the keyboard's rect when the point is on
  it.
- `await app.keyboard.type(text, { timeout = 1000 })`: into the text field that has focus, one character (code point)
  at a time through the IME, at the cursor, each settled, so a per-character `onChangeText` (a code input moving focus
  to the next box) sees every character apart; `onKeyPress` fires per character on both platforms. `"\n"` is typed as a
  character, not as the return key (an iOS multiline field may still take it as one). Waits up to `timeout` for a field to take the first character (the tap that focuses it may
  still be landing). `fill` replaces the whole value in one go instead. `NOT_FOCUSED`: nothing typed; `DELIVERED` with
  `err.typed`: that many characters went in first, `err.cause` is what stopped it. An error on the first character is
  thrown as is (`AGENT_ERROR`; `DISCONNECTED`: it may have gone in). `type("")` does nothing, focused or not.
- `await app.scroll("up" | "down" | "left" | "right")`: a drag on the screen's main scroll view of that axis: the
  largest scrollable one on screen whose centre isn't covered (a list under a sheet); none when another is at least 80%
  as large side by side; of nested ones about as large, the inner one (a swipe moves it first). `down` / `right` reveal
  what is below / to the right, by half the scroll view's size. `{ ok: true, tag, moved }` (`moved: false`: at the end),
  or `{ ok: false, reason }`: no focus (after waiting 300 ms for it), no such scroll view, or the keyboard is up (unlike
  a locator's auto-scroll, which hides it).
- `app.on("touch", (t) => ...)` (`App` is an `EventEmitter`): once for every touch Mantis injects (a locator's or a
  point tap, `fill`'s focusing tap, the drag of a scroll or auto-scroll), once its RPC answered:
  `{ type: "tap" | "drag", x, y, dx, dy, start, end }`. `x`, `y`: where the finger went down, `dx`, `dy`: how far it
  moved (0 for a tap), screen dp (px = dp × `snapshot().screen.density`); `start`, `end`: the host's `Date.now()` before
  the RPC was sent and when it answered, not device times. No event when the RPC failed or timed out (the touch may
  still have happened), nor for a drag from an app built with an older Mantis. Listeners run in a microtask: one that
  throws doesn't fail the action (its error is uncaught). Costs nothing without a listener.
- `idle({ since })` counts any commit or draw after the mark as the app reacting, a press ripple or a caret blink too:
  a heuristic for actions the app handles a while later (back), not proof that the action's result is on screen.

### Errors

Mantis's errors are `MantisError`s with a stable `code` and `name` (messages may change); waits that run out are
`TimeoutError`s (a subclass), both exported. TypeScript types ship with the package (the runner, `/runner`, `/device`
and `/metro`), the error codes and every result included (the runner's need `@types/node`: `App` is an `EventEmitter`); `/agent`, `/detox` and `/reset` are side-effect imports
that export nothing. An exception inside an agent (the app) comes back as `AGENT_ERROR`.

| `code`             | Meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `TIMEOUT`          | a wait ran out: `idle`, `expect`, a read-only RPC                                             |
| `NOT_ACTIONABLE`   | a tap / fill target never became actionable; `err.reason`: the last check (`not found`, `disabled`, `covered by ...`) |
| `NOT_FOCUSED`      | no text field took the text (`fill`, `keyboard.type`)                                        |
| `DELIVERED`        | the touch or text reached the app, or may have (an `Input.*` RPC that never answered): retrying could do it twice |
| `STRICT`           | a locator matched several elements                                                            |
| `STALE`            | what a snapshot showed is gone (a `getByTag` node, the view under a point tap, a JS reload): snapshot again; `err.tag` says which |
| `COVERED`          | `touchscreen.tap` at a point under a system window or the keyboard; `err.state`, `err.keyboard` |
| `UNSUPPORTED`      | the app's agent is older than this runner: rebuild the app                                    |
| `INVALID_ARGUMENT` | e.g. `scroll("sideways")`                                                                    |
| `NOT_CONNECTED`    | an agent didn't connect in time                                                               |
| `PORT_IN_USE`      | a cabled iPhone: another app answered on the agent's port (another Mantis build, or a launch of another runner) and this launch's agent never did (`relaunch`, a call waiting for the agents) |
| `DISCONNECTED`     | an agent went away during a call (relaunch, crash); the call may or may not have run. `idle` and `mark` throw it at once when an agent is gone (other calls wait for it to reconnect) |
| `AGENT_ERROR`      | the call threw inside the app's agent                                                         |

## Channel

The runner listens on `127.0.0.1` only. Android agents dial 9123 on the device, and `adb reverse` maps it to the
runner's host port: a free one the OS picks, unless you pass a port or set `MANTIS_PORT` (read `app.port` after
`start()`). So a Mantis app on another device on the same host, with its own `adb reverse`, can't reach this runner.
Agents say hello with the
protocol version; an app built with another Mantis version is refused with an error that says so. Agents must also
echo the runner's token (launch arg `mantisToken`, which the Detox layer adds; `app.launchArgs` for the Playwright-style
API): iOS simulators share the Mac's localhost, and every Mantis app on an Android device dials the same 9123. A hello
without it is refused. When the agents don't connect, `NOT_CONNECTED` lists the distinct reasons hellos were refused
since the launch: `no token` (launched without `app.launchArgs`; on Android also an app built with an older Mantis),
`wrong token` (launched by another runner), another protocol version. Any Mantis app on the device can dial in, so a
reason may come from another app than the one launched. Only the greeted socket of each agent may answer calls or send events, so another Mantis app on the device can't
take over the runner. Each Jest worker gets its own port, so parallel workers (one device each) work.

Android: the native agent reads the token from the intent of the app's first activity (Detox's `launchArgs` bundle,
or `am start --es mantisToken`), and starts dialing then; the JS agent reads it through the `Mantis` native module (a
legacy module: needs the New Architecture's TurboModule interop, on by default). A launch that reuses the running
process (Detox `newInstance: false`) keeps the token of the process's first launch. An app that starts React before
any activity (prewarmed in `Application.onCreate`, headless JS) has no token yet then: its JS agent asks again after
2 s, so it connects about 2 s later.

What the channel does not protect against:

- Other processes on the test host. Anything that can reach `127.0.0.1` there can reach the adb server too
  (`127.0.0.1:5037`, no authentication), which already controls the device and can read the token from the launch.
- Other apps on the device. The agents trust whatever listens on the device's `localhost` port, so an app that binds
  it could read the UI tree and drive the E2E build. Install `MANTIS_E2E=1` builds only on emulators, simulators and
  test devices. On a physical iPhone the native agent listens instead, and takes only connections that carry the
  token of its launch.
- `MANTIS_TRACE` records RPCs, but typed text only as its length.

## Without Detox

The agents only dial a WebSocket and the runner is plain Node, so any test framework works. Launch the app (an
`MANTIS_E2E=1` build, installed) with anything; `@codelionapps/mantis/device` has adb / simctl helpers:

```js
const { test, before, after } = require("node:test");
const { App, expect } = require("@codelionapps/mantis");
const { launchApp, reversePort } = require("@codelionapps/mantis/device");

const target = { platform: "ios", deviceId: "<simulator UDID>", appId: "com.example.app" };
const app = new App(undefined, target.platform); // port left out: PORT (iOS), a free one (Android)
before(async () => {
  await app.start();
  reversePort(app.port, target); // Android only, after start(); no-op on iOS
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

## Physical iPhone

Over USB, without Detox (it has no physical iPhone support): the Playwright-style API, the app launched with
`xcrun devicectl`. The phone's `localhost` is the phone's, and reaching the Mac would need the user's Local Network
consent, so the native agent listens on the phone's loopback (`127.0.0.1:<mantisPort>`) and the runner dials it
through usbmuxd (the Mac's USB multiplexer, as `iproxy` does), one connection per agent, each opened with the
runner's token. The JS agent dials the native one, which relays it. No XCTest, no consent prompts. On an iPhone SE
(iOS 18.3), p50: RPC round trip 1 ms to the native agent, 3 ms to the JS one (relayed); tap 125 ms with the auto-wait;
launch to connected and active 0.8 s.

**Build.** `MANTIS_E2E=1` turns the agent on as for simulators, and the configuration must allow device builds:
`MANTIS_DEVICE=YES` on the mantis pod target. Set it in the Podfile for your E2E / staging configuration only (the
podspec pins it to `NO`, so the environment can't set it):

```ruby
post_install do |installer|
  # ... react_native_post_install(...)
  installer.pods_project.targets.select { |t| t.name == "mantis" }.each do |t|
    t.build_configurations.each { |c| c.build_settings["MANTIS_DEVICE"] = "YES" if c.name == "Staging" }
  end
end
```

```sh
MANTIS_E2E=1 xcodebuild -workspace ios/App.xcworkspace -scheme App -configuration Staging -sdk iphoneos ...
xcrun devicectl device install app --device <UDID> <path>/App.app
```

Building from Xcode, with nothing in the environment: set `MANTIS_E2E=1` for that configuration as a build setting
too, on the app target (Metro's bundling step reads it) and on the mantis pod target next to `MANTIS_DEVICE`.

What keeps the agent out of the App Store build:

- a device build with `MANTIS_E2E=1` of any configuration without `MANTIS_DEVICE=YES` fails to compile;
- on the phone the agent stays off unless the app was launched with the runner's `-mantisToken`, which only a Mac the
  phone trusts can pass (`devicectl`, Xcode); it listens on loopback only and drops connections without the token;
- what you archive from the allowed configuration (TestFlight, Ad Hoc) carries the agent, by design. Check the build
  you upload: `check-release.sh App.ipa`.

**Test.** Target the phone by its hardware UDID (`xcrun devicectl device info details --device <id>` shows it as
`udid`; not devicectl's own identifier, which looks like a simulator's):

```js
const target = { platform: "ios", deviceId: "<hardware UDID>", appId: "com.example.app" };
const app = new App(undefined, "ios", { usb: target.deviceId }); // setupMantis(target) picks USB by itself
before(() => app.start()); // fails at once if that iPhone isn't on USB
after(() => app.close());

test("login", async () => {
  await app.relaunch(() => launchApp({ ...target, launchArgs: app.launchArgs }));
  // ...
});
```

- `launchApp` runs `xcrun devicectl device process launch --terminate-existing <app> -- <launch args>`: the app's
  arguments go after `--`, or devicectl takes `-mantisPort` as its own option. `clearAppData` and `permissions` throw:
  reinstall instead (`devicectl device uninstall app` / `install app`). `app.relaunch` also waits up to 1 s for the
  app to be active: on a phone the agents connect during its launch animation.
- iOS parses a launch argument value that starts with `[` or `(` as a plist (an array), not a string (simulators too).
- A connection that drops (relaunch, crash, cable out) fails the calls in flight with `DISCONNECTED`; the runner
  redials until `close()`, and later calls wait for the agents as after a relaunch (`NOT_CONNECTED` after 15 s).
- Prepare the phone: Developer Mode on and paired with the Mac; AutoFill Passwords off (the "Save Password?" sheet is
  the system's: Mantis can't close it and a tap under it fails with `COVERED`); Auto-Lock off.
- One Mantis app at a time per phone and port. An app sent to the background frees the port (and takes it back when
  it's in the foreground again; the runner redials), and an app that finds the port taken retries. An app built with
  Mantis 0.5.0 keeps the port in the background: stop it. When another app answers there, `relaunch` and calls fail
  with `PORT_IN_USE`; a suspended one refuses connections like a free port, so that one shows only as `NOT_CONNECTED`
  (the app's log says `listener on port N failed`).

## Supported

- React Native with the New Architecture (Fabric); the agents assume `view.tag` / `View.id` is the React tag.
  Old Architecture: not tested. Tested on RN 0.88. The JS agent uses RN internals (`ReactFabric`, `RawEventEmitter`,
  DOM Node APIs on refs); a version without them fails with an error that names the missing piece.
- Actions on one `App` run one at a time (await each; no `Promise.all` of taps / scrolls). A second gesture while one
  is in progress fails. A gesture that fails midway, or is still down after 10 s (app sent to the background), is
  cancelled, so the next one starts clean. The agents turn Objective-C / Java exceptions into errors of the call;
  a C++ exception (Fabric) still crashes the app.
- Detox 20 for the Detox layer; any Node test framework without it. Node 22+.
- Android emulator (API 29+ for Modals: `WindowInspector`), iOS simulator, physical iPhone over USB (tested on
  iOS 18.3, see [Physical iPhone](#physical-iphone)).

## License

MIT

## Development

- `npm test`: runner + the agent's query engine against a fake tree and a fake native agent, no device.
- `example/`: the spike's test app wired to this package (`file:..`). `npm run e2e:build:android` /
  `e2e:build:ios`, then `npm run e2e:android` / `e2e:ios`.
- `docs/spike`: results and decisions of the spike.
  Mantis was called Probe then, so the docs use that name.
