import { SCRUBBED_INTEGRATION_SECRET_ENV_VARS } from "./integrationSecrets.ts";

/**
 * Variables that bind a process to THIS instance: its data directory, its
 * listening socket, its API token. The systemd unit exports them (`flake.nix`),
 * and every agent session the server starts inherits the server's environment
 * wholesale — pi sessions run in-process, and the Claude CLI and its Bash tool
 * are ordinary children. An agent therefore used to see `DATA_DIR` pointing at
 * production while working inside its own worktree.
 *
 * That is not hypothetical: it is how a feature branch's migration reached the
 * production database. An agent ran a dev server from its worktree without
 * overriding `DATA_DIR`, `runMigrations` opened `/home/alice/assistant-data` and
 * applied the branch's `0042`, the branch was rebased the next morning and its
 * migration renumbered to `0043`, and the following release crash-looped
 * against a checksum no shipped file could produce.
 *
 * `config.ts`, `authToken.ts`, `buildInfo.ts` and `index.ts` each read these
 * ONCE into module constants while the server is still starting. Afterwards the
 * process has no use for them, so we delete them before the first agent can
 * exist. Integration secrets are stricter: `integrationSecrets.ts` deletes
 * their variables immediately as it captures them. A child that means to act
 * on this instance's data now has to say so
 * (`DATA_DIR=/home/alice/assistant-data …`), which is also the audit trail we want.
 *
 * Removing the default is not the same as making the explicit form safe — the
 * migration ownership guard in `db/index.ts` is what stops an override from
 * writing unshipped schema into a deployed database.
 */

/**
 * Instance-scoped variables, deleted from `process.env` once the server has
 * resolved its own configuration. Deliberately NOT the whole `ASSISTANT_*`
 * space: `ASSISTANT_STT_*` names host-provided recognizer and model locations,
 * not instance identity or a core-only credential.
 */
export const INSTANCE_OWNED_ENV_VARS = [
  "ASSISTANT_ALLOWED_ORIGINS",
  "ASSISTANT_BACKGROUND_FETCH",
  "ASSISTANT_BACKGROUND_PR_SYNC",
  // Which commit THIS server was packaged from. Inherited, it would make a dev
  // server started from a worktree report production's build as its own — the
  // same misattributed identity as the rest of this list, in the one place whose
  // whole job is to say which build you are looking at. `buildInfo.ts` is read
  // into a module constant before the scrub, like every other reader here.
  "ASSISTANT_BUILD_COMMIT",
  // Optional override for THIS server's Claude SDK executable. Runtime assets
  // capture it before the scrub; a worktree server must choose its own CLI.
  "ASSISTANT_CLAUDE_CLI_BIN",
  // THIS deployment's integration config (Nix `settings`). Inherited, it would
  // outrank a worktree server's own config/app.json and point it at
  // production's Atlassian site, Slack workspace and OAuth clients.
  "ASSISTANT_CONFIG",
  "ASSISTANT_CWD",
  "ASSISTANT_HOST",
  "ASSISTANT_PORT",
  "ASSISTANT_PUBLIC_BASE_URL",
  // Immutable files belonging to THIS packaged server. Runtime-asset modules
  // capture it before this scrub; inheriting it would make a worktree server
  // use production web/config/migrations and misclassify itself as packaged.
  "ASSISTANT_RUNTIME_DIR",
  "ASSISTANT_TOKEN",
  // THIS server's APNs key; a worktree server must never push as production.
  "APNS_CREDENTIAL_FILE",
  ...SCRUBBED_INTEGRATION_SECRET_ENV_VARS,
  "DATA_DIR",
] as const;

/**
 * Delete the instance-owned and core-only credential variables from this
 * process's environment and return the names that were actually set. Call once,
 * after configuration is resolved and before anything can spawn an agent.
 */
export function scrubInstanceEnvironment(): string[] {
  const removed: string[] = [];
  for (const name of INSTANCE_OWNED_ENV_VARS) {
    if (process.env[name] === undefined) continue;
    delete process.env[name];
    removed.push(name);
  }
  return removed;
}
