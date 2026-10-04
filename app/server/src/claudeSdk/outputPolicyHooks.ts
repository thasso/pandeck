import type { ClaudeSdkOptions } from "./sdkSeam.ts";
import {
  addArtifactNotice,
  boundNativeOutput,
  fullOutputPathFromUnknownToolOutput,
  persistOutputArtifact,
  prepareReadWindow,
  readResultMetadataFromUnknownToolOutput,
  replaceUnknownToolOutputText,
  textFromUnknownToolOutput,
  type ReadWindowDecision,
} from "../outputPolicy.ts";
import { childProcessEnv } from "../subprocessEnv.ts";

const POLICY_TOOLS = new Set(["Read", "Bash", "Grep", "Glob"]);

export interface ClaudeQueryLifecycleHooks {
  preToolUse(input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  }): Promise<
    /** `context` reaches the model beside the call (the job's PA id). */
    { allowed: true; context?: string } | { allowed: false; reason: string }
  >;
  stop(
    tasks: Array<{
      id: string;
      type: string;
      status: string;
      description: string;
      command?: string;
    }>,
  ): void;
  postCompact(summary: string): void;
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandFrom(value: unknown): string {
  const input = recordInput(value);
  return typeof input.command === "string" ? input.command.trim() : "";
}

function isConflictCommand(command: string): boolean {
  return /\bgit\s+(?:rebase|merge|cherry-pick)\b/.test(command);
}

/** Native output hooks for one Claude query. Maps are query-local by design. */
export function claudeOutputPolicyHooks(
  sessionId: string,
  lifecycle?: ClaudeQueryLifecycleHooks,
): NonNullable<ClaudeSdkOptions["hooks"]> {
  const reads = new Map<string, ReadWindowDecision>();
  return {
    PreToolUse: [
      {
        hooks: [
          async (input, toolUseId) => {
            if (input.hook_event_name !== "PreToolUse")
              return { continue: true };
            const resolvedToolUseId = toolUseId ?? input.tool_use_id;
            if (lifecycle) {
              const admission = await lifecycle.preToolUse({
                toolName: input.tool_name,
                toolInput: recordInput(input.tool_input),
                toolUseId: resolvedToolUseId,
              });
              if (!admission.allowed)
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: admission.reason,
                  },
                };
              if (admission.context)
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    additionalContext: admission.context,
                  },
                };
            }
            if (input.tool_name !== "Read") return { continue: true };
            const decision = await prepareReadWindow(
              recordInput(input.tool_input),
              input.cwd,
            );
            reads.set(resolvedToolUseId, decision);
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                updatedInput: decision.input,
              },
            };
          },
        ],
      },
    ],
    ...(lifecycle
      ? {
          Stop: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "Stop")
                    lifecycle.stop(
                      (input.background_tasks ?? []).map((task) => ({
                        id: task.id,
                        type: task.type,
                        status: task.status,
                        description: task.description,
                        ...(task.command ? { command: task.command } : {}),
                      })),
                    );
                  return { continue: true };
                },
              ],
            },
          ],
          PostCompact: [
            {
              hooks: [
                async (input) => {
                  if (
                    "compact_summary" in input &&
                    typeof input.compact_summary === "string"
                  )
                    lifecycle.postCompact(input.compact_summary);
                  return { continue: true };
                },
              ],
            },
          ],
        }
      : {}),
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (
              input.hook_event_name !== "PostToolUse" ||
              !POLICY_TOOLS.has(input.tool_name)
            )
              return { continue: true };
            const raw = textFromUnknownToolOutput(input.tool_response);
            if (!raw) return { continue: true };
            const readDecisionValue = reads.get(input.tool_use_id);
            const readResultValue = readResultMetadataFromUnknownToolOutput(
              input.tool_response,
            );
            let bounded = boundNativeOutput({
              toolName: input.tool_name,
              toolInput: recordInput(input.tool_input),
              raw,
              ...(input.tool_name === "Bash" ? { exitCode: 0 } : {}),
              ...(input.tool_name === "Read"
                ? {
                    ...(readDecisionValue !== undefined
                      ? { readDecision: readDecisionValue }
                      : {}),
                    ...(readResultValue !== undefined
                      ? { readResult: readResultValue }
                      : {}),
                  }
                : {}),
            });
            reads.delete(input.tool_use_id);
            if (bounded.elided) {
              const sourcePath = fullOutputPathFromUnknownToolOutput(
                input.tool_response,
              );
              const artifact = await persistOutputArtifact({
                sessionId,
                toolName: input.tool_name,
                raw,
                ...(sourcePath ? { sourcePath } : {}),
              });
              bounded = addArtifactNotice(bounded, artifact);
            }
            if (bounded.text === raw) return { continue: true };
            const updatedToolOutput = replaceUnknownToolOutputText(
              input.tool_response,
              bounded.text,
            );
            if (updatedToolOutput === undefined) return { continue: true };
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PostToolUse" as const,
                updatedToolOutput,
              },
            };
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input) => {
            if (
              input.hook_event_name !== "PostToolUseFailure" ||
              input.tool_name !== "Bash"
            )
              return { continue: true };
            const command = commandFrom(input.tool_input);
            const guidance = [
              command
                ? `Failed command: ${command}`
                : "Native Bash command failed.",
              isConflictCommand(command)
                ? "Bounded conflict diagnostics: run git status --short; git diff --name-only --diff-filter=U; then git diff --cc -- <path>."
                : "Inspect the bounded failure tail; use the reported full-output file for targeted diagnostics when present.",
            ].join("\n");
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PostToolUseFailure" as const,
                additionalContext: guidance,
              },
            };
          },
        ],
      },
    ],
  };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(childProcessEnv()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** Tight vendor caps are a first line of defence; hooks add context-aware policy. */
export function withClaudeOutputBudgetEnvironment(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...(env ?? inheritedEnvironment()),
    BASH_MAX_OUTPUT_LENGTH: "12000",
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "3000",
    MAX_MCP_OUTPUT_TOKENS: "5000",
    TASK_MAX_OUTPUT_LENGTH: "12000",
    ENABLE_MCP_LARGE_OUTPUT_FILES: "true",
  };
}
