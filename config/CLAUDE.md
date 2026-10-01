<!-- instruction-budget: bytes=3200 reason="host-tools.json is a new committed contract whose two prohibitions are silent-failure modes: a vendored tool listed here measures the package's own copy, and an optional capability listed here turns a graceful degrade into a refused boot on every host lacking it. The file already held six binding rules at 96% of budget. deadcode-budgets.json then added a third budgets file whose numbers are a RATCHET rather than a ceiling — raising one silently re-opens the pool the gate exists to cap — and that direction is not inferable from the other two." task=545 date=2026-08-21 -->

# Committed config

- Nothing here may hold live, app-mutated state. User-editable settings are
  runtime state under `DATA_DIR/settings/`, whose defaults are the `DEFAULT_*`
  constants in `app/server/src/settings.ts`.
- `app.json` is the neutral packaged default: no deployment's hosts, client ids
  or URLs. A deployment brings its own through `ASSISTANT_CONFIG` (the Nix
  `settings` option). Authorization results, tokens and cookies stay under
  `DATA_DIR/settings/`. No committed or packaged config may contain a secret,
  even by explicit user choice; secrets use the deployment variables in
  `docs/credential-distribution.md`.
- `stt-models.json` is the SINGLE source of truth for the speech model catalog,
  read by `flake.nix`, the install script and the server. Model WEIGHTS never
  live here or in `DATA_DIR`; the nixosModule deploys none.
- `host-tools.json` declares binaries and version floors REQUIRED on the host
  PATH; a missing one fails startup in production. Never list what the package
  wrapper vendors (`git`, `ssh`), which measures the vendored copy rather than
  the host, nor an OPTIONAL capability, which turns a graceful degrade into a
  refused boot on every host lacking it.
- `instruction-budgets.json` holds the enforced instruction-doc numbers and is
  read by `scripts/check-instruction-docs.mjs`, which never hard-codes them;
  `docs/instruction-docs.md` mirrors them in prose, this file wins on conflict,
  and the checker fails on drift between the two.
- `prompt-budgets.json` holds the enforced per-persona prompt and tool-block
  ceilings; `app/server/src/promptBudgets.ts` never hard-codes one, and changing
  a number takes a `raises` entry in the same file.
- `deadcode-budgets.json` holds the enforced knip finding counts;
  `scripts/check-deadcode.mjs` never hard-codes one. Each is a high-water mark:
  lower it with a `changes` entry, delete the entry at zero, never raise one.
- A prompt edit under `prompts/` is a product behaviour change: keep tool names,
  render kinds and UI conventions synchronized with the server tools and web
  renderers, and never instruct an agent to expose secrets or bypass a
  confirmation gate.
- `prompts/` is a PACKAGED asset directory: the server resolves it from its own
  module path, never from a working directory or session project, and a tracked
  asset that fails to load is fatal rather than replaced by built-in text. Every
  persona asset stays tracked so it ships; `ASSISTANT_PROMPTS_DIR` (absolute,
  existing) is the only override.
