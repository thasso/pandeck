/**
 * The Claude CLI's child environment, from the base its host hands children
 * and the non-secret half of a credential profile. A leaf with no server
 * state: the server resolves the profile (`claudeProfileRuntime`), and whoever
 * starts the CLI applies it over its own base. It lives outside `claudeSdk/`
 * so `credentialProfiles.ts` composes from it without reaching an engine
 * folder (`harnessBoundary.test.ts`).
 */
import type { EngineGatewayAccess } from "./workerProtocol/engineMethods.ts";

/** What a Claude credential profile changes in the CLI's environment. */
export interface ClaudeProfileRuntime {
  /** `CLAUDE_CONFIG_DIR`; absent for the default profile's `~/.claude`. */
  configDir?: string;
}

/**
 * `base` without undefined entries. With a profile, provider switches and
 * credentials never leak from the service into it: only ordinary process
 * settings (PATH, locale, proxy, etc.) stay, and a named profile binds the CLI
 * to its config directory.
 */
export function claudeChildEnvironment(
  base: NodeJS.ProcessEnv,
  profile: ClaudeProfileRuntime | undefined,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) =>
        value !== undefined &&
        (!profile ||
          (!key.startsWith("ANTHROPIC_") &&
            !key.startsWith("CLAUDE_") &&
            !key.startsWith("AWS_") &&
            !key.startsWith("VERTEXAI_") &&
            key !== "GOOGLE_APPLICATION_CREDENTIALS")),
    ),
  ) as Record<string, string>;
  return profile?.configDir !== undefined
    ? { ...env, CLAUDE_CONFIG_DIR: profile.configDir }
    : env;
}

/**
 * `env` with the lease as the child's only credential, set last: the
 * gateway's Anthropic prefix and the lease as the OAuth token. `env` must be a
 * profile's, scrubbed of inherited credentials.
 */
export function claudeGatewayEnvironment(
  env: Record<string, string>,
  gateway: EngineGatewayAccess,
): Record<string, string> {
  return {
    ...env,
    ANTHROPIC_BASE_URL: `${gateway.baseUrl}/anthropic`,
    CLAUDE_CODE_OAUTH_TOKEN: gateway.leaseToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}
