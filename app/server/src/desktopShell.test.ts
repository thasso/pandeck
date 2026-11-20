import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLoopbackHostHeader,
  parseDesktopShellPid,
  stopWhenShellExits,
} from "./desktopShell.ts";

describe("isLoopbackHostHeader", () => {
  it("accepts loopback names with or without a port", () => {
    for (const host of [
      "127.0.0.1:41234",
      "localhost:41234",
      "localhost",
      "[::1]:41234",
    ])
      expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it("refuses a rebound or missing host", () => {
    for (const host of [
      undefined,
      "",
      "evil.example:41234",
      "127.0.0.1.evil.example",
      "localhost.evil.example:41234",
      "10.0.0.5:41234",
    ])
      expect(isLoopbackHostHeader(host)).toBe(false);
  });
});

describe("parseDesktopShellPid", () => {
  it("accepts a real pid", () => {
    expect(parseDesktopShellPid("4242")).toBe(4242);
  });

  it("refuses anything that is not a shell's pid", () => {
    for (const value of [undefined, "", "0", "1", "-5", "12x", "1e3", " 42"])
      expect(parseDesktopShellPid(value)).toBeUndefined();
  });
});

describe("stopWhenShellExits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops exactly once after the parent is gone", () => {
    vi.useFakeTimers();
    let alive = true;
    const stop = vi.fn();
    stopWhenShellExits(4242, stop, { exists: () => alive });
    vi.advanceTimersByTime(5000);
    expect(stop).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(5000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops at the first check when the shell died before the watch began", () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    stopWhenShellExits(4242, stop, { exists: () => false });
    vi.advanceTimersByTime(1000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("treats a live process as the running shell", () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    stopWhenShellExits(process.ppid, stop);
    vi.advanceTimersByTime(3000);
    expect(stop).not.toHaveBeenCalled();
  });
});
