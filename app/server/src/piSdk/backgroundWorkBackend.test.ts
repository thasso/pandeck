import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type {
  BackgroundWorkActivity,
  BackgroundWorkActivityRateExceeded,
  BackgroundWorkBackendEvents,
  BackgroundWorkCompletion,
  BackgroundWorkOutputCaptured,
  BackgroundWorkProviderBinding,
} from "../backgroundWork/backends.ts";
import type { ToolSession } from "../mcp/tool.ts";

const dataDir = mkdtempSync(join(tmpdir(), "pi-background-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { PiBackgroundWorkBackend, createPiBackgroundTools } =
  await import("./backgroundWorkBackend.ts");
const { createPiToolActivation, mergedActiveToolNames } =
  await import("./toolActivation.ts");
const { BackgroundWorkSupervisor, backgroundWorkSupervisor } =
  await import("../backgroundWork/supervisor.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { updateSettings } = await import("../settings.ts");
const { setChildProcessEnvOverlay } = await import("../subprocessEnv.ts");
const { listSessionArtifacts } =
  await import("../mcp/toolGroups/packRuntime.ts");

function artifactPath(url: string): string {
  const pathname = new URL(url, "http://localhost").pathname;
  const relative = pathname.slice("/api/session-artifacts/".length);
  return join(
    dataDir,
    "session-artifacts",
    ...relative.split("/").map(decodeURIComponent),
  );
}

let serial = 0;

function owner(): string {
  serial += 1;
  const id = `pi-background-owner-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "developer",
  });
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 5,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  return id;
}

function eventProxy(): {
  events: BackgroundWorkBackendEvents;
  setTarget(target: BackgroundWorkBackendEvents): void;
} {
  let target: BackgroundWorkBackendEvents | undefined;
  return {
    events: {
      providerBound(binding: BackgroundWorkProviderBinding) {
        target?.providerBound(binding);
      },
      activity(activity: BackgroundWorkActivity) {
        target?.activity(activity);
      },
      activityRateExceeded(event: BackgroundWorkActivityRateExceeded) {
        target?.activityRateExceeded(event);
      },
      outputCaptured(output: BackgroundWorkOutputCaptured) {
        target?.outputCaptured(output);
      },
      completed(completion: BackgroundWorkCompletion) {
        target?.completed(completion);
      },
    },
    setTarget(next) {
      target = next;
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class FakeActivityScheduler {
  readonly delays: number[] = [];
  private callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];

  schedule = (delayMs: number, callback: () => void) => {
    this.delays.push(delayMs);
    const entry = { callback, cancelled: false };
    this.callbacks.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  };

  runNext(): boolean {
    const next = this.callbacks.shift();
    if (!next) return false;
    if (!next.cancelled) next.callback();
    return true;
  }
}

function admit(
  supervisor: InstanceType<typeof BackgroundWorkSupervisor>,
  ownerSessionId: string,
  kind: "shell" | "monitor-command" | "monitor-websocket",
) {
  serial += 1;
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "host-process",
    kind,
    label: `work ${serial}`,
    sourceRequestId: `source-${serial}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) throw new Error("background admission failed");
  return admission;
}

class FakeSocket extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
    this.emit("close");
  }
}

test("the eager custom definitions shadow builtin bash through the active-set merge", () => {
  const active = mergedActiveToolNames({
    current: ["read", "bash"],
    bridgeToolNames: new Set(["bash", "monitor"]),
    extraBuiltin: [],
    planRestrictedBuiltin: ["edit", "write"],
    mode: "build",
    activeBridge: ["bash", "monitor"],
  });
  assert.deepEqual(
    new Set(active),
    new Set(["read", "bash", "monitor", "edit", "write"]),
  );
  assert.equal(active.filter((name) => name === "bash").length, 1);
});

test("Plan keeps the existing bash capability but removes monitor", () => {
  const sessionId = owner();
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const tools = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
  });
  let applied = new Set<string>();
  const activation = createPiToolActivation({
    sessionId: `plan-background-${serial}`,
    agentType: "developer",
    agentTools: tools,
    eagerToolNames: new Set(["bash", "monitor"]),
    deferToolLoading: true,
    mode: () => "plan",
    applyActiveToolNames: (names) => (applied = new Set(names)),
  });
  try {
    activation.initialize([]);
    assert.equal(applied.has("bash"), true);
    assert.equal(applied.has("monitor"), false);
  } finally {
    activation.dispose();
  }
});

test("foreground bash delegates to upstream with streaming, cwd, PI identity and the child overlay", async () => {
  setChildProcessEnvOverlay({ PA_PI_OVERLAY_PROBE: "foreground-overlay" });
  const sessionId = owner();
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
    sessionFile: join(dataDir, "session.jsonl"),
  };
  const tools = createPiBackgroundTools({
    session: () => session,
    identity: () => ({
      sessionId,
      sessionFile: session.sessionFile!,
      provider: "provider-probe",
      model: "model-probe",
      reasoningLevel: "high",
    }),
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["bash", "monitor"],
    "both shadow definitions register up front",
  );
  const bash = tools[0]!;
  const updates: string[] = [];
  const result = await bash.execute(
    {
      command:
        'printf \'%s|%s|%s|%s|%s|%s|%s\' "$PWD" "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL" "$PA_PI_OVERLAY_PROBE"',
    },
    {
      toolCallId: "foreground-probe",
      session,
      progress: (partial) => {
        const text = partial.content.find((block) => block.type === "text");
        if (text?.type === "text") updates.push(text.text);
      },
    },
  );
  setChildProcessEnvOverlay(null);
  const text = result.content.find((block) => block.type === "text");
  assert.equal(
    text?.type === "text" ? text.text : undefined,
    [
      dataDir,
      sessionId,
      session.sessionFile,
      "provider-probe",
      "model-probe",
      "high",
      "foreground-overlay",
    ].join("|"),
  );
  assert.ok(updates.length > 0, "upstream progress updates were preserved");
});

test("foreground shadow passes pi shell path and command prefix through", async () => {
  const sessionId = owner();
  const marker = join(dataDir, `custom-shell-${serial}.txt`);
  const shell = join(dataDir, `custom-shell-${serial}.sh`);
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf CUSTOM_SHELL_RAN > ${JSON.stringify(marker)}\nexec bash "$@"\n`,
  );
  chmodSync(shell, 0o700);
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const bash = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
    bashConfig: () => ({
      shellPath: shell,
      commandPrefix: "export PI_PREFIX_PROBE=yes",
    }),
  })[0]!;
  const result = await bash.execute(
    { command: "printf '%s' \"$PI_PREFIX_PROBE\"" },
    { toolCallId: `shell-config-${serial}`, session },
  );
  const text = result.content.find((block) => block.type === "text");
  assert.equal(text?.type === "text" ? text.text : undefined, "yes");
  assert.equal(readFileSync(marker, "utf8"), "CUSTOM_SHELL_RAN");
});

test("foreground bash preserves upstream truncation and cancellation cleanup", async () => {
  const sessionId = owner();
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const bash = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
  })[0]!;
  const truncated = await bash.execute(
    { command: "seq 1 5000" },
    { toolCallId: `foreground-truncation-${serial}`, session },
  );
  const details = truncated.details as {
    truncation?: { truncated?: boolean; totalLines?: number };
    fullOutputPath?: string;
  };
  assert.equal(details.truncation?.truncated, true);
  assert.equal(details.truncation?.totalLines, 5_000);
  assert.ok(details.fullOutputPath);

  const controller = new AbortController();
  let reportPids!: (line: string) => void;
  const pids = new Promise<string>((resolve) => (reportPids = resolve));
  const running = bash.execute(
    {
      command:
        'sh -c \'sleep 300 & child=$!; printf "%s %s\\n" "$$" "$child"; wait "$child"\'',
    },
    {
      toolCallId: `foreground-cancel-${serial}`,
      session,
      signal: controller.signal,
      progress: (partial) => {
        const text = partial.content.find((block) => block.type === "text");
        if (text?.type !== "text") return;
        const line = text.text
          .split("\n")
          .find((candidate) => /^\d+ \d+$/.test(candidate));
        if (line) reportPids(line);
      },
    },
  );
  const [leader, child] = (await pids).split(" ").map(Number);
  controller.abort();
  await assert.rejects(() => running, /Command aborted/);
  await assertProcessGone(leader!);
  await assertProcessGone(child!);
});

test("background bash returns a PA id and freezes all five PI values and the child overlay", async () => {
  setChildProcessEnvOverlay({ PA_PI_OVERLAY_PROBE: "background-overlay" });
  const sessionId = owner();
  const outputPath = join(dataDir, `background-env-${serial}.txt`);
  const shellMarker = join(dataDir, `background-shell-${serial}.txt`);
  const shell = join(dataDir, `background-shell-${serial}.sh`);
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf CUSTOM_SHELL_RAN > ${JSON.stringify(shellMarker)}\nexec bash "$@"\n`,
  );
  chmodSync(shell, 0o700);
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
    sessionFile: join(dataDir, "background-session.jsonl"),
  };
  const bash = createPiBackgroundTools({
    session: () => session,
    bashConfig: () => ({
      shellPath: shell,
      commandPrefix: "export PI_BACKGROUND_PREFIX=yes",
    }),
    identity: () => ({
      sessionId,
      sessionFile: session.sessionFile!,
      provider: "provider-background",
      model: "model-background",
      reasoningLevel: "medium",
    }),
  })[0]!;
  const completed = new Promise<void>((resolve) => {
    backgroundWorkSupervisor.setCompletionRecordedHandler((item) => {
      if (item.ownerSessionId === sessionId) resolve();
    });
  });
  const result = await bash.execute(
    {
      command: `printf '%s|%s|%s|%s|%s|%s|%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL" "$PATH" "$PI_BACKGROUND_PREFIX" "$PA_PI_OVERLAY_PROBE" > ${JSON.stringify(outputPath)}`,
      run_in_background: true,
    },
    { toolCallId: `background-env-${serial}`, session },
  );
  // Frozen at admission: withdrawing the overlay now must not reach the item.
  setChildProcessEnvOverlay(null);
  const details = result.details as {
    taskId?: string;
    state?: string;
    hint?: string;
  };
  assert.match(details.taskId ?? "", /^bgw_/);
  assert.equal(details.state, "running");
  assert.match(details.hint ?? "", /set_intent/);
  await completed;
  backgroundWorkSupervisor.setCompletionRecordedHandler(undefined);
  const [
    actualSession,
    file,
    provider,
    model,
    reasoning,
    path,
    prefix,
    overlay,
  ] = readFileSync(outputPath, "utf8").split("|");
  assert.deepEqual(
    [actualSession, file, provider, model, reasoning, prefix, overlay],
    [
      sessionId,
      session.sessionFile,
      "provider-background",
      "model-background",
      "medium",
      "yes",
      "background-overlay",
    ],
  );
  assert.equal(readFileSync(shellMarker, "utf8"), "CUSTOM_SHELL_RAN");
  assert.ok(
    path
      ?.split(":")
      .includes(
        join(
          process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
          "bin",
        ),
      ),
  );
});

test("command monitor uses the configured shell and command prefix", async () => {
  const sessionId = owner();
  const outputPath = join(dataDir, `monitor-config-${serial}.txt`);
  const shellMarker = join(dataDir, `monitor-shell-${serial}.txt`);
  const shell = join(dataDir, `monitor-shell-${serial}.sh`);
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf CFG_SHELL_RAN > ${JSON.stringify(shellMarker)}\nexec bash "$@"\n`,
  );
  chmodSync(shell, 0o700);
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const monitor = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
    bashConfig: () => ({
      shellPath: shell,
      commandPrefix: "export MONITOR_PREFIX=applied",
    }),
  })[1]!;
  const completed = new Promise<void>((resolve) => {
    backgroundWorkSupervisor.setCompletionRecordedHandler((item) => {
      if (item.ownerSessionId === sessionId) resolve();
    });
  });
  await monitor.execute(
    {
      description: "configured monitor",
      timeout_ms: 10_000,
      persistent: false,
      command: `printf 'prefix=%s' "$MONITOR_PREFIX" > ${JSON.stringify(outputPath)}`,
    },
    { toolCallId: `monitor-config-${serial}`, session },
  );
  await completed;
  backgroundWorkSupervisor.setCompletionRecordedHandler(undefined);
  assert.equal(readFileSync(shellMarker, "utf8"), "CFG_SHELL_RAN");
  assert.equal(readFileSync(outputPath, "utf8"), "prefix=applied");
});

test("excluded owners keep foreground bash while background admission is denied", async () => {
  serial += 1;
  const sessionId = `pi-background-internal-${serial}`;
  sessionStore.upsert({
    id: sessionId,
    scope: "internal",
    harness: "pi",
    agentType: "developer",
  });
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const bash = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
  })[0]!;
  const foreground = await bash.execute(
    { command: "printf foreground" },
    { toolCallId: `excluded-foreground-${serial}`, session },
  );
  const text = foreground.content.find((block) => block.type === "text");
  assert.equal(text?.type === "text" ? text.text : undefined, "foreground");
  await assert.rejects(
    () =>
      bash.execute(
        { command: "printf denied", run_in_background: true },
        { toolCallId: `excluded-background-${serial}`, session },
      ),
    /Background work denied/,
  );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: sessionId }).length,
    0,
  );
});

test("WebSocket monitor reuses public-host SSRF policy before admission", async () => {
  const sessionId = owner();
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const monitor = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
  })[1]!;
  for (const url of [
    "ws://127.0.0.1:3000/",
    "http://127.0.0.1:8787/",
    "ws+unix:/var/run/docker.sock:/x",
  ])
    await assert.rejects(
      () =>
        monitor.execute(
          {
            description: "SSRF probe",
            timeout_ms: 1_000,
            persistent: false,
            ws: { url },
          },
          { toolCallId: `ssrf-${serial}-${url}`, session },
        ),
      /non-public|only ws:\/\/ and wss:\/\//,
    );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: sessionId }).length,
    0,
  );
});

test("persistent monitor freezes timeout_ms and still stops through the supervisor", async () => {
  const sessionId = owner();
  const session: ToolSession = {
    sessionId,
    harness: "pi",
    agentType: "developer",
    cwd: dataDir,
  };
  const monitor = createPiBackgroundTools({
    session: () => session,
    identity: () => ({ sessionId }),
  })[1]!;
  const result = await monitor.execute(
    {
      description: "persistent probe",
      timeout_ms: 1_234,
      persistent: true,
      command: "sleep 300",
    },
    { toolCallId: `persistent-monitor-${serial}`, session },
  );
  const details = result.details as { taskId: string };
  const item = backgroundWorkStore.getItem(details.taskId);
  assert.equal(item?.lifetimeMs, 1_234);
  const stopped = await backgroundWorkSupervisor.stopOne({
    itemId: details.taskId,
    ownerSessionId: sessionId,
    sourceRequestId: `persistent-stop-${serial}`,
    reason: "test cleanup",
  });
  assert.equal(stopped.state, "stopped");
});

test("a background shell command pushes nothing while it runs", async () => {
  const proxy = eventProxy();
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      options.onData(Buffer.from("one\ntwo\n"));
      return Promise.resolve({ exitCode: 0 });
    },
  };
  const activities: BackgroundWorkActivity[] = [];
  const scheduler = new FakeActivityScheduler();
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
    scheduleActivity: scheduler.schedule,
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "shell");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "shell",
    command: "probe",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  // Not merely unsent: never scheduled, so a chatty server cannot arm a timer
  // per output chunk for the whole time it runs.
  assert.deepEqual(scheduler.delays, []);
  assert.deepEqual(activities, []);
  const completed = backgroundWorkStore.getItem(admission.item.id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.outcomeSummary, "Exited with code 0");
  // The lines still reached the artifact: the agent reads them when it wants to.
  const artifact = listSessionArtifacts(ownerSessionId).find(
    (candidate) => candidate.id === completed?.evidence?.artifactId,
  );
  assert.ok(artifact);
  assert.equal(readFileSync(artifactPath(artifact.url), "utf8"), "one\ntwo\n");
});

test("monitor completion records bounded activity, terminal counts and evidence", async () => {
  const proxy = eventProxy();
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      options.onData(Buffer.from("one\ntwo\n"));
      return Promise.resolve({ exitCode: 0 });
    },
  };
  const activities: BackgroundWorkActivity[] = [];
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command: "probe",
    cwd: dataDir,
    env: {},
  });
  const running = await supervisor.launch(admission);
  assert.equal(running?.state, "running");
  await flush();
  const completed = backgroundWorkStore.getItem(admission.item.id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.outcomeSummary, "Exited with code 0");
  assert.ok(completed?.evidence?.artifactId);
  assert.equal(completed?.evidence?.text, true);
  assert.deepEqual(
    activities.flatMap((batch) => batch.lines),
    ["one", "two"],
  );
});

test("capture writer preserves the real final 32 KiB after its bounded head", async () => {
  const proxy = eventProxy();
  const output = Buffer.from(
    Array.from(
      { length: 40_000 },
      (_, index) =>
        `line-${String(index).padStart(5, "0")}-${"x".repeat(32)}\n`,
    ).join(""),
  );
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      options.onData(output);
      return Promise.resolve({ exitCode: 0 });
    },
  };
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
  });
  const supervisor = new BackgroundWorkSupervisor({ ports: [backend] });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "shell");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "shell",
    command: "noisy",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  const item = backgroundWorkStore.getItem(admission.item.id);
  assert.equal(item?.evidence?.originalBytes, output.length);
  assert.equal(item?.evidence?.truncated, true);
  assert.match(
    item?.outcomeSummary ?? "",
    new RegExp(
      `${output.length - 1024 * 1024 - 32 * 1024} output byte\\(s\\) dropped at the capture cap`,
    ),
  );
  const artifact = listSessionArtifacts(ownerSessionId)[0];
  assert.ok(artifact);
  const captured = readFileSync(artifactPath(artifact.url), "utf8");
  assert.match(captured, /line-39999-/);
  assert.doesNotMatch(captured, /line-21400-/);
});

test("activity bounding reports the exact dropped-line count", async () => {
  const proxy = eventProxy();
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      options.onData(
        Buffer.from(
          Array.from({ length: 103 }, (_, index) => `line-${index}`).join(
            "\n",
          ) + "\n",
        ),
      );
      return Promise.resolve({ exitCode: 0 });
    },
  };
  const activities: BackgroundWorkActivity[] = [];
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command: "noisy",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.lines.length, 100);
  assert.equal(activities[0]?.droppedEventCount, 3);
  assert.match(
    backgroundWorkStore.getItem(admission.item.id)?.outcomeSummary ?? "",
    /^Exited with code 0 · 3 activity event\(s\) dropped/,
  );
});

test("an unfiltered monitor is stopped once it exceeds its notification rate", async () => {
  const proxy = eventProxy();
  const scheduler = new FakeActivityScheduler();
  let onData!: (data: Buffer) => void;
  let rejectRun!: (error: Error) => void;
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      onData = options.onData;
      return new Promise((_resolve, reject) => {
        rejectRun = reject;
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const activities: BackgroundWorkActivity[] = [];
  // One window: everything below happens at the same instant.
  const clock = 1_000;
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
    scheduleActivity: scheduler.schedule,
    now: () => clock,
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command: "chatty",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  // 200 flushes inside one window, against a budget of 20.
  for (let index = 0; index < 200; index += 1) {
    onData(Buffer.from(`line-${index}\n`));
    scheduler.runNext();
  }
  rejectRun(new Error("aborted"));
  await flush();
  assert.equal(activities.length, 20);
  // Batched by arrival, not by a clock tick the agent waits out.
  assert.ok(scheduler.delays.every((delay) => delay === 200));
  // The item is Stopped, not merely muted: a live monitor nobody hears from is
  // indistinguishable from one with nothing to say.
  const item = backgroundWorkStore.getItem(admission.item.id);
  assert.equal(item?.state, "stopped");
  assert.equal(item?.terminalReason, "stopped-for-event-rate");
  assert.match(item?.stopReason ?? "", /Restart it with a filter/);
});

test("a monitor under its rate keeps streaming and is never stopped", async () => {
  const proxy = eventProxy();
  const scheduler = new FakeActivityScheduler();
  let onData!: (data: Buffer) => void;
  const operations: BashOperations = {
    exec: (_command, _cwd, options) => {
      onData = options.onData;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const activities: BackgroundWorkActivity[] = [];
  let clock = 1_000;
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
    scheduleActivity: scheduler.schedule,
    now: () => clock,
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command: "filtered",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  // Ten notifications per window, sustained over six windows: well past the old
  // 120-wakeup budget, and none of it trips the rate.
  for (let index = 0; index < 60; index += 1) {
    if (index > 0 && index % 10 === 0) clock += 60_000;
    onData(Buffer.from(`ERROR ${index}\n`));
    scheduler.runNext();
  }
  await flush();
  assert.equal(activities.length, 60);
  assert.equal(
    backgroundWorkStore.getItem(admission.item.id)?.state,
    "running",
  );
});

test("targeted Stop aborts the exact process operation", async () => {
  const proxy = eventProxy();
  let aborted = false;
  const operations: BashOperations = {
    exec: (_command, _cwd, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  const backend = new PiBackgroundWorkBackend({
    operations,
    events: proxy.events,
  });
  const supervisor = new BackgroundWorkSupervisor({ ports: [backend] });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "shell");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "shell",
    command: "long",
    cwd: dataDir,
    env: {},
  });
  await supervisor.launch(admission);
  await flush();
  const stopped = await supervisor.stopOne({
    itemId: admission.item.id,
    ownerSessionId,
    sourceRequestId: "stop-process",
    reason: "test Stop",
  });
  assert.equal(aborted, true);
  assert.equal(stopped.state, "stopped");
});

test("background diagnostics distinguish cwd, shell and timeout failures", async () => {
  async function runFailure(input: {
    cwd: string;
    shellPath?: string;
    operations?: BashOperations;
  }) {
    const proxy = eventProxy();
    let terminal!: () => void;
    const completed = new Promise<void>((resolve) => (terminal = resolve));
    const backend = new PiBackgroundWorkBackend({
      events: proxy.events,
      ...(input.operations ? { operations: input.operations } : {}),
    });
    const supervisor = new BackgroundWorkSupervisor({
      ports: [backend],
      completionRecorded: () => terminal(),
    });
    proxy.setTarget(supervisor);
    const ownerSessionId = owner();
    const admission = admit(supervisor, ownerSessionId, "shell");
    backend.reserve(admission.item.id, {
      type: "process",
      ownerSessionId,
      kind: "shell",
      command: "printf unreachable",
      cwd: input.cwd,
      env: {},
      ...(input.shellPath ? { shellPath: input.shellPath } : {}),
    });
    await supervisor.launch(admission);
    await completed;
    return backgroundWorkStore.getItem(admission.item.id)?.outcomeSummary ?? "";
  }

  const missingCwd = join(dataDir, `missing-cwd-${serial}`);
  assert.match(
    await runFailure({ cwd: missingCwd }),
    new RegExp(
      `Working directory does not exist: ${missingCwd.replaceAll("/", "\\/")}\\nCannot execute bash commands\\.`,
    ),
  );
  const missingShell = join(dataDir, `missing-shell-${serial}`);
  assert.match(
    await runFailure({ cwd: dataDir, shellPath: missingShell }),
    new RegExp(
      `Custom shell path not found: ${missingShell.replaceAll("/", "\\/")}`,
    ),
  );
  assert.match(
    await runFailure({
      cwd: dataDir,
      operations: {
        exec: () => Promise.reject(new Error("timeout:1")),
      },
    }),
    /^Command timed out after 1 seconds$/,
  );
});

test("natural leader exit reaps descendants before terminal completion", async () => {
  const proxy = eventProxy();
  let childPid: number | undefined;
  const backend = new PiBackgroundWorkBackend({
    events: proxy.events,
    scheduleActivity: (_delay, callback) => {
      queueMicrotask(callback);
      return { cancel: () => undefined };
    },
  });
  let terminal!: () => void;
  const completed = new Promise<void>((resolve) => (terminal = resolve));
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => {
      const line = activity.lines.find((candidate) => /^\d+$/.test(candidate));
      if (line) childPid = Number(line);
    },
    completionRecorded: () => terminal(),
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  // A monitor, because the pids reach this test through the activity stream that
  // only a monitor has. The subject is process-group reaping, which is identical
  // for both kinds.
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command: "sh -c 'sleep 300 & echo $!; exit 0'",
    cwd: dataDir,
    env: process.env,
  });
  await supervisor.launch(admission);
  await completed;
  assert.ok(childPid);
  assert.equal(
    backgroundWorkStore.getItem(admission.item.id)?.state,
    "completed",
  );
  await assertProcessGone(childPid!);
});

test("the supervised local operation Stop terminates the process group", async () => {
  const proxy = eventProxy();
  let reportPids!: (line: string) => void;
  const pids = new Promise<string>((resolve) => (reportPids = resolve));
  const backend = new PiBackgroundWorkBackend({
    events: proxy.events,
    scheduleActivity: (_delay, callback) => {
      queueMicrotask(callback);
      return { cancel: () => undefined };
    },
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => {
      const line = activity.lines.find((candidate) =>
        /^\d+ \d+$/.test(candidate),
      );
      if (line) reportPids(line);
    },
  });
  proxy.setTarget(supervisor);
  const ownerSessionId = owner();
  const admission = admit(supervisor, ownerSessionId, "monitor-command");
  backend.reserve(admission.item.id, {
    type: "process",
    ownerSessionId,
    kind: "monitor-command",
    command:
      'sh -c \'sleep 300 & child=$!; printf "%s %s\\n" "$$" "$child"; wait "$child"\'',
    cwd: dataDir,
    env: process.env,
  });
  await supervisor.launch(admission);
  const [leader, child] = (await pids).split(" ").map(Number);
  assert.equal(processIsRunning(leader!), true);
  assert.equal(processIsRunning(child!), true);
  const stopped = await supervisor.stopOne({
    itemId: admission.item.id,
    ownerSessionId,
    sourceRequestId: "stop-process-group",
    reason: "test process-group Stop",
  });
  assert.equal(stopped.state, "stopped");
  await assertProcessGone(leader!);
  await assertProcessGone(child!);
});

function processIsRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

// SIGKILL to a process group is delivered asynchronously. The awaited promise
// settles on the leader's `close`, which only means the inherited pipe writers
// were released -- a descendant killed with it can still answer a /proc sample
// with a state this helper does not count as dead. A single sample right after
// that promise therefore fails on a loaded runner for reasons the code under
// test never caused, so give the teardown a bounded grace period and keep the
// assertion on the outcome: a descendant that truly survives cancellation
// sleeps for 300s and cannot go away inside it.
async function assertProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processIsRunning(pid), false, `pid ${pid} is still running`);
}

test("WebSocket monitor emits activity and Stop closes only its owned socket", async () => {
  const proxy = eventProxy();
  const sockets: FakeSocket[] = [];
  const activities: BackgroundWorkActivity[] = [];
  const backend = new PiBackgroundWorkBackend({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    events: proxy.events,
    scheduleActivity: (_delay, callback) => {
      queueMicrotask(callback);
      return { cancel: () => undefined };
    },
  });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [backend],
    activityRecorded: (_item, activity) => activities.push(activity),
  });
  proxy.setTarget(supervisor);
  const firstOwner = owner();
  const secondOwner = owner();
  const first = admit(supervisor, firstOwner, "monitor-websocket");
  const second = admit(supervisor, secondOwner, "monitor-websocket");
  for (const [admission, ownerSessionId] of [
    [first, firstOwner],
    [second, secondOwner],
  ] as const) {
    backend.reserve(admission.item.id, {
      type: "socket",
      ownerSessionId,
      kind: "monitor-websocket",
      url: "ws://probe.invalid",
    });
    await supervisor.launch(admission);
  }
  sockets[0]!.emit("message", Buffer.from("changed\n"));
  await flush();
  assert.deepEqual(
    activities.flatMap((batch) => batch.lines),
    ["changed"],
  );
  const stopped = await supervisor.stopOne({
    itemId: first.item.id,
    ownerSessionId: firstOwner,
    sourceRequestId: "stop-socket",
    reason: "test Stop",
  });
  assert.equal(stopped.state, "stopped");
  assert.equal(sockets[0]!.closeCalls, 1);
  assert.equal(sockets[1]!.closeCalls, 0);
  sockets[1]!.emit("close");
  await flush();
  assert.equal(backgroundWorkStore.getItem(second.item.id)?.state, "completed");
});
