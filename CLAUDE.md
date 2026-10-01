# Pandeck

Instruction files (`CLAUDE.md`) contain only binding rules. This file is
repo-wide; child files govern their subtrees. Update the nearest one when a
contract or durable user preference changes. Put everything else in `docs/`,
indexed by `docs/README.md` and governed by `docs/instruction-docs.md`. Update
the owning document with its product, API, or storage contract.
`docs/reference/` mirrors subtrees; it is never required reading or binding.

## Workspace

- `app/shared/` owns the wire model, `app/server/` the runtime and integrations,
  `app/web/` the browser client.
- `app/shell/` (the Rust/Tauri wrapper) is deliberately outside the pnpm
  workspace, Nix package and CI; build it locally.
- A protocol or model change lands across shared, server, and web in the same
  change.
- A domain migrated to state-change events (`docs/state-sync.md`; tasks is the
  pilot) travels as EVENTS: no full collection on any mutation reply or
  broadcast, snapshots only as the subscribe/resync answer, and the server's
  notify-with-touched-ids IS the revision bump.

## Dependencies

- Use pnpm 11 for every install and script; `pnpm-lock.yaml` is committed and a
  `package-lock.json` is never generated.
- `pnpm-workspace.yaml` owns the package globs, the allowed dependency build
  scripts, and the `catalog` of exact versions. A manifest references `catalog:`
  for external dependencies and `workspace:*` for `@assistant/*`, never a
  version literal.
- The app's OWN version is declared in several files; only
  `pnpm run version:set` writes them, and a new declaration belongs in
  `scripts/release-utils.mjs` so `release:check` guards it.
- Production Bun bundle changes (dev and tests run on Node) follow
  `docs/deployment.md#bun-package`.

## Quality gates

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
- Prettier owns formatting for every tracked TypeScript, Markdown, JSON, CSS,
  and YAML file: run `pnpm run format` and never hand-format against it. CI
  fails on `pnpm run format:check`.

## Boundaries

- `assistant-data/`, `node_modules/`, and `app/web/dist/` are generated or local
  runtime output: never edit them by hand or treat them as source of truth.
- Backwards compatibility is not required: legacy URL/route shapes and wire
  back-compat may be dropped rather than carried.
- `assistant-data/` holds the user's real data. Never wipe or reset it to avoid
  writing a migration; if a change would make persisted data unreadable, say so
  and let the user decide.
