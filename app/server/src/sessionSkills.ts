import {
  isCodingAgentType,
  isSafeSkillName,
  type SessionAgentType,
} from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { getSettings } from "./settings.ts";
import { scanSkillLibrary } from "./skills/skillLibraryScanner.ts";
import { skillLibraryStore } from "./skills/skillLibraryStore.ts";
import { resolveSkillNames } from "./skills/skillResolver.ts";

export interface SessionSkillsDeps {
  getFrozen(sessionId: string): string | undefined;
  freeze(sessionId: string, namesJson: string): string;
  resolve(): Promise<string[]>;
}

const REAL_DEPS: SessionSkillsDeps = {
  getFrozen: (sessionId) => sessionStore.getSkills(sessionId),
  freeze: (sessionId, namesJson) =>
    sessionStore.freezeSkills(sessionId, namesJson),
  resolve: async () => {
    await skillLibraryStore.ensureInitialized();
    const scan = await scanSkillLibrary(skillLibraryStore.root);
    return resolveSkillNames(scan.skills, [getSettings().skills]);
  },
};

/**
 * Read a frozen JSON name list. A malformed row fails closed to an empty list:
 * it is still an existing freeze and must never be replaced from live settings.
 */
export function parseSessionSkills(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isSafeSkillName(item)) return [];
    names.push(item);
  }
  const normalized = [...new Set(names)].sort(compareText);
  if (
    normalized.length !== names.length ||
    normalized.some((name, index) => name !== names[index])
  )
    return [];
  return normalized;
}

/** Read the stored list only. This function never computes or creates a freeze. */
function frozenSessionSkills(sessionId: string): string[] | undefined {
  return parseSessionSkills(sessionStore.getSkills(sessionId));
}

/**
 * SessionState projection for the coding personas. The empty array deliberately
 * covers both an empty freeze and a legacy session not started since upgrade;
 * rendering metadata must not itself freeze live settings.
 */
export function activeSkillsForSession(
  sessionId: string,
  agentType: SessionAgentType,
): string[] | undefined {
  return isCodingAgentType(agentType)
    ? (frozenSessionSkills(sessionId) ?? [])
    : undefined;
}

/**
 * The one coding-session lifecycle seam for library skills.
 *
 * A stored row always wins. Otherwise coding personas resolve the current
 * working-tree scan plus settings and persist that sorted list insert-only.
 * Forks pass the parent's already-frozen list as `preset`. Non-coding personas
 * return empty without reading settings, scanning, or creating a row.
 */
export async function sessionSkills(
  sessionId: string,
  agentType: SessionAgentType,
  preset?: readonly string[],
  deps: SessionSkillsDeps = REAL_DEPS,
): Promise<string[]> {
  if (!isCodingAgentType(agentType)) return [];

  const stored = parseSessionSkills(deps.getFrozen(sessionId));
  if (stored !== undefined) return stored;

  let names: string[];
  if (preset !== undefined) {
    names = normalizePreset(preset);
  } else {
    try {
      names = normalizePreset(await deps.resolve());
    } catch (error) {
      console.warn(
        "Failed to resolve session skills; freezing an empty list:",
        error instanceof Error ? error.message : String(error),
      );
      names = [];
    }
  }

  return (
    parseSessionSkills(deps.freeze(sessionId, JSON.stringify(names))) ?? []
  );
}

function normalizePreset(names: readonly string[]): string[] {
  if (names.some((name) => !isSafeSkillName(name))) return [];
  return [...new Set(names)].sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
