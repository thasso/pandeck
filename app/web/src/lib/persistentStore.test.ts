import { describe, expect, it } from "vitest";
import type { ListableStorage } from "./localStore.ts";
import {
  createPersistentStore,
  type PersistentStoreBackend,
} from "./persistentStore.ts";

function memoryStorage(entries: Record<string, string> = {}): ListableStorage {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

function fakeBackend(entries: Record<string, string> = {}) {
  const stored = new Map(Object.entries(entries));
  const commits: { puts: Map<string, string>; deletes: Set<string> }[] = [];
  let gate: Promise<void> | null = null;
  let openGate = () => {};
  const backend = {
    stored,
    commits,
    failLoad: false,
    failCommit: false,
    /** Hold `load()` until `releaseLoad()`. */
    hold() {
      gate = new Promise<void>((resolve) => (openGate = resolve));
    },
    releaseLoad() {
      openGate();
    },
    async load() {
      if (gate) await gate;
      if (backend.failLoad) throw new Error("no database");
      return new Map(stored);
    },
    async commit(puts: Map<string, string>, deletes: Set<string>) {
      if (backend.failCommit) throw new Error("quota");
      commits.push({ puts: new Map(puts), deletes: new Set(deletes) });
      for (const key of deletes) stored.delete(key);
      for (const [key, value] of puts) stored.set(key, value);
    },
  } satisfies PersistentStoreBackend & Record<string, unknown>;
  return backend;
}

/** Timers run only when the test says so. */
function manualTimers() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    schedule: (run: () => void, ms: number) => void pending.push({ run, ms }),
    run(ms: number) {
      for (const timer of pending.splice(0).filter((t) => t.ms === ms))
        timer.run();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("persistentStore", () => {
  it("serves loaded entries synchronously and batches writes", async () => {
    const backend = fakeBackend({ a: "1" });
    const timers = manualTimers();
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      schedule: timers.schedule,
    });
    await store.load(300);
    expect(store.getItem("a")).toBe("1");

    store.setItem("b", "2");
    store.setItem("b", "3");
    store.removeItem("a");
    expect(store.getItem("b")).toBe("3");
    expect(backend.commits).toEqual([]);

    timers.run(250);
    await settle();
    expect(backend.commits).toEqual([
      { puts: new Map([["b", "3"]]), deletes: new Set(["a"]) },
    ]);
  });

  it("does not write a value it already holds", async () => {
    const backend = fakeBackend({ a: "1" });
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      schedule: manualTimers().schedule,
    });
    await store.load(300);
    store.setItem("a", "1");
    store.flush();
    await settle();
    expect(backend.commits).toEqual([]);
  });

  it("moves owned keys off localStorage and drops superseded caches", async () => {
    const legacy = memoryStorage({
      "assistant.composerDraft.session:s1": "draft",
      "assistant.composerDraft.session:s1.chatComments#c1": "{}",
      "assistant.prefs": '{"theme":"light"}',
      "assistant.appShellCache.v1": "{}",
      "assistant.webBuildId": "b1",
    });
    const backend = fakeBackend({ "assistant.prefs": '{"theme":"dark"}' });
    const store = createPersistentStore({
      backend,
      legacy,
      schedule: manualTimers().schedule,
    });
    await store.load(300);

    expect(store.getItem("assistant.composerDraft.session:s1")).toBe("draft");
    expect(backend.stored.get("assistant.composerDraft.session:s1")).toBe(
      "draft",
    );
    // The database's copy is the newer one.
    expect(store.getItem("assistant.prefs")).toBe('{"theme":"dark"}');
    expect(legacy.keys().sort()).toEqual([
      "assistant.composerDraft.session:s1.chatComments#c1",
      "assistant.webBuildId",
    ]);
  });

  it("leaves localStorage alone when the migration cannot be written", async () => {
    const legacy = memoryStorage({ "assistant.dictation.recent": "[]" });
    const backend = fakeBackend();
    backend.failCommit = true;
    const store = createPersistentStore({
      backend,
      legacy,
      schedule: manualTimers().schedule,
    });
    await store.load(300);
    expect(legacy.getItem("assistant.dictation.recent")).toBe("[]");
  });

  it("renders without a slow load and merges it in when it lands", async () => {
    const backend = fakeBackend({ a: "stored", b: "stored" });
    backend.hold();
    const timers = manualTimers();
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      schedule: timers.schedule,
    });
    const loading = store.load(300);
    timers.run(300);
    await loading;
    expect(store.getItem("a")).toBeNull();

    // Written before the load answered: newer than the database.
    store.setItem("a", "fresh");
    store.removeItem("b");
    backend.releaseLoad();
    await settle();
    expect(store.getItem("a")).toBe("fresh");
    expect(store.getItem("b")).toBeNull();

    timers.run(250);
    await settle();
    expect(backend.stored.get("a")).toBe("fresh");
    expect(backend.stored.has("b")).toBe(false);
  });

  it("falls back to localStorage, keeping earlier writes, when the database fails", async () => {
    const legacy = memoryStorage({ kept: "1" });
    const backend = fakeBackend();
    backend.hold();
    backend.failLoad = true;
    const timers = manualTimers();
    const store = createPersistentStore({
      backend,
      legacy,
      schedule: timers.schedule,
    });
    const loading = store.load(300);
    store.setItem("early", "x");
    backend.releaseLoad();
    await loading;

    expect(legacy.getItem("early")).toBe("x");
    store.setItem("late", "y");
    expect(legacy.getItem("late")).toBe("y");
    expect(store.getItem("kept")).toBe("1");
  });

  it("writes at once while the page is hidden", async () => {
    const backend = fakeBackend();
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      schedule: manualTimers().schedule,
    });
    await store.load(300);
    store.setHidden(true);
    store.setItem("late", "1");
    await settle();
    expect(backend.stored.get("late")).toBe("1");
  });

  it("takes writes from other windows without writing them again", async () => {
    const backend = fakeBackend({ a: "1" });
    const channel = {
      postMessage: () => {},
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      channel,
      schedule: manualTimers().schedule,
    });
    await store.load(300);
    channel.onmessage?.({ data: { key: "a", value: "2" } });
    channel.onmessage?.({ data: { key: "b", value: null } });
    expect(store.getItem("a")).toBe("2");
    store.flush();
    await settle();
    expect(backend.commits).toEqual([]);
  });
});
