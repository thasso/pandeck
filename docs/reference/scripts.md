# Repository scripts — implementation reference

Relocated from `scripts/CLAUDE.md` (Task-274) so it stops costing agent context
on every visit. This is a descriptive snapshot of what the modules in that
subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Repository utility scripts run from pnpm commands or manually by maintainers.

## Module ownership

- `measure-web-build.mjs` owns production web bundle size and cache-policy
  reporting after a build.
- `check-migrations-lock.mjs` owns the ACROSS-COMMITS half of the append-only
  migration guard: it reads `migrations.lock.json` at the merge base (`--base`,
  else `origin/main`) and fails when an entry was renamed, rehashed, or removed,
  or when two files claim one version. This is the only check that sees a
  migration renumbered during a rebase — the in-commit checks compare the lock
  with the files beside it, which a renumber leaves perfectly consistent while
  orphaning the version already applied to production. Passes when no base ref
  or no base lock resolves (a shallow clone), which is why CI checks out full
  history. Runs from `pnpm run check:migrations`, `pnpm run test`, and its own
  CI step. Contract: `docs/migrations.md`.
- `check-instruction-docs.mjs` owns enforcement of the instruction-document
  policy (`docs/instruction-docs.md`): it walks the in-scope `CLAUDE.md` files
  and checks per-file budgets, path-chain totals, the line-length backstop,
  exception markers, cross-file paragraph duplication, and the budget table
  mirrored in the policy doc. Every number comes from
  `config/instruction-budgets.json` — the script owns the rules, never the
  values, so a budget change is a config edit. Runs from
  `pnpm run check:instructions`, `pnpm run test`, and the CI `check` job;
  `--root <dir>` and `--config <path>` exist so its failure modes can be
  exercised against a fixture tree.
- `run-kb-tests.mjs` owns the focused KB regression test discovery runner used
  by `pnpm run test:kb`; it auto-includes `knowledge*.test.*` files plus
  explicitly selected cross-cutting Knowledge route/rendering tests.
- `install-stt-model.mjs` owns local speech-model installation
  (`pnpm run stt:model [<id>]`). It is a thin wrapper around
  `nix build --out-link` against `config/stt-models.json`, NOT a downloader: Nix
  already fetches and verifies the pinned hash (the same artifact prod gets),
  and `--out-link` both symlinks the store path into the
  `DATA_DIR/models/stt/<id>` slot the server probes (so no env var is needed)
  and registers an indirect GC root so collection cannot strand it. It creates a
  symlink, never a 631 MB copy, and honours `DATA_DIR` — beware that pointing
  that at the production data dir would write into a backed-up directory.
- The release utilities keep release preparation deterministic and reviewable.
  `set-version.mjs` updates all package manifests and the Nix package together;
  `generate-changelog.mjs` turns first-parent history since a selected or
  nearest tag into Task-grouped notes with Forgejo links and formats the result
  with the repository's Prettier; `release-notes.mjs` extracts one exact
  non-empty section for maintainer inspection via `pnpm run release:notes`.
  `release-check.mjs` (`pnpm run release:check <version> [--ref <ref>]`) owns
  the pre-publication gate that `tag-release.yml` used to run on its own
  checkout — every declaration equal to the version (it prints how many agreed),
  exactly one non-empty changelog section, and a target on the local
  `origin/main`'s first-parent history — and prints the target SHA plus those
  notes for the `forgejo_create_release` approval. It is read-only and never
  fetches, so a stale `origin/main` rejects a target rather than admitting a
  wrong one; `--root <dir>` exists only so the gate can be tested against a
  fixture repository. `release-utils.mjs` owns the shared SemVer,
  changelog-extraction, declaration-reading and first-parent predicates, with
  its Node test wired into the root test gate. It also owns the LIST of version
  declarations, in two kinds: manifests re-serialized from JSON, and
  declarations embedded in a larger file (the Nix package, and the native
  shell's `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`) patched by an
  anchored pattern that captures the version itself — `d`-flagged, so only the
  capture is rewritten and Prettier's or cargo's formatting around it survives.
  Every pattern must match exactly once or the run fails, and all reads and
  validations precede the first write, so a broken tree is never left
  half-bumped.

## Contract notes and rationale

- Keep scripts runnable from the repository root unless explicitly documented
  otherwise.
- Use portable Node APIs and clear error messages for missing generated
  prerequisites.
- Do not embed machine-local paths or secrets.

## Working notes

- Add package script entries in root `package.json` when a utility becomes a
  standard workflow.

## Verification commands

- Run the affected script when changing script behavior.
- Run `pnpm run test:kb` when changing the KB test discovery runner or Knowledge
  Base verification docs.
- Run root `pnpm run build` before closeout.
