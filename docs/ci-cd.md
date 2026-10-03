# CI/CD

How `main` is gated and how a release is cut. CI is one GitHub Actions workflow,
`.github/workflows/ci.yml`, on GitHub-hosted runners. It never deploys: a
release is a `vMAJOR.MINOR.PATCH` tag, and how a deployment picks up a tag is
the operator's business. `docs/deployment.md` describes the Nix package and
NixOS module such a deployment builds.

## Workflow

`ci.yml` runs on every push to `main` and on every pull request, including
forks. The `pull_request` trigger has no `branches:` filter, so stacked work
whose base is an intermediate branch is gated like work against `main`. What a
non-`main` base changes is the comparison point of the two checks that only
history can decide: the workflow exports the PR's base commit as `PA_BASE_REF`
(`github.event.pull_request.base.sha`, empty on a push to `main`),
`check-migrations-lock.mjs` applies the append-only rule against it, and the
prompt-budget size baseline attributes growth against it. Both fall back to
`origin/main`/`main` when it is unset, which is what a local run and a push to
`main` get.

The jobs run in parallel, because a single job spent ten of its eleven minutes
in the test suites on two vCPUs:

- `check` — every gate except the server and web suites (see "Gates"). It is the
  only job that saves the pnpm store and the Prettier cache.
- `test-server (i/3)` and `test-web (i/2)` — the server and web suites, split by
  `vitest --shard`. Vitest orders the files by a hash of their path and slices
  them by count, so the split is stable until a test file is added, removed or
  renamed. Measured shards stay within about 30% of each other, and their sum
  matches the unsharded suite, so a shard costs only its ~25s of setup.
- `nix-build` — the production package `.#personal-assistant` (the Bun bundle,
  whose install check boots it under the packaged Bun) and the flake checks:
  closure policy, preview isolation and OOM policy of the NixOS module. The
  workspace suites run on Node, so this install check is CI's only run of the
  server under Bun (`docs/deployment.md#bun-package`).
- `nix-rebuild` — a second, independent build of the package on another runner.
  `reproducible` then compares the two NAR hashes. This replaced a
  `nix build --rebuild` step after the first build, which ran on the same runner
  and added about 2.5 minutes to the critical path; two runners also compare
  across machines, not only across time.
- `ci` — the gate, and the only check branch protection should require. It
  `needs:` every other job, runs on `always()` and fails unless every one of
  them reported `success`. Requiring the individual jobs instead would not be
  enough: a job skipped because its dependency failed (`reproducible` after a
  failed build) reports `skipped`, which GitHub counts as passing, and the
  matrix legs' names change with the shard count. `always()` rather than
  `!cancelled()` makes a cancelled run fail the gate instead of skipping it. A
  new job must be added to the gate's `needs:` or it gates nothing.

Every Node job runs `.github/actions/setup-workspace`: git identity, Node 24,
pnpm via corepack, the pnpm store restore and a frozen install. The suites pass
`--maxWorkers=100%`: Vitest defaults to one worker below the CPU count, a single
worker on the 2-vCPU private-repository runner, and one per CPU took the server
suite from 327s to 250s on two pinned SMT CPUs, while three or four workers
gained nothing and added memory (1.4 GB → 2.0 GB peak). The percentage scales to
the 4-vCPU runner public repositories get. `VITEST_MAX_WORKERS`, when set,
overrides the flag (Vitest reads it after the CLI), so CI must not set it.

The workflow has read-only repository permissions, uses no secrets, pins actions
to commit SHAs, and cancels superseded PR runs per ref. Active `main` runs are
not cancelled, preserving their verdict and cache saves. Job timeouts are 30
minutes for the Node jobs, 60 for the Nix builds and 5 for the comparison and
gate jobs. Before the repository goes public, it must require workflow approval
for all external contributors in its Actions settings. Dependabot checks only
GitHub Actions (workflows and the local composite action) weekly, groups updates
into one PR and applies a seven-day cooldown; the pnpm catalog remains manually
managed. There are no deployment, preview or release workflows.

## Gates

`check` runs, in order: `pnpm run check:package-config-secrets` →
`pnpm run format:check` → `pnpm run lint` → `pnpm run lint:deadcode` →
`pnpm run check:instructions` → `check-migrations-lock.mjs` →
`pnpm run check:prompts` → `pnpm run typecheck` → `pnpm run test:release`,
`pnpm run test:package-config-secrets` and the shared suite → `pnpm run build`.
The umbrella `pnpm run test` remains the local gate: it runs lint, the fast
repository checks and every suite. CI names those gates separately so a failure
says which one broke, and runs the server and web suites in their own jobs.

`pnpm run lint` (oxlint, `docs/linting.md`) takes about 5s on four CPUs at about
1.7 GB peak, so it needs no cache, no worker tuning and no heap flag. Under
type-aware ESLint it had its own job with an ESLint cache and a 5 GiB worker
heap, and the first hosted cold run was cancelled after 25 minutes (#3).

Three local layers are parallel, and each was measured rather than assumed.
`format` and `format:check` pass `--experimental-cli`, Prettier's parallel CLI:
the default one is single-threaded (~21s cold on a 24-core box) where this fans
out (~8s cold, ~1s warm). It was verified against the default CLI on this
repository — same matched file set, same `.prettierignore` handling, same exit
codes, same `--write` output. `typecheck` runs the three packages concurrently,
which halves it (~6.4s → ~3.0s) because TypeScript 7's native compiler uses ~2.7
cores for all three together. `pnpm run test:suites` runs the three workspace
suites concurrently after the release suite (45.5s → 37.5s on that box); that
gain is smaller than the arithmetic promises because the server and web suites
each already occupy ~14.5 of 24 cores, so the win is only their ramp-up and
ramp-down overlapping. On a 2-vCPU runner the fan-out buys nothing, which is why
CI shards across jobs instead. The package fan-outs use `--no-bail`, so every
failing package reports its errors instead of only the first. The cost is
interleaved output, prefixed by package name.

`pnpm run test` is recursive over the workspace. While iterating locally, narrow
it to the package you are changing — `pnpm --filter @assistant/server test` (or
`@assistant/web`, `@assistant/shared`), and
`pnpm --filter @assistant/server test <path>` for one file — then run the full
gate before handing the change over.

The runners are small and shared, so a test that asserts on how long something
took is asserting on the runner's spare capacity. The memory selector's
3,000-card guard measured 16ms of wall clock on an idle machine and 17ms, 113ms
and 188ms across three runs on a loaded one — against a 250ms bound. Assert CPU
time instead (`app/server/src/test/cpuBudget.ts`): the same three loaded runs
cost 26.5ms, 28.6ms and 31.0ms of it, because `process.cpuUsage()` does not
count the time the process spent off a core. It also does not count time in a
child process, on disk or on a timer, so where the work is not CPU-bound, assert
an ordering instead — that the cancelled read settled before the uncancelled one
did, rather than that it settled inside 2s.

## Caches

Two caches are restored: the pnpm content-addressed store (~194 MB packed,
before install, in `setup-workspace`) and Prettier's content-hash cache in
`node_modules/.cache/prettier` (~80 KB, in `check`). Both follow the same three
rules, and a new cache should follow them too.

**Restore and save are separate steps.** `actions/cache/restore` on every run,
`actions/cache/save` only on a push to `main` and only in `check` — so a PR run
never pays a save, and the shared entry tracks `main` rather than whichever
branch finished last. GitHub also scopes a PR's cache access to its merge ref,
which `main` could not restore from anyway. The save is additionally skipped
when the restore reported an exact `cache-hit`, because writing a key that
already exists is a warning and a wasted upload.

**Keys carry an ISO year-week** (`date -u +%G-%V`) so an entry expires on a
schedule. A key that never changes freezes the cache on the day it was first
written and lets its coverage decay as files change; a key carrying `github.sha`
goes to the opposite extreme and forces a save on every run. The week bucket
means the first `main` build of a week misses the exact key, restores the
previous week's entry through `restore-keys`, and saves the refreshed one.

**They are optimizations, never correctness.** Prettier and pnpm validate
restored entries by content hash, so a stale or missing cache is slower and
never wrong. A cache whose verdict depends on files outside its key does not
meet that bar: ESLint's did not, because a type-aware result depends on other
files, which is why it was restored on pull requests only while it existed. The
Nix jobs restore nothing for the same reason: `nix-store --import` of a cached
pnpm dependency store does not verify it against the derivation's output hash.

## Cutting a release

Pandeck uses Semantic Versioning: repository metadata contains the version
without `v`, while Git tags add it. The first Pandeck release is `v0.52.0`; it
continues Personal Assistant `0.51.0`, whose history and changelog stay in that
project. The package fields are private metadata rather than a registry
publishing contract, but they ARE what the app reports at runtime: the version
is what Settings → About and the desktop app's About panel show, paired with the
commit each part was built from (see "What a build says it is" below).

A release is prepared in a pull request like any other change, because `main` is
protected:

```bash
pnpm run version:set 0.53.0
pnpm run changelog:generate 0.53.0
```

`version:set` updates every version declaration in the tree as one operation:
the root, server, shared and web package manifests, the Nix package version, and
the native shell's `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. The shell
is outside the pnpm workspace and CI but not outside the release — its
declaration is what its About panel and its bundle carry, so a shell left behind
ships a release calling itself an older version. `changelog:generate` finds the
nearest first-parent tag, reads only first-parent commits after it, takes each
squash-merge subject (`Title (#N)`) as one entry with its PR link, groups titles
that start with `Task-NNN:` by Task, lists other commits with a commit link, and
runs Prettier on the result. Use `--base <ref>` to select a different boundary —
required whenever the previous version was never tagged, because the automatic
lookup finds the nearest tag and would otherwise reach back past it.

Review and edit the generated `CHANGELOG.md` — it is the release notes, so it
should say what a user needs to know, including upgrade notes such as a
migration that makes a downgrade need a backup. The release-preparation PR
itself cannot appear in notes generated before it exists; its version and
changelog diff are instead part of the tagged source. Merge it once `ci` is
green, then check the merged commit from an up-to-date `main` checkout:

```bash
git fetch origin && git merge --ff-only origin/main
pnpm run release:check 0.53.0            # add --ref <sha> to release an older commit
```

`release:check` is the gate before publication: every version declaration must
equal `0.53.0` (it prints how many agreed, so a new declaration added to
`scripts/release-utils.mjs` is visible in the output rather than silently
unchecked), `CHANGELOG.md` must hold exactly one non-empty section for it, and
the target must be on `origin/main`'s first-parent history, which `ci.yml`
gates. It reads the local `origin/main`, so fetch before trusting it, and it
writes nothing — it prints the target SHA and the notes.
(`pnpm run release:notes <version>` prints the section alone.)

Publication is the tag. Ask an agent for `git_publish_tag` with tag `v0.53.0` on
the main checkout at that SHA and approve the card it stages; nothing is pushed
before the approval, and the tool refuses to move an existing tag. A GitHub
Release is optional: paste the `release:notes` output into one for the tag if
you want the notes on the releases page.

Rolling back a deployment means deploying an older tag. Neither direction undoes
a data migration: `DATA_DIR`/SQLite changes made by the new version are not
reversed by running an older one, so a release that migrates persisted data
needs a backup taken before the upgrade to roll back (`docs/migrations.md`).
Rolling forward instead — revert the offending change on `main`, let CI confirm,
cut a new release — is the right move when the bad change should disappear from
the history.

## What a build says it is

Three runtimes are versioned and shipped independently — the browser bundle, the
server that served it, and the hand-installed native shell — so "which version
am I running" is three answers. Each carries a `BuildInfo`
(`app/shared/buildInfo.ts`): the declared version, the commit it was built from,
whether that commit is the release tag, and whether the tree was modified. They
are shown side by side in Settings → About, and the shell's own row is what its
native About panel prints.

None of the three can ask git at runtime — a bundle is static assets, the server
runs from an immutable store path, the shell is a signed binary — so the answer
is stamped in at build time:

- the browser bundle: a Vite `define` from `app/server/src/buildInfo.ts`, the
  one resolver, so the numbers in About are comparable rather than merely
  similar;
- the server: the same resolver at startup, memoized per process;
- the shell: `app/shell/build.rs` asks git and stamps `PA_BUILD_*` into the
  binary, which `app/shell/src/buildinfo.rs` reads back.

The commit comes from the environment first and git second. That order is what
makes a Nix build identifiable at all: `cleanSrc` is a gitignore-filtered copy
with no `.git`, so `flake.nix` passes `self.rev` in as `ASSISTANT_BUILD_COMMIT`
(both into the build, for the web bundle, and into the server's wrapper).

`release` is deliberately tri-state. `false` means the build is positively NOT
the tagged release and is displayed as `0.14.1-dev`; `undefined` means the build
could not tell, which is all a Nix build can honestly say, since it sees a
commit but no tags. A deployed server therefore reports `0.14.1 (<sha>)` and
never claims the tag it may or may not be sitting on — the sha is the identity.

Nothing else is added to the release itself: the browser bundle and the server
are stamped by the Nix build a deployment runs anyway. The DESKTOP app is the
one part a release does not produce — `app/shell/` is outside CI, so an
installed .app keeps saying whatever it was built from until it is rebuilt. To
ship the new version there, after the release is published:

```bash
git fetch --tags                        # the tag decides `-dev`, and it is read LOCALLY
git checkout v0.15.0                    # or main, if it is still the tagged commit
cd app/shell && cargo tauri build
```

Order matters only in that the tag must be present before the build: without it
the panel honestly reads `0.15.0-dev`. Fetching the tag after an earlier build
of the same commit is enough — `build.rs` watches `packed-refs`/`refs/tags`, so
the arriving tag re-runs the stamp instead of relinking the stale one.
