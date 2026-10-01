/**
 * A stand-in for the Claude CLI that the Bun install check points the packaged
 * server at (`ASSISTANT_CLAUDE_CLI_BIN`), so a real Claude SDK turn runs with
 * no account and no network. It speaks the SDK's stream-json protocol: every
 * control request succeeds, and every user message is answered with one
 * streamed text reply, `Fake reply to: <prompt>`, and a successful result.
 *
 * Each invocation appends one JSON line to `fake-claude.jsonl` in the
 * `CLAUDE_CONFIG_DIR` the server gave it, which is how the check sees the
 * credential profile's environment arrive and a resumed session come back.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MODEL = "claude-opus-5-5";

const args = process.argv.slice(2);
/** `--name=value` (how the SDK passes `--resume`) or `--name value`. */
const flag = (name) => {
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const resumed = flag("--resume");
const sessionId = resumed ?? flag("--session-id") ?? randomUUID();
const configDir = process.env.CLAUDE_CONFIG_DIR;
const turns = [];

function record(entry) {
  if (configDir)
    appendFileSync(
      join(configDir, "fake-claude.jsonl"),
      `${JSON.stringify({ pid: process.pid, sessionId, ...entry })}\n`,
    );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(requestId, response) {
  send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

const CONTROL_RESPONSES = {
  initialize: {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {},
    pid: process.pid,
  },
  get_context_usage: { mcpTools: [] },
  mcp_status: { mcpServers: [] },
};

function answer(prompt) {
  const reply = `Fake reply to: ${prompt}`;
  const envelope = { session_id: sessionId, parent_tool_use_id: null };
  const stream = (event) =>
    send({ type: "stream_event", event, uuid: randomUUID(), ...envelope });
  const messageId = `msg_${randomUUID()}`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (turns.length === 0)
    send({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: sessionId,
      cwd: process.cwd(),
      model: MODEL,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
      permissionMode: "default",
      apiKeySource: "none",
      output_style: "default",
      claude_code_version: "fake",
    });
  turns.push(prompt);
  stream({ type: "message_start", message: { id: messageId, usage } });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: reply },
  });
  stream({ type: "content_block_stop", index: 0 });
  send({
    type: "assistant",
    uuid: randomUUID(),
    ...envelope,
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      usage,
    },
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: randomUUID(),
    session_id: sessionId,
    result: reply,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage,
    permission_denials: [],
    modelUsage: {
      [MODEL]: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        contextWindow: 200_000,
      },
    },
  });
  send({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function promptText(message) {
  const { content } = message.message ?? {};
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
}

record({
  started: true,
  resumed: resumed !== undefined,
  model: flag("--model"),
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_request")
    respond(
      message.request_id,
      CONTROL_RESPONSES[message.request?.subtype] ?? {},
    );
  else if (message.type === "user") answer(promptText(message));
});
input.on("close", () => {
  record({ exited: true, turns });
  process.exit(0);
});
