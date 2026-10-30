// Device helpers that make launches fast: wipe app data instead of reinstalling, start the app without Detox's
// "wait for idle". Plain adb / xcrun simctl, no test framework needed.
// Target: each helper takes { platform, deviceId, appId }. Left out, they come from Detox when it runs (its `device`
// global; the app id from MANTIS_APP_ID, else the Detox app config: bundleId, or read from binaryPath).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf8" });
// `adb shell` joins its arguments into one device-side shell command line: quote every untrusted value
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// package names / bundle ids: letters, digits, '.', '_', '-'. Anything else is a misconfiguration, never a shell string.
const checkId = (id) => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Mantis: invalid app id ${JSON.stringify(id)}`);
  return id;
};

// Detox from the project under test, not from this package (a symlinked / monorepo install has no Detox next to it)
const requireDetox = (m) => require(require.resolve(m, { paths: [process.cwd(), __dirname] }));

// Detox's current device: its global, or the worker's (exposeGlobals: false)
const detoxDevice = (what) => {
  let d = global.device;
  try {
    d ??= requireDetox("detox/internals").worker.device;
  } catch {}
  if (!d) throw new Error(`Mantis: pass ${what} (no Detox device to take it from)`);
  return d;
};

/** The device to act on: explicit platform / deviceId, else Detox's current device. */
function target({ platform, deviceId } = {}) {
  return {
    platform: platform ?? detoxDevice("platform").getPlatform(),
    deviceId: deviceId ?? detoxDevice("deviceId").id,
  };
}
const adb = (t, ...args) => run("adb", "-s", t.deviceId, ...args);
const isIos = (t) => t.platform === "ios";

let cachedAppId;
/** App id: opts.appId, else MANTIS_APP_ID, else the Detox app config. */
async function appId(opts = {}) {
  if (opts.appId) return checkId(opts.appId);
  if (process.env.MANTIS_APP_ID) return checkId(process.env.MANTIS_APP_ID);
  if (cachedAppId) return cachedAppId;
  let config;
  try {
    config = requireDetox("detox/internals").config;
  } catch {}
  // ponytail: first app of the configuration; multi-app configs need MANTIS_APP_ID
  const app = config && Object.values(config.apps)[0];
  if (!app) throw new Error("Mantis: pass appId or set MANTIS_APP_ID (no Detox config to read it from)");
  if (app.bundleId) return (cachedAppId = checkId(app.bundleId));
  if (isIos(target(opts))) {
    const plist = path.join(path.resolve(app.binaryPath), "Info.plist");
    return (cachedAppId = checkId(run("plutil", "-extract", "CFBundleIdentifier", "raw", plist).trim()));
  }
  const AAPT = requireDetox("detox/src/devices/common/drivers/android/exec/AAPT");
  return (cachedAppId = checkId(await new AAPT().getPackageName(path.resolve(app.binaryPath))));
}

/** Android: the agents dial 9123 on the device; map it to the runner's host port. iOS shares the Mac's localhost. */
function reversePort(hostPort, opts) {
  const t = target(opts);
  if (!isIos(t)) adb(t, "reverse", "tcp:9123", `tcp:${hostPort}`);
}

// iOS: permissions via applesimutils restart SpringBoard (~4 s per permission on the next launch). A wipe keeps them,
// an install drops them, so set them once per install: the marker holds the app's bundle path (new on every
// install) and the permissions last set.
const permissionsMarker = (t) => path.join(os.tmpdir(), `mantis-permissions-${t.deviceId}`);
const readMarker = (t) => {
  try {
    return fs.readFileSync(permissionsMarker(t), "utf8");
  } catch {
    return undefined;
  }
};
function setIosPermissions(t, id, permissions) {
  // the app's bundle path changes with every install
  const bundle = run("xcrun", "simctl", "get_app_container", t.deviceId, id, "app").trim();
  const marker = `${bundle} ${JSON.stringify(permissions)}`;
  if (readMarker(t) === marker) return;
  const list = Object.entries(permissions)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  run("applesimutils", "--byId", t.deviceId, "--bundle", id, "--restartSB", "--setPermissions", list);
  fs.writeFileSync(permissionsMarker(t), marker);
}

// best effort: the app or cfprefsd may simply not be running
const tryRun = (...a) => {
  try {
    run(...a);
  } catch {}
};

/**
 * Wipes the app's data, like a fresh install but much faster, and stops the app. Instead of `delete: true`.
 * Android: `pm clear`, then grants every runtime permission the app requests (pm clear revokes them; like
 * `pm install -g`, which Detox uses). iOS simulator: empties the app's data container (keeps the empty dirs a fresh
 * install has; the keychain survives, as it does a reinstall). `permissions` (iOS, Detox format): set once per install.
 * Fails (throws) when the app's data can't be located; never deletes anything else.
 */
async function clearAppData({ permissions, ...opts } = {}) {
  const t = target(opts);
  const id = await appId(opts);
  if (!isIos(t)) {
    const out = adb(t, "shell", "pm", "clear", id);
    if (!out.includes("Success")) throw new Error(`Mantis: pm clear ${id} failed: ${out.trim()}`);
    // ponytail: one shell round trip; a permission the app can't be granted (not runtime) is skipped
    adb(
      t,
      "shell",
      `dumpsys package ${shq(id)} | grep -oE 'android\\.permission\\.[A-Z_]+: granted=false' | cut -d: -f1 | sort -u | while read p; do pm grant ${shq(id)} "$p" 2>/dev/null; done; true`,
    );
    return;
  }
  const udid = t.deviceId;
  // cfprefsd caches the app's preferences and writes them back, so kill it before deleting (it respawns on demand)
  tryRun("xcrun", "simctl", "terminate", udid, id);
  tryRun("xcrun", "simctl", "spawn", udid, "launchctl", "kill", "SIGKILL", "user/foreground/com.apple.cfprefsd.xpc.daemon");
  const data = run("xcrun", "simctl", "get_app_container", udid, id, "data").trim();
  if (!path.isAbsolute(data) || !data.includes("/Containers/Data/Application/") || !fs.statSync(data).isDirectory())
    throw new Error(`Mantis: unexpected data container for ${id}: ${JSON.stringify(data)}`);
  for (const dir of ["Documents", "Library", "tmp"]) {
    const abs = path.join(data, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs))
      if (entry !== "SplashBoard") fs.rmSync(path.join(abs, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(data, "Library/Caches"), { recursive: true });
  fs.mkdirSync(path.join(data, "Library/Preferences"), { recursive: true });
  if (permissions) setIosPermissions(t, id, permissions);
}

/**
 * Starts the app without Detox's instrumentation, so nothing waits for Detox's "app idle" (on a real app, seconds
 * of startup network); the first step's auto-wait covers startup instead. Takes device.launchApp's options
 * (delete, launchArgs, permissions) plus the target. Launch args: Android intent extras (`am start --es`), iOS
 * `-key value` arguments, the formats Detox uses, so react-native-launch-arguments reads them the same way.
 */
async function launchApp({ delete: reinstall = false, launchArgs = {}, permissions, newInstance, ...opts } = {}) {
  // always a fresh process; Detox's url, userNotification, languageAndLocale, ... would be dropped silently
  const unsupported = Object.keys(opts).filter((k) => !["platform", "deviceId", "appId"].includes(k));
  if (newInstance === false) unsupported.push("newInstance: false");
  if (unsupported.length)
    throw new Error(`Mantis launchApp (MANTIS_NO_IDLE) doesn't support ${unsupported.join(", ")}; launch with Detox`);
  const t = target(opts);
  const id = await appId(opts);
  if (reinstall) {
    // ponytail: reinstalling needs the binary Detox knows; without Detox, install it yourself (adb install / simctl install)
    const d = detoxDevice("delete: false and install the app yourself");
    await d.uninstallApp();
    await d.installApp();
  }
  const str = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  if (isIos(t)) {
    if (permissions) setIosPermissions(t, id, permissions);
    const args = Object.entries(launchArgs).flatMap(([k, v]) => [`-${k}`, str(v)]);
    run("xcrun", "simctl", "launch", "--terminate-running-process", t.deviceId, id, ...args);
    return;
  }
  // ponytail: Android permissions come from `pm install -g` (Detox's install) or clearAppData
  adb(t, "shell", "am", "force-stop", id);
  const activity = adb(t, "shell", "cmd", "package", "resolve-activity", "--brief", id).trim().split("\n").pop();
  const extras = Object.entries(launchArgs).flatMap(([k, v]) => ["--es", shq(k), shq(str(v))]);
  adb(t, "shell", "am", "start", "-W", "-n", shq(activity), ...extras);
}

module.exports = { appId, clearAppData, detoxDevice, launchApp, requireDetox, reversePort, target };
