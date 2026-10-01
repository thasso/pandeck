import { describe, expect, it } from "vitest";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import { paObjectReferenceKey, sessionReferenceKey } from "./transcriptKeys.ts";

function reference(
  patch: Partial<PaObjectLinkResolution> = {},
): PaObjectLinkResolution {
  return {
    uri: "pa://task/42",
    objectType: "task",
    knownType: true,
    id: "42",
    href: "/tasks/42",
    title: "Some task",
    typeLabel: "Task",
    existence: "exists",
    ...patch,
  };
}

describe("paObjectReferenceKey", () => {
  it("ignores fields derived from the uri", () => {
    const before = paObjectReferenceKey([reference()]);
    // href/typeLabel cannot vary independently of uri, so they are not keyed.
    const after = paObjectReferenceKey([
      reference({ href: "/elsewhere", typeLabel: "Ticket" }),
    ]);
    expect(after).toBe(before);
  });

  it("changes when a title or existence changes", () => {
    const base = paObjectReferenceKey([reference()]);
    expect(paObjectReferenceKey([reference({ title: "Renamed" })])).not.toBe(
      base,
    );
    expect(
      paObjectReferenceKey([reference({ existence: "missing" })]),
    ).not.toBe(base);
  });

  it("changes when a reference is added or removed", () => {
    const one = reference();
    const two = reference({ uri: "pa://task/43", id: "43", title: "Other" });
    expect(paObjectReferenceKey([one, two])).not.toBe(
      paObjectReferenceKey([one]),
    );
  });

  it("ignores the ORDER of the references", () => {
    const one = reference();
    const two = reference({ uri: "pa://task/43", id: "43", title: "Other" });
    // The list these are built from is sorted by `updatedAt`, so any agent turn
    // anywhere re-sorts it. The consumer reads them as a lookup, so a reorder is
    // not a content change — treating it as one re-rendered the whole transcript
    // several times a second while anything was running.
    expect(paObjectReferenceKey([two, one])).toBe(
      paObjectReferenceKey([one, two]),
    );
  });
});

describe("sessionReferenceKey", () => {
  it("keys id and title, and ignores order", () => {
    const rows = [
      { id: "s1", title: "One" },
      { id: "s2", title: "Two" },
    ];
    expect(sessionReferenceKey([...rows].reverse())).toBe(
      sessionReferenceKey(rows),
    );
    expect(
      sessionReferenceKey([{ id: "s1", title: "Renamed" }, rows[1]!]),
    ).not.toBe(sessionReferenceKey(rows));
  });

  it("ignores everything a session row carries besides id and title", () => {
    const base = sessionReferenceKey([{ id: "s1", title: "One" }]);
    const withVolatileFields = sessionReferenceKey([
      {
        id: "s1",
        title: "One",
        updatedAt: 42,
        isStreaming: true,
      } as { id: string; title?: string },
    ]);
    expect(withVolatileFields).toBe(base);
  });
});
