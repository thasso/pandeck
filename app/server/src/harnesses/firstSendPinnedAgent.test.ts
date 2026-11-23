/**
 * A browser first send of a pinned definition on a runtime the user picked
 * (`docs/agent-definitions.md`, pinned versions): the definition's listed pin
 * for that runtime decides the account BEFORE Automatic picks one, through
 * the real router. `firstSendAccountRouting.test.ts` mocks the router, so this
 * case lives here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "first-send-pinned-agent-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const {
  claudeConfigDir,
  createCredentialProfile,
  listCredentialProfiles,
  setCredentialProfileEnabled,
} = await import("../credentialProfiles.ts");
const { firstSendEngine } = await import("./firstSend.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./claudeAccountModels.ts");
const { reportAccountRunFailure, readAccountBench } =
  await import("../accountHealth.ts");
const { agentLibraryStore, formatAgentManifest } =
  await import("../agents/agentLibrary.ts");
const { sessionAgent } = await import("../agents/sessionAgent.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { getSettings, updateSettings } = await import("../settings.ts");
const { Y } = await import("../test/claudeListings.ts");
await import("../hub.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A healthy Claude account: a fake credential file, no real login. */
function healthyClaude(name: string): string {
  const profile = createCredentialProfile({ name, provider: "claude" });
  mkdirSync(claudeConfigDir(profile.id), { recursive: true });
  writeFileSync(
    join(claudeConfigDir(profile.id), ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  return profile.id;
}

/** A definition listing fable pinned to 5-2 at high effort. */
async function writePinnedDefinition(): Promise<void> {
  await agentLibraryStore.ensureInitialized();
  const folder = join(agentLibraryStore.root, "pinned-fable");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "AGENT.md"),
    formatAgentManifest({
      name: "pinned-fable",
      description: "Runs only on the newest fable.",
      persona: "assistant",
      models: ["claude-fable-5-2"],
      effort: "high",
      denyTools: [],
      skills: [],
      body: "You review.",
    } as never),
  );
}

const send = (id: string, thinkingLevel: "high" | "medium") => ({
  type: "harnessSend" as const,
  harness: "claude-sdk" as const,
  id,
  agentType: "assistant" as const,
  text: "hello",
  agent: "pinned-fable",
  modelProvider: "claude-sdk",
  modelId: "fable",
  thinkingLevel,
});

let sequence = 0;

test.each(["x-first", "y-first"] as const)(
  "a picked listed runtime carries its pin into Automatic: benched X over healthy Y (%s)",
  async (order) => {
    for (const profile of listCredentialProfiles())
      if (profile.provider === "claude" && profile.enabled)
        setCredentialProfileEnabled(profile.id, false);
    const before = getSettings().claudeSdk;
    updateSettings({ claudeSdk: { ...before, enabled: true } });
    const ids: string[] = [];
    const created: string[] = [];
    try {
      const [x, y] =
        order === "x-first"
          ? (() => {
              const x = healthyClaude(`X ${order}`);
              return [x, healthyClaude(`Y ${order}`)];
            })()
          : (() => {
              const y = healthyClaude(`Y ${order}`);
              return [healthyClaude(`X ${order}`), y];
            })();
      ids.push(x!, y!);
      // X is never read (unknown): 5-2 is a fable candidate it may run.
      resetClaudeAccountModelsForTests({
        read: async (id) => (id === y ? [...Y] : undefined),
      });
      await writePinnedDefinition();
      // X is entitled but benched on a quota failure; Y is healthy.
      reportAccountRunFailure(
        x!,
        { kind: "quota", resetAtMs: Date.now() + 3_600_000 },
        "claude-sdk",
      );
      assert.ok(readAccountBench(x!, ""), "X is benched");

      const engine = firstSendEngine("claude-sdk");
      const pinnedSend = send(`pinned-${order}-${sequence++}`, "high");
      const admission = await engine.account(pinnedSend);
      assert.deepEqual(admission, { profileId: x });
      const prepared = await engine.prepare(pinnedSend, x!);
      assert.ok("create" in prepared, "prepare succeeds on X");
      const started = await prepared.create({
        worktree: null,
        evidence: { hasAttachments: false },
      });
      assert.ok("live" in started);
      created.push(pinnedSend.id);
      assert.equal(
        sessionAgent(pinnedSend.id)?.pinnedModel,
        "claude-fable-5-2",
      );

      // Control: a runtime no listed model matches (another effort) is the
      // user's own choice, unpinned, and routes to the healthy account.
      const unpinned = await engine.account(
        send(`unpinned-${order}-${sequence++}`, "medium"),
      );
      assert.deepEqual(unpinned, { profileId: y });
    } finally {
      for (const id of created)
        await sessionRuntime.disposeSession(id).catch(() => undefined);
      for (const id of ids) setCredentialProfileEnabled(id, false);
      updateSettings({ claudeSdk: before });
      resetClaudeAccountModelsForTests();
    }
  },
);
