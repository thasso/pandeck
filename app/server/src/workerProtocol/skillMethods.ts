/**
 * The skill method of worker protocol 1.9: `skills.materialize` (Worker →
 * server) asks the server to materialize a frozen skill set from its library
 * into the content-addressed runtime the engine's loader reads, before every
 * loader reload (`docs/workers.md`). It names no session: the request writes
 * only the runtime for those names. The answer is `{}`; a set the server
 * cannot materialize fails with {@link SKILLS_UNAVAILABLE} and the
 * materializer's message.
 */
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

export const SKILL_METHODS = {
  /** Worker → server: materialize a frozen skill set. */
  materialize: "skills.materialize",
} as const;

/** The frozen skill set cannot be materialized; the message says why. */
export const SKILLS_UNAVAILABLE = "skills_unavailable";

export interface SkillMaterializeRequest {
  names: string[];
}

export function encodeSkillMaterialize(
  request: SkillMaterializeRequest,
): Payload {
  return { json: { names: [...request.names] } };
}

export function decodeSkillMaterialize(
  payload: Payload,
): SkillMaterializeRequest {
  const json = payload.json as { names?: unknown } | null;
  const names = typeof json === "object" && json !== null ? json.names : null;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
    throw new WorkerMethodError(INVALID_PARAMS, "Invalid skill names.");
  return { names: names as string[] };
}

/** The server answers `{}` once the runtime is in place. */
export function decodeSkillMaterialized(payload: Payload): void {
  const json = payload.json;
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Error(
      `The server answered a malformed ${SKILL_METHODS.materialize} result.`,
    );
}
