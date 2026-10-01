import { describe, expect, it } from "vitest";
import {
  anchorScrollTop,
  canReach,
  clampScrollTop,
  createListScrollMemory,
  fallbackScrollTop,
  isAtScrollTop,
  LIST_SCROLL_KEY,
  LIST_SCROLL_LIMIT,
  maxScrollTop,
  parseListScrollMemory,
  positionToRemember,
  rememberListScroll,
  type ListScrollMemoryEntry,
  type ListScrollStorage,
} from "./listScroll.ts";
import type { IdleWriterEnv } from "./idleWriter.ts";

const metrics = (
  scrollTop: number,
  scrollHeight = 2000,
  clientHeight = 600,
) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

/** Writes straight through, so a test never waits on an idle callback. */
function immediateWriterEnv(): IdleWriterEnv {
  return {
    now: () => 0,
    setTimer: (run) => {
      run();
      return 0;
    },
    clearTimer: () => {},
    whenIdle: (run) => run(),
  };
}

function memoryStorage(): ListScrollStorage & { value: string | null } {
  return {
    value: null,
    getItem(key) {
      return key === LIST_SCROLL_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === LIST_SCROLL_KEY) this.value = value;
    },
  };
}

describe("positionToRemember", () => {
  it("remembers nothing at the top — that is where every list opens", () => {
    expect(positionToRemember(metrics(0), null)).toBeNull();
    expect(positionToRemember(metrics(3), null)).toBeNull();
  });

  it("refuses a container that is not laid out", () => {
    expect(positionToRemember(metrics(400, 2000, 0), null)).toBeNull();
  });

  it("keeps the anchor alongside the offset", () => {
    const anchor = { rowId: "task-7", offset: -12 };
    expect(positionToRemember(metrics(420), anchor)).toEqual({
      scrollTop: 420,
      anchor,
    });
    expect(positionToRemember(metrics(420), null)).toEqual({ scrollTop: 420 });
  });
});

describe("scroll targets", () => {
  it("clamps to what the content allows", () => {
    expect(maxScrollTop(metrics(0, 2000, 600))).toBe(1400);
    expect(clampScrollTop(9999, metrics(0))).toBe(1400);
    expect(clampScrollTop(-20, metrics(0))).toBe(0);
    expect(maxScrollTop(metrics(0, 300, 600))).toBe(0);
  });

  it("corrects by the anchored row's drift from its remembered offset", () => {
    // The row sits 100px below the container's top edge; it was left 12px above
    // it, so the view has to move down by 112px.
    expect(anchorScrollTop(metrics(500), 80, 180, -12)).toBe(612);
  });

  it("falls back to the remembered offset, clamped", () => {
    expect(fallbackScrollTop({ scrollTop: 420 }, metrics(0))).toBe(420);
    expect(fallbackScrollTop({ scrollTop: 9999 }, metrics(0))).toBe(1400);
  });

  it("knows when the list is still too short to hold the position", () => {
    // A list that has not arrived yet: 800px of content cannot hold a 420px
    // offset that was taken against 2000px.
    expect(canReach({ scrollTop: 420 }, metrics(0, 500, 600))).toBe(false);
    expect(canReach({ scrollTop: 420 }, metrics(0, 2000, 600))).toBe(true);
  });

  it("recognises a position that already landed", () => {
    expect(isAtScrollTop(metrics(420), 420)).toBe(true);
    expect(isAtScrollTop(metrics(420), 421)).toBe(true);
    expect(isAtScrollTop(metrics(420), 460)).toBe(false);
  });
});

describe("memory entries", () => {
  it("keeps one entry per list, newest first, bounded", () => {
    let entries: ListScrollMemoryEntry[] = [];
    for (let i = 0; i < LIST_SCROLL_LIMIT + 5; i += 1) {
      entries = rememberListScroll(entries, {
        listKey: `sidebar:${i}`,
        savedAt: i,
        scrollTop: i * 10,
      });
    }
    expect(entries).toHaveLength(LIST_SCROLL_LIMIT);
    expect(entries[0]?.listKey).toBe(`sidebar:${LIST_SCROLL_LIMIT + 4}`);

    const replaced = rememberListScroll(entries, {
      listKey: entries[3]!.listKey,
      savedAt: 999,
      scrollTop: 12,
    });
    expect(
      replaced.filter((item) => item.listKey === entries[3]!.listKey),
    ).toHaveLength(1);
    expect(replaced[0]?.scrollTop).toBe(12);
  });

  it("drops malformed persisted entries rather than restoring nonsense", () => {
    expect(parseListScrollMemory(null)).toEqual([]);
    expect(parseListScrollMemory("{oh no")).toEqual([]);
    expect(parseListScrollMemory(JSON.stringify({}))).toEqual([]);
    const parsed = parseListScrollMemory(
      JSON.stringify([
        { listKey: "", savedAt: 1, scrollTop: 10 },
        { listKey: "sidebar:tasks", savedAt: "soon", scrollTop: 10 },
        { listKey: "sidebar:sessions", savedAt: 1, scrollTop: "far" },
        {
          listKey: "sidebar:worktrees",
          savedAt: 2,
          scrollTop: 40,
          anchor: { rowId: "", offset: 3 },
        },
        {
          listKey: "sidebar:projects",
          savedAt: 3,
          scrollTop: 60,
          anchor: { rowId: "p1", offset: -8 },
        },
      ]),
    );
    expect(parsed).toEqual([
      { listKey: "sidebar:worktrees", savedAt: 2, scrollTop: 40 },
      {
        listKey: "sidebar:projects",
        savedAt: 3,
        scrollTop: 60,
        anchor: { rowId: "p1", offset: -8 },
      },
    ]);
  });
});

describe("createListScrollMemory", () => {
  it("round-trips a position through storage", () => {
    const storage = memoryStorage();
    const memory = createListScrollMemory({
      storage,
      now: () => 42,
      writerEnv: immediateWriterEnv(),
    });
    memory.save("sidebar:tasks", {
      scrollTop: 300,
      anchor: { rowId: "task-9", offset: -4 },
    });
    memory.flush();

    const reloaded = createListScrollMemory({
      storage,
      writerEnv: immediateWriterEnv(),
    });
    expect(reloaded.read("sidebar:tasks")).toEqual({
      scrollTop: 300,
      anchor: { rowId: "task-9", offset: -4 },
    });
    expect(reloaded.read("sidebar:sessions")).toBeUndefined();
  });

  it("forgets a list rather than leaving a stale position behind", () => {
    const storage = memoryStorage();
    const memory = createListScrollMemory({
      storage,
      writerEnv: immediateWriterEnv(),
    });
    memory.save("sidebar:sessions", { scrollTop: 120 });
    memory.forget("sidebar:sessions");
    memory.flush();
    expect(memory.read("sidebar:sessions")).toBeUndefined();
    expect(storage.value).toBe("[]");
  });

  it("survives storage that refuses to answer", () => {
    const blocked: ListScrollStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    const memory = createListScrollMemory({
      storage: blocked,
      writerEnv: immediateWriterEnv(),
    });
    expect(memory.read("sidebar:tasks")).toBeUndefined();
    expect(() => {
      memory.save("sidebar:tasks", { scrollTop: 10 });
      memory.flush();
    }).not.toThrow();
    // The position still lives for this page.
    expect(memory.read("sidebar:tasks")).toEqual({ scrollTop: 10 });
  });
});
