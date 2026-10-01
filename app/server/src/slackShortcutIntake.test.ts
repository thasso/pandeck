import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PUBLIC_BASE_URL, SLACK_STATIC_CONFIG } from "./config.ts";
import {
  handleSlackShortcutEnvelope,
  SLACK_CREATE_TASK_CALLBACK_ID,
} from "./slackShortcutIntake.ts";
import { SlackSocketModeClient } from "./slackSocketMode.ts";
import { curateTaskIntake } from "./taskIntakeAgent.ts";
import { listTasks, readTask } from "./tasks.ts";

vi.mock("./slackSettings.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./slackSettings.ts")>();
  return {
    ...original,
    getSlackRuntimeSettings: () => ({
      enabled: true,
      accountUserId: "U1",
      botUserId: "UBOT",
    }),
    getSlackToolConfig: () => ({ enabled: true, token: "xoxp-test" }),
  };
});

vi.mock("./settings.ts", () => ({
  getSettings: () => ({
    taskIntakeAgent: {
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
      projectId: "intake-project",
      additionalInstructions: "",
    },
  }),
}));

vi.mock("./projectRegistry.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./projectRegistry.ts")>();
  return {
    ...original,
    getProject: (id: string) =>
      id === "intake-project"
        ? { id, name: "Intake Project", key: "IP", status: "active" }
        : null,
  };
});

vi.mock("./taskIntakeAgent.ts", () => ({
  curateTaskIntake: vi.fn(
    async ({ title, description }: { title: string; description: string }) => ({
      title,
      description,
    }),
  ),
}));

const originalFetch = globalThis.fetch;
let sequence = 0;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class IntakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function envelope(overrides: Record<string, unknown> = {}) {
  const ts = `1783862${String(sequence++).padStart(3, "0")}.123456`;
  return {
    envelope_id: `E-${ts}`,
    type: "interactive",
    payload: {
      type: "message_action",
      callback_id: SLACK_CREATE_TASK_CALLBACK_ID,
      response_url: "https://hooks.slack.com/actions/T/B/test",
      team: { id: SLACK_STATIC_CONFIG.teamId },
      user: { id: "U1" },
      channel: { id: `C${sequence}`, name: "product" },
      message_ts: ts,
      message: {
        ts,
        user: "U2",
        text: "Investigate the playback failure",
        files: [{ title: "trace.txt", mimetype: "text/plain" }],
      },
      ...overrides,
    },
  };
}

function installSuccessfulFetch(
  threadMessages?: Array<Record<string, unknown>>,
) {
  const confirmations: unknown[] = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://hooks.slack.com/actions/")) {
        confirmations.push(url);
        return new Response("ok", { status: 200 });
      }
      const method = url.split("/").pop();
      const params = new URLSearchParams(String(init?.body ?? ""));
      const bodies: Record<string, unknown> = {
        "chat.getPermalink": {
          ok: true,
          permalink: `https://acme.slack.com/archives/${params.get("channel")}/p${params.get("message_ts")?.replace(".", "")}`,
        },
        "conversations.info": { ok: true, channel: { name: "product" } },
        "conversations.replies": {
          ok: true,
          messages: threadMessages ?? [
            {
              ts: "1783862000.123456",
              user: "U2",
              text: "Investigate the playback failure",
            },
          ],
        },
        "conversations.history": {
          ok: true,
          messages: [
            { ts: "1783861999.000001", user: "U3", text: "Earlier context" },
          ],
        },
        "users.info": {
          ok: true,
          user: { profile: { display_name: "Alice" } },
        },
        "conversations.open": { ok: true, channel: { id: "D-PA" } },
        "chat.postMessage": { ok: true, ts: "1783862998.000001" },
        "chat.update": { ok: true, ts: "1783862998.000001" },
        "chat.postEphemeral": { ok: true, message_ts: "1783862999.000001" },
      };
      return new Response(
        JSON.stringify(bodies[method!] ?? { ok: false, error: "unknown" }),
        { status: 200 },
      );
    },
  ) as typeof fetch;
  return confirmations;
}

beforeEach(() => {
  sequence += 10;
  vi.mocked(curateTaskIntake).mockImplementation(
    async ({ title, description }) => ({ title, description }),
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Slack message shortcut intake", () => {
  test("acknowledges a Socket Mode shortcut before dispatching it into Task intake", async () => {
    installSuccessfulFetch();
    const socket = new IntakeSocket();
    const client = new SlackSocketModeClient({
      appToken: "xapp-test",
      teamId: SLACK_STATIC_CONFIG.teamId,
      expectedUserId: () => "U1",
      enabled: () => true,
      openConnection: async () => "wss://example.test/socket",
      createSocket: () => socket,
      logger: { info: () => undefined, warn: () => undefined },
    });
    client.subscribe(handleSlackShortcutEnvelope);
    const input = envelope();
    client.start();
    await flush();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify(input)));
    assert.deepEqual(socket.sent, [
      JSON.stringify({ envelope_id: input.envelope_id }),
    ]);
    await flush();
    await flush();
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    client.stop();
  });

  test("creates and enriches a root-message Task with a private confirmation", async () => {
    const confirmations = installSuccessfulFetch();
    const input = envelope();
    await handleSlackShortcutEnvelope(input);
    const channelId = input.payload.channel.id;
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${channelId}/`),
      ),
    );
    assert.ok(task);
    const full = readTask(task.id)!;
    assert.equal(full.title, "Investigate the playback failure");
    assert.match(full.description, /## Selected message/);
    assert.match(full.description, /trace\.txt/);
    assert.equal(full.externalLinks?.[0]?.source, "slack");
    assert.equal(full.projectId, "intake-project");
    assert.equal(
      vi.mocked(curateTaskIntake).mock.calls.at(-1)?.[0].projectId,
      "intake-project",
    );
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    assert.equal(
      confirmations.length,
      0,
      "App-DM progress replaces the generic interaction response",
    );
    assert.ok(
      calls.some(([url]) => String(url).endsWith("/conversations.open")),
    );
    assert.ok(
      calls.some(
        ([url, init]) =>
          String(url).endsWith("/chat.postMessage") &&
          String(init?.body).includes("Task+%23"),
      ),
    );
    const updateCall = calls.find(([url]) =>
      String(url).endsWith("/chat.update"),
    );
    assert.ok(updateCall);
    const updateBody = new URLSearchParams(String(updateCall[1]?.body ?? ""));
    assert.match(
      updateBody.get("blocks") ?? "",
      new RegExp(
        `${PUBLIC_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tasks/${task.id}`,
      ),
    );
    assert.match(
      updateBody.get("blocks") ?? "",
      new RegExp(`/archives/${channelId}/`),
    );
  });

  test("labels a DM source with its resolved participant instead of #directmessage", async () => {
    installSuccessfulFetch();
    const successfulFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/conversations.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: { name: "directmessage", is_im: true, user: "U2" },
            }),
          );
        }
        return successfulFetch(input, init);
      },
    ) as typeof fetch;
    const input = envelope({ channel: { id: "D123", name: "directmessage" } });

    await handleSlackShortcutEnvelope(input);

    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) => link.url.includes("/archives/D123/")),
    );
    assert.ok(task);
    assert.equal(
      task.externalLinks?.[0]?.title,
      "Slack message in DM with Alice",
    );
    const curatorInput = vi.mocked(curateTaskIntake).mock.calls.at(-1)?.[0];
    assert.equal(curatorInput?.sourceLabel, "DM with Alice");
  });

  test("includes bounded root and reply context for a selected thread reply", async () => {
    installSuccessfulFetch([
      { ts: "1783862100.000001", user: "U2", text: "Root cause?" },
      {
        ts: "1783862101.000001",
        thread_ts: "1783862100.000001",
        user: "U1",
        text: "I will investigate",
      },
    ]);
    const input = envelope({
      message_ts: "1783862101.000001",
      message: {
        ts: "1783862101.000001",
        thread_ts: "1783862100.000001",
        user: "U1",
        text: "I will investigate",
      },
    });
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes("p1783862101000001"),
      ),
    );
    assert.ok(task);
    assert.match(
      readTask(task.id)!.description,
      /Thread context \(2 messages\)/,
    );
    assert.match(readTask(task.id)!.description, /Root cause\?/);
  });

  test("falls back to a private selected-channel confirmation when App-DM progress is unavailable", async () => {
    installSuccessfulFetch();
    const successfulFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/conversations.open"))
          return new Response(
            JSON.stringify({ ok: false, error: "restricted_action" }),
          );
        return successfulFetch(input, init);
      },
    ) as typeof fetch;
    const input = envelope({ response_url: undefined });
    await handleSlackShortcutEnvelope(input);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    assert.ok(
      calls.some(([url]) => String(url).endsWith("/chat.postEphemeral")),
    );
  });

  test("reuses an existing Task and sends linked duplicate feedback in the Pandeck DM", async () => {
    installSuccessfulFetch();
    const input = envelope();
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    const countBefore = listTasks({ includeArchived: true }).length;
    const postsBefore = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) =>
        String(url).endsWith("/chat.postMessage"),
      ).length;

    await handleSlackShortcutEnvelope({
      ...input,
      envelope_id: "retry-envelope",
    });

    assert.equal(listTasks({ includeArchived: true }).length, countBefore);
    const postCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/chat.postMessage"));
    assert.equal(postCalls.length, postsBefore + 1);
    const duplicateBody = new URLSearchParams(
      String(postCalls.at(-1)?.[1]?.body ?? ""),
    );
    const blocks = duplicateBody.get("blocks") ?? "";
    assert.match(blocks, /Task already exists/);
    assert.match(
      blocks,
      new RegExp(
        `${PUBLIC_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tasks/${task.id}`,
      ),
    );
    assert.match(blocks, new RegExp(`/archives/${input.payload.channel.id}/`));
  });

  test("keeps a curated Task when every private confirmation delivery fails", async () => {
    installSuccessfulFetch();
    const successfulFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://hooks.slack.com/actions/"))
          throw new Error("response URL unavailable");
        if (
          url.endsWith("/conversations.open") ||
          url.endsWith("/chat.postEphemeral")
        )
          return new Response(
            JSON.stringify({ ok: false, error: "restricted_action" }),
            { status: 200 },
          );
        return successfulFetch(input, init);
      },
    ) as typeof fetch;
    const input = envelope();
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    assert.equal(readTask(task.id)!.title, "Investigate the playback failure");
    assert.doesNotMatch(
      readTask(task.id)!.description,
      /Task Intake Agent curation is pending/,
    );
  });

  test("keeps enriched context and retries the same Task when curation fails", async () => {
    installSuccessfulFetch();
    vi.mocked(curateTaskIntake).mockRejectedValueOnce(
      new Error("model unavailable"),
    );
    const input = envelope();
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    assert.match(
      readTask(task.id)!.description,
      /Task Intake Agent curation is pending and can be retried/,
    );
    await handleSlackShortcutEnvelope({
      ...input,
      envelope_id: "curation-retry",
    });
    assert.equal(
      listTasks({ includeArchived: true }).filter((item) => item.id === task.id)
        .length,
      1,
    );
    assert.doesNotMatch(
      readTask(task.id)!.description,
      /Task Intake Agent curation is pending/,
    );
  });

  test("persists a retryable Task when all Slack enrichment calls fail", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://hooks.slack.com/actions/"))
        return new Response("ok");
      return new Response(
        JSON.stringify({ ok: false, error: "temporarily_unavailable" }),
        { status: 200 },
      );
    }) as typeof fetch;
    const input = envelope();
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    assert.match(
      readTask(task.id)!.description,
      /Task Intake Agent curation is pending and can be retried/,
    );
  });

  test("bounds untrusted message text and attachment collections before persisting context", async () => {
    installSuccessfulFetch();
    const successfulFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/chat.getPermalink"))
          return new Response(
            JSON.stringify({
              ok: true,
              permalink: `https://user@${SLACK_STATIC_CONFIG.workspaceHost}:8443/archives/C1/p1783862100123456`,
            }),
          );
        if (url.endsWith("/conversations.info"))
          return new Response(
            JSON.stringify({
              ok: true,
              channel: {
                is_mpim: true,
                members: Array.from({ length: 100 }, (_, index) => `U${index}`),
              },
            }),
          );
        if (url.endsWith("/users.info"))
          return new Response(
            JSON.stringify({
              ok: true,
              user: {
                profile: {
                  display_name: "Very Long Participant Name ".repeat(20),
                },
              },
            }),
          );
        return successfulFetch(input, init);
      },
    ) as typeof fetch;
    const unsafeUrls = [
      "javascript:alert(1)",
      "https://user:password@example.com/file",
      "http://127.0.0.1/private",
      "https://example.com/file?X-Amz-Signature=secret",
      "https://files.slack.com/private-download",
      "https://sub.files.slack.com/private-download",
      "https://slack-files.com/private-download",
      "https://downloads.slack-edge.com/private-download",
    ];
    const files = Array.from({ length: 40 }, (_, index) => ({
      name: `file-${index}.txt`,
      permalink: unsafeUrls[index] ?? `https://example.com/file-${index}`,
    }));
    const input = envelope({
      message: {
        ts: "1783862100.000001",
        user: "U1",
        text: "x".repeat(200_000),
        files,
      },
    });
    await handleSlackShortcutEnvelope(input);
    const task = listTasks({ includeArchived: true }).find((item) =>
      item.externalLinks?.some((link) =>
        link.url.includes(`/archives/${input.payload.channel.id}/`),
      ),
    );
    assert.ok(task);
    const description = readTask(task.id)!.description;
    assert.ok(description.length <= 100_000);
    assert.doesNotMatch(
      description,
      /javascript:|user:password|127\.0\.0\.1|X-Amz|files\.slack\.com|slack-files\.com|slack-edge\.com/,
    );
    assert.doesNotMatch(description, /file-39/);
    assert.ok((task.externalLinks?.[0]?.title?.length ?? 0) <= 350);
    assert.doesNotMatch(task.externalLinks?.[0]?.url ?? "", /user@|:8443/);
    assert.doesNotMatch(
      task.externalLinks?.[0]?.title ?? "",
      /U99|Very Long Participant Name Very Long Participant Name Very Long Participant Name Very Long Participant Name Very Long Participant Name/,
    );
  });

  test("ignores the wrong user or workspace without creating a Task", async () => {
    installSuccessfulFetch();
    const before = listTasks({ includeArchived: true }).length;
    await handleSlackShortcutEnvelope(envelope({ user: { id: "U-other" } }));
    await handleSlackShortcutEnvelope(envelope({ team: { id: "T-other" } }));
    assert.equal(listTasks({ includeArchived: true }).length, before);
  });
});
