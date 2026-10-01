import { describe, expect, it } from "vitest";
import {
  createWorktreeWatchRegistry,
  type WorktreeWatchTransport,
} from "./worktreeWatchRegistry.ts";

/**
 * What the SOCKET sees. The wire has no refcount — one Set of ids per
 * connection, so one unwatch ends the watch for everyone — which makes every
 * assertion here about the traffic this suppresses as much as the traffic it
 * sends.
 */

type Call = `watch:${string}` | `unwatch:${string}`;

function transport() {
  const calls: Call[] = [];
  const t: WorktreeWatchTransport = {
    watchWorktree: (id) => void calls.push(`watch:${id}`),
    unwatchWorktree: (id) => void calls.push(`unwatch:${id}`),
  };
  return { calls, t };
}

describe("worktreeWatchRegistry", () => {
  it("watches once for two holders and releases on the last one", () => {
    const { calls, t } = transport();
    const registry = createWorktreeWatchRegistry();
    registry.setConnection(true, t);

    // A project page's Task rows and the Projects browser, both up, both
    // wanting the same worktree.
    const page = registry.lease();
    const browser = registry.lease();
    page.set(["wt-1"]);
    browser.set(["wt-1", "wt-2"]);
    expect(calls).toEqual(["watch:wt-1", "watch:wt-2"]);

    calls.length = 0;
    // The browser goes away. `wt-1` is still on screen on the page, so nothing
    // may leave the socket for it — this is the freeze the registry exists for.
    browser.release();
    expect(calls).toEqual(["unwatch:wt-2"]);
    expect(registry.watching()).toEqual(["wt-1"]);

    calls.length = 0;
    page.release();
    expect(calls).toEqual(["unwatch:wt-1"]);
    expect(registry.watching()).toEqual([]);
  });

  it("keeps a watch that survives one lease's change of mind", () => {
    const { calls, t } = transport();
    const registry = createWorktreeWatchRegistry();
    registry.setConnection(true, t);
    const lease = registry.lease();
    lease.set(["wt-1", "wt-2"]);

    calls.length = 0;
    // `wt-1` is in both lists: it must not be released and re-taken, which
    // would cost a forced rescan and a gap where nothing was watched.
    lease.set(["wt-1", "wt-3"]);
    expect(calls).toEqual(["watch:wt-3", "unwatch:wt-2"]);
  });

  it("re-establishes the whole union on a new connection", () => {
    const { calls, t } = transport();
    const registry = createWorktreeWatchRegistry();
    registry.setConnection(true, t);
    const a = registry.lease();
    const b = registry.lease();
    a.set(["wt-1"]);
    b.set(["wt-2"]);

    calls.length = 0;
    // The socket drops. The connection took its watches with it, so there is
    // nothing to release — and an unwatch now would be answered by the NEXT
    // connection, against watches about to be made there.
    registry.setConnection(false, t);
    expect(calls).toEqual([]);
    expect(registry.watching()).toEqual([]);

    // A lease may well change while the socket is down; the reconnect owes the
    // server the CURRENT demand, not the one it had when it dropped.
    b.set(["wt-3"]);
    expect(calls).toEqual([]);

    registry.setConnection(true, t);
    expect(calls.sort()).toEqual(["watch:wt-1", "watch:wt-3"]);
  });

  it("says nothing before there is a connection to say it on", () => {
    const { calls, t } = transport();
    const registry = createWorktreeWatchRegistry();
    const lease = registry.lease();
    lease.set(["wt-1"]);
    expect(calls).toEqual([]);
    registry.setConnection(true, t);
    expect(calls).toEqual(["watch:wt-1"]);
    // Repeating what it already knows is not a connection change.
    calls.length = 0;
    registry.setConnection(true, t);
    expect(calls).toEqual([]);
  });
});
