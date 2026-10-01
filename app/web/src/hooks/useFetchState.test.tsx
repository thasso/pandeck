// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { LoadState } from "../lib/loadState.ts";
import { useFetchState } from "./useFetchState.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

interface Deferred {
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

/** A fetcher whose answers are handed out one by one, per call. */
function controllable() {
  const pending: Deferred[] = [];
  const keys: string[] = [];
  const fetcher = (key: string) => {
    keys.push(key);
    return new Promise<string>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  return { fetcher, pending, keys };
}

it("paints cached initial data and silently revalidates the same key", async () => {
  const { fetcher, pending, keys } = controllable();
  const seen: LoadState<string>[] = [];

  function Probe() {
    seen.push(useFetchState("a", fetcher, { initialData: "cached" }).state);
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  expect(seen[0]).toEqual({ status: "ready", data: "cached" });
  expect(seen.at(-1)).toEqual({ status: "refreshing", data: "cached" });
  expect(keys).toEqual(["a"]);

  await act(async () => {
    pending[0]!.resolve("live");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "live" });
});

it("drops data on a key change and keeps it on a same-key reload", async () => {
  const { fetcher, pending, keys } = controllable();
  const seen: LoadState<string>[] = [];
  let reload = () => {};

  function Probe({ entryKey }: { entryKey: string | null }) {
    const result = useFetchState(entryKey, fetcher);
    seen.push(result.state);
    reload = result.reload;
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(<Probe entryKey="a" />);
  });
  expect(seen.at(-1)).toEqual({ status: "loading" });

  await act(async () => {
    pending[0]!.resolve("A");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "A" });

  // R2: same key, so the answer stays on screen while the refetch runs.
  await act(async () => {
    reload();
  });
  expect(seen.at(-1)).toEqual({ status: "refreshing", data: "A" });
  await act(async () => {
    pending[1]!.resolve("A2");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "A2" });

  // R3: a different object never renders under the previous object's data —
  // not even for one frame, so no state in this render carried "A2".
  const before = seen.length;
  await act(async () => {
    root!.render(<Probe entryKey="b" />);
  });
  expect(seen.slice(before).map((state) => state.status)).not.toContain(
    "ready",
  );
  expect(seen.at(-1)).toEqual({ status: "loading" });

  await act(async () => {
    pending[2]!.resolve("B");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "B" });
  expect(keys).toEqual(["a", "a", "b"]);
});

it("keeps data when a refresh fails and clears the error on the next answer", async () => {
  const { fetcher, pending } = controllable();
  const seen: LoadState<string>[] = [];
  let reload = () => {};

  function Probe() {
    const result = useFetchState("a", fetcher);
    seen.push(result.state);
    reload = result.reload;
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(<Probe />);
  });
  await act(async () => {
    pending[0]!.resolve("A");
  });

  await act(async () => {
    reload();
  });
  await act(async () => {
    pending[1]!.reject(new Error("network down"));
  });
  expect(seen.at(-1)).toEqual({
    status: "error",
    error: "network down",
    data: "A",
  });

  // A retry of a failed refresh is still a refresh: the stale data stays.
  await act(async () => {
    reload();
  });
  expect(seen.at(-1)).toEqual({ status: "refreshing", data: "A" });
  await act(async () => {
    pending[2]!.resolve("A3");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "A3" });
});

it("reports a first failure with no data to retain", async () => {
  const { fetcher, pending } = controllable();
  const seen: LoadState<string>[] = [];

  function Probe() {
    seen.push(useFetchState("a", fetcher).state);
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await act(async () => {
    pending[0]!.reject("offline");
  });
  expect(seen.at(-1)).toEqual({ status: "error", error: "offline" });
});

it("ignores an answer that arrives after its key was abandoned", async () => {
  const { fetcher, pending } = controllable();
  const seen: LoadState<string>[] = [];

  function Probe({ entryKey }: { entryKey: string }) {
    seen.push(useFetchState(entryKey, fetcher).state);
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe entryKey="a" />);
  });
  await act(async () => {
    root!.render(<Probe entryKey="b" />);
  });

  // The request for "a" resolves late; it must not become "b"'s content.
  await act(async () => {
    pending[0]!.resolve("A");
  });
  expect(seen.at(-1)).toEqual({ status: "loading" });

  await act(async () => {
    pending[1]!.resolve("B");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "B" });
});

it("aborts the in-flight request when the key changes or the host unmounts", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = (_key: string, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>(() => {});
  };

  function Probe({ entryKey }: { entryKey: string }) {
    useFetchState(entryKey, fetcher);
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe entryKey="a" />);
  });
  await act(async () => {
    root!.render(<Probe entryKey="b" />);
  });
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);

  await act(async () => {
    root!.unmount();
  });
  root = null;
  expect(signals[1]!.aborted).toBe(true);
});

it("parks at idle while disabled and loads once enabled", async () => {
  const { fetcher, pending, keys } = controllable();
  const seen: LoadState<string>[] = [];

  function Probe({ enabled }: { enabled: boolean }) {
    seen.push(useFetchState("a", fetcher, { enabled }).state);
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe enabled={false} />);
  });
  expect(seen.at(-1)).toEqual({ status: "idle" });
  expect(keys).toEqual([]);

  await act(async () => {
    root!.render(<Probe enabled />);
  });
  expect(seen.at(-1)).toEqual({ status: "loading" });
  await act(async () => {
    pending[0]!.resolve("A");
  });
  expect(seen.at(-1)).toEqual({ status: "ready", data: "A" });

  await act(async () => {
    root!.render(<Probe enabled={false} />);
  });
  expect(seen.at(-1)).toEqual({ status: "idle" });
});

it("does not restart the request when only the fetcher identity changes", async () => {
  const calls: string[] = [];

  function Probe({ tag }: { tag: string }) {
    // A fresh closure on every render, the way a caller writes it inline.
    useFetchState("a", (key: string) => {
      calls.push(`${tag}:${key}`);
      return new Promise<string>(() => {});
    });
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe tag="one" />);
  });
  await act(async () => {
    root!.render(<Probe tag="two" />);
  });
  expect(calls).toEqual(["one:a"]);
});
