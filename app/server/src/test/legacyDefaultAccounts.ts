/**
 * An install from before Pandeck stopped making default accounts: its registry
 * holds "Default OpenAI" (`default`) and "Default Claude" (`claude-default`),
 * written as that version wrote them (`docs/account-routing.md`). Nothing in
 * the app creates them any more, so a test of their behaviour seeds them here.
 *
 * The registry path is read when this runs, so DATA_DIR set by the test file
 * before its imports applies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LEGACY_DEFAULT_OPENAI_ID = "default";
const LEGACY_DEFAULT_CLAUDE_ID = "claude-default";

/** Add whichever default record is missing to the registry. */
export async function seedLegacyDefaultAccounts(
  which: { openai?: boolean; claude?: boolean } = {},
): Promise<void> {
  const { CREDENTIAL_PROFILES_ROOT } =
    await import("../credentialProfilePaths.ts");
  const registry = join(CREDENTIAL_PROFILES_ROOT, "profiles.json");
  const profiles = existsSync(registry)
    ? (JSON.parse(readFileSync(registry, "utf8")) as Array<{ id: string }>)
    : [];
  const now = Date.now();
  const wanted = [
    ...(which.openai !== false
      ? [
          {
            id: LEGACY_DEFAULT_OPENAI_ID,
            name: "Default OpenAI",
            provider: "openai-codex",
          },
        ]
      : []),
    ...(which.claude !== false
      ? [
          {
            id: LEGACY_DEFAULT_CLAUDE_ID,
            name: "Default Claude",
            provider: "claude",
          },
        ]
      : []),
  ];
  let changed = false;
  for (const [index, profile] of wanted.entries()) {
    if (profiles.some((existing) => existing.id === profile.id)) continue;
    const record = {
      ...profile,
      enabled: true,
      enterprise: false,
      createdAt: now - 1000 + index,
      updatedAt: now - 1000 + index,
    };
    // The old code put Default OpenAI first and appended Default Claude.
    if (profile.id === LEGACY_DEFAULT_OPENAI_ID) profiles.unshift(record);
    else profiles.push(record);
    changed = true;
  }
  if (!changed) return;
  mkdirSync(CREDENTIAL_PROFILES_ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(registry, `${JSON.stringify(profiles, null, 2)}\n`, {
    mode: 0o600,
  });
}
