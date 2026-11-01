import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { SessionListItem } from "@assistant/shared";
import { hub } from "../hub.ts";
import { sessionListHiddenProbe } from "../permanentAssistantVisibility.ts";
import { recordSessionRowTouches } from "./sessionRowTouches.ts";

/** Independent full builds; neither expected ids nor the hub's delta map select rows. */
export async function publicSessionRows() {
  const rows = new Map<string, SessionListItem>();
  for (const archived of [false, true]) {
    const hidden = sessionListHiddenProbe();
    for (const row of await hub.listSessions({ includeArchived: archived })) {
      if (hidden(row)) continue;
      const { file: _file, ...item } = row;
      rows.set(`${archived ? "archived" : "default"}:${row.id}`, item);
    }
  }
  return rows;
}

export async function assertSessionRowsReported<T>(
  label: string,
  write: () => T | PromiseLike<T>,
  options: {
    changed?: readonly string[] | ((value: T) => readonly string[]);
    equal?: string;
  } = {},
): Promise<T> {
  assert.ok(
    options.changed || options.equal,
    `${label}: state the expected change or equal-public reason`,
  );
  const before = await publicSessionRows();
  const recorder = recordSessionRowTouches();
  let result: T;
  let touched: Set<string>;
  try {
    const value = write();
    // Sample sync APIs before yielding; async writers are sampled at completion.
    const thenable =
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function";
    result = thenable ? await value : (value as T);
    touched = recorder.ids();
  } finally {
    recorder.stop();
  }
  const after = await publicSessionRows();
  const changed = new Set(
    [...new Set([...before.keys(), ...after.keys()])]
      .filter((key) => !isDeepStrictEqual(before.get(key), after.get(key)))
      .map((key) => key.slice(key.indexOf(":") + 1)),
  );
  const expected =
    typeof options.changed === "function"
      ? options.changed(result!)
      : (options.changed ?? []);
  for (const id of expected)
    assert.ok(changed.has(id), `${label}: fixture did not change ${id}`);
  if (options.equal)
    assert.equal(changed.size, 0, `${label}: ${options.equal}`);
  for (const id of changed)
    assert.ok(
      touched!.has(id),
      `${label}: ${id} changed without a synchronous report`,
    );
  return result!;
}
