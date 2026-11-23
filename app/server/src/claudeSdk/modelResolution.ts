/**
 * Which concrete Claude id an alias runs on one account
 * (`docs/agent-harnesses.md`, models port). Pure and persona-free: the bound
 * form that reads an account's listing lives in
 * `../harnesses/claudeModelResolution.ts`.
 */
import {
  claudeSdkModel,
  knownClaudeSdkModelAlias,
  type CuratedClaudeModel,
} from "./modelSettings.ts";

/**
 * The concrete id `alias` runs on an account whose listing is `listed`
 * (undefined: unknown), or undefined when that account does not offer it.
 *
 * - `pin` is the effective pinned id (a spawned agent's exact version), kept
 *   across accounts and never repointed.
 * - `persistedPin` is the session's stored `session_agent.pinnedModel`
 *   string, exactly as stored, passed only for an existing session. It lets an
 *   unknown account keep running a legacy pin of the session's own alias.
 *
 * A known account runs only what it lists. An unknown account runs a gated
 * alias (mythos) never; for the others it runs the newest candidate, a pin to
 * any candidate, or the session's own stored pin of that alias.
 */
export function resolveClaudeSdkModel(
  aliasOrId: string,
  listed: ReadonlySet<string> | undefined,
  pin?: string,
  persistedPin?: string,
): string | undefined {
  const model = claudeSdkModel(aliasOrId);
  if (pin !== undefined) return resolvePin(model, listed, pin, persistedPin);
  if (listed) return model.sdkModelIds.find((id) => listed.has(id));
  return model.offeredWhenUnknown ? model.sdkModelIds[0] : undefined;
}

function resolvePin(
  model: CuratedClaudeModel,
  listed: ReadonlySet<string> | undefined,
  pin: string,
  persistedPin: string | undefined,
): string | undefined {
  if (listed) return listed.has(pin) ? pin : undefined;
  if (!model.offeredWhenUnknown) return undefined;
  // A gated id never runs without a listing, under any alias or allowance.
  if (isMythosId(pin)) return undefined;
  if (model.sdkModelIds.includes(pin)) return pin;
  // A legacy pin: exactly the session's stored one, of its own alias.
  if (
    persistedPin !== undefined &&
    pin === persistedPin &&
    knownClaudeSdkModelAlias(pin) === model.id
  )
    return pin;
  return undefined;
}

function isMythosId(id: string): boolean {
  return knownClaudeSdkModelAlias(id) === "mythos";
}
