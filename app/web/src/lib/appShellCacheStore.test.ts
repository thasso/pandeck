// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as store from "./appShellCacheStore.ts";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const record = {
  version: 1,
  savedAt: 1,
  models: [{ id: "m" }],
  agents: [],
  sessions: [{ id: "s1" }],
  settings: {},
  slashCommands: [],
  taskList: { tasks: [{ id: "413" }] },
  taskRevisions: { "413": 3 },
  worktrees: [],
};

it("reads back what it wrote", () => {
  store.writeAppShellCacheRecord(record);
  expect(store.readAppShellCacheRecord()).toEqual(record);
});

it("rewrites only the slices that changed", () => {
  store.writeAppShellCacheRecord(record);
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  store.writeAppShellCacheRecord({
    ...record,
    savedAt: 2,
    sessions: [{ id: "s2" }],
  });

  expect(setItem.mock.calls.map(([key]) => key).sort()).toEqual([
    "assistant.appShellCache.v2.meta",
    "assistant.appShellCache.v2.sessions",
  ]);
});

it("leaves nothing readable when a save fails part-way", () => {
  store.writeAppShellCacheRecord(record);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key.endsWith(".tasks")) throw new DOMException("full", "QuotaExceeded");
    setItem.call(this, key, value);
  });

  expect(() =>
    store.writeAppShellCacheRecord({
      ...record,
      sessions: [{ id: "s2" }],
      taskList: { tasks: [] },
    }),
  ).toThrow();
  expect(store.readAppShellCacheRecord()).toBeNull();
});
