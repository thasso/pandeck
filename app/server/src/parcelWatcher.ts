import { createRequire } from "node:module";
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
