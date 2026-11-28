// Types of the runner's public API (README: Playwright-style API, Driving from a snapshot, Errors).
import { EventEmitter } from "node:events";

export type Platform = "android" | "ios";

/** Screen dp (iOS: points), as drawn natively. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ErrorCode =
  | "TIMEOUT"
  | "NOT_ACTIONABLE"
  | "NOT_FOCUSED"
  | "DELIVERED"
  | "STRICT"
  | "STALE"
  | "COVERED"
  | "UNSUPPORTED"
  | "INVALID_ARGUMENT"
  | "NOT_CONNECTED"
  | "PORT_IN_USE"
  | "DISCONNECTED"
  | "AGENT_ERROR";

/** Mantis's errors: a stable code; messages may change. Some codes carry facts as properties. */
export class MantisError extends Error {
  constructor(code: ErrorCode, message: string, props?: object);
  code: ErrorCode;
  /** NOT_ACTIONABLE: the last check that failed ("not found", "disabled", "covered by ..."). */
  reason?: string;
  /** keyboard.type: how many characters went in (NOT_FOCUSED: 0; DELIVERED: before cause). */
  typed?: number;
  /** STALE: the tag that is gone (getByTag's, or the view under a point tap; null: unknown). */
  tag?: number | null;
}
/** A wait that ran out (code TIMEOUT, or NOT_ACTIONABLE / NOT_FOCUSED for an action's auto-wait). */
export class TimeoutError extends MantisError {
  /** idle: what still held the wait when it ran out */
  busy?: IdleBusy;
}

/** A host view of app.snapshot(). */
export interface SnapshotNode {
  tag: number;
  /** index of the nearest kept ancestor in nodes, -1 for none */
  parent: number;
  /** host component name, e.g. RCTView, RCTText */
  type: string;
  testID: string | null;
  label: string | null;
  /** accessible name: the label, else the text inside */
  name: string;
  /** a Text's own text, else null */
  text: string | null;
  role: string | null;
  /** a text input's text as it is natively; a mask for a secret one */
  value: string | null;
  secret: boolean;
  placeholder: string | null;
  editable: boolean;
  pressable: boolean;
  enabled: boolean;
  selected: boolean | null;
  checked: boolean | "mixed" | null;
  scroll: boolean;
  horizontal: boolean;
  rect: Rect;
  /** visible share, 0..1 */
  ratio: number;
  /** a touch at its visible centre reaches it; null: can't tell */
  hit: boolean | null;
}

export interface Snapshot {
  commitId: number;
  nodes: SnapshotNode[];
  /** false: a system window, another app or (iOS) an alert of the app's own is in front */
  focused: boolean | null;
  keyboard: Rect | null;
  screen: { width: number; height: number; density: number } | null;
  complete: boolean;
  reasons: string[];
}

/** What a locator matched (Tree.query). */
export interface QueryNode {
  tag: number;
  type: string;
  name: string;
  text: string;
  rect: Rect;
  /** a non-empty box */
  visible: boolean;
  enabled: boolean;
  state?: object;
  /** its own tag and its descendants' */
  tags: number[];
  scrolls: { tag: number; rect: Rect; horizontal: boolean }[];
  busy: string | null;
}

export type TextMatch = string | RegExp;

export interface ActionOptions {
  /** ms; default 10000 */
  timeout?: number;
  /** skip the enabled check (Detox taps disabled views too) */
  force?: boolean;
}

export declare class Locator {
  nth(index: number): Locator;
  first(): Locator;
  filter(opts: { visible?: boolean; shown?: boolean }): Locator;
  getByText(text: TextMatch): Locator;
  getByTestId(testId: string): Locator;
  all(): Promise<QueryNode[]>;
  /** The one match (STRICT if several), the nth with nth(); undefined when none. */
  resolve(): Promise<QueryNode | undefined>;
  tap(opts?: ActionOptions): Promise<void>;
  fill(text: string, opts?: ActionOptions & { append?: boolean }): Promise<void>;
}

export interface Mark {
  commitId: number;
  /** the native draw count; absent from older iOS agents */
  draws?: number;
}

export interface IdleOptions {
  quietMs?: number;
  timeout?: number;
  since?: Mark;
  reactMs?: number;
  /** a request in flight longer than this doesn't hold the wait (default Infinity); a WebSocket: 1500 at most */
  netMaxMs?: number;
  /** a one-off setTimeout / requestAnimationFrame set for longer than this doesn't hold the wait (default 1500; 0: none) */
  timerMaxMs?: number;
}

/**
 * An XHR / fetch in flight (URL without query), a WebSocket connecting or waiting for a reply to a message it sent, or
 * an image loading natively (RN's <Image>: fetch and decode).
 */
export interface PendingRequest {
  url: string;
  /** ms in flight (WebSocket reply: since the message it sent) */
  ms: number;
  ws?: "connecting" | "reply";
  image?: true;
}

/** A pending JS timer (in err.busy also one that just fired: fired true). */
export interface PendingTimer {
  kind: "timeout" | "interval" | "frame";
  /** its delay (frame: 0) */
  ms: number;
  /** ms until due (negative: overdue, the JS thread is busy); null for an interval or one that fired */
  left: number | null;
  /** an interval, or its kind and delay bucket fired at least twice in a row (a poll, a loop): never holds the wait */
  recurring: boolean;
  /** how often its kind and delay bucket fired in a row */
  fires: number;
  /** ms since that bucket last fired; null: never */
  sinceLastFire: number | null;
  /** err.busy only: a one-off timer that fired less than quietMs ago (what it started may show a frame later) */
  fired?: true;
}

/** idle resolved: what was still pending but didn't hold the wait (beyond netMaxMs / timerMaxMs, recurring). */
export interface IdleResult {
  network: PendingRequest[];
  timers: PendingTimer[];
}

/** idle ran out: each source that still held it. */
export interface IdleBusy {
  network?: PendingRequest[];
  timers?: PendingTimer[];
  /** React committed less than quietMs ago */
  react?: { idleMs: number };
  /** the screen changed less than quietMs ago; what: the animation still running or the last change, if known */
  screen?: { idleMs: number; what: string | null };
  /** since: no commit or draw after the mark yet */
  reacted?: false;
  /** that thread didn't answer at all */
  thread?: "JS" | "main";
}

export type BackResult =
  | { ok: true; via: string; [fact: string]: unknown }
  | { ok: false; reason: string };

export type ScrollResult =
  | { ok: true; tag: number; moved: boolean }
  | { ok: false; reason: string; tag?: number };

export interface TapResult {
  /** the app's JS saw the touch */
  seen: boolean;
  /** tag of the innermost React view the native hit-test found under the point; null: none, or an older agent */
  took: number | null;
}

/**
 * A touch Mantis injected: x, y where the finger went down, dx, dy how far it moved, screen dp (px: times
 * snapshot().screen.density).
 */
export interface TouchEvent {
  type: "tap" | "drag";
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** the host's Date.now() before the RPC was sent and when it answered */
  start: number;
  end: number;
}

export declare class App extends EventEmitter {
  /**
   * usb: hardware UDID of a cabled iPhone: the runner dials its agents through usbmuxd instead of listening.
   * port left out: PORT, but on Android without MANTIS_PORT a free port the OS picks (read app.port after start()).
   */
  constructor(port?: number, platform?: Platform, opts?: { usb?: string });
  readonly port: number;
  readonly usb: string | undefined;
  platform: Platform;
  /** Launch args the agents need: this runner's token (both platforms) and port (iOS). Pass them to every launch. */
  readonly launchArgs: { mantisPort: number; mantisToken: string };
  readonly touchscreen: { tap(x: number, y: number, opts?: { timeout?: number }): Promise<TapResult> };
  readonly keyboard: { type(text: string, opts?: { timeout?: number }): Promise<void> };
  start(): Promise<void>;
  close(): Promise<void>;
  relaunch(launch: () => unknown, opts?: { timeout?: number }): Promise<void>;
  reloadJs(reload: () => unknown, opts?: { timeout?: number }): Promise<void>;
  snapshot(): Promise<Snapshot>;
  scroll(direction: "up" | "down" | "left" | "right"): Promise<ScrollResult>;
  back(): Promise<BackResult>;
  mark(opts?: { timeout?: number }): Promise<Mark>;
  idle(opts?: IdleOptions): Promise<IdleResult>;
  getByRole(role: string, opts?: { name?: TextMatch }): Locator;
  getByText(text: TextMatch): Locator;
  getByLabel(label: TextMatch): Locator;
  getByTestId(testId: string): Locator;
  getByTag(tag: number): Locator;
  getByPlaceholder(text: TextMatch, opts?: { exact?: boolean }): Locator;
  /** Raw RPC to the native agent, e.g. call("Page.screenshot", { scale }) (README: { png, windows, fallbacks }). */
  readonly native: { call(method: string, params?: object): Promise<any> };

  on(event: "touch", listener: (touch: TouchEvent) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: "touch", listener: (touch: TouchEvent) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: "touch", listener: (touch: TouchEvent) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
}

export interface Assertions {
  readonly not: Assertions;
  toBeAttached(opts?: { timeout?: number }): Promise<void>;
  toBeVisible(opts?: { timeout?: number }): Promise<void>;
  toBeHidden(opts?: { timeout?: number }): Promise<void>;
  toBeInViewport(opts?: { ratio?: number; timeout?: number }): Promise<void>;
  toHaveText(text: string, opts?: { timeout?: number }): Promise<void>;
  toHaveCount(count: number, opts?: { timeout?: number }): Promise<void>;
}

export function expect(locator: Locator): Assertions;
export function setupMantis(target?: { platform?: Platform; deviceId?: string }): App;
/** Default host port: MANTIS_PORT (else 9123) + Jest worker - 1. Android runners given no port don't use it without MANTIS_PORT. */
export const PORT: number;
export const PROTOCOL: number;
/** Detox's toBeVisible threshold, for toBeInViewport. */
export const DETOX_VISIBLE: { readonly ratio: 0.75 };
