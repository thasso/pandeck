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
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type {
  ClaudeSdkSeam,
  ClaudeQueryParams,
  ClaudeSdkMessage,
} from "./claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "account-switch-engines-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const profiles = await import("./credentialProfiles.ts");
// Protected defaults may point at real host credentials. Never select them in a fake-provider test.
profiles.listCredentialProfiles();
profiles.setCredentialProfileEnabled(profiles.DEFAULT_CLAUDE_PROFILE_ID, false);
profiles.setCredentialProfileEnabled(profiles.DEFAULT_OPENAI_PROFILE_ID, false);
const { sessionStore } = await import("./db/sessionStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { piModelForAccount } = await import("./harnesses/models.ts");
const { createSession } = await import("./harnesses/create.ts");
const { updateSettings, getSettings } = await import("./settings.ts");
updateSettings({ claudeSdk: { enabled: true } });
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const lifecycle = await import("./session/runtime/liveSession.ts");
const health = await import("./accountHealth.ts");
await import("./hub.ts");
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
  rmSync(tmp, { recursive: true, force: true });
});

function account(provider: "claude" | "openai-codex", name: string) {
  const p = profiles.createCredentialProfile({ provider, name });
  if (provider === "openai-codex")
    writeFileSync(
      join(profiles.piAgentDir(p.id), "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "test-token",
          refresh: "test-refresh",
          expires: Date.now() + 86400_000,
        },
      }),
    );
  else
    writeFileSync(
      join(profiles.claudeConfigDir(p.id), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-token",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 86400_000,
        },
      }),
    );
  profiles.listCredentialProfiles();
  return p.id;
}

test.each([
  "normal",
  "encrypted",
  "admission",
  "peer-switch",
  "background",
  "plan-to-build",
  "build-to-plan",
  "rename-during-reopen",
] as const)(
  "real pi store preserves native history/SDK settlement across switching: %s",
  async (mode) => {
    const encryptedRejection = mode === "encrypted";
    const modeFlip = mode === "plan-to-build" || mode === "build-to-plan";
    const initialMode = mode === "plan-to-build" ? "plan" : "build";
    const targetMode = mode === "plan-to-build" ? "build" : "plan";
    let staged = false;
    let renameDuringReopen: (() => void) | undefined;
    const extraTurns = mode === "admission" ? 3 : 0;
    const cleanup: (() => void)[] = [];
    let releaseMove: (() => void) | undefined;
    const a = account("openai-codex", "Pi A");
    const b = account("openai-codex", "Pi B");
    const calls: {
      profile: string;
      context: Context;
      activeTools: string[];
    }[] = [];
    const opens: { profile: string; session: AgentSession }[] = [];
    const internals = piStore as unknown as {
      create: (...args: unknown[]) => Promise<{
        session: AgentSession;
        notices: unknown[];
        commit: () => void;
        dispose: () => void;
      }>;
    };
    const original = internals.create.bind(piStore);
    const factory = vi
      .spyOn(internals, "create")
      .mockImplementation(async (...args) => {
        const opened = await original(...args);
        const profile = args[5] as string;
        opens.push({ profile, session: opened.session });
        opened.session.setAutoRetryEnabled(false);
        opened.session.agent.streamFunction = (model, context) => {
          calls.push({
            profile,
            context: structuredClone(context),
            activeTools: opened.session.getActiveToolNames(),
          });
          const rejectedReasoning =
            encryptedRejection &&
            profile === b &&
            calls.filter((call) => call.profile === b).length === 1;
          const failure = profile === a || rejectedReasoning;
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              { type: "text", text: failure ? "" : "Recovered answer" },
            ],
            stopReason: failure ? "error" : "stop",
            ...(failure
              ? {
                  errorMessage: rejectedReasoning
                    ? "invalid_encrypted_content"
                    : "Usage limit reached",
                }
              : {}),
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            if (!failure) {
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta: "Recovered answer",
                partial: message,
              });
            }
            stream.push(
              failure
                ? { type: "error", reason: "error", error: message }
                : { type: "done", reason: "stop", message },
            );
            stream.end();
          });
          return stream;
        };
        if (profile === b && args[8] === true) renameDuringReopen?.();
        if (modeFlip && profile === b && args[8] === true) {
          staged = true;
          await new Promise<void>((resolve) => {
            releaseMove = resolve;
          });
        }
        return opened;
      });
    const runtime = sessionRuntime;
    let id: string | undefined;
    let childId: string | undefined;
    const continuationForks: string[] = [];
    try {
      const live = await createSession({
        harness: "pi",
        agentType: modeFlip ? "developer" : "assistant",
        mode: initialMode,
        credentialProfileId: a,
        model: await piModelForAccount(a, "openai-codex", "gpt-5.5"),
        thinkingLevel: "off",
        title: "Existing session",
      });
      id = live.id;
      const file = live.sessionFile!;
      const pi = live as import("./piSdk/PiLiveSession.ts").PiLiveSession;
      const old = pi.session;
      if (mode === "rename-during-reopen") {
        renameDuringReopen = () => pi.rename("Named while reopening");
      }
      let backgroundPid: number | undefined;
      if (mode === "background") {
        const { createPiBackgroundTools } =
          await import("./piSdk/backgroundWorkBackend.ts");
        updateSettings({
          backgroundWork: { ...getSettings().backgroundWork, enabled: true },
        });
        const toolSession = {
          sessionId: id,
          harness: "pi" as const,
          agentType: "developer" as const,
          cwd: tmp,
        };
        const bash = createPiBackgroundTools({
          session: () => toolSession,
          identity: () => ({ sessionId: id!, sessionFile: file }),
        })[0]!;
        const marker = join(tmp, `background-pid-${id}`);
        await bash.execute(
          {
            command: `printf '%s' "$$" > ${JSON.stringify(marker)}; sleep 300`,
            run_in_background: true,
          },
          { toolCallId: `switch-background-${id}`, session: toolSession },
        );
        await vi.waitFor(() => assert.ok(existsSync(marker)));
        backgroundPid = Number(readFileSync(marker, "utf8"));
        process.kill(backgroundPid, 0);
      }
      const history: AssistantMessage = {
        role: "assistant",
        api: old.model!.api,
        provider: "openai-codex",
        model: "gpt-5.5",
        timestamp: Date.now(),
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "private reasoning",
            thinkingSignature: "opaque-encrypted-reasoning",
          },
          { type: "text", text: "Earlier answer" },
          {
            type: "toolCall",
            id: "old-tool",
            name: "Read",
            arguments: { file_path: "earlier.txt" },
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      old.sessionManager.appendMessage({
        role: "user",
        content: "Earlier question",
        timestamp: Date.now(),
      });
      old.sessionManager.appendMessage(history);
      old.sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "old-tool",
        toolName: "Read",
        content: [{ type: "text", text: "Earlier tool result" }],
        isError: false,
        timestamp: Date.now(),
      });
      if (encryptedRejection) {
        for (const toolCall of [false, true]) {
          const omitted = old.sessionManager.appendMessage({
            ...history,
            stopReason: "error",
            content: [
              {
                type: "thinking",
                thinking: "abandoned thinking",
                thinkingSignature: "omitted-signed-reasoning",
              },
              { type: "text", text: "Omitted retry attempt" },
              ...(toolCall
                ? [
                    {
                      type: "toolCall" as const,
                      id: "omitted-call",
                      name: "Read",
                      arguments: { file_path: "omitted.txt" },
                    },
                  ]
                : []),
            ],
          });
          old.sessionManager.appendContextEdit(omitted, null);
          if (toolCall) {
            const result = old.sessionManager.appendMessage({
              role: "toolResult",
              toolCallId: "omitted-call",
              toolName: "Read",
              content: [{ type: "text", text: "Omitted retry result" }],
              isError: false,
              timestamp: Date.now(),
            });
            old.sessionManager.appendContextEdit(result, null);
          }
        }
        const edited = old.sessionManager.appendMessage({
          ...history,
          stopReason: "stop",
          content: [
            {
              type: "thinking",
              thinking: "edited thinking",
              thinkingSignature: "edited-signature",
            },
            { type: "text", text: "Raw pre-edit answer" },
          ],
        });
        old.sessionManager.appendContextEdit(edited, {
          content: [
            {
              type: "thinking",
              thinking: "edited thinking",
              thinkingSignature: "edited-signature",
            },
            { type: "text", text: "Current edited answer" },
          ],
        });
      }
      const peer = await import("./peerPrompt.ts");
      const { peerPromptStore } = await import("./db/peerPromptStore.ts");
      let sender: string | undefined;
      if (mode === "admission" || mode === "peer-switch") {
        let moving = false;
        const originalSwitch = pi.switchAccount.bind(pi);
        const move = vi
          .spyOn(pi, "switchAccount")
          .mockImplementation(async (next, admit) => {
            moving = true;
            await new Promise<void>((resolve) => {
              releaseMove = resolve;
            });
            return originalSwitch(next, admit);
          });
        cleanup.push(() => move.mockRestore());
        peer.setPeerPromptAutoDeliverForTests(false);
        cleanup.push(() => peer.setPeerPromptAutoDeliverForTests(true));
        const uninstallNotices = peer.installDelegationFailureNotices();
        cleanup.push(uninstallNotices);
        sender = randomUUID();
        sessionStore.upsert({
          id: sender,
          harness: "pi",
          agentType: "assistant",
          title: "Peer sender",
        });
        const first =
          mode === "peer-switch"
            ? await peer.sendPeerPrompt({
                senderSessionId: sender,
                targetSessionId: id,
                prompt: "Keep the original question",
                responseRequested: true,
              })
            : undefined;
        const sent = first
          ? peer.drainRecipient(id)
          : promptRuntimeSessionWithRuntime(
              runtime,
              live,
              "Keep the original question",
            );
        await vi.waitFor(() => assert.ok(moving));
        if (first)
          assert.equal(
            peerPromptStore.getById(first.message.id)?.status,
            "acknowledged",
          );
        const { runClearForHost, runCompactForHost } =
          await import("./hostSlashCommands.ts");
        const leaf = pi.session.sessionManager.getLeafId();
        await assert.rejects(pi.acceptCommitDryRun("not-an-entry"), {
          name: "AccountSwitchInProgressError",
        });
        await assert.rejects(runClearForHost(pi), {
          name: "AccountSwitchInProgressError",
        });
        await assert.rejects(runCompactForHost(pi, ""), {
          name: "AccountSwitchInProgressError",
        });
        assert.equal(pi.session.sessionManager.getLeafId(), leaf);
        if (mode === "admission") {
          const queue = await import("./promptQueue.ts");
          const { promptQueueStore } = await import("./db/promptQueueStore.ts");
          const handoffs = await import("./agentHandoffs.ts");
          const { agentHandoffStore } =
            await import("./db/agentHandoffStore.ts");
          queue.setPromptQueueHost({
            resolve: async () => pi as never,
            live: () => pi as never,
            publish: () => {},
            reportError: () => assert.fail("queue must not pause on recovery"),
            yieldToOthers: () => {},
          });
          cleanup.push(() => queue.setPromptQueueHost(undefined));
          queue.queuePrompt(id, { text: "Queued user input" });
          await queue.drainPromptQueue(id);
          assert.equal(promptQueueStore.state(id).items.length, 1);
          assert.equal(promptQueueStore.state(id).paused, false);
          const waiting = await peer.sendPeerPrompt({
            senderSessionId: sender,
            targetSessionId: id,
            prompt: "Waiting peer input",
            responseRequested: false,
          });
          await peer.drainRecipient(id);
          assert.equal(
            peerPromptStore.getById(waiting.message.id)?.attempts,
            0,
          );
          assert.equal(
            peerPromptStore.getById(waiting.message.id)?.status,
            "queued",
          );
          assert.equal(
            await handoffs.deliverAgentHandoff({
              sessionId: id,
              driver: pi,
              text: "Waiting handoff",
              origin: { kind: "system", source: "review-outcome" },
            }),
            "queued",
          );
          assert.equal(agentHandoffStore.listForSession(id)[0]?.attempts, 0);
          lifecycle.setSessionIdleHook((sid) => {
            void queue.drainPromptQueue(sid);
            void peer.drainRecipient(sid);
            void handoffs.drainAgentHandoffs(sid);
          });
          cleanup.push(() => lifecycle.setSessionIdleHook(undefined));
          releaseMove!();
          await sent;
          await vi.waitFor(() => {
            assert.equal(promptQueueStore.state(id!).items.length, 0);
            assert.equal(promptQueueStore.state(id!).paused, false);
            assert.equal(
              peerPromptStore.getById(waiting.message.id)?.status,
              "completed",
            );
            assert.equal(agentHandoffStore.listForSession(id!).length, 0);
          });
        } else {
          releaseMove!();
          await sent;
          const settled = peerPromptStore.getById(first!.message.id)!;
          assert.equal(settled.status, "awaiting_response");
          assert.equal(settled.interruptionKind, undefined);
          assert.equal(settled.failureReason, undefined);
        }
      } else if (modeFlip) {
        const sent = promptRuntimeSessionWithRuntime(
          runtime,
          live,
          "Keep the original question",
        );
        await vi.waitFor(() => assert.ok(staged));
        const replacement = opens.at(-1)!.session;
        for (const name of ["edit", "write"])
          assert.equal(
            replacement.getActiveToolNames().includes(name),
            initialMode === "build",
          );
        pi.setMode(targetMode);
        for (const name of ["edit", "write"])
          assert.equal(
            old.getActiveToolNames().includes(name),
            targetMode === "build",
          );
        releaseMove!();
        await sent;
        assert.equal(pi.sessionMode, targetMode);
        assert.equal(sessionStore.get(id)?.mode, targetMode);
        for (const name of ["edit", "write"]) {
          assert.equal(
            replacement.getActiveToolNames().includes(name),
            targetMode === "build",
          );
          assert.equal(
            calls.at(-1)!.activeTools.includes(name),
            targetMode === "build",
          );
        }
      } else if (mode === "rename-during-reopen") {
        await assert.rejects(
          promptRuntimeSessionWithRuntime(
            runtime,
            live,
            "Keep the original question",
          ),
        );
        assert.equal(
          calls.length,
          1,
          "stale replacement never runs a continuation",
        );
        assert.equal(pi.session, old);
        assert.equal(live.credentialProfileId, a);
        assert.equal(sessionStore.get(id)?.credentialProfileId, a);
        assert.notEqual(
          old.sessionManager.getLeafId(),
          opens.at(-1)!.session.sessionManager.getLeafId(),
        );
        assert.equal(
          old.sessionManager.getSessionName(),
          "Named while reopening",
        );
        assert.ok(readFileSync(file, "utf8").includes("Named while reopening"));
        const timeline = JSON.stringify(runtime.get(id)!.clientTimeline());
        assert.ok(
          timeline.includes(
            "The account switch could not safely resume this session",
          ),
        );
        assert.ok(!timeline.includes("Switched from"));
        return;
      } else
        await promptRuntimeSessionWithRuntime(
          runtime,
          live,
          "Keep the original question",
        );
      await vi.waitFor(() =>
        assert.equal(calls.length, (encryptedRejection ? 3 : 2) + extraTurns),
      );
      await vi.waitFor(() => assert.equal(live.isRunning, false));
      assert.equal(live.credentialProfileId, b);
      assert.equal(sessionStore.get(id)?.credentialProfileId, b);
      assert.equal(live.sessionFile, file);
      assert.equal(pi.session.sessionId, old.sessionId);
      assert.notEqual(
        pi.session,
        old,
        "engine and its account registry reopened, wrapper retained",
      );
      assert.deepEqual(
        opens.map((o) => o.profile),
        [a, b],
      );
      assert.ok(
        JSON.stringify(calls[1]!.context).includes(
          "Keep the original question",
        ),
      );
      assert.ok(!JSON.stringify(calls[1]!.context).includes("Switched from"));
      assert.ok(
        JSON.stringify(calls[1]!.context).includes(
          "opaque-encrypted-reasoning",
        ),
        "signed reasoning is not dropped preemptively",
      );
      const finalContext = JSON.stringify(calls.at(-1)!.context);
      assert.ok(
        finalContext.includes("Earlier answer") &&
          finalContext.includes("Earlier tool result") &&
          finalContext.includes("old-tool"),
      );
      assert.equal(
        finalContext.includes("opaque-encrypted-reasoning"),
        !encryptedRejection,
      );
      if (encryptedRejection) {
        for (const omitted of [
          "Omitted retry attempt",
          "Omitted retry result",
          "omitted-call",
          "Raw pre-edit answer",
        ]) {
          assert.ok(
            !finalContext.includes(omitted),
            `fallback preserves existing omission/edit: ${omitted}`,
          );
        }
        assert.ok(
          finalContext.includes("Current edited answer"),
          "fallback filters current projected content",
        );
        const physical = readFileSync(file, "utf8");
        assert.ok(
          physical.includes("Omitted retry attempt") &&
            physical.includes("omitted-call"),
          "omitted physical history remains append-only",
        );
      }
      assert.deepEqual(
        calls.map((call) => call.profile),
        encryptedRejection
          ? [a, b, b]
          : [a, b, ...Array.from({ length: extraTurns }, () => b)],
      );
      assert.ok(
        readFileSync(file, "utf8").includes("opaque-encrypted-reasoning"),
        "physical history stays intact even on fallback",
      );
      const native = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              message?: { role?: string };
              customType?: string;
              display?: boolean;
            },
        );
      assert.equal(
        native.filter((e) => e.type === "message" && e.message?.role === "user")
          .length,
        2 + extraTurns,
      );
      assert.ok(
        native.some(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "account-continuation" &&
            !e.display,
        ),
      );
      assert.equal(
        runtime
          .get(id)!
          .getSnapshot()
          .entries.filter((e) => e.type === "message" && e.role === "user")
          .length,
        1 + extraTurns,
      );
      assert.ok(health.readAccountBench(a, "gpt-5.5"));
      const nativeUser = pi.session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes(
              "Keep the original question",
            ),
        );
      assert.ok(nativeUser);
      const appUser = runtime
        .get(id)!
        .clientTimeline()
        .find((entry) => entry.type === "message" && entry.role === "user");
      assert.ok(appUser);
      const child = await piStore.forkSession(
        "assistant",
        file,
        nativeUser.id,
        "at",
        appUser.id,
      );
      childId = child.id;
      assert.equal(
        child.credentialProfileId,
        b,
        "a historical fork inherits the current account, not the original one",
      );
      assert.equal(sessionStore.get(child.id)?.credentialProfileId, b);
      if (mode === "normal" || mode === "encrypted") {
        const recovered = runtime
          .get(id)!
          .clientTimeline()
          .findLast(
            (entry) => entry.type === "message" && entry.role === "assistant",
          );
        assert.ok(recovered);
        const anchors = runtime.forkAnchors(id, recovered.id);
        assert.ok(
          anchors.ownTurnEnd,
          "recovered reply has a terminal fork anchor",
        );
        const recoveredFork = await piStore.forkSession(
          "assistant",
          file,
          anchors.ownTurnEnd,
          "at",
          recovered.id,
        );
        continuationForks.push(recoveredFork.id);
        assert.ok(
          JSON.stringify(recoveredFork.session.messages).includes(
            "Recovered answer",
          ),
        );
        const copied = runtime.forkLog(id, recoveredFork.id, recovered.id);
        assert.ok(JSON.stringify(copied).includes("Recovered answer"));
        await promptRuntimeSessionWithRuntime(
          runtime,
          live,
          "Next user question",
        );
        if (encryptedRejection) {
          const laterContext = JSON.stringify(calls.at(-1)!.context);
          assert.ok(!laterContext.includes("Omitted retry attempt"));
          assert.ok(!laterContext.includes("omitted-call"));
          assert.ok(!laterContext.includes("Raw pre-edit answer"));
          assert.ok(laterContext.includes("Current edited answer"));
        }
        const nextUser = runtime
          .get(id)!
          .clientTimeline()
          .findLast(
            (entry) => entry.type === "message" && entry.role === "user",
          );
        assert.ok(nextUser);
        const nextAnchors = runtime.forkAnchors(id, nextUser.id);
        assert.equal(nextAnchors.previous, anchors.ownTurnEnd);
        assert.equal(
          nextAnchors.previousEntryId,
          recovered.id,
          "fork before next prompt keeps recovered reply",
        );
        assert.ok(nextAnchors.own);
        const beforeFork = await piStore.forkSession(
          "assistant",
          file,
          nextAnchors.own,
          "before",
          nextUser.id,
        );
        continuationForks.push(beforeFork.id);
        assert.ok(
          JSON.stringify(beforeFork.session.messages).includes(
            "Recovered answer",
          ),
        );
        assert.ok(
          !JSON.stringify(beforeFork.session.messages).includes(
            "Next user question",
          ),
        );
        const beforeLog = runtime.forkLog(
          id,
          beforeFork.id,
          nextAnchors.previousEntryId,
        );
        assert.ok(JSON.stringify(beforeLog).includes("Recovered answer"));
        assert.ok(!JSON.stringify(beforeLog).includes("Next user question"));
      }
      if (backgroundPid) {
        process.kill(backgroundPid, 0);
        const { backgroundWorkStore } =
          await import("./db/backgroundWorkStore.ts");
        assert.equal(
          backgroundWorkStore.listItems({ ownerSessionId: id, state: "active" })
            .length,
          1,
        );
      }
    } finally {
      if (mode === "background" && id) {
        const { backgroundWorkSupervisor } =
          await import("./backgroundWork/supervisor.ts");
        await backgroundWorkSupervisor.stopAllOwner({
          ownerSessionId: id,
          sourceRequestId: "switch-test-cleanup",
          reason: "test cleanup",
        });
      }
      releaseMove?.();
      for (const dispose of cleanup.reverse()) dispose();
      factory.mockRestore();
      if (childId) piStore.evict(childId);
      for (const child of continuationForks) piStore.evict(child);
      if (id) {
        await runtime.disposeSession(id);
        piStore.evict(id);
      }
      profiles.setCredentialProfileEnabled(a, false);
      profiles.setCredentialProfileEnabled(b, false);
    }
  },
);

test("pi staging keeps live tool exposure and pruning on refusal, then transfers them on commit", async () => {
  const {
    toolExposureForSession,
    prepareToolsForUserTurn,
    UNUSED_TOOL_PRUNE_IDLE_MS,
  } = await import("./piSdk/toolActivation.ts");
  const { sessionToolExposure } =
    await import("./tools/sessionToolExposure.ts");
  const a = account("openai-codex", "Exposure A");
  const b = account("openai-codex", "Exposure B");
  const live = await createSession({
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: a,
    model: await piModelForAccount(a, "openai-codex", "gpt-5.5"),
    thinkingLevel: "off",
  });
  const pi = live as import("./piSdk/PiLiveSession.ts").PiLiveSession;
  const internals = piStore as unknown as {
    toolRuntimes: Map<
      string,
      import("./piSdk/toolActivation.ts").PiToolActivation
    >;
    create: (...args: unknown[]) => Promise<{
      session: AgentSession;
      commit: () => void;
      dispose: () => void;
    }>;
  };
  const old = pi.session;
  // A native transcript must have a persisted conversation to reopen its id.
  old.sessionManager.appendMessage({
    role: "user",
    content: "Existing question",
    timestamp: Date.now(),
  });
  old.sessionManager.appendMessage({
    role: "assistant",
    api: old.model!.api,
    provider: old.model!.provider,
    model: old.model!.id,
    content: [{ type: "text", text: "Existing answer" }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const previous = internals.toolRuntimes.get(live.id)!;
  previous.initialize(["kb_read"]);
  const exposure = previous.exposure();
  let staged: AgentSession | undefined;
  let release: (() => void) | undefined;
  const create = internals.create.bind(piStore);
  const factory = vi
    .spyOn(internals, "create")
    .mockImplementation(async (...args) => {
      const replacement = await create(...args);
      if (args[8] === true) {
        staged = replacement.session;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return replacement;
    });
  let refuse = false;
  try {
    const switching = pi.switchAccount(b, () => {
      if (refuse) throw new Error("Recovery admission was withdrawn.");
    });
    const rejected = assert.rejects(switching, /admission was withdrawn/);
    await vi.waitFor(() => assert.ok(staged));
    assert.deepEqual(
      toolExposureForSession(live.id),
      exposure,
      "staging has not replaced the live registry",
    );
    assert.deepEqual(sessionToolExposure(live.id), exposure);
    refuse = true;
    release!();
    await rejected;
    assert.equal(pi.session, old);
    assert.equal(pi.credentialProfileId, a);
    assert.deepEqual(
      toolExposureForSession(live.id),
      exposure,
      "staged disposal leaves live exposure intact",
    );
    assert.deepEqual(sessionToolExposure(live.id), exposure);
    assert.deepEqual(
      prepareToolsForUserTurn(live.id, UNUSED_TOOL_PRUNE_IDLE_MS),
      ["kb_read"],
    );
    assert.equal(
      old.getActiveToolNames().includes("kb_read"),
      false,
      "cold prune still reaches the live activation",
    );
    factory.mockRestore();
    await pi.switchAccount(b, () => {});
    const current = internals.toolRuntimes.get(live.id)!;
    assert.notEqual(current, previous);
    assert.notEqual(pi.session, old);
    assert.deepEqual(toolExposureForSession(live.id), current.exposure());
    assert.deepEqual(sessionToolExposure(live.id), current.exposure());
    current.initialize(["kb_read"]);
    assert.equal(pi.session.getActiveToolNames().includes("kb_read"), true);
    assert.deepEqual(
      prepareToolsForUserTurn(live.id, UNUSED_TOOL_PRUNE_IDLE_MS),
      ["kb_read"],
    );
    assert.equal(
      pi.session.getActiveToolNames().includes("kb_read"),
      false,
      "committed prune reaches replacement",
    );
  } finally {
    release?.();
    factory.mockRestore();
    await sessionRuntime.disposeSession(live.id);
    piStore.evict(live.id);
    profiles.setCredentialProfileEnabled(a, false);
    profiles.setCredentialProfileEnabled(b, false);
  }
});

test("real Claude store terminates its old epoch, copies JSONL/subagents and resumes the same native id", async () => {
  const a = account("claude", "Claude A");
  const b = account("claude", "Claude B");
  const providerId = randomUUID();
  const project = "-account-switch-test";
  const from = join(profiles.claudeConfigDir(a), "projects", project);
  mkdirSync(join(from, providerId, "subagents"), { recursive: true });
  const nativeBody =
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"signed reasoning","signature":"signature-a"},{"type":"tool_use","id":"tool-a","name":"Read","input":{"file_path":"x"}}]}}\n';
  writeFileSync(join(from, `${providerId}.jsonl`), nativeBody);
  writeFileSync(
    join(from, providerId, "subagents", "child.jsonl"),
    "subagent history\n",
  );
  const queries: ClaudeQueryParams[] = [];
  const inputs: unknown[] = [];
  let oldEnded = false;
  const seam: ClaudeSdkSeam = {
    query(params) {
      const index = queries.length;
      const messageId = randomUUID();
      if (index)
        assert.ok(
          oldEnded,
          "old query iterator ended before replacement opens",
        );
      queries.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          try {
            if (typeof params.prompt !== "string") {
              const iterator = params.prompt[Symbol.asyncIterator]();
              const input = await iterator.next();
              assert.equal(input.done, false);
              inputs.push(input.value);
              if (!index)
                writeFileSync(
                  join(from, `${providerId}.jsonl`),
                  nativeBody + JSON.stringify(input.value) + "\n",
                );
              await iterator.return?.();
            }
            yield {
              type: "system",
              subtype: "init",
              session_id: providerId,
              uuid: randomUUID(),
            } as ClaudeSdkMessage;
            yield {
              type: "stream_event",
              session_id: providerId,
              uuid: randomUUID(),
              event: { type: "message_start", message: { id: messageId } },
              parent_tool_use_id: null,
            } as unknown as ClaudeSdkMessage;
            yield {
              type: "assistant",
              session_id: providerId,
              uuid: randomUUID(),
              message: {
                id: messageId,
                model: "claude-sonnet-4-6",
                content: [
                  {
                    type: "text",
                    text: index ? "Recovered answer" : "Usage limit reached",
                  },
                ],
                usage: { input_tokens: 0, output_tokens: 0 },
              },
              ...(index ? {} : { error: "rate_limit" }),
            } as unknown as ClaudeSdkMessage;
            yield {
              type: "result",
              subtype: index ? "success" : "error_during_execution",
              is_error: !index,
              session_id: providerId,
              uuid: randomUUID(),
              ...(index
                ? {}
                : { errors: ["Usage limit reached"], api_error_status: 429 }),
              total_cost_usd: 0,
              modelUsage: {},
            } as unknown as ClaudeSdkMessage;
          } finally {
            if (!index) oldEnded = true;
          }
        },
      };
    },
  };
  seam.forkSession = async (nativeId, options) => {
    assert.equal(nativeId, providerId);
    assert.equal(
      (options.sessionStore as { root: string }).root,
      profiles.claudeConfigDir(b),
    );
    return { sessionId: randomUUID() };
  };
  const internals = claudeSdkStore as unknown as {
    seam: () => Promise<ClaudeSdkSeam>;
  };
  const factory = vi.spyOn(internals, "seam").mockResolvedValue(seam);
  const runtime = sessionRuntime;
  const id = randomUUID();
  let childId: string | undefined;
  try {
    const live = await createSession({
      harness: "claude-sdk",
      id,
      agentType: "assistant",
      credentialProfileId: a,
      modelId: "sonnet",
      thinkingLevel: "medium",
      title: "Existing Claude",
    });
    await promptRuntimeSessionWithRuntime(
      runtime,
      live,
      "Keep the Claude question",
    ).catch(() => {});
    await vi.waitFor(() => assert.equal(queries.length, 2));
    await vi.waitFor(() => assert.equal(live.isRunning, false));
    assert.equal(live.credentialProfileId, b);
    assert.equal(sessionStore.get(id)?.credentialProfileId, b);
    assert.equal(queries[1]!.options?.resume, providerId);
    assert.equal(
      queries[1]!.options?.env?.CLAUDE_CONFIG_DIR,
      profiles.claudeConfigDir(b),
    );
    const to = join(profiles.claudeConfigDir(b), "projects", project);
    assert.equal(
      readFileSync(join(to, `${providerId}.jsonl`), "utf8"),
      nativeBody + JSON.stringify(inputs[0]) + "\n",
    );
    assert.equal(
      readFileSync(join(to, providerId, "subagents", "child.jsonl"), "utf8"),
      "subagent history\n",
    );
    assert.equal(existsSync(join(from, `${providerId}.jsonl`)), false);
    assert.equal(existsSync(join(from, providerId)), false);
    assert.equal(inputs.length, 2);
    assert.equal(
      (
        readFileSync(join(to, `${providerId}.jsonl`), "utf8").match(
          /Keep the Claude question/g,
        ) ?? []
      ).length,
      1,
    );
    assert.ok(!JSON.stringify(inputs[1]).includes("Switched from"));
    const timeline = runtime.get(id)!.clientTimeline();
    const last = timeline.findLast(
      (entry) =>
        entry.type === "message" &&
        entry.role === "assistant" &&
        "forkable" in entry &&
        entry.forkable,
    );
    assert.ok(last);
    const anchor = runtime.forkAnchors(id, last.id).own;
    assert.ok(anchor);
    const claude =
      live as import("./claudeSdk/ClaudeSdkSession.ts").ClaudeSdkSession;
    const currentMeta = claude.toRecordMeta();
    const staleMeta = vi
      .spyOn(claude, "toRecordMeta")
      .mockReturnValue({ ...currentMeta, credentialProfileId: a });
    try {
      const child = await claudeSdkStore.forkSession(id, {
        anchor,
        keepThroughEntryId: last.id,
        forkOrigin: { harness: "claude-sdk", parentSessionId: id },
      });
      childId = child.id;
      assert.equal(
        child.credentialProfileId,
        b,
        "row binding wins even against lagged parent metadata",
      );
      assert.equal(sessionStore.get(child.id)?.credentialProfileId, b);
    } finally {
      staleMeta.mockRestore();
    }
    assert.equal(
      runtime
        .get(id)!
        .getSnapshot()
        .entries.filter((e) => e.type === "message" && e.role === "user")
        .length,
      1,
    );
  } finally {
    factory.mockRestore();
    await runtime.disposeSession(id);
    if (childId) claudeSdkStore.remove(childId);
    claudeSdkStore.remove(id);
    profiles.setCredentialProfileEnabled(a, false);
    profiles.setCredentialProfileEnabled(b, false);
  }
});
