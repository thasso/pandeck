import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { isLoopbackHostHeader, stopWhenShellExits } from "./desktopShell.ts";

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

describe("stopWhenShellExits", () => {
  it("stops exactly once when the shell's pipe ends", () => {
    const stdin = new PassThrough();
    const stop = vi.fn();
    stopWhenShellExits(stdin, stop);
    stdin.write("ignored");
    expect(stop).not.toHaveBeenCalled();
    stdin.end();
    stdin.destroy();
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(stop).toHaveBeenCalledTimes(1);
        resolve();
      }),
    );
  });
});
