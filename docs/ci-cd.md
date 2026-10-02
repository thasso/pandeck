# CI/CD

The project's current Forgejo Actions pipeline that gates `main` and the
deliberate actions that ship it. It assumes a self-hosted Forgejo whose `native`
runner lives on the NixOS deploy host. What a deploy builds and switches to is
described in `docs/deployment.md`.

CI is automatic; deployment and version publication are not. Pushing to `main`
validates the commit and changes nothing that is running: production moves only
when someone dispatches the Release workflow or publishes a release, a versioned
source snapshot exists only after someone approves a release proposal, and a PR
preview exists only after someone dispatches the Preview workflow. Both paths
into Release require repository write access — that is the authorization model,
and the runner still never holds general root.

## GitHub Actions

`.github/workflows/ci.yml` is CI for the public `pandeck` repository. It runs on
GitHub-hosted `ubuntu-latest` runners for pushes to `main` and all pull
requests, including forks. It preserves the Forgejo gates, the migration lock
check, and the weekly pnpm and Prettier cache restores described below. Only
pushes to `main` save caches. Node 24 runs the workspace gates; Nix builds and
tests the Bun package, checks the closure and NixOS module policies, and
verifies reproducibility.

The jobs run in parallel, because a single job spent ten of its eleven minutes
in the test suites on two vCPUs:

- `check` — every gate except the server and web suites: format, lint, dead
  code, instruction and prompt budgets, migration lock, typecheck, the script
  and shared tests, and the web build. It is the only job that saves the pnpm
  store and the Prettier cache.
- `test-server (i/3)` and `test-web (i/2)` — the server and web suites, split by
  `vitest --shard` (equal file counts, ordered by path hash). Measured shards
  stay within about 30% of each other, and their sum matches the unsharded
  suite, so a shard costs only its ~25s of setup.
- `nix-build` — the package and its flake checks.
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

Every Node job runs `.github/actions/setup-workspace` (Node, corepack, pnpm
store restore, frozen install). The suites pass `--maxWorkers=100%`: Vitest
defaults to one worker below the CPU count, a single worker on the 2-vCPU
private-repository runner, and one per CPU took the server suite from 327s to
250s on two pinned SMT CPUs, while three or four workers gained nothing and
added memory (1.4 GB → 2.0 GB peak). The percentage scales to the 4-vCPU runner
public repositories get. `VITEST_MAX_WORKERS`, when set, overrides the flag
(Vitest reads it after the CLI), so CI must not set it.

`pnpm run lint` (oxlint, `docs/linting.md`) is a step of the `check` job. It
takes about 5s on four CPUs at about 1.7 GB peak, so it needs no cache, no
worker tuning and no heap flag. Under type-aware ESLint it had its own job with
an ESLint cache and a 5 GiB worker heap, and the first hosted cold run was
cancelled after 25 minutes (#3).

The workflow has read-only repository permissions, uses no secrets, pins actions
to commit SHAs, and cancels superseded PR runs per ref. Active main runs are not
cancelled, preserving their verdict and cache saves. Job timeouts are 30 minutes
for the Node jobs and 60 for the Nix builds. Before the public cut, the
repository must require workflow approval for all external contributors in its
Actions settings. Dependabot checks only GitHub Actions (workflows and local
composite actions) weekly, groups updates into one PR and applies a seven-day
cooldown; the pnpm catalog remains manually managed. There are no GitHub
deployment, preview or release workflows. The Forgejo pipeline remains for the
current deployment until the switch.

## Gates

CI (`.forgejo/workflows/ci.yml`) enforces the repository quality gates on push
to `main` and on pull requests, in a `node:24` container job on the Docker-based
runner (`runs-on: ubuntu-latest`). `check` runs `corepack enable` → restore
caches → `pnpm install --frozen-lockfile` →
`pnpm run check:package-config-secrets` → `pnpm run format:check` →
`pnpm run lint` → `pnpm run lint:deadcode` → `pnpm run check:instructions` →
`pnpm run check:prompts` → `pnpm run typecheck` → `pnpm run test:suites` →
`pnpm run build`. The umbrella `pnpm run test` remains the local gate and also
runs lint and the fast repository checks. CI names those gates separately and
uses `test:suites` to avoid running them a second time.

Three layers are parallel, and each was measured rather than assumed. `format`
and `format:check` pass `--experimental-cli`, Prettier's parallel CLI: the
default one is single-threaded (~21s cold on a 24-core box) where this fans out
(~8s cold, ~1s warm). It was verified against the default CLI on this repository
— same matched file set, same `.prettierignore` handling, same exit codes, same
`--write` output. `typecheck` runs the three packages concurrently, which halves
it (~6.4s → ~3.0s) because TypeScript 7's native compiler uses ~2.7 cores for
all three together. `pnpm run test:suites` runs the three workspace suites
concurrently after the release suite (45.5s → 37.5s); that gain is smaller than
the arithmetic promises because the server and web suites each already occupy
~14.5 of 24 cores, so the win is only their ramp-up and ramp-down overlapping.
The package fan-outs use `--no-bail`, so every failing package reports its
errors instead of only the first. The cost is interleaved output, prefixed by
package name.

`pnpm run test` is recursive over the workspace. While iterating locally, narrow
it to the package you are changing — `pnpm --filter @assistant/server test` (or
`@assistant/web`, `@assistant/shared`), and
`pnpm --filter @assistant/server test <path>` for one file — then run the full
gate before handing the change over.

Two caches are restored: the pnpm content-addressed store (~194 MB packed,
before install) and Prettier's content-hash cache in
`node_modules/.cache/prettier` (~80 KB). Both follow the same three rules, and a
new cache should follow them too.

**Restore and save are separate steps.** `actions/cache/restore@v4` on every
run, `actions/cache/save@v4` only on a push to `main` — so a PR run never pays a
save, and the shared entry tracks `main` rather than whichever branch finished
last. The save is additionally skipped when the restore reported an exact
`cache-hit`, because writing a key that already exists is a warning and a wasted
upload.

**Keys carry an ISO year-week** (`date -u +%G-%V`) so an entry expires on a
schedule. A key that never changes freezes the cache on the day it was first
written and lets its coverage decay as files change; a key carrying
`github.sha`, as an earlier version of this workflow used, goes to the opposite
extreme and forces a save on every run. The week bucket means the first `main`
build of a week misses the exact key, restores the previous week's entry through
`restore-keys`, and saves the refreshed one.

**They are optimizations, never correctness.** Prettier and pnpm validate
restored entries by content hash, so a stale or missing cache is slower and
never wrong. A cache whose verdict depends on files outside its key does not
meet that bar: ESLint's did not, because a type-aware result depends on other
files, which is why it was restored on pull requests only while it existed.

Restoring anything here depends on the runner's cache proxy being reachable from
the job container — see the caveat under `ci.yml` below before adding a cache
step.

The runner is shared and the gate layers are parallel, so a test that asserts on
how long something took is asserting on the runner's spare capacity. The memory
selector's 3,000-card guard measured 16ms of wall clock on an idle machine and
17ms, 113ms and 188ms across three runs on a loaded one — against a 250ms bound.
Assert CPU time instead (`app/server/src/test/cpuBudget.ts`): the same three
loaded runs cost 26.5ms, 28.6ms and 31.0ms of it, because `process.cpuUsage()`
does not count the time the process spent off a core. It also does not count
time in a child process, on disk or on a timer, so where the work is not
CPU-bound, assert an ordering instead — that the cancelled read settled before
the uncancelled one did, rather than that it settled inside 2s.

That container is `node:24-bookworm`, whose Debian git is **2.39** — older than
any current dev machine's. The worktree and merge suites shell out to git, so a
flag introduced after 2.39 (`show-ref --exists`, for one) passes locally and
fails only in CI. Prefer the portable spelling, and reproduce a git-related CI
failure in that container rather than on the host — as the host user, never the
default root, or the run leaves files in your checkout that only root can delete
(`docs/container-images.md#bind-mounts-and-file-ownership`):

    docker run --rm -it --user "$(id -u):$(id -g)" \
      -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack \
      -v "$PWD:/w" -w /w node:24-bookworm bash

## Workflows and jobs

Four workflows live in `.forgejo/workflows/`: automatic `ci.yml`, `release.yml`
(dispatch or a published release), plus the `workflow_dispatch` workflows
`preview.yml` and `ops.yml`. The `pull_request` trigger listens for
`opened/synchronize/reopened/closed`; `check`/`nix-build` skip the `closed`
action.

The `pull_request` trigger carries no `branches:` filter: a PR is gated whatever
it targets, so stacked work whose base is an intermediate branch is built like
work against `main`. The `push` trigger stays `main`-only — an intermediate base
branch is itself normally a PR, and is gated as one. What a non-`main` base
changes is the comparison point of the two checks that only history can decide,
so the `check` job exports the PR's base commit as `PA_BASE_REF`
(`github.event.pull_request.base.sha`, empty on a push to `main`):
`check-migrations-lock.mjs` applies the append-only rule against it, and the
prompt-budget size baseline attributes growth against it. Each falls back to
`origin/main`/`main` when it is unset, which is what a local run and a push to
`main` get. A check comparing against `main` on a stacked PR would judge this
change by the base branch's commits — a migration the base added, prompt growth
the base introduced.

Every job that touches the host runs on the `native` runner, which has
`NoNewPrivileges` (setuid sudo is blocked): it asks systemd over D-Bus to start
a fixed root oneshot, authorized by a narrow polkit rule scoped to
`gitea-runner` and those units. The commands are fixed in the units, so the
runner can only start them — it gets no other root.

### `ci.yml` — automatic, never deploys

A cache step here is only useful if the runner's cache proxy answers from inside
the job container. Jobs never talk to the cache server directly: they get a
one-time `ACTIONS_CACHE_URL` pointing at a proxy the runner binds on the host,
and the runner creates a fresh network per job, so that traffic arrives on a
`br-<id>` interface and needs both a fixed `cache.proxy_port` and a firewall
rule to survive. Where that is not configured, `actions/cache` does not fail —
it retries, times out after ~20s, reports a miss, and silently saves nothing, so
the only symptom is a job that is slower than its steps can explain. Check the
runner's cache directory for entries before trusting a cache step here.

- `check` — format-check/lint/dead-code/instruction/prompt/typecheck/test/build
  gates in a `node:24` Docker container.
- `nix-build` — builds the production package `.#personal-assistant` (the Bun
  bundle, whose install check boots it under the packaged Bun), its closure
  check, and the NixOS preview-isolation and OOM-policy checks on the `native`
  (host-backend) Forgejo runner, so the artifacts land in the deploy host's
  `/nix/store` and the flake is validated on the deploy platform. After that
  first build makes the output valid in the runner's store, a separate
  `--rebuild --keep-failed` step verifies that the package is reproducible. A
  later Release of that commit reuses that store artifact. The `check` job's
  tests run on Node, so this install check is CI's only run of the server under
  Bun (`docs/deployment.md#bun-package`).
- `pr-deploy` — `needs: [check, lint, nix-build]`, on PR open/sync/reopen.
  Refreshes the PR's preview by starting `pa-pr-deploy@<n>.service`, but ONLY if
  `pa-pr@<n>.service` is already `active`/`activating`/`reloading`/`failed`;
  otherwise it prints how to start one and exits 0. So pushing to a PR without a
  preview changes nothing, and a crashed preview is repaired by the next push.
- `pr-teardown` — no build gates, runs on PR `closed` (merge or close); starts
  `pa-pr-teardown@<n>.service`. Teardown stays automatic because it removes an
  environment rather than changing one, and it is idempotent, so it is harmless
  for a PR that never had a preview.

### Cutting a release — prepared on `main`, published by the agent tool

Pandeck uses Semantic Versioning: repository metadata contains the version
without `v`, while Git tags add it. Historical tags `v00001` and `v00002`
predate this scheme. `0.2.0` was prepared but never tagged, so the first SemVer
release is `v0.3.0`, and its tagged source covers every first-parent change
after `v00002` across both the `0.2.0` and `0.3.0` changelog sections. The
package fields are private metadata rather than a registry publishing contract,
but they ARE what the app reports at runtime: the version is what Settings →
About and the desktop app's About panel show, paired with the commit each part
was built from (see "What a build says it is" below).

Prepare a release directly in the main worktree on `main` — no release branch,
worktree, or pull request:

```bash
pnpm run version:set 0.3.0
pnpm run changelog:generate 0.3.0
```

`version:set` updates every version declaration in the tree as one operation:
the root, server, shared and web package manifests, the Nix package version, and
the native shell's `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. The shell
is outside the pnpm workspace and CI but not outside the release — its
declaration is what its About panel and its bundle carry, so a shell left behind
ships a release calling itself an older version. `changelog:generate` finds the
nearest first-parent tag, reads only first-parent commits after it, groups
Forgejo merge subjects by `Task-NNN`, adds PR links, records non-Task commits
separately, and runs Prettier on the result. Use `--base <ref>` to select a
different boundary — required whenever the previous version was never tagged,
because the automatic lookup finds the nearest tag and would otherwise reach
back past it.

Review the generated `CHANGELOG.md`, then commit and push `main` with `/commit`
and `/push`. Preparing on `main` means `ci.yml` runs on the pushed commit
instead of gating it beforehand, so run `pnpm run format:check`,
`pnpm run typecheck`, and `pnpm run test` before committing, and confirm CI is
green on the target SHA before publishing. The release-preparation commit itself
cannot appear in notes generated before that commit exists; its version and
changelog diff are instead part of the tagged source.

Then check the pushed tree and publish:

```bash
pnpm run release:check 0.3.0            # add --ref <sha> to release an older commit
```

`release:check` is the gate a workflow used to run on its own checkout: every
version declaration must equal `0.3.0` (it prints how many agreed, so a new
declaration added to `scripts/release-utils.mjs` is visible in the output rather
than silently unchecked), `CHANGELOG.md` must hold exactly one non-empty section
for it, and the target must be on `origin/main`'s first-parent history, which
`ci.yml` runs against. It reads the local `origin/main`, so fetch before
trusting it, and it writes nothing — it prints the target SHA and the notes.
(`pnpm run release:notes <version>` prints the section alone.)

Publication itself is an agent tool, `forgejo_create_release` (coding personas,
gate `forgejo`): ask for the release and approve the card it stages. Do not use
`git_publish_tag` for this repository's releases: it proposes a lightweight Git
tag without release notes or a release event, while this flow creates the
annotated tag and release together. Nothing is written during the model turn —
the approval is where a human decides to ship, because the published release is
what starts the deploy. The tool resolves the target to a COMMIT when it
proposes, so the tag lands on the revision that was approved even if `main`
moved meanwhile; it creates the annotated tag before the release (the release
endpoint would otherwise leave a lightweight one); and it refuses an existing
release outright, reusing an existing tag only when that tag already points at
the same commit.

This is deliberately not a workflow. A release published by a workflow token is
created by the Actions user, and Forgejo drops events whose doer is that user
(its cycle guard), so `release.yml` would never see it. Publishing with the
user's own token through the tool is what makes "cut a release" and "deploy it"
a single decision.

### What a build says it is

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
never claims the tag it may or may not be sitting on — the sha is the identity,
and the sha is what `release.yml` prints as shipped.

Nothing else is added to the release itself: the browser bundle and the server
are stamped by the build the deploy already runs. The DESKTOP app is the one
part a release does not produce — `app/shell/` is outside CI, so an installed
.app keeps saying whatever it was built from until it is rebuilt. To ship the
new version there, after the release is published:

```bash
git fetch --tags                        # the tag decides `-dev`, and it is read LOCALLY
git checkout v0.15.0                    # or main, if it is still the tagged commit
cd app/shell && cargo tauri build
```

Order matters only in that the tag must be present before the build: without it
the panel honestly reads `0.15.0-dev`. Fetching the tag after an earlier build
of the same commit is enough — `build.rs` watches `packed-refs`/`refs/tags`, so
the arriving tag re-runs the stamp instead of relinking the stale one.

### `release.yml` — the only path to production

**What ships is a release tag, never a branch head.** Two triggers, no inputs:
`release: types: [published]`, so that publishing a release — an agent creating
one, or a human in the UI — ships that release's own tag without a second
gesture; and `workflow_dispatch` (Actions → Release → Run workflow), which
redeploys the highest existing `vMAJOR.MINOR.PATCH` tag. The strict pattern
matters: the repo also carries non-release tags (`v00001`, `v00002`) that
`sort -V` would rank above every real version. Dispatch re-applies a release; it
is not a way to ship unreleased work — the host's manual
`personal-assistant-deploy` unit is that, and no polkit rule lets CI reach it.
One caveat comes with the release trigger: Forgejo reads the workflow file from
the **released commit**, so a release cut from a commit that predates this
trigger runs nothing.

It resolves the tag to a commit (a depth-1 fetch of `refs/tags/<tag>`, peeled
with `^{commit}` because the release tool creates annotated tags, so the log
carries the revision AND its subject) and builds that commit on the host with
`nix build .#personal-assistant` — the deploy's own build is then a store cache
hit — then starts `personal-assistant-release@<tag>.service`, streaming the
unit's journal into the job log (the runner service has `systemd-journal`
membership), printing a per-minute unit-state heartbeat, and failing with a
status dump after a 75m timeout instead of hanging silently. Finally it polls
`/api/health` on the port from the unit's own environment — an unreadable or
non-numeric `ASSISTANT_PORT` fails the run rather than falling back to a guess —
so a run is green only if the service came back, and prints the shipped tag,
revision and the production URL.

What the run reports as shipped is read back from the release unit's own
`Deploying personal-assistant <tag> (<rev>)` journal line rather than assumed,
and a mismatch against the commit this run built **fails** the release — with
the tag as the contract, the two can no longer legitimately differ.

Releases are serialized by a file lock (`/tmp/personal-assistant-release.lock`)
plus a wait for every switch-driving unit to fall idle inside it — this tag's
instance, any other `personal-assistant-release@*`, and the manual
`personal-assistant-deploy`. This is load-bearing: `systemctl start --wait`
against a unit whose start job is already running JOINS that job instead of
queueing a second execution, so two overlapping releases would otherwise both
report success while only the first one's revision shipped. One started in the
instant between the idle check and the start could still be joined — which is
the other reason the shipped tag is read from the journal rather than assumed.

The release unit and the other switch-driving oneshots are HOST configuration,
not part of this flake: the module only authorizes the runner to start them
(`docs/deployment.md#service-lifecycle-and-environment`). A host running this
pipeline provides `personal-assistant-release@<tag>.service`,
`personal-assistant-deploy.service` and
`personal-assistant-force-restart.service`, and the workflows depend on the
behavior below.

`personal-assistant-release@<tag>.service` is the deploy. It validates the tag
twice (shape, then charset) because the string reaches `sed`, a URL and a commit
message; resolves the tag on the remote, peeling `^{}` for annotated tags;
refuses to run when the host flake's `flake.nix` or `flake.lock` has uncommitted
changes, so it never clobbers work in progress; rewrites the `personalAssistant`
pin to `?ref=refs/tags/<tag>`; `nix flake update personalAssistant --refresh`
(the refresh so a cached tag→rev mapping cannot ship the wrong commit); verifies
the lock records the expected revision; and only then `nixos-rebuild switch`. A
failed switch restores both files, so a failed release leaves a clean tree and
the previous pin. A successful one commits **only** those two files — never
pushes — and then issues an explicit
`systemctl restart personal-assistant.service`. Every repo operation runs as the
checkout's owner via `runuser`, so nothing there ends up root-owned; only the
switch and the restart are root.

The restart is explicit because the unit is `restartIfChanged = false`: a switch
never interrupts a running agent turn, and a restart therefore means "a release
shipped" and nothing else (`docs/deployment.md`). The commit lands _before_ the
restart — the switch has already happened, so the system is on the new tag
either way, and a tree that disagreed with the running system would be the worse
state.

Because the pin lands in `flake.lock`, a later plain host rebuild reproduces
production instead of rolling it back — and it does not restart the assistant,
whether or not a release happened in between. The corollary: changing the pin by
hand and switching leaves the old server running until you restart it, so start
the release unit for that.

`personal-assistant-deploy` remains as a manual hotfix: it floats the app input
to current remote `main` via `--override-input` without touching the pin, so the
next plain host rebuild returns to the pinned release. CI cannot start it.

The release/deploy oneshots and the runner service must be
`restartIfChanged = false` in the host configuration because they DRIVE the
activation: otherwise a switch that changes their unit files (any nixpkgs bump
moves the script's store path) stops the in-flight deploy and force-kills the
job hosting it, and with `forgejo`/`caddy` restarting in the same batch the
runner can never upload a terminal status — the run then shows as "running"
forever in Forgejo even though the deploy succeeded.

### `preview.yml` — bring a PR preview up or down

`workflow_dispatch` with `pr` and `action` (`up`/`down`); starts
`pa-pr-deploy@<n>`/`pa-pr-teardown@<n>` and streams the unit's journal so
`pa-pr`'s progress reaches the job log, then prints the instance URL read back
from `pa-pr`'s `PR <n> live at …` line (the preview domain is host
configuration, so it is never duplicated in the workflow). A new preview starts
with empty application state and a preview-local HOME. It receives no production
environment file or copied production data. An instance left by the old seeding
design makes `up` stop the old service and fail without modifying that
directory; preserve anything needed, run `down`, then run `up` to provision it
again. `down` is the explicit destructive step.

Dispatch inputs reach the shell through the environment and are rejected unless
a plain number: they are untrusted text that becomes a systemd instance name,
and interpolating `${{ … }}` into a `run` block would execute it as shell source
before any validation. Normally run once per PR: `ci.yml`'s `pr-deploy`
refreshes the instance afterwards, and `pr-teardown` removes it when the PR
closes.

### `ops.yml` — runtime escape hatch

`workflow_dispatch` with a single `force-restart` action, which starts the
force-restart oneshot (SIGKILL the cgroup, then restart). Deploying is not here:
shipping a release is the Release workflow.

## Rollback

A deploy is a pin, so rolling back is repinning. From a shell on the host,
`sudo systemctl start personal-assistant-release@v0.16.0` deploys any earlier
release directly; in the host configuration, `git revert` of the
`Deploy personal-assistant <tag>` commit plus a rebuild does the same thing and
keeps the pin honest. Release dispatch will NOT roll back — it redeploys the
highest tag. Rolling forward instead (revert the offending commit on `main`, let
CI confirm, cut a new release) is still the right move when the bad change
should disappear from the history. `sudo nixos-rebuild --rollback` reverts the
previous switch but takes the whole system generation with it, so it is a last
resort rather than an app-level undo.

Neither undoes a data migration: `DATA_DIR`/SQLite changes made by the new
version are not reversed by running an older one, and a release that migrates
persisted data is therefore not reversible by rollback alone.
