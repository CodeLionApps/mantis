// Device helpers that make launches fast: wipe app data instead of reinstalling, start the app without Detox's
// "wait for idle". Run inside Detox's Jest environment (they use the `device` global for its id and platform).
// The app id comes from MANTIS_APP_ID, else from the Detox app config (bundleId, or read from binaryPath).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf8" });
const sh = (script) => run("sh", "-c", script);
const adb = (...args) => run("adb", "-s", device.id, ...args);
const ios = () => device.getPlatform() === "ios";

let cachedAppId;
async function appId() {
  if (process.env.MANTIS_APP_ID) return process.env.MANTIS_APP_ID;
  if (cachedAppId) return cachedAppId;
  // ponytail: first app of the configuration; multi-app configs need MANTIS_APP_ID
  const app = Object.values(require("detox/internals").config.apps)[0];
  if (app.bundleId) return (cachedAppId = app.bundleId);
  if (ios()) {
    const plist = path.join(path.resolve(app.binaryPath), "Info.plist");
    return (cachedAppId = run("plutil", "-extract", "CFBundleIdentifier", "raw", plist).trim());
  }
  const AAPT = require("detox/src/devices/common/drivers/android/exec/AAPT");
  return (cachedAppId = await new AAPT().getPackageName(path.resolve(app.binaryPath)));
}

/** Android: the agents dial 9123 on the device; map it to the runner's host port. iOS shares the Mac's localhost. */
function reversePort(hostPort) {
  if (!ios()) adb("reverse", "tcp:9123", `tcp:${hostPort}`);
}

// iOS: permissions via applesimutils restart SpringBoard (~4 s per permission on the next launch). A wipe keeps them,
// an install drops them, so set them once per install: the marker holds the app's bundle path (new on every
// install) and the permissions last set.
const permissionsMarker = () => path.join(os.tmpdir(), `mantis-permissions-${device.id}`);
const readMarker = () => {
  try {
    return fs.readFileSync(permissionsMarker(), "utf8");
  } catch {
    return undefined;
  }
};
function setIosPermissions(id, permissions) {
  const list = Object.entries(permissions)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  run("applesimutils", "--byId", device.id, "--bundle", id, "--restartSB", "--setPermissions", list);
}

/**
 * Wipes the app's data, like a fresh install but much faster, and stops the app. Instead of `delete: true`.
 * Android: `pm clear`, then grants every runtime permission the app requests (pm clear revokes them; like
 * `pm install -g`, which Detox uses). iOS simulator: empties the app's data container (keeps the empty dirs a fresh
 * install has; the keychain survives, as it does a reinstall). `permissions` (iOS, Detox format): set once per install.
 */
async function clearAppData({ permissions } = {}) {
  const id = await appId();
  if (!ios()) {
    adb(
      "shell",
      `pm clear ${id} >/dev/null && dumpsys package ${id} | grep -oE 'android\\.permission\\.[A-Z_]+: granted=false' | cut -d: -f1 | sort -u | while read p; do pm grant ${id} $p 2>/dev/null; done; true`,
    );
    return;
  }
  // cfprefsd caches the app's preferences and writes them back, so kill it before deleting (it may not be running:
  // it respawns on demand). Prints the app's bundle path, which changes with every install.
  const udid = device.id;
  const bundle = sh(
    `xcrun simctl terminate ${udid} ${id} 2>/dev/null; xcrun simctl spawn ${udid} launchctl kill SIGKILL user/foreground/com.apple.cfprefsd.xpc.daemon 2>/dev/null; cd "$(xcrun simctl get_app_container ${udid} ${id} data)" && find Documents Library tmp -mindepth 1 -maxdepth 1 ! -name SplashBoard -exec rm -rf {} + && mkdir -p Library/Caches Library/Preferences && xcrun simctl get_app_container ${udid} ${id} app`,
  ).trim();
  if (!permissions) return;
  const marker = `${bundle} ${JSON.stringify(permissions)}`;
  if (readMarker() === marker) return;
  setIosPermissions(id, permissions);
  fs.writeFileSync(permissionsMarker(), marker);
}

/**
 * Starts the app without Detox's instrumentation, so nothing waits for Detox's "app idle" (on a real app, seconds
 * of startup network); the first step's auto-wait covers startup instead. Takes device.launchApp's options
 * (delete, launchArgs, permissions). Launch args: Android intent extras (`am start --es`), iOS `-key value`
 * arguments, the formats Detox uses, so react-native-launch-arguments reads them the same way.
 */
async function launchApp({ delete: reinstall = false, launchArgs = {}, permissions } = {}) {
  const id = await appId();
  if (reinstall) {
    await device.uninstallApp();
    await device.installApp();
  }
  if (ios()) {
    if (permissions) setIosPermissions(id, permissions);
    const args = Object.entries(launchArgs).flatMap(([k, v]) => [`-${k}`, typeof v === "string" ? v : JSON.stringify(v)]);
    run("xcrun", "simctl", "launch", "--terminate-running-process", device.id, id, ...args);
    return;
  }
  // ponytail: Android permissions come from `pm install -g` (Detox's install) or clearAppData
  adb("shell", "am", "force-stop", id);
  const activity = adb("shell", "cmd", "package", "resolve-activity", "--brief", id).trim().split("\n").pop();
  const extras = Object.entries(launchArgs).flatMap(([k, v]) => [
    "--es",
    k,
    `'${typeof v === "string" ? v : JSON.stringify(v)}'`,
  ]);
  adb("shell", "am", "start", "-W", "-n", activity, ...extras);
}

module.exports = { appId, clearAppData, launchApp, reversePort };
