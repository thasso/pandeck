/**
 * In-process adapter: the app's harness-neutral {@link AgentTool}s → pi
 * `ToolDefinition`s for `customTools`. This replaced the former MCP client
 * bridge (`mcpToolBridge.ts`): no MCP hop, no `_meta` smuggling, no client
 * timeout to override — `ctx.progress` maps to pi `onUpdate`,
 * `details`/`terminate` map 1:1, and a thrown error is pi's failure contract
 * too. The session MCP server remains for the Claude harness (and future
 * external MCP clients) only.
 *
 * An interactive session's app tools run on the server: their definitions
 * send each call through the session's Worker (`appTools`), and the server
 * applies the Plan gate and `onExecute` there (`workers/appToolHost.ts`).
 * Every other tool — `find_tools` and the background shell tools — executes
 * here, with the gate applied here.
 *
 * Executing `find_tools` in-process is what makes pi's cache-friendly dynamic
 * tool loading work: when it additively activates more tools via
 * `setActiveToolsByName` DURING its execute window, pi's tool wrapper records
 * the added names on that tool result and natively defer-loads the
 * definitions on supported models.
 */
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { AppToolBinding } from "../workers/appToolHost.ts";
import type {
  AgentTool,
  AppToolExecutor,
  ToolResult,
  ToolSession,
} from "../mcp/tool.ts";

/*
 * NO constrained sampling here, deliberately. `constrainedSampling:
 * { type: "json_schema", strict: "prefer" }` looks safe but is not: pi's
 * `resolveJsonSchemaStrictSampling` gates only on the MODEL's strict capability
 * and never checks whether the SCHEMA is strict-compatible, and the codex/azure
 * responses adapters default that capability to true. The provider then receives
 * `strict: true` alongside our unchanged schema and rejects the whole request
 * ("Invalid schema for function 'current_time': 'required' … Missing 'timeZone'"),
 * killing the turn before it starts. Our schemas use ordinary optional properties,
 * which OpenAI's strict subset forbids — see the Task on making this opt-in per
 * verified-compatible schema.
 */

/** Per-session context the adapter threads into every tool execution. */
export interface PiAgentToolAdapterConfig {
  /** Live session identity (sessionFile/title can appear after persistence). */
  session(): ToolSession;
  /** Return a policy denial message when this tool may not execute now. */
  unavailableReason?(tool: AgentTool): string | undefined;
  /** Called immediately before a tool executes. */
  onExecute?(name: string): void;
  /**
   * The app tools that run away from the engine, and how. For these the
   * executor's side applies the gate and `onExecute`, not the adapter.
   */
  appTools?: { routes: ReadonlySet<AgentTool>; execute: AppToolExecutor };
}

/** Adapt the persona's AgentTools into pi custom-tool definitions. */
export function toPiToolDefinitions(
  tools: AgentTool[],
  config: PiAgentToolAdapterConfig,
): ToolDefinition[] {
  return tools.map((tool) => toPiToolDefinition(tool, config));
}

function toPiToolDefinition(
  tool: AgentTool,
  config: PiAgentToolAdapterConfig,
): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.label,
    // No promptSnippet/promptGuidelines: an AgentTool carries no prompt extras
    // (Task-282), so pi's "Available tools:"/"Guidelines:" lists hold only its
    // own builtins and our rules ride the description/schema both harnesses read.
    description: tool.description,
    ...(tool.executionMode !== undefined
      ? { executionMode: tool.executionMode }
      : {}),
    parameters: toPiParameters(tool.parameters),
    async execute(toolCallId, params, signal, onUpdate) {
      const progress = onUpdate
        ? (partial: ToolResult) => onUpdate(toPiResult(partial))
        : undefined;
      if (config.appTools?.routes.has(tool))
        return toPiResult(
          await config.appTools.execute(
            tool.name,
            (params ?? {}) as Record<string, unknown>,
            {
              toolCallId,
              ...(signal !== undefined ? { signal } : {}),
              ...(progress !== undefined ? { progress } : {}),
            },
          ),
        );
      const unavailableReason = config.unavailableReason?.(tool);
      if (unavailableReason) throw new Error(unavailableReason);
      config.onExecute?.(tool.name);
      const result = await tool.execute(
        (params ?? {}) as Record<string, unknown>,
        {
          toolCallId,
          session: config.session(),
          ...(signal !== undefined ? { signal } : {}),
          ...(progress !== undefined ? { progress } : {}),
        },
      );
      return toPiResult(result);
    },
  });
}

/**
 * The server's binding for the app tools a pi session routes: by name, the
 * same Plan denial and `onExecute` the adapter applies to its local tools.
 * pi checks no active set at call time, so neither does this.
 */
export function piAppToolBinding(
  tools: readonly AgentTool[],
  config: PiAgentToolAdapterConfig,
): AppToolBinding {
  return {
    resolve: (name) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const unavailableReason = config.unavailableReason?.(tool);
      if (unavailableReason) throw new Error(unavailableReason);
      return tool;
    },
    session: () => config.session(),
    ...(config.onExecute ? { onExecute: config.onExecute } : {}),
  };
}

function toPiResult(result: ToolResult): AgentToolResult<unknown> {
  return {
    content: result.content as AgentToolResult<unknown>["content"],
    details: result.details,
    ...(result.terminate ? { terminate: true } : {}),
  };
}

/**
 * The pi `parameters` schema for a tool. Our native tools carry plain
 * self-contained JSON Schema, which pi (TypeBox is JSON-Schema-first) consumes
 * unchanged — preserving `additionalProperties: false` and friends exactly.
 * Only schemas using local refs (proxied external MCP tools) go through the
 * TypeBox conversion, which inlines `$defs`/`definitions`.
 */
function toPiParameters(schema: unknown): TSchema {
  if (!isRecord(schema)) return Type.Object({});
  return containsSchemaRefs(schema)
    ? jsonSchemaToTypeBox(schema)
    : (schema as TSchema);
}

/** Deep-scan a schema for `$ref` / `$defs` / `definitions` anywhere. */
function containsSchemaRefs(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSchemaRefs);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" || key === "$defs" || key === "definitions") return true;
    if (containsSchemaRefs(child)) return true;
  }
  return false;
}

/** Convert an MCP JSON Schema subset to a TypeBox schema for pi. */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  return convertSchema(schema, rootDefs(schema));
}

function convertSchema(
  schema: unknown,
  defs: Record<string, unknown>,
  seenRefs = new Set<string>(),
): TSchema {
  if (!schema || typeof schema !== "object") return Type.Any();
  const record = schema as Record<string, unknown>;

  if (typeof record["$ref"] === "string") {
    const ref = record["$ref"];
    const resolved = resolveLocalRef(ref, defs);
    if (resolved === undefined || seenRefs.has(ref)) return Type.Any();
    return convertSchema(resolved, defs, new Set([...seenRefs, ref]));
  }

  const variants =
    arrayOfSchemas(record["oneOf"]) ?? arrayOfSchemas(record["anyOf"]);
  if (variants)
    return Type.Union(
      variants.map((item) => convertSchema(item, defs, seenRefs)),
    );

  if (Array.isArray(record["enum"])) {
    const literals = record["enum"].map((value) =>
      value === null ? Type.Null() : Type.Literal(value as never),
    );
    return literals.length === 1 ? literals[0]! : Type.Union(literals);
  }

  const type = record["type"];
  if (Array.isArray(type)) {
    return Type.Union(
      type.map((item) =>
        convertSchema({ ...record, type: item }, defs, seenRefs),
      ),
    );
  }

  switch (type) {
    case "object":
      return convertObject(record, defs, seenRefs);
    case "array":
      return Type.Array(convertSchema(record["items"], defs, seenRefs));
    case "string":
      return Type.String(copyAnnotations(record));
    case "number":
      return Type.Number(copyAnnotations(record));
    case "integer":
      return Type.Integer(copyAnnotations(record));
    case "boolean":
      return Type.Boolean(copyAnnotations(record));
    case "null":
      return Type.Null();
    default:
      return Type.Any();
  }
}

function convertObject(
  record: Record<string, unknown>,
  defs: Record<string, unknown>,
  seenRefs: Set<string>,
): TSchema {
  const required = new Set(
    Array.isArray(record["required"])
      ? record["required"].filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const properties =
    record["properties"] && typeof record["properties"] === "object"
      ? (record["properties"] as Record<string, unknown>)
      : {};
  const mapped: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    const converted = convertSchema(value, defs, seenRefs);
    mapped[key] = required.has(key) ? converted : Type.Optional(converted);
  }
  return Type.Object(mapped, copyAnnotations(record));
}

function rootDefs(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  return {
    ...(isRecord(schema["definitions"]) ? schema["definitions"] : {}),
    ...(isRecord(schema["$defs"]) ? schema["$defs"] : {}),
  };
}

function resolveLocalRef(ref: string, defs: Record<string, unknown>): unknown {
  if (ref.startsWith("#/$defs/") || ref.startsWith("#/definitions/")) {
    const name = ref.split("/").pop();
    return name === undefined ? undefined : defs[name];
  }
  return undefined;
}

function arrayOfSchemas(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function copyAnnotations(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const annotations: Record<string, unknown> = {};
  for (const key of [
    "description",
    "title",
    "default",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]) {
    if (record[key] !== undefined) annotations[key] = record[key];
  }
  return annotations;
}
