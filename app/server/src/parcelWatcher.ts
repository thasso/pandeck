import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { sep } from "node:path";
import {
  IS_PACKAGED_RUNTIME,
  PACKAGED_PARCEL_WATCHER_ADDON,
  PACKAGED_PARCEL_WATCHER_WRAPPER,
} from "./runtimeAssets.ts";
import type parcelWatcher from "@parcel/watcher";

export type { AsyncSubscription } from "@parcel/watcher";

type ParcelWatcher = typeof parcelWatcher;
type WatchCallback = Parameters<ParcelWatcher["subscribe"]>[1];

type NativeBinding = {
  subscribe(
    directory: string,
    callback: WatchCallback,
    options: Record<string, unknown>,
  ): Promise<void>;
  unsubscribe(
    directory: string,
    callback: WatchCallback,
    options: Record<string, unknown>,
  ): Promise<void>;
};

type WatcherWrapper = {
  createWrapper(binding: NativeBinding): ParcelWatcher;
};

function packagedWatcher(): ParcelWatcher {
  const require = createRequire(import.meta.url);
  const binding = require(PACKAGED_PARCEL_WATCHER_ADDON) as NativeBinding;
  const wrapper = require(PACKAGED_PARCEL_WATCHER_WRAPPER) as WatcherWrapper;
  return wrapper.createWrapper(binding);
}

function developmentWatcher(): ParcelWatcher {
  const require = createRequire(import.meta.url);
  const packageName = ["@parcel", "watcher"].join("/");
  return require(packageName) as ParcelWatcher;
}

const watcher = IS_PACKAGED_RUNTIME ? packagedWatcher() : developmentWatcher();

export default watcher;

/**
 * The root a native watch subscribes to, on either side: its real path. macOS FSEvents reports
 * real paths whatever spelling was subscribed (`/var` is `/private/var`), and
 * through an alias also reports spurious directory events, so the watch is
 * native on the real path and its events are spelled back as asked
 * ({@link spelledAsAsked}). Only notification spelling changes: parcel follows
 * the same link itself. A root that cannot be resolved is subscribed as asked,
 * so parcel answers its own failure.
 */
export async function nativeWatchRoot(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** An event `path` under the native root `real`, as under the asked `root`. */
export function spelledAsAsked(
  root: string,
  real: string,
  path: string,
): string {
  if (real === root) return path;
  if (path === real) return root;
  return path.startsWith(real + sep) ? root + path.slice(real.length) : path;
}
