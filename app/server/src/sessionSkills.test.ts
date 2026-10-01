import { describe, expect, it, vi } from "vitest";
import {
  activeSkillsForSession,
  parseSessionSkills,
  sessionSkills,
  type SessionSkillsDeps,
} from "./sessionSkills.ts";
import { sessionStore } from "./db/sessionStore.ts";

function fakeDeps(initial?: string): SessionSkillsDeps & {
  stored: Map<string, string>;
} {
  const stored = new Map<string, string>();
  if (initial !== undefined) stored.set("session", initial);
  return {
    stored,
    getFrozen: (id) => stored.get(id),
    freeze: (id, value) => {
      if (!stored.has(id)) stored.set(id, value);
      return stored.get(id)!;
    },
    resolve: vi.fn(async () => ["zeta", "alpha"]),
  };
}

describe("sessionSkills", () => {
  it("freezes before the first turn and ignores later settings resolution", async () => {
    const deps = fakeDeps();
    expect(
      await sessionSkills("session", "developer", undefined, deps),
    ).toEqual(["alpha", "zeta"]);
    deps.resolve = vi.fn(async () => ["new-skill"]);
    expect(
      await sessionSkills("session", "developer", undefined, deps),
    ).toEqual(["alpha", "zeta"]);
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("inherits a fork preset and preserves first-writer-wins", async () => {
    const deps = fakeDeps();
    expect(
      await sessionSkills("session", "workshop", ["zeta", "alpha"], deps),
    ).toEqual(["alpha", "zeta"]);
    expect(await sessionSkills("session", "workshop", ["other"], deps)).toEqual(
      ["alpha", "zeta"],
    );
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it.each(["assistant", "personal-assistant", "workflow-coordinator"] as const)(
    "never scans or stores skills for %s",
    async (agentType) => {
      const deps = fakeDeps();
      expect(
        await sessionSkills("session", agentType, undefined, deps),
      ).toEqual([]);
      expect(deps.resolve).not.toHaveBeenCalled();
      expect(deps.stored.size).toBe(0);
    },
  );

  it("fails malformed frozen JSON closed without recomputing", async () => {
    const deps = fakeDeps('{"not":"a list"}');
    expect(
      await sessionSkills("session", "developer", undefined, deps),
    ).toEqual([]);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(parseSessionSkills('["zeta","alpha"]')).toEqual([]);
  });

  it("projects only stored names without freezing during rendering", () => {
    const missing = `skills-state-missing-${Date.now()}`;
    expect(activeSkillsForSession(missing, "developer")).toEqual([]);
    expect(sessionStore.getSkills(missing)).toBeUndefined();
    expect(activeSkillsForSession(missing, "assistant")).toBeUndefined();

    const frozen = `skills-state-frozen-${Date.now()}`;
    sessionStore.freezeSkills(frozen, '["alpha"]');
    expect(activeSkillsForSession(frozen, "developer")).toEqual(["alpha"]);
  });
});
