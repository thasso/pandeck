# Instruction Document Policy

Agent instruction files (`CLAUDE.md`) are loaded into agent context: the root
file on every provider request, a child file whenever an agent touches the
subtree it sits in. They are the most expensive prose in the repository, so they
carry only rules an agent must not violate. Everything else — architecture,
rationale, component catalogues, runbooks — belongs in `docs/`.

One rule governs maintenance: **update the nearest instruction file when a
contract changes.**

## Scope

Applies to every `CLAUDE.md` tracked in the repository; the exact
`include`/`exclude` globs are in `config/instruction-budgets.json`. Documents
under `docs/` and `README.md` have no size budget — they are read on demand and
are the intended destination for long-form material.

Do not add parallel instruction files (`AGENTS.md`, `.cursorrules`, …). One per
folder, named `CLAUDE.md`.

## Budgets

The enforced values live in `config/instruction-budgets.json` and are the source
of truth; the table below mirrors them, and the JSON wins if they ever disagree.

| Budget            |    Value | ~tokens | What it covers                                                                                              |
| ----------------- | -------: | ------: | ----------------------------------------------------------------------------------------------------------- |
| Root `CLAUDE.md`  |  4,096 B |  ~1,000 | Auto-loaded into every provider request                                                                     |
| Child `CLAUDE.md` |  2,048 B |    ~500 | Read when an agent touches that subtree                                                                     |
| Path chain        | 12,288 B |  ~3,000 | Root plus every ancestor file down to the folder — what one edit target costs before a line of code is read |

Bytes are the enforced unit: deterministic, tokenizer-independent, and about
four bytes per token. There is no separate line-count budget — at 80 columns the
byte budget already implies roughly 80 lines for root and 40 for a child.

The chain budget is absolute and takes no exceptions. A chain that fails has to
lose content somewhere along it, and the right fix is usually deleting a child
file rather than shaving every file in the chain. A file at 90% of its budget
produces a warning, not a failure.

## What justifies a child file

A child `CLAUDE.md` exists to state local contracts: rules an agent must follow
when changing that subtree. A statement is a local contract only if all four
hold:

1. It constrains how code here may be changed — it can be written as "must" or
   "never".
2. It is not obvious from reading the folder's code and tests.
3. Violating it causes a real defect or a rejected review, not just a different
   style.
4. It is not already stated by a parent file.

A folder with fewer than two such rules gets no file: fold the rule into the
parent, or drop it.

Not local contracts, and therefore not allowed: catalogues of the files or
components in the folder, descriptions of what a module renders or returns,
explanations of why the architecture is shaped the way it is, change history,
and restatements of repo-wide gates such as `pnpm run test`. A single ownership
sentence ("this folder owns X; Y lives in Z") is fine; a bullet-per-module
inventory is not.

There is no mandated section order and no required sections. Never maintain an
index of child instruction files — the tooling already surfaces them, and a
hand-written index only goes stale. A pointer to the folder's own
`docs/reference/` document does not belong in one either: the root file already
says `docs/reference/` is never required reading, and `docs/README.md` maps
every folder to its document.

## Formatting

Instruction files are formatted with Prettier at `printWidth: 80` and
`proseWrap: "always"` (settings mirrored in the `formatter` block of
`config/instruction-budgets.json`), so line length is a formatter concern rather
than a review concern. The budget check keeps a 120-character backstop for the
lines Prettier will not wrap by itself; table rows, fenced code, and the
exception marker below (one unwrappable HTML comment) are exempt from it.

The same `.prettierrc.json` covers the whole repository — TypeScript, Markdown,
JSON, CSS, YAML — so there is one formatter and one width for everything an
editor might format on save; `.prettierignore` carves out generated output and
machine-written manifests. `pnpm run format` writes, `pnpm run format:check`
verifies, and CI runs the check.

## Exceptions

A file that genuinely cannot meet its budget declares an exception on its first
line:

```
<!-- instruction-budget: bytes=3600 reason="..." task=274 date=2026-07-30 -->
```

- `bytes` is the allowance being claimed and may not exceed twice the budget for
  that file's tier. Anything larger is a relocation job, not an exception.
- `reason` says what would be lost by shrinking the file. "Too much content" is
  not a reason.
- `task` and `date` record who agreed to it and when.
- A stale marker fails the check: once the file fits its normal budget, the
  marker must go.

Exceptions are per-file. The chain budget still applies, so an exception spends
headroom that the rest of its chain then has to give up.

## Enforcement

`scripts/check-instruction-docs.mjs` reads `config/instruction-budgets.json` and
runs from `pnpm run test` (also as `pnpm run check:instructions`) and the
`check` CI job. It fails on a per-file budget exceeded without a valid
exception, a chain budget exceeded, an over-long line, and a malformed or stale
exception marker — including a marker below line 1, where it would be silently
ignored. A file or chain at 90% of its budget warns and still exits 0.

Two consistency checks come with it. The budget table above is compared against
the JSON, so the prose cannot drift from the enforced numbers, and a paragraph
repeated verbatim in two instruction files is reported as a warning: state it
once in the nearest shared parent. Both are configured in the JSON
(`docsMirror`, `duplication`); the duplication check's `severity` can be raised
to `error` or set to `off`.

The checker takes `--root <dir>` to scan a directory other than the repository
(used to verify that it actually fails on an oversized file) and
`--config <path>` to point at another budget file.

The pre-rewrite baseline, measured on 2026-07-30 before this policy existed, was
31 files, 486 KB total, root at 17.6 KB, worst chain 165 KB. That is the whole
record worth keeping; the per-file inventory behind it is reproducible by
running the checker against any older revision (`git worktree add` plus
`node scripts/check-instruction-docs.mjs --root <dir>`), which prints every file
with its budget usage, the total, and the worst chain.
