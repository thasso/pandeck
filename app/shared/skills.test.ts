import { describe, expect, test } from "vitest";
import {
  BROADCAST_TOPICS,
  isSafeSkillName,
  isSkillEnabled,
  MAX_SKILL_NAME_CHARS,
  type BroadcastTopic,
  type ServerMessage,
  type SkillDiagnostic,
  type SkillLibraryList,
} from "./protocol.ts";

/**
 * The `skills` contract is small, and both halves of it are the kind that fail
 * silently: a topic the server does not accept subscribes a surface to nothing,
 * and a list shape that can say "empty" and "failed" at once teaches a client
 * to draw an empty library over a read that never happened.
 */
describe("skills topic contract", () => {
  test("`skills` is a subscribable topic", () => {
    const topic: BroadcastTopic = "skills";
    expect(BROADCAST_TOPICS).toContain(topic);
  });

  test("a successful list carries summaries and diagnostics together", () => {
    const list: SkillLibraryList = {
      libraryPath: "/data/skills",
      skills: [
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
    const message: ServerMessage = { type: "skillList", list };

    expect(message).toEqual({ type: "skillList", list });
    // The malformed folder is identified by its SOURCE folder, which is
    // independent of any name it declares.
    const [diagnostic] = list.diagnostics as [SkillDiagnostic];
    expect(diagnostic.folder).toBe("notes-copy");
    expect(diagnostic.declaredName).toBe("notes");
  });

  test("a failed scan carries an error instead of an empty library", () => {
    const message: ServerMessage = {
      type: "skillList",
      error: "Failed to read the skills library: EACCES",
    };

    expect(message.type === "skillList" && message.list).toBeUndefined();
  });

  test("the skill list message requires exactly one outcome", () => {
    // @ts-expect-error A skill-list message must carry a list or an error.
    const missingOutcome: ServerMessage = { type: "skillList" };
    const ambiguousOutcome: ServerMessage = {
      type: "skillList",
      list: { libraryPath: "/data/skills", skills: [], diagnostics: [] },
      // @ts-expect-error A skill-list message cannot carry both outcomes.
      error: "scan failed",
    };

    expect(missingOutcome.type).toBe("skillList");
    expect(ambiguousOutcome.type).toBe("skillList");
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
      expect(isSafeSkillName(name)).toBe(true);
    for (const name of [
      "",
      "Release-Notes",
      "-leading",
      "trailing-",
      "double--hyphen",
      "with space",
      "with/slash",
      "..",
      "x".repeat(MAX_SKILL_NAME_CHARS + 1),
    ])
      expect(isSafeSkillName(name)).toBe(false);
    expect(isSafeSkillName("x".repeat(MAX_SKILL_NAME_CHARS))).toBe(true);
  });
});
