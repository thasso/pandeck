/**
 * The pi transcript of a stored app session, resolved through its active engine
 * binding's native id (`docs/session-runtime-switching.md` "Engine bindings").
 * A session without a binding (no row yet: a fresh pi session before its first
 * message, or a rowless transcript) is its own native id.
 */
import type { Harness } from "@assistant/shared";
import {
  activeBinding,
  type SessionEngineBinding,
} from "./db/sessionEngineBinding.ts";
import { piNativeFile } from "./sessionStorage.ts";

export function piSessionFile(appId: string): string {
  const binding = activeBinding(appId);
  const nativeId = binding ? PI_NATIVE_ID[binding.harness](binding) : undefined;
  return piNativeFile(appId, nativeId ?? appId);
}

/** A pi binding's native id; any other engine's binding names no pi file. */
const PI_NATIVE_ID: Record<
  Harness,
  (binding: SessionEngineBinding) => string | undefined
> = {
  pi: (binding) => binding.nativeSessionId,
  "claude-sdk": () => undefined,
};
