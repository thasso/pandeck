/**
 * Opt-in, content-free provider-payload prefix probe for `measure:tools`.
 *
 * Set ASSISTANT_TOOL_PAYLOAD_PROBE_FILE to a JSONL path before starting the
 * server. Real payloads are serialized only in memory; the probe persists
 * hashes, sizes, and adjacent common-prefix lengths, never request content.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function installToolPayloadProbe(session: AgentSession): void {
  const file = process.env.ASSISTANT_TOOL_PAYLOAD_PROBE_FILE?.trim();
  if (!file) return;
  const agent = session.agent as typeof session.agent & {
    onPayload?: (
      payload: unknown,
      model: { id?: string; api?: string },
    ) => unknown;
  };
  const previousHook = agent.onPayload;
  let previous = "";
  agent.onPayload = async (payload, model) => {
    const next = previousHook ? await previousHook(payload, model) : payload;
    try {
      const serialized = JSON.stringify(next ?? payload);
      const commonPrefixChars = commonPrefixLength(previous, serialized);
      const row = {
        at: Date.now(),
        sessionId: session.sessionId,
        model: model?.id,
        api: model?.api,
        chars: serialized.length,
        sha256: createHash("sha256").update(serialized).digest("hex"),
        previousChars: previous.length,
        commonPrefixChars,
        prefixRatio:
          previous.length > 0
            ? commonPrefixChars / Math.min(previous.length, serialized.length)
            : 0,
      };
      previous = serialized;
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      // Measurement must never break or mutate a real provider request.
    }
    return next;
  };
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}
