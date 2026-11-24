# Pandeck

`CLAUDE.md` files contain only binding rules: this one is repo-wide; children
govern subtrees. Update the nearest when contracts or durable user preferences
change. Put everything else in `docs/`, indexed by `docs/README.md` and governed
by `docs/instruction-docs.md`. Update the owning document with its product, API,
or storage contract. `docs/reference/` mirrors subtrees; it is never required
reading or binding.

## Workspace

- Use Claude implementer and reviewer subagents.
- `app/shared/` owns the wire model, `app/server/` the runtime and integrations,
  `app/web/` the browser client.
- `app/shell/` (the Rust/Tauri wrapper) is deliberately outside the pnpm
  workspace and Nix package; only `desktop.yml` builds it.
- A protocol or model change lands across shared, server, and web in the same
  change.
- A domain migrated to state-change events (`docs/state-sync.md`; tasks is the
  pilot) travels as EVENTS: no full collection on any mutation reply or
  broadcast, snapshots only as the subscribe/resync answer, and the server's
  notify-with-touched-ids IS the revision bump.

## Dependencies

- Use pnpm 11; commit `pnpm-lock.yaml`, never generate `package-lock.json`.
- `pnpm-workspace.yaml` owns package globs, allowed dependency build scripts and
  the exact-version `catalog`. Manifests use `catalog:` for externals and
  `workspace:*` for `@assistant/*`, never literal versions.
- Only `pnpm run version:set` writes app versions. Add new declarations to
  `scripts/release-utils.mjs` so `release:check` guards them.
- Production Bun bundle changes (dev and tests run on Node) follow
  `docs/deployment.md#bun-package`.

## Quality gates

- Fix macOS product gaps; adapt only platform-bound fixtures. Never weaken
  assertions or filesystem, credential and process safety for green CI.
- `pnpm run test` runs the test gate.
- `pnpm run test:kb` runs the focused fast Knowledge Base regression and
  token/performance audit.
- `pnpm run build` produces the production web bundle.
- `pnpm run typecheck` is required whenever server or shared TypeScript changes.
- `pnpm run lint` BLOCKS: a rule too costly to adopt today is staged OFF with
  its measured count, never silenced per file or scattered as suppressions.
- `pnpm run lint:deadcode` gates every knip category at zero. Never set
  `ignoreExportsUsedInFile` in `knip.json`: it suppresses exactly "exported but
  only read in its own file", most of what this gate catches, and would leave it
  green forever. `docs/linting.md` is the contract for both.
- `pnpm run check:instructions` enforces the `CLAUDE.md` size budgets in
  `config/instruction-budgets.json`; `pnpm run test` and CI run it.
- `pnpm run check:prompts` enforces the per-persona prompt and eager-tool
  budgets in `config/prompt-budgets.json`. A breach is a decision, not a
  verdict: trim redundant text, or raise the budget with a `raises` entry — see
  `docs/prompt-budgets.md`. Never fit by deleting a rule agents need.
- Prettier owns tracked TypeScript, Markdown, JSON, CSS and YAML formatting. Run
  `pnpm run format`, never hand-format against it; CI gates `format:check`.

## Boundaries

- `assistant-data/`, `node_modules/`, and `app/web/dist/` are generated or local
  runtime output: never edit them by hand or treat them as source of truth.
- Backwards compatibility is not required: legacy URL/route shapes and wire
  back-compat may be dropped rather than carried.
- `assistant-data/` holds the user's real data. Never wipe or reset it to avoid
  writing a migration; if a change would make persisted data unreadable, say so
  and let the user decide.
