import type { AgentTool, ToolSideEffects } from "../mcp/tool.ts";

export type PiBackgroundToolDefinition = Pick<
  AgentTool,
  "name" | "label" | "description" | "parameters"
> & { sideEffects: ToolSideEffects };

export const PI_BACKGROUND_BASH_TOOL_DEFINITION = {
  name: "bash",
  label: "bash",
  description:
    'Execute a bash command in the current working directory. Returns stdout and stderr. Output uses pi\'s upstream truncation contract.\n\nSet run_in_background to true to start PA-supervised work and return its task id immediately. It notifies you exactly ONCE, at exit, pointing at the captured output file rather than pasting it; nothing is pushed while it runs. So use it for a command that ends on its own (build, test run, install) or for one condition: `until grep -q "Ready in" dev.log; do sleep 0.5; done`. Start a long-lived server this way and wait for readiness in a separate task. Use monitor when you need one notification per occurrence.',
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in seconds (optional, no default timeout)",
      },
      run_in_background: {
        type: "boolean",
        description: "Start governed background work and return immediately",
      },
      description: {
        type: "string",
        maxLength: 200,
        description:
          'ONLY with run_in_background: a short human title for the background job, shown wherever the job is listed (e.g. "Start dev server"). Omit it for ordinary foreground calls; it has no effect there.',
      },
    },
  },
  sideEffects: "none",
} satisfies PiBackgroundToolDefinition;

export const PI_MONITOR_TOOL_DEFINITION = {
  name: "monitor",
  label: "Monitor",
  description:
    'Start a governed command or WebSocket monitor. Each stdout line is an event and becomes a notification while you keep working; events are not replies from the user. Exactly one of command or ws.\n\nPick by how many notifications you need:\n- ONE ("tell me when the build finishes") → not this tool. Use bash run_in_background with a command that exits when the condition holds: `until grep -q "Ready in" dev.log; do sleep 0.5; done`.\n- One PER OCCURRENCE ("every time an ERROR appears") → monitor, unbounded (`tail -f`, `inotifywait -m`, `while true`) or ending on its own once the last event is in.\n\nThere is no filter parameter: stdout IS the event stream, so emit only the lines you would act on.\n\n  tail -f /var/log/app.log | grep --line-buffered "ERROR"\n\nNever pipe raw logs. A server or build log notifies every few seconds and every notification is a full turn, so PA stops a monitor that exceeds its sustained rate and tells you — you then re-arm it with a tighter filter.\n\nNever use an unbounded command for one notification: `tail -f`/`while true` never exit, so the monitor stays armed until its deadline after the event fired. `grep -m 1` does not fix it — if the log goes quiet after the match, tail never gets SIGPIPE.\n\nSilence is not success. Match every terminal state, not just the happy path: filtering for the success marker alone stays silent through a crash, a hang or an OOM, which looks identical to still running. Prefer `grep -E --line-buffered "progress=|Traceback|Error|FAILED|Killed|OOM"`, emit on every terminal status in a poll loop, and broaden the alternation rather than narrow it when unsure.\n\nAlso: every pipe stage must flush per line or matches sit unseen (grep --line-buffered, awk fflush(); head cannot flush at all); poll loops survive transient failures (`curl … || true`) and poll remote APIs no faster than 30s; stderr reaches the output file but notifies nothing, so merge it with 2>&1 to filter it; description appears in every notification, so write "errors in deploy.log", not "watching logs".\n\nLines arriving within 200ms batch into one notification. Persistent monitors survive turn completion and session eviction but keep their frozen PA deadline; stop one early with background_tasks.\n\nws opens a WebSocket and streams each text frame as an event — no shell, no polling, binary frames placeholdered, close ends the watch. Prefer it over `websocat`, and subscribe to a filtered feed where one exists: the same rate limit applies.',
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["description", "timeout_ms", "persistent"],
    oneOf: [{ required: ["command"] }, { required: ["ws"] }],
    properties: {
      description: { type: "string", minLength: 1, maxLength: 200 },
      timeout_ms: { type: "number", minimum: 1 },
      persistent: { type: "boolean" },
      command: { type: "string", minLength: 1 },
      ws: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 1 },
          protocols: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  sideEffects: "local",
} satisfies PiBackgroundToolDefinition;

export const PI_BACKGROUND_TOOL_DEFINITIONS: PiBackgroundToolDefinition[] = [
  PI_BACKGROUND_BASH_TOOL_DEFINITION,
  PI_MONITOR_TOOL_DEFINITION,
];
