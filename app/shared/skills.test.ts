import { describe, expect, test } from "vitest";
import {
  BROADCAST_TOPICS,
  isSafeEntryName,
  isSkillEnabled,
  MAX_ENTRY_NAME_CHARS,
  type BroadcastTopic,
  type ServerMessage,
  type EntryDiagnostic,
  type EntryLibraryList,
} from "./protocol.ts";

/**
 * The `skills` contract is small, and both halves of it are the kind that fail
 * silently: a topic the server does not accept subscribes a surface to nothing,
 * and a list shape that can say "empty" and "failed" at once teaches a client
 * to draw an empty library over a read that never happened.
 */
describe("library topic contract", () => {
  test("`skills` and `agents` are subscribable topics", () => {
    for (const topic of ["skills", "agents"] satisfies BroadcastTopic[])
      expect(BROADCAST_TOPICS).toContain(topic);
  });

  test("a successful list carries summaries and diagnostics together", () => {
    const list: EntryLibraryList = {
      libraryPath: "/data/skills",
      entries: [
        { name: "notes", description: "Take notes.", path: "notes/SKILL.md" },
      ],
      diagnostics: [
        {
          code: "duplicate-name",
          folder: "notes-copy",
          path: "notes-copy/SKILL.md",
          declaredName: "notes",
          error: 'Duplicate declared skill name "notes".',
        },
      ],
    };
    const message: ServerMessage = {
      type: "libraryList",
      library: "skills",
      list,
    };

    expect(message).toEqual({ type: "libraryList", library: "skills", list });
    // The malformed folder is identified by its SOURCE folder, which is
    // independent of any name it declares.
    const [diagnostic] = list.diagnostics as [EntryDiagnostic];
    expect(diagnostic.folder).toBe("notes-copy");
    expect(diagnostic.declaredName).toBe("notes");
  });

  test("a failed scan carries an error instead of an empty library", () => {
    const message: ServerMessage = {
      type: "libraryList",
      library: "skills",
      error: "Failed to read the skills library: EACCES",
    };

    expect(message.type === "libraryList" && message.list).toBeUndefined();
  });

  test("the library list message requires exactly one outcome", () => {
    // @ts-expect-error A library-list message must carry a list or an error.
    const missingOutcome: ServerMessage = {
      type: "libraryList",
      library: "agents",
    };
    const ambiguousOutcome: ServerMessage = {
      type: "libraryList",
      library: "skills",
      list: { libraryPath: "/data/skills", entries: [], diagnostics: [] },
      // @ts-expect-error A library-list message cannot carry both outcomes.
      error: "scan failed",
    };

    expect(missingOutcome.type).toBe("libraryList");
    expect(ambiguousOutcome.type).toBe("libraryList");
  });
});

/**
 * The toggle map's read rule ([Task-613](pa://task/613)). It is one line of
 * code and the whole safety property of the section: everything that is not an
 * explicit "on" is off, so no absent entry, no stale settings object and no
 * value invented elsewhere can enable a skill the user never enabled.
 */
describe("skill toggles", () => {
  test("only an explicit `on` enables a skill", () => {
    expect(isSkillEnabled({ notes: "on" }, "notes")).toBe(true);
    expect(isSkillEnabled({ notes: "off" }, "notes")).toBe(false);
    // Absent, empty and unread settings all answer the same way.
    expect(isSkillEnabled({ other: "on" }, "notes")).toBe(false);
    expect(isSkillEnabled({}, "notes")).toBe(false);
    expect(isSkillEnabled(undefined, "notes")).toBe(false);
  });

  test("a value that is not one of the two states is not `on`", () => {
    const dirty = { notes: "ON" } as unknown as Record<string, "on" | "off">;
    expect(isSkillEnabled(dirty, "notes")).toBe(false);
  });
});

describe("declared skill names", () => {
  test("accepts the agentskills.io shape and nothing wider", () => {
    for (const name of ["notes", "release-notes", "pr2", "a"])
      expect(isSafeEntryName(name)).toBe(true);
    for (const name of [
      "",
      "Release-Notes",
      "-leading",
      "trailing-",
      "double--hyphen",
      "with space",
      "with/slash",
      "..",
      "x".repeat(MAX_ENTRY_NAME_CHARS + 1),
    ])
      expect(isSafeEntryName(name)).toBe(false);
    expect(isSafeEntryName("x".repeat(MAX_ENTRY_NAME_CHARS))).toBe(true);
  });
});
