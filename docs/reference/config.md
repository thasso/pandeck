# Committed config — implementation reference

Relocated from `config/CLAUDE.md` (Task-274) so it stops costing agent context
on every visit. This is a descriptive snapshot of what the modules in that
subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Static, committed application config: bootstrap config and prompt assets used by
server-side agents and workflows.

## Module ownership

- `app.json` is the neutral packaged default of the bootstrap/static config
  shape (`dataDir`, optional `publicBaseUrl`, static integration client
  identifiers); the committed file sets only `dataDir`. It is read-only at
  runtime and is bundled into packaged builds unless `ASSISTANT_CONFIG` or a
  config under `ASSISTANT_CWD` overrides it. A deployment's own values arrive
  through `ASSISTANT_CONFIG` — the Nix module renders its `settings` option and
  hands the same file to production and PR previews, so every instance still
  resolves the same integration client ids. `ASSISTANT_SLACK_APP_DISABLED=1` is
  the one switch that overrides that for the Slack app-level token and OAuth
  client id/secret (empty ahead of both file and environment), so only
  production holds the single permitted Socket Mode connection; see
  `docs/slack.md` and `docs/deployment.md`.
- `stt-models.json` owns the speech-to-text model catalog (id, label, language,
  download URL, SRI hash, archive prefix, expected file names) — static
  deployment metadata, not app-mutated state. It is the SINGLE source of truth
  read by three consumers: `flake.nix` via `builtins.fromJSON` (one
  `stt-model-<id>` package per entry), `scripts/install-stt-model.mjs` for local
  dev, and the server's `speech/sttConfig.ts` for labels and model-directory
  validation. Bumping or adding a model is a one-file edit and `nix build` fails
  loudly on a stale hash (`nix hash file --sri --type sha256 <tarball>`). Ids
  must stay free of `.` so `nix build .#stt-model-<id>` attr paths do not need
  quoting. Model WEIGHTS never live here or in `DATA_DIR` — they are Nix store
  paths injected as env.
- `instruction-budgets.json` owns the enforced numbers for agent instruction
  files (`CLAUDE.md`): the in-scope globs, per-file and path-chain byte budgets,
  the long-line backstop, the Prettier `printWidth`/`proseWrap` settings the
  repo-wide `.prettierrc.json` mirrors, and the exception-marker rules. It is
  repo tooling config, not application config: the only consumer is the budget
  check run from `pnpm run test` and CI. Rules and rationale live in
  `docs/instruction-docs.md`, which mirrors these numbers in prose — this file
  wins on conflict.
- `prompt-budgets.json` owns the enforced ceilings on what a session's first
  request carries, per persona and per harness: the `limits` (each a selector
  over the inventory's layers, so a narrower budget is a config edit rather than
  a code change), the warn threshold, the `measurement` normalizations the
  numbers were taken under, and the `raises` log that records every deliberate
  change with its reason. Like `instruction-budgets.json` it is repo tooling
  config with one consumer — `app/server/src/promptBudgets.ts`, which never
  hard-codes a number — and unlike it nothing mirrors the numbers in prose:
  `docs/prompt-budgets.md` carries the policy and points here.
- `prompts/` has a child contract for persona prompts. It is a PACKAGED asset
  directory: the server resolves it relative to `app/server/src/config.ts`'s own
  module URL (`PACKAGED_PROMPTS_DIR`), so a checkout, the Nix package and a PR
  preview all load their own tracked assets whatever `ASSISTANT_CWD` is.
  `ASSISTANT_PROMPTS_DIR` overrides the directory for development and must be
  absolute and existing. Details in `docs/reference/prompts.md`.

## Contract notes and rationale

- Nothing here may hold live, app-mutated state. User-editable settings are
  runtime state and live under `DATA_DIR/settings/app.json` (see
  `app/server/src/settings.ts`); defaults are the `DEFAULT_*` constants in that
  module. `app/server/src/config.ts` resolves `DATA_DIR` and exposes
  `SKILLS_LIBRARY_DIR` (`DATA_DIR/skills`, user-owned source) separately from
  `SKILLS_RUNTIME_DIR` (`DATA_DIR/skills-runtime`, generated output); neither is
  a separately configurable `app.json` field.
- A deployment's own static, NONSECRET integration parameters belong in the file
  `ASSISTANT_CONFIG` names, never in the packaged `app.json` (for example
  Google/Slack OAuth client ids, Slack workspace metadata/read defaults, the
  Atlassian/Jira host `jira.host`, the Tempo OAuth client id
  `tempo.oauthClientId`, or a public base URL). Client secrets and the Slack app
  token come only from the deployment environment variables in
  `docs/credential-distribution.md`. Runtime authorization results,
  refresh/bot/user tokens, browser cookies, and live user settings stay under
  `DATA_DIR/settings/`. Jira email/token live in `DATA_DIR/settings/jira.json`;
  Tempo OAuth tokens live in `DATA_DIR/settings/tempo.json`; Forgejo instance
  base URL + access token are user settings in `DATA_DIR/settings/forgejo.json`
  (Settings → Forgejo), not static config.
- Do not commit live user/session tokens or credential examples. Integration
  secrets (OAuth client secrets, the Slack app token) come ONLY from the named
  runtime environment variables, supplied through a private systemd
  `EnvironmentFile` (the Nix module's `tokenFile`); there is no config-file
  exception, packaged or not. `config.ts` uses only the four values
  `integrationSecrets.ts` captures (`docs/credential-distribution.md`).
- Treat prompt edits as behavior changes: update related tool/UI docs when
  prompt contracts reference rendered outputs or conventions.
- Keep JSON parseable and stable for server config loaders.

## Working notes

- Keep `app.json` limited to static deployment config; anything configurable
  from the app belongs in `DATA_DIR`, not here.
- When adding a new prompt file, update the server loader path and this index if
  it becomes a durable boundary.

## Verification commands

- Run root `pnpm run build` before closeout.
- Run root `pnpm run typecheck` when config changes affect typed settings or
  prompt-loading code.
