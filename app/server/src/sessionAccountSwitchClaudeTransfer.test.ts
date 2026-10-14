import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "account-transfer-"));
const originalHome = process.env.HOME;
process.env.HOME = join(tmp, "home");
process.env.DATA_DIR = join(tmp, "data");
process.env.ASSISTANT_CWD = tmp;
const profiles = await import("./credentialProfiles.ts");
profiles.listCredentialProfiles();
profiles.setCredentialProfileEnabled(profiles.DEFAULT_CLAUDE_PROFILE_ID, false);
profiles.setCredentialProfileEnabled(profiles.DEFAULT_OPENAI_PROFILE_ID, false);
const { sessionStore } = await import("./db/sessionStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const transfers = await import("./claudeSdk/profileSessionStore.ts");
const { createSession } = await import("./harnesses/create.ts");
const { updateSettings } = await import("./settings.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const lifecycle = await import("./session/runtime/liveSession.ts");
const health = await import("./accountHealth.ts");
await import("./hub.ts");
updateSettings({ claudeSdk: { enabled: true } });
health.initializeAccountHealth({
  broadcast: () => {},
  push: async () => {},
  profiles: profiles.listCredentialProfiles,
  hasCredential: profiles.credentialProfileHasCredential,
  subscribeChanges: profiles.subscribeCredentialProfileChanges,
  subscribeDeleted: profiles.subscribeCredentialProfileDeleted,
});
const tracking = health.trackSessionRunHealth({
  session: sessionStore.get,
  subscribeStarted: lifecycle.subscribeSessionRunStarted,
  subscribeFailed: lifecycle.subscribeSessionRunFailed,
  subscribeClosed: lifecycle.subscribeSessionTurnClosed,
});
afterAll(() => {
  tracking.dispose();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

function account(name: string): string {
  const profile = profiles.createCredentialProfile({
    name,
    provider: "claude",
  });
  writeFileSync(
    join(profiles.claudeConfigDir(profile.id), ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 86400_000,
      },
    }),
  );
  profiles.listCredentialProfiles();
  return profile.id;
}

const internals = claudeSdkStore as unknown as {
  seam: () => Promise<ClaudeSdkSeam>;
};
test.each([
  "stop",
  "deleted",
  "stale-cas",
  "source-cleanup-fails",
  "rollback-fails",
] as const)("Claude move cleanup and delete sweep: %s", async (reason) => {
  const a = account("A");
  const b = account("B");
  const id = randomUUID();
  const nativeId = randomUUID();
  const messageId = randomUUID();
  const from = join(profiles.claudeConfigDir(a), "projects", "test-project");
  const to = join(profiles.claudeConfigDir(b), "projects", "test-project");
  const body = '{"type":"user","message":{"content":"Original request"}}\n';
  mkdirSync(join(from, nativeId, "subagents"), { recursive: true });
  writeFileSync(join(from, `${nativeId}.jsonl`), body);
  writeFileSync(
    join(from, nativeId, "subagents", "child.jsonl"),
    "Full child history\n",
  );
  let queries = 0;
  const seam: ClaudeSdkSeam = {
    query: () => {
      queries++;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: nativeId,
            uuid: randomUUID(),
          } as ClaudeSdkMessage;
          yield {
            type: "stream_event",
            session_id: nativeId,
            uuid: randomUUID(),
            parent_tool_use_id: null,
            event: { type: "message_start", message: { id: messageId } },
          } as unknown as ClaudeSdkMessage;
          yield {
            type: "assistant",
            session_id: nativeId,
            uuid: randomUUID(),
            message: {
              id: messageId,
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Usage limit reached" }],
            },
            error: "rate_limit",
          } as unknown as ClaudeSdkMessage;
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            session_id: nativeId,
            uuid: randomUUID(),
            errors: ["Usage limit reached"],
            api_error_status: 429,
            total_cost_usd: 0,
            modelUsage: {},
          } as unknown as ClaudeSdkMessage;
        },
      };
    },
  };
  const factory = vi.spyOn(internals, "seam").mockResolvedValue(seam);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const copy = transfers.copyClaudeSessionForAccount;
  let release!: () => void;
  let copied = false;
  const gate = vi
    .spyOn(transfers, "copyClaudeSessionForAccount")
    .mockImplementation(async (...args) => {
      const transfer = await copy(...args);
      copied = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const fail = async () => {
        throw new Error("private transcript content at /secret/transcript");
      };
      return {
        commit: reason === "source-cleanup-fails" ? fail : transfer.commit,
        rollback: reason === "rollback-fails" ? fail : transfer.rollback,
      };
    });
  try {
    const live = await createSession({
      harness: "claude-sdk",
      id,
      agentType: "assistant",
      credentialProfileId: a,
      modelId: "sonnet",
      thinkingLevel: "medium",
    });
    const sent = promptRuntimeSessionWithRuntime(
      sessionRuntime,
      live,
      "Original request",
    ).catch(() => {});
    await vi.waitFor(() => assert.ok(copied));
    assert.ok(existsSync(join(to, `${nativeId}.jsonl`)));
    const { runClearForHost, runCompactForHost } =
      await import("./hostSlashCommands.ts");
    const host =
      live as import("./claudeSdk/ClaudeSdkSession.ts").ClaudeSdkSession;
    await assert.rejects(runClearForHost(host), {
      name: "AccountSwitchInProgressError",
    });
    await assert.rejects(runCompactForHost(host, ""), {
      name: "AccountSwitchInProgressError",
    });
    if (reason === "stop" || reason === "rollback-fails")
      await sessionRuntime.get(id)!.abort();
    else if (reason === "deleted") sessionStore.remove(id);
    else if (reason === "stale-cas")
      sessionStore.switchCredentialProfile(id, a, b);
    release();
    await sent;
    assert.equal(
      live.credentialProfileId,
      reason === "source-cleanup-fails" ? b : a,
    );
    assert.equal(queries, reason === "source-cleanup-fails" ? 2 : 1);
    assert.equal(readFileSync(join(from, `${nativeId}.jsonl`), "utf8"), body);
    assert.ok(existsSync(join(from, nativeId, "subagents", "child.jsonl")));
    const leftover =
      reason === "source-cleanup-fails" || reason === "rollback-fails";
    assert.equal(existsSync(join(to, `${nativeId}.jsonl`)), leftover);
    assert.equal(existsSync(join(to, nativeId)), leftover);
    if (leftover) {
      const warnings = warn.mock.calls.flat().join(" ");
      assert.ok(
        warnings.includes(
          reason === "source-cleanup-fails"
            ? "source cleanup"
            : "destination rollback",
        ),
      );
      assert.ok(
        !warnings.includes("/secret") &&
          !warnings.includes("private transcript content"),
      );
      const other = account("Disabled leftover");
      profiles.setCredentialProfileEnabled(other, false);
      const extra = join(
        profiles.claudeConfigDir(other),
        "projects",
        "other-project",
      );
      mkdirSync(join(extra, nativeId, "subagents"), { recursive: true });
      writeFileSync(join(extra, `${nativeId}.jsonl`), body);
      writeFileSync(
        join(extra, nativeId, "subagents", "leftover.jsonl"),
        "leftover\n",
      );
      writeFileSync(join(extra, "unrelated.jsonl"), "keep\n");
      const legacy = join(
        profiles.claudeConfigDir(profiles.DEFAULT_CLAUDE_PROFILE_ID),
        "projects",
        "legacy-project",
      );
      mkdirSync(join(legacy, nativeId, "subagents"), { recursive: true });
      writeFileSync(join(legacy, `${nativeId}.jsonl`), body);
      writeFileSync(
        join(legacy, nativeId, "subagents", "legacy.jsonl"),
        "legacy\n",
      );
      seam.deleteSession = async () => {
        throw new Error("private transcript content at /secret/sdk-delete");
      };
      claudeSdkStore.remove(id);
      await vi.waitFor(() => {
        for (const base of [from, to, extra, legacy]) {
          assert.equal(existsSync(join(base, `${nativeId}.jsonl`)), false);
          assert.equal(existsSync(join(base, nativeId)), false);
        }
      });
      assert.equal(
        readFileSync(join(extra, "unrelated.jsonl"), "utf8"),
        "keep\n",
      );
      const deletionWarnings = warn.mock.calls.flat().join(" ");
      assert.ok(deletionWarnings.includes("Native session deletion failed"));
      assert.ok(
        !deletionWarnings.includes("/secret") &&
          !deletionWarnings.includes("private transcript content"),
      );
    }
  } finally {
    release?.();
    gate.mockRestore();
    warn.mockRestore();
    factory.mockRestore();
    await sessionRuntime.disposeSession(id);
    claudeSdkStore.remove(id);
    profiles.setCredentialProfileEnabled(a, false);
    profiles.setCredentialProfileEnabled(b, false);
  }
});

test.each([false, true])(
  "Claude refuses failover when login setup fails before native init; after clear=%s",
  async (afterClear) => {
    const a = account("No init A");
    const b = account("No init B");
    const id = randomUUID();
    let queries = 0;
    const factory = vi.spyOn(internals, "seam").mockResolvedValue({
      query: () => {
        queries++;
        if (afterClear && queries === 1)
          return {
            async *[Symbol.asyncIterator]() {
              const nativeId = randomUUID();
              yield {
                type: "system",
                subtype: "init",
                session_id: nativeId,
                uuid: randomUUID(),
              } as ClaudeSdkMessage;
              yield {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: nativeId,
                uuid: randomUUID(),
                total_cost_usd: 0,
                modelUsage: {},
              } as unknown as ClaudeSdkMessage;
            },
          };
        throw Object.assign(new Error("OAuth token expired"), { status: 401 });
      },
    });
    try {
      const live = await createSession({
        harness: "claude-sdk",
        id,
        agentType: "assistant",
        credentialProfileId: a,
        modelId: "sonnet",
        thinkingLevel: "medium",
      });
      if (afterClear) {
        await promptRuntimeSessionWithRuntime(
          sessionRuntime,
          live,
          "An earlier turn",
        );
        const { runClearForHost } = await import("./hostSlashCommands.ts");
        await runClearForHost(
          live as import("./claudeSdk/ClaudeSdkSession.ts").ClaudeSdkSession,
        );
      }
      await assert.rejects(
        promptRuntimeSessionWithRuntime(
          sessionRuntime,
          live,
          "Do not lose this request",
        ),
      );
      assert.equal(queries, afterClear ? 2 : 1);
      assert.equal(live.credentialProfileId, a);
      assert.equal(sessionStore.get(id)?.credentialProfileId, a);
      const timeline = sessionRuntime.get(id)!.clientTimeline();
      assert.ok(JSON.stringify(timeline).includes("could not safely resume"));
      assert.equal(
        timeline.filter(
          (entry) => entry.type === "message" && entry.role === "user",
        ).length,
        afterClear ? 2 : 1,
      );
    } finally {
      factory.mockRestore();
      await sessionRuntime.disposeSession(id);
      claudeSdkStore.remove(id);
      profiles.setCredentialProfileEnabled(a, false);
      profiles.setCredentialProfileEnabled(b, false);
    }
  },
);
