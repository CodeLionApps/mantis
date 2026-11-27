// Types of @codelionapps/mantis/device (README: Fast resets, Without Detox).
import type { Platform } from "../runner";

/** The device to act on; left out: Detox's current device. */
export interface Target {
  platform?: Platform;
  deviceId?: string;
  /** package / bundle id; else MANTIS_APP_ID, else the Detox app config */
  appId?: string;
}

/** Detox format, e.g. { notifications: "YES" } (iOS). */
export type Permissions = Record<string, string>;

/** A cabled iPhone: iOS and a hardware UDID (not a simulator's or devicectl's UUID); pass it as new App()'s usb. */
export function isIosDevice(opts?: Target): boolean;
export function target(opts?: Target): { platform: Platform; deviceId: string };
export function appId(opts?: Target): Promise<string>;
/** Android: maps the device's 9123 to the runner's host port (adb reverse); no-op on iOS. */
export function reversePort(hostPort: number, opts?: Target): void;
/** Wipes the app's data and stops it, instead of a reinstall. Throws on a physical iPhone. */
export function clearAppData(opts?: Target & { permissions?: Permissions }): Promise<void>;
/** Starts the app without Detox's instrumentation; always a fresh process. permissions throw on a physical iPhone. */
export function launchApp(
  opts?: Target & { delete?: boolean; launchArgs?: Record<string, unknown>; permissions?: Permissions; newInstance?: true },
): Promise<void>;
