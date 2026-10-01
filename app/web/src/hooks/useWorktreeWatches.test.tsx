// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantActions } from "./useAssistant.ts";
import { useWorktreeWatches } from "./useWorktreeWatches.ts";
import {
  createWorktreeWatchRegistry,
  type WorktreeWatchRegistry,
} from "../lib/worktreeWatchRegistry.ts";

/**
 * The hook's own job: bind one surface's demand to the shared registry for as
 * long as that surface is mounted. Every failure here is silent — the rows keep
 * rendering whatever they last heard — so the assertions are the calls that
 * reach the socket, above all across an unmount that another surface survives
 * and across a reconnect.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

type Call = `watch:${string}` | `unwatch:${string}`;

/** Two independent surfaces over one socket, mounted and unmounted at will. */
function harness() {
  const calls: Call[] = [];
  const actions = {
    watchWorktree: (id: string) => void calls.push(`watch:${id}`),
    unwatchWorktree: (id: string) => void calls.push(`unwatch:${id}`),
  } as AssistantActions;
  const registry: WorktreeWatchRegistry = createWorktreeWatchRegistry();

  function Surface({ ids, connected }: { ids: string[]; connected: boolean }) {
    useWorktreeWatches({ ids, connected, actions, registry });
    return null;
  }

  const render = ({
    a,
    b,
    connected = true,
  }: {
    a?: string[];
    b?: string[];
    connected?: boolean;
  }) => {
    container ??= document.createElement("div");
    if (!container.isConnected) document.body.append(container);
    root ??= createRoot(container);
    act(() => {
      root!.render(
        <>
          {a ? <Surface ids={a} connected={connected} /> : null}
          {b ? <Surface ids={b} connected={connected} /> : null}
        </>,
      );
    });
  };
  return { calls, registry, render };
}

describe("useWorktreeWatches", () => {
  it("keeps a shared worktree watched until the last surface goes", () => {
    const { calls, registry, render } = harness();
    // The routine overlap: a project page's Task rows and the Projects browser
    // both want `wt-1`.
    render({ a: ["wt-1"], b: ["wt-1", "wt-2"] });
    expect(calls).toEqual(["watch:wt-1", "watch:wt-2"]);

    calls.length = 0;
    // The browser unmounts. `wt-1` is still on screen on the page, and the wire
    // has no refcount — one unwatch here would freeze the page's dirty dots.
    render({ a: ["wt-1"] });
    expect(calls).toEqual(["unwatch:wt-2"]);
    expect(registry.watching()).toEqual(["wt-1"]);

    calls.length = 0;
    render({});
    expect(calls).toEqual(["unwatch:wt-1"]);
  });

  it("watches while connected and follows a surface's change of mind", () => {
    const { calls, render } = harness();
    render({ a: ["wt-a", "wt-b"] });
    expect(calls).toEqual(["watch:wt-a", "watch:wt-b"]);

    calls.length = 0;
    // A row's session moved to another worktree. `wt-b` is in both lists, so it
    // is neither released nor re-taken; the same list in a new array is a no-op.
    render({ a: ["wt-b", "wt-c"] });
    expect(calls).toEqual(["watch:wt-c", "unwatch:wt-a"]);

    calls.length = 0;
    render({ a: ["wt-b", "wt-c"] });
    expect(calls).toEqual([]);
  });

  it("re-establishes every surface's watches after a reconnect", () => {
    const { calls, registry, render } = harness();
    render({ a: ["wt-1"], b: ["wt-2"] });
    calls.length = 0;

    // The socket drops. Nothing is sent: the server took the watches with the
    // connection, and an unwatch would land on the replacement one.
    render({ a: ["wt-1"], b: ["wt-2"], connected: false });
    expect(calls).toEqual([]);
    expect(registry.watching()).toEqual([]);

    // Reconnected. Both surfaces are re-established, not just one that happened
    // to change its ids — without this every marker silently stops updating.
    render({ a: ["wt-1"], b: ["wt-2"], connected: true });
    expect(calls.sort()).toEqual(["watch:wt-1", "watch:wt-2"]);
  });

  it("asks for nothing while it has nothing to show", () => {
    const { calls, render } = harness();
    render({ a: [] });
    expect(calls).toEqual([]);
    render({ a: [], connected: false });
    expect(calls).toEqual([]);
  });
});
