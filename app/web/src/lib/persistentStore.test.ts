import { describe, expect, it } from "vitest";
import type { ListableStorage } from "./localStore.ts";
import {
  createPersistentStore,
  supersedes,
  type PersistentStoreBackend,
  type StoredEntry,
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

/** Applies a commit the way the IndexedDB backend does: newest stamp wins. */
function fakeBackend(entries: Record<string, string> = {}) {
  const stored = new Map<string, StoredEntry>(
    Object.entries(entries).map(([key, value]) => [
      key,
      { value, at: 1, by: "seed" },
    ]),
  );
  const commits: Map<string, string | null>[] = [];
  let gate: Promise<void> | null = null;
  let openGate = () => {};
  const backend = {
    stored,
    commits,
    /** What a fresh load would serve for `key`. */
    value: (key: string) => stored.get(key)?.value ?? null,
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
    async commit(batch: Map<string, StoredEntry>) {
      if (backend.failCommit) throw new Error("quota");
      commits.push(new Map([...batch].map(([key, e]) => [key, e.value])));
      for (const [key, entry] of batch) {
        const held = stored.get(key);
        if (!held || supersedes(entry, held)) stored.set(key, entry);
      }
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
      new Map([
        ["b", "3"],
        ["a", null],
      ]),
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
    expect(backend.value("assistant.composerDraft.session:s1")).toBe("draft");
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
    expect(backend.value("a")).toBe("fresh");
    expect(backend.value("b")).toBeNull();
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
    expect(backend.value("late")).toBe("1");
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
    const at = Date.now() + 1_000;
    channel.onmessage?.({ data: { key: "a", value: "2", at, by: "w2" } });
    channel.onmessage?.({ data: { key: "b", value: null, at, by: "w2" } });
    // Unstamped or older than what memory holds: ignored.
    channel.onmessage?.({ data: { key: "a", value: "3" } });
    channel.onmessage?.({ data: { key: "a", value: "0", at: 0, by: "w2" } });
    expect(store.getItem("a")).toBe("2");
    store.flush();
    await settle();
    expect(backend.commits).toEqual([]);
  });

  it("reports a load that answered after the bounded wait", async () => {
    const backend = fakeBackend({ a: "stored" });
    backend.hold();
    const timers = manualTimers();
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage({ "assistant.prefs": "legacy" }),
      schedule: timers.schedule,
    });
    const loading = store.load(300);
    timers.run(300);
    await loading;
    expect(store.isLoaded()).toBe(false);

    backend.releaseLoad();
    await store.whenLoaded();
    expect(store.isLoaded()).toBe(true);
    // Migrated entries are in memory by then, too.
    expect(store.getItem("a")).toBe("stored");
    expect(store.getItem("assistant.prefs")).toBe("legacy");
  });

  it("reports a failed load as loaded once it falls back", async () => {
    const backend = fakeBackend();
    backend.failLoad = true;
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage({ kept: "1" }),
      schedule: manualTimers().schedule,
    });
    await store.whenLoaded();
    expect(store.isLoaded()).toBe(true);
    expect(store.getItem("kept")).toBe("1");
  });
});

/** Two windows on one database, each message delivered when the test says. */
function twoWindows(entries: Record<string, string> = {}) {
  const backend = fakeBackend(entries);
  const inbox = { a: [] as unknown[], b: [] as unknown[] };
  const channel = (to: unknown[]) => ({
    postMessage: (message: unknown) => void to.push(message),
    onmessage: null as ((event: { data: unknown }) => void) | null,
  });
  const channelA = channel(inbox.b);
  const channelB = channel(inbox.a);
  const open = (windowId: string, ch: typeof channelA) =>
    createPersistentStore({
      backend,
      legacy: memoryStorage(),
      channel: ch,
      schedule: manualTimers().schedule,
      windowId,
      now: () => 1_000,
    });
  const deliver = (to: unknown[], ch: typeof channelA) => {
    for (const data of to.splice(0)) ch.onmessage?.({ data });
  };
  return {
    backend,
    a: open("a", channelA),
    b: open("b", channelB),
    deliverToA: () => deliver(inbox.a, channelA),
    deliverToB: () => deliver(inbox.b, channelB),
    /** A window opened afterwards: what a reload reads. */
    async reopen() {
      const store = createPersistentStore({
        backend,
        legacy: memoryStorage(),
        schedule: manualTimers().schedule,
      });
      await store.load(300);
      return store;
    },
  };
}

describe("persistentStore across windows", () => {
  it("keeps the newer value when the older window's commit lands last", async () => {
    const w = twoWindows();
    await Promise.all([w.a.load(300), w.b.load(300)]);

    w.a.setItem("draft", "older");
    w.deliverToB();
    w.b.setItem("draft", "newer");
    w.b.flush();
    await settle();
    // B's message is still on its way when A's queued write commits.
    w.a.flush();
    await settle();
    w.deliverToA();
    w.a.flush();
    await settle();

    expect(w.a.getItem("draft")).toBe("newer");
    expect(w.b.getItem("draft")).toBe("newer");
    expect(w.backend.value("draft")).toBe("newer");
    expect((await w.reopen()).getItem("draft")).toBe("newer");
  });

  it("keeps a removal when the older window's write lands last", async () => {
    const w = twoWindows({ draft: "saved" });
    await Promise.all([w.a.load(300), w.b.load(300)]);

    w.a.setItem("draft", "edited");
    w.deliverToB();
    w.b.removeItem("draft");
    w.b.flush();
    await settle();
    w.a.flush();
    await settle();
    w.deliverToA();
    w.a.flush();
    await settle();

    expect(w.a.getItem("draft")).toBeNull();
    expect(w.backend.value("draft")).toBeNull();
    const reopened = await w.reopen();
    expect(reopened.getItem("draft")).toBeNull();
    expect(reopened.keys()).not.toContain("draft");
  });

  it("drops a queued write that another window has since replaced", async () => {
    const w = twoWindows();
    await Promise.all([w.a.load(300), w.b.load(300)]);

    w.a.setItem("assistant.prefs", "older");
    w.deliverToB();
    w.b.setHidden(true);
    w.b.setItem("assistant.prefs", "newer");
    await settle();
    w.deliverToA();
    w.a.flush();
    await settle();

    expect(w.a.getItem("assistant.prefs")).toBe("newer");
    expect(w.backend.value("assistant.prefs")).toBe("newer");
    expect(w.backend.commits).toHaveLength(1);
  });

  for (const first of ["a", "b"] as const)
    it(`settles two different simultaneous writes on one value (${first} commits first)`, async () => {
      const w = twoWindows();
      await Promise.all([w.a.load(300), w.b.load(300)]);
      w.a.setItem("k", "from a");
      w.b.setItem("k", "from b");
      const order = first === "a" ? [w.a, w.b] : [w.b, w.a];
      for (const store of order) store.flush();
      await settle();
      w.deliverToA();
      w.deliverToB();

      const value = w.backend.value("k");
      expect(w.a.getItem("k")).toBe(value);
      expect(w.b.getItem("k")).toBe(value);
      // Same clock reading: the window id breaks the tie, the same everywhere.
      expect(value).toBe("from b");
    });

  for (const deliverFirst of ["toA", "toB"] as const)
    it(`settles writes made before either window heard the other (delivered ${deliverFirst} first)`, async () => {
      const w = twoWindows();
      await Promise.all([w.a.load(300), w.b.load(300)]);
      w.a.setItem("k", "from a");
      w.b.setItem("k", "from b");
      if (deliverFirst === "toA") {
        w.deliverToA();
        w.deliverToB();
      } else {
        w.deliverToB();
        w.deliverToA();
      }
      w.a.flush();
      w.b.flush();
      await settle();

      const value = w.backend.value("k");
      expect(w.a.getItem("k")).toBe(value);
      expect(w.b.getItem("k")).toBe(value);
      expect((await w.reopen()).getItem("k")).toBe(value);
    });

  it("keeps writing a value both windows queued at once", async () => {
    const w = twoWindows();
    await Promise.all([w.a.load(300), w.b.load(300)]);
    w.a.setItem("preview", "same");
    w.b.setItem("preview", "same");
    w.deliverToA();
    w.deliverToB();
    w.a.flush();
    w.b.flush();
    await settle();
    expect(w.backend.value("preview")).toBe("same");
  });

  it("writes over what it loaded even with a clock behind the writer's", async () => {
    const backend = fakeBackend();
    backend.stored.set("k", { value: "from a fast clock", at: 5_000, by: "x" });
    const store = createPersistentStore({
      backend,
      legacy: memoryStorage(),
      schedule: manualTimers().schedule,
      now: () => 1_000,
    });
    await store.load(300);
    store.setItem("k", "later");
    store.flush();
    await settle();
    expect(backend.value("k")).toBe("later");
  });

  for (const early of ["write", "removal"] as const)
    it(`keeps a ${early} made before the load over a stored stamp ahead of its clock`, async () => {
      const backend = fakeBackend();
      backend.stored.set("draft", {
        value: "old",
        at: 5_000,
        by: "old-window",
      });
      backend.hold();
      const timers = manualTimers();
      const store = createPersistentStore({
        backend,
        legacy: memoryStorage(),
        schedule: timers.schedule,
        now: () => 1_000,
      });
      const loading = store.load(300);
      timers.run(300);
      await loading;
      if (early === "write") store.setItem("draft", "genuine early edit");
      else store.removeItem("draft");
      store.flush();
      backend.releaseLoad();
      await store.whenLoaded();
      store.flush();
      await settle();

      const expected = early === "write" ? "genuine early edit" : null;
      expect(store.getItem("draft")).toBe(expected);
      expect(backend.value("draft")).toBe(expected);
      const reopened = createPersistentStore({
        backend,
        legacy: memoryStorage(),
        schedule: manualTimers().schedule,
      });
      await reopened.load(300);
      expect(reopened.getItem("draft")).toBe(expected);
    });

  for (const heard of ["before", "after"] as const)
    it(`orders an early write against another window's write heard ${heard} it`, async () => {
      const w = twoWindows({ k: "stored" });
      await w.b.load(300);
      w.backend.hold();
      const loadingA = w.a.load(300);
      if (heard === "before") {
        w.b.setItem("k", "from b");
        w.deliverToA();
        w.a.setItem("k", "early in a");
      } else {
        w.a.setItem("k", "early in a");
        w.b.setItem("k", "from b");
        w.deliverToA();
      }
      w.backend.releaseLoad();
      await loadingA;
      await w.a.whenLoaded();
      w.deliverToB();
      w.a.flush();
      w.b.flush();
      await settle();

      const expected = heard === "before" ? "early in a" : "from b";
      expect(w.a.getItem("k")).toBe(expected);
      expect(w.b.getItem("k")).toBe(expected);
      expect(w.backend.value("k")).toBe(expected);
    });

  for (const op of ["write", "removal"] as const)
    for (const late of ["older", "repeated"] as const)
      it(`keeps an early ${op} when a message ${late === "older" ? "older than" : "repeating"} one already taken arrives`, async () => {
        const backend = fakeBackend({ draft: "stored" });
        backend.hold();
        const channel = {
          postMessage: () => {},
          onmessage: null as ((event: { data: unknown }) => void) | null,
        };
        const timers = manualTimers();
        const store = createPersistentStore({
          backend,
          legacy: memoryStorage(),
          channel,
          schedule: timers.schedule,
          now: () => 1_000,
        });
        const loading = store.load(300);
        timers.run(300);
        await loading;
        const seen = { key: "draft", value: "seen newer remote", by: "b" };
        channel.onmessage?.({ data: { ...seen, at: 5_000 } });
        if (op === "write") store.setItem("draft", "genuine early edit");
        else store.removeItem("draft");
        channel.onmessage?.({
          data:
            late === "older"
              ? { key: "draft", value: "stale", at: 1_000, by: "c" }
              : { ...seen, at: 5_000 },
        });
        backend.releaseLoad();
        await store.whenLoaded();
        store.flush();
        await settle();

        const expected = op === "write" ? "genuine early edit" : null;
        expect(store.getItem("draft")).toBe(expected);
        expect(backend.value("draft")).toBe(expected);
        const reopened = createPersistentStore({
          backend,
          legacy: memoryStorage(),
          schedule: manualTimers().schedule,
        });
        await reopened.load(300);
        expect(reopened.getItem("draft")).toBe(expected);
      });

  it("does not migrate a localStorage copy over a stored removal", async () => {
    const backend = fakeBackend();
    backend.stored.set("assistant.prefs", { value: null, at: 5, by: "x" });
    const legacy = memoryStorage({ "assistant.prefs": "stale" });
    const store = createPersistentStore({
      backend,
      legacy,
      schedule: manualTimers().schedule,
    });
    await store.load(300);
    expect(store.getItem("assistant.prefs")).toBeNull();
    expect(backend.value("assistant.prefs")).toBeNull();
    expect(legacy.keys()).toEqual([]);
  });
});
