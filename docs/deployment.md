# Packaging & Deployment

How the app is packaged with Nix and how it runs as a NixOS service: the
service, its environment, the host dependencies it leans on, dictation, and the
PR preview instances. How CI builds and checks it, and how a release is cut, is
in `docs/ci-cd.md`.

## Host and data

Target: a user-space systemd service on a NixOS host (running as the user for
real filesystem/home access), fronted by a reverse proxy such as Caddy and
reachable only on a private network (a VPN such as Tailscale, or a LAN). The
browser token gates `/api/*`, but the app is not designed to face the public
internet: an agent session can read whatever the service user can. Deploy a
RELEASE TAG, not a branch head: pin the host configuration's flake input to the
tag, so the host's `flake.nix` + `flake.lock` are the record of what production
runs and `git log` there is the deploy history.

`DATA_DIR` (module option `dataDir`, default
`/home/<user>/.local/share/personal-assistant`; this documentation writes
`/home/alice/assistant-data` in examples) holds all runtime state. Back it up
while the server runs: take the SQLite database (`app.sqlite3`) with SQLite's
online backup (`sqlite3 app.sqlite3 ".backup …"`) and copy the rest at file
level. `claude-session-records.md#backups` covers what a live file-level copy of
the record logs restores.

The backup contains application state and may contain credential material.
Restrict its staging directory and repository data to root (mode 0700, config
0600). If the backup tool does not encrypt, filesystem access control is the
only at-rest protection. Runtime copies and backups made before credential
isolation may need operator review and credential rotation
(`docs/credential-distribution.md`).

## Bun package

`packages.<system>.personal-assistant` is the production package: a Linux Bun
executable bundle. `packages.default` and the NixOS module's `package` default
are the same derivation, and `pa-pr` builds this attribute for previews.
Production has run it since 0.49.0, and the Node/tsx package it replaced is
gone.

Development and the test suites run on Node and tsx (`pnpm run dev`, vitest),
while production runs this bundle under Bun. Two things guard that gap: the
package's install check, which boots the bundled server under the packaged Bun,
and the runtime probe it runs, which reaches code a booted server runs only on
demand. Both are described below. A difference found only under Bun is fixed in
the bundle or the server and covered by one of them. The whole server suite can
also be run under Bun by hand (Running the server suite under Bun, below).

`scripts/build-bun-server-bundle.mjs` owns the target layout. Nix installs pnpm
dependencies against `pnpm-lock.yaml`, builds the web UI, and invokes that
builder with nixpkgs' pinned Bun. If the lockfile changes, `nix build` prints
the new fixed-output `pnpmDeps` hash. That fetch and the offline install take
optional platform packages only for `pnpmPlatformFlags` (Linux x64 and arm64 on
glibc), named explicitly rather than detected from the host, so the hash is the
same wherever it is built; a new target system extends that list and changes the
hash. The offline install hardlinks from the unpacked store. The flake then
applies two Nix-specific ELF fixes and wraps the runtime as
`bin/personal-assistant-server` with `NODE_ENV=production`, the build commit,
and a pinned git and OpenSSH PATH prefix. The first fix gives the
`@parcel/watcher` addon an rpath to libstdc++. The second runs
`patchelf --set-interpreter` over the copied Bun-compiled Claude CLI, which
otherwise requests the FHS loader `/lib64/ld-linux-*.so.2`, absent on NixOS.
Both SDK sessions and the browser-streamed official Claude profile-login
terminal resolve this exact binary. Only the interpreter may be rewritten:
`--set-rpath` corrupts Bun's appended payload (segfault), and the binary links
nothing beyond glibc. Equally, it must be exec'd directly and never through a
script that invokes the loader explicitly. That makes `/proc/self/exe` the
loader, so the CLI exports a `CLAUDE_CODE_EXECPATH` pointing at `ld-linux` into
every Bash-tool shell, and its shell snapshot's `grep`/`find`/`rg` shadow
functions, which re-exec that path as a multi-call binary, fail with exit 127.
The server hashes the built `web/dist/index.html` into `ready.webBuildId`; an
already-open production browser remembers that id and reloads when a reconnect
reaches a newly deployed web build, preventing stale JS from continuing against
a changed WebSocket protocol. `index.ts` also swallows EPIPE/ECONNRESET write
faults from dead agent subprocesses so one turn's failure can't take the whole
server down.

The Bun package contains the pinned Bun executable, one deterministic bundled
server module, and explicit runtime assets: the built web UI, app configuration
and prompts, SQLite migrations and their lock, the root version manifest, the
Apache-2.0 `LICENSE` and `NOTICE`, the native watcher addon, Photon module and
WASM, a bundled JSDOM sync-XHR worker, the Claude CLI, and `browser-mcp/` with
the pinned Playwright MCP CLI and its `playwright-core` package. It does not
contain Node, tsx, workspace sources, or a `node_modules` tree. The wrapper sets
`ASSISTANT_RUNTIME_DIR` to this asset root. `runtimeAssets.ts` captures it once
at module load and is the single server-side resolver for these files, so the
bundled module never uses its own location to infer installed asset paths. The
variable is then scrubbed before any agent starts: a worktree dev server must
not inherit production assets or identify its checkout as a packaged build. The
optional `ASSISTANT_CLAUDE_CLI_BIN` override is captured and scrubbed for the
same reason. Lazy Photon and JSDOM loaders consume the captured paths rather
than rereading the scrubbed environment. Starting the packaged bundle without
`ASSISTANT_RUNTIME_DIR` fails immediately with a named packaged-server error.

`scripts/bun-bundle.mjs` owns the esbuild call and its plugins, so the install
check bundles its runtime probe exactly as the builder bundles `server.js`.
Every bundle it emits starts with Bun's pragma: `// @bun` for the ES modules
(`server.js`, the sync-XHR worker, the runtime probe) and `// @bun @bun-cjs`
plus the function wrapper Bun expects for the CommonJS watcher wrapper. The
pragma marks a file as already transpiled. Without it, Bun's runtime transpiler
re-parsed the 19 MB `server.js` at load and kept about 1.4 GB alive for the
module's lifetime: on a copy of production data, 1225 MB RSS at ready against
Node's 593 MB, and 295 MB with the pragma. With no transpiler, nothing supplies
an ES module's `require`, `__filename` and `__dirname`, which esbuild's CommonJS
interop still names, so the ES banner's second line defines them from
`import.meta.url` through helpers imported under `__paBun` names. The bundler
refuses an output that declares any of those names itself, in any scope. It
aliases `node:sqlite` to the small `bun:sqlite` adapter in `scripts/bun-shims/`.
The adapter covers only the `DatabaseSync` surface this server uses: the
constructor (`readOnly`, `enableForeignKeyConstraints`), `prepare`, `exec`,
`close` and `isTransaction`, and statements' `get`, `all`, `run` and `iterate`
with positional or `$`/`:`/`@`-prefixed named parameters (the grammar is below).
It keeps Node's semantics where Bun's differ: the foreign-key default, a
comments-only `exec()` as a no-op, an absent row as `undefined`, `isTransaction`
inside BEGIN and SAVEPOINT, and `run()`'s `changes` as the statement's own rows.
Bun would also count rows that foreign-key actions and triggers changed, so a
one-row delete with cascades reported more than 1. The adapter reads Node's
figures from `changes()` and `last_insert_rowid()` instead. Named parameters
follow Node's rules: a name the statement does not declare (`$x` for `:x`)
throws `Unknown named parameter`, where Bun would bind NULL, and one left out
binds NULL. A bare name (`x`) is rejected rather than silently misbound, since
Node would match it to any prefix and Bun to none. Only names of the form
`[:$@][A-Za-z_][A-Za-z0-9_]*` are supported. A statement bound with an object
whose SQL declares any other name that SQLite accepts (`$foo::bar`, `$foo(bar)`,
`:a$b`, any name holding a non-ASCII character, combining marks included) throws
`Unsupported named parameter syntax`. The server binds positionally. The adapter
opens Bun with `safeIntegers` and returns integers as numbers, throwing Node's
`RangeError` for one outside ±2^53 that Bun would round. That costs about 30% on
a read of 20,000 five-column rows. A BLOB parameter is bound as a BLOB. Any
other Node member or option throws a named error rather than reading as
`undefined`: a missing `isTransaction` made every nested transaction look like
none. The builder also aliases `child_process` to
`scripts/bun-shims/node-child-process.mjs`. Bun 1.3.13 starts a synchronous
spawn (`spawnSync`, `execFileSync`, `execSync`) that was given no `env` with the
environment the process started with, not the current `process.env`. Without the
shim, the host-tool probes and every dependency's synchronous spawn would
inherit the instance token and the integration secrets that boot deletes. The
shim passes the live `process.env` for an omitted or `null` `env`, Node's
documented default, and leaves any env object, `{}` included, as given.
`Bun.spawnSync` has the same leak and no shim, so it must never be used: server
code cannot name it (its types are Node's), and the install check fails on any
bundled `Bun.spawnSync`. `parcelWatcher.ts` loads the copied N-API addon and a
bundled copy of its upstream option-normalizing wrapper by absolute path. Every
Claude SDK query option builder and the login terminal use the packaged CLI
path. For browser work, the builder patches the MCP CLI's two package imports to
local relative paths before copying it. The server launches that CLI with the
packaged Bun executable, so browser sessions do not need Node, `npx`, a runtime
npm download, or a `node_modules` tree. The Photon shim loads its copied module
and sibling WASM from the runtime asset root. The builder also inlines JSDOM's
default stylesheet and points its separately bundled sync-XHR worker at that
root. JSDOM launches that worker with `process.execPath`, which is the packaged
Bun runtime in this package; Pandeck's current JSDOM use does not issue
synchronous XHR.

The package's install check boots from an unrelated temporary cwd and data
directory, applies exactly the migration set named by the packaged lock to a
fresh database, checks health, web and WebSocket service, verifies the native
process executable, restarts against the same database, and asserts the explicit
file set. A wrong-token WebSocket upgrade must be closed within 5 s without
opening. A granted port-forward session echoes 1 MiB through a local TCP target
in frames of at most 64 KiB, and both the target's end and the client's close
end it. The restart is a Claude session's whole life, driven over the WebSocket
with `scripts/fake-claude-cli.mjs` standing in for the Claude CLI through the
existing `ASSISTANT_CLAUDE_CLI_BIN` override, so no account or network is
involved. The fake speaks the SDK's stream-json protocol and answers each prompt
with `Fake reply to: <prompt>`. The session is created with a turn, opened while
resident, released once unviewed, opened by a reader from storage and released
again, resumed for a second turn with `--resume`, and deleted through the
one-transaction delete. Every open must show the model and thinking level it was
created with. That boot runs the same `server.js` under the packaged Bun with
`scripts/bun-check-short-graces.mjs` preloaded, a check-only file that shortens
the two release graces to 200 ms. The check waits for the server's
`[sessions] released <id>: …` lines. A SIGUSR1 must leave the server running and
write a private V8-format heap snapshot, and a second one right after must write
nothing. The check starts every process in its own process group and ends every
group still running before it deletes its temporary directory, on success or
failure.

Before booting, the check asserts the pragma on the first line of `server.js`,
the worker and the watcher wrapper. It then runs a copy of `server.js` whose
first statement after the banner prints the process's peak RSS and exits. An ES
module is parsed and linked whole before its first statement runs, so that is
the cost of parse and link alone, and it must stay under 300 MB: 130–180 MB with
the pragma, about 1.6 GB without. The check then bundles
`scripts/bun-runtime-probe.mjs` with the server's plugins and defines and runs
it with the packaged Bun, which reaches code a booted server runs only on
demand. It runs git through `gitExec.ts` and the spawn broker. The broker must
be the packaged Bun executable and lead its own process group. A cancelled
request must kill its child. Killing the broker must fail the lost request as an
execution failure and kill the grandchild git started, and the broker must come
back for the next call. A second run under `ASSISTANT_SPAWN_BROKER=0` checks the
in-process fallback. The probe derives a tree-watch ignore set from a small
repository's `.gitignore`, one ignored directory at the root and one nested. It
subscribes the packaged watcher with that set, which must report the watched
edits and none under the ignored directories. It runs the SQLite paths the shim
must carry: `inDbTransaction` nested in a transaction, the links memo
invalidated by another connection's commit (`PRAGMA data_version`) and never
kept from a rolled-back transaction, and the session delete rolling its
tombstone back when the session write fails. A synchronous spawn must see a
variable deleted from `process.env` as gone. The probe starts the real package
proxy, which must leave `process.env` untouched. The proxy answers plain HTTP
with 501 for every host, so the probe's own `fetch` and `node:http` requests to
an `.invalid` host must fail to resolve, while a packaged-Bun child given
`childProcessEnv()` must get the proxy's 501 for the same URL, and git through
the broker must see the bundle's `HTTPS_PROXY`. The check removes any proxy
variables it inherited from the probe's environment. pi loads each provider's
OAuth flow through a variable `import()` of a sibling file the bundle does not
have, so `piSdk/models.ts` registers the statically imported flows
(`@earendil-works/pi-ai/bun-oauth`); the probe derives `openai-codex` auth from
a ChatGPT credential the check seeds in its data directory, which fails the way
production did — every subscription model — if that registration is lost. The
check itself exercises each adapter behavior above directly. It also compiles
and runs a Photon probe so the WASM path is covered inside a compiled Bun
executable. From an unrelated cwd and a clean environment, it also runs the
packaged browser MCP CLI's version command and an MCP initialize plus
`tools/list`, covering the patched local imports without a workspace
`node_modules`. When Chrome or Chromium is available, the check also launches it
and navigates a page. The Nix sandbox has neither browser, so that last probe
reports an explicit skip there; the same clean-environment probe with the pinned
Bun 1.3.13 passes launch and navigation on a host with Chrome. The server itself
keeps its deterministic bundle beside the executable because Bun's standalone
compiler randomizes its embedded module-table encryption; the package wrapper
invokes that module explicitly, while `/proc/<pid>/exe` remains the packaged Bun
executable. Bun's ordinary bundler also emits scheduler-dependent module order
and identifier names, even when pinned to one CPU and given a lexically
recreated source tree. The builder therefore uses pinned esbuild for the server
module and its two bundled helpers; Bun remains the packaged runtime. The flake
closure check rejects Node, tsx, `node_modules`, and source derivations, then
confirms pinned git and OpenSSH remain present. The install check also scans
every runtime file for the Nix source path and build directory. CI builds the
package and its closure check on every change (`docs/ci-cd.md`), and a
deployment of that commit builds the same derivation.

The package must not use `bun build --compile` or Bun's ordinary bundler: Bun
1.3.13's standalone compiler encrypts its embedded module table with a random
nonce, while ordinary bundles vary in module order and short identifier names.
Keeping the pinned Bun runtime and esbuild-produced `server.js` separate avoids
both sources of nondeterminism. CI builds `.#personal-assistant` twice on
separate runners and compares the NAR hashes, so a return to either path cannot
silently regress reproducibility.

### Bun runtime differences

These were found by running the whole server test suite under Bun 1.3.13 with
the adapter aliased in (recipe below). All but the fixed ones are covered by
production code already or affect only test clients:

- Fixed in the adapter: `isTransaction` was missing, `run().changes` counted
  cascaded and trigger rows (`deleteCancelledRun` checks for exactly 1), an
  undeclared named parameter bound NULL, and an integer past 2^53 was rounded.
- Fixed in the server: pi loads each provider's OAuth flow through a variable
  `import()` of a sibling file, which the bundle does not have, so every
  subscription model failed. `piSdk/models.ts` registers the flows statically,
  and the runtime probe covers it (above).
- Fixed in the child_process shim: synchronous spawns without `env`, or with
  `env: null`, used the start-up environment. `Bun.spawnSync` does too, and is
  kept out of the bundle.
- `readdir` returns directory order; Node's is sorted. Every production caller
  whose result order matters sorts it.
- `os.homedir()` is read once at start-up and does not follow a later `HOME`
  change. The server never changes `HOME`.
- `fetch` and `node:http`'s client honour `HTTP(S)_PROXY`/`NO_PROXY` from
  `process.env`, where Node's `fetch` ignores them. The package proxy therefore
  publishes its bundle to child processes only (`docs/package-proxy.md`).
- `node:http`'s client is built on fetch: it normalizes a request path and
  cannot send CONNECT. The server side of both, raw request paths and the
  package proxy's CONNECT tunnel, behaves as under Node.
- An `EXPLAIN QUERY PLAN` of a write statement stays active after `all()` and
  blocks the next COMMIT. Only query-plan tests prepare EXPLAIN.
- Nothing written to a `node:http` upgrade socket reaches the client. An upgrade
  the server refuses (wrong token, origin, port-forward grant) still never
  opens, but the client sees the connection close instead of the 4xx or 503
  status line.
- Fixed in the server: the bundle keeps `ws` external, so the server uses Bun's
  built-in `ws`, whose server socket has no `pause()`/`resume()`.
  `attachPortForwardSocket` called both, so every port-forward connection failed
  on the 0.49.0 Bun package. `portForwarding.ts` now uses them only where they
  exist. Without them, frames are copied into a queue of 64 KiB chunks capped at
  4 MiB per connection, so many tiny frames retain no more than their bytes, and
  empty frames are dropped. A client that overruns the cap is closed with 1008.
  `portForwarding.test.ts` runs its socket tests with Node's pause hidden, and
  the install check forwards a real session.
- That server honours none of the `WebSocketServer` options: `maxPayload` is
  Bun's 16 MiB, so the forwarding frame limit is checked per message, and
  `perMessageDeflate` is never negotiated, so session frames are uncompressed. A
  send's callback fires once uWS takes the frame, not once it is written; only
  past uWS's 16 MiB buffer does it wait for a drain.
- `node:net` delivers reads of up to 512 KiB, where Node's are 64 KiB.
  Forwarding splits them, because the shell refuses messages over 64 KiB.
  `terminate()` drops frames uWS still buffers, so a target's end closes the
  socket normally.
- uWS does not check that client frames are masked. Other protocol violations
  close the connection, as under Node.
- An `http.Server` that has served a WebSocket never calls back from `close()`.
  Shutdown does not wait for that callback; tests must not either.

### Running the server suite under Bun

There is no CI job for this yet. The run needs a per-test expected-failure
comparison, because vitest cannot skip single tests by name from outside the
file. The run takes about 4 minutes on a 24-core host. The recipe, from
`app/server`, with this `vitest.bun.config.ts` beside `vitest.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        "node:sqlite": fileURLToPath(
          new URL("../../scripts/bun-shims/node-sqlite.mjs", import.meta.url),
        ),
      },
    },
  }),
);
```

```bash
bun=$(nix build --no-link --print-out-paths --inputs-from . nixpkgs#bun)
gcc=$(nix build --no-link --print-out-paths --inputs-from . 'nixpkgs#stdenv.cc.cc.lib')
env -u NODE_ENV CI=true LD_LIBRARY_PATH="$gcc/lib" \
  "$bun/bin/bun" --bun ./node_modules/vitest/vitest.mjs run \
  --config vitest.bun.config.ts
```

Run the `nix build` lines from the repository root, where `--inputs-from .` pins
the flake's own Bun. `LD_LIBRARY_PATH` lets the `@parcel/watcher` addon find
libstdc++, which the package gives it through an rpath instead. Without it, 178
files fail to import. The run lacks the package's `child_process` shim: an
`enforce: "pre"` plugin redirecting that builtin to it had no effect.

On 30 Sep 2026 (0.49.0 plus this change), 3908 of 3931 tests passed and one file
failed at setup. Of the 23 failures, `memoryLog.test.ts` expecting a Node
runtime name has since been made runtime-neutral, and the two in
`portForwarding.test.ts` were the port-forward defect, since fixed (above). The
rest are expected, and a job must compare its failures against exactly this
list:

- `webStatic.test.ts`: the three "never reads outside the dist root for …" cases
  with encoded or doubled `..` segments. The test's `node:http` client
  normalizes the path before sending it.
- `packageProxy/proxyServer.test.ts`: nine cases, every one that sends CONNECT
  or an absolute-form request through the test's `node:http` client, which Bun
  cannot send.
- `worktrees/worktrees.test.ts` (the whole file, at its submodule setup) and
  `worktrees/worktreeTracking.test.ts` "discards the tracking checkout when a
  post-add step throws": the tests set `GIT_CONFIG_*` in `process.env` and run
  git through `execFileSync`, which starts children with the environment from
  start-up. The package's `child_process` shim fixes it; the test run lacks it.
- `credentialProfiles.test.ts` "the protected Claude default reflects the normal
  user login …" and `tools/core/lsTool.test.ts` "`~` and `~/sub` expand against
  the home directory": both change `HOME`, which `os.homedir()` does not follow.
- `skills/skillRuntimeMaterializer.test.ts` "reuses the sorted set …": the
  test's own `readdir` is unsorted.
- `piSdk/toolBinaries.test.ts` "stops pi's tool lookup from spawning once
  linked": its child counts spawns by patching `child_process` with
  `syncBuiltinESMExports`, which Bun ignores.
- `db/subagentStore.test.ts` "separate SQLite connections serialize concurrent
  capacity admission": its workers start with `--import tsx`.
- `db/cardStoresQueryPlan.test.ts`, both cases: the `EXPLAIN QUERY PLAN`
  difference above.

### Diagnostics under Bun

Bun has no Node inspector, and Bun's default action for SIGUSR1 ends the
process. Under Bun the server instead answers `kill -USR1 <pid>` by writing a
V8-format heap snapshot with `node:v8`'s `writeHeapSnapshot`
(`heapSnapshotSignal.ts`). `index.ts` imports that module right after the boot
lock, so a signal during boot is answered too. The file goes to
`$TMPDIR/personal-assistant-heap-snapshots/heap-<pid>-<ms>.heapsnapshot`, in a
0700 directory with mode 0600, and never to `DATA_DIR`, which is backed up: a
heap holds every token the server has read. The service has no private temp
directory, so the files stay until someone deletes them. Load one in Chrome
DevTools, Memory tab, Load, and delete it when done.

Writing blocks the event loop, 2.6 s for a 24 MB heap in the install check and
proportionally longer on a production-sized heap, and each file is about the
heap's size. So the handler is bounded. It writes one snapshot at a time. A
signal within 60 s of the last snapshot's start is logged as
`[memory] heap snapshot skipped: …` and writes nothing. Before writing, it
deletes all but the newest file in the directory, so at most two are kept. The
log names each new file with `[memory] heap snapshot written to …`, and a
failure with `[memory] heap snapshot failed: …`. A dev server runs on Node,
where SIGUSR1 still opens the inspector on 127.0.0.1:9229.

The `[memory]` line names its runtime: `runtime=bun-1.3.13` in production,
`runtime=node-24.x` on a dev server. `heapUsed` and `heapTotal` are the engine's
own heap, JavaScriptCore's under Bun and V8's under Node, and are not comparable
across the two. Compare `rss`, which is also the figure to watch for growth in
production: the gap between it and the heap is native memory.

## One server per data directory

A `DATA_DIR` belongs to one server process at a time. Several stores keep
process-local state about their files: the Claude record log cursors
(`claude-session-records.md#one-writer`) most of all, where two servers would
silently replace each other's turns. The server enforces it.

- `index.ts` imports `serverBootLock.ts` first, so the lock is taken before any
  module opens the database or writes under `DATA_DIR`.
- The lock is a sequence of generation files, `DATA_DIR/server.lock.<n>`, and
  the highest one is the owner. Each records the owner's pid, its kernel start
  time (`/proc/<pid>/stat` field 22, where `/proc` exists), host name, time and
  the canonical (`realpath`) data directory it is for, and is hard-linked into
  place from a finished draft, which fails if that generation exists, so it is
  never seen half-written (`serverInstanceLock.ts`).
- A live owner makes the second server exit with status 1, naming the owner's
  pid and lock file. An owner is stale when its pid is gone, when its pid now
  belongs to a process with a different start time, when its file names a
  DIFFERENT data directory, or when the file is malformed — which includes a pid
  that is not a positive integer, since `kill(0 | -1, 0)` would signal a whole
  process group and pass for alive forever. The next server logs a stale owner
  and creates the NEXT generation. Two servers racing for one stale lock cannot
  both create the same generation, so exactly one wins and the other judges the
  winner live.
- Nothing ever removes a file another server could still be judging: a
  generation is deleted only by its successor (which judged its owner gone) or
  by its own owner, on exit after closing the database. A SIGKILL or power loss
  leaves a stale generation for the next start to supersede.

What this does not change: systemd stops the old server before starting the new
one, the dev supervisor respawns its child only after the old one exited, and a
worktree dev server runs on its own `DATA_DIR`. Tests use temporary data
directories and never start `index.ts`. CLI tools and `measure:*` scripts that
import stores take no lock. They read, and must not be pointed at a live
server's `DATA_DIR` to write.

A backup of a running server holds its live lock file. Restored into another
directory on the same host while that server still runs, the copy names the
ORIGINAL directory, so the restored server takes it over instead of refusing;
the original directory keeps refusing.

The check is local: two HOSTS sharing one `DATA_DIR` over a network file system
are not detected, and neither is one directory reached through two canonical
paths (a bind mount). Neither is a supported setup.

## Service lifecycle and environment

Service lifecycle and environment (nixos module in `flake.nix`): systemd gives
the server up to `TimeoutStopSec = 1h` to drain active agent turns on
stop/deploy; the server stops accepting new HTTP/WebSocket work, waits for
sessions/workflow hand-offs to settle, then exits through the SQLite close hook.

**Only a deploy restarts it.** The unit's store paths are the app package, its
own drain script (built from this flake's nixpkgs, not the host's), and whatever
`speech.modelDir` points at — nothing derived from the host's `pkgs`, so a host
input update cannot move any of them. `enableDefaultPath = false` drops the
coreutils/findutils/gnugrep/gnused/systemd NixOS appends to every unit, and
`LOCALE_ARCHIVE`/`TZDIR` are overridden with the hash-free forms NixOS uses for
the session environment, because `systemd.globalEnvironment` otherwise injects
the host's glibc-locales (`config/i18n.nix`) and tzdata (`config/locale.nix`)
paths into every unit.

**This depends on one precondition:** a consumer must not set
`inputs.personal-assistant.inputs.nixpkgs.follows`. That reflex — added to
deduplicate closures — collapses `paPkgs` onto the host's `pkgs`, so the drain
script and `cfg.package` rebuild from host nixpkgs and the churn returns with
nothing to notice it by. As a belt, the module leaves one setting to the host: a
host can mark the unit `restartIfChanged = false` and restart it explicitly as
the last step of a deploy, so a restart means "a release shipped". Without that,
a switch that changes the package restarts the service. It is the same shape the
module uses for `pa-pr@` previews, restarted only by `pa-pr deploy`. The unit's
`ExecStop` implements drain-then-sweep: it waits for the main process to exit,
then SIGKILLs anything left in the unit cgroup — stray processes spawned by
agent sessions (e.g. a backgrounded dev server) would otherwise survive SIGTERM
and hold the stop, and any deploy waiting on the restart, for the full timeout.
Manual recovery runbook: README "Operations". A host may wrap it in a
`personal-assistant-force-restart` root oneshot that SIGKILLs the cgroup and
restarts; the module does not define one, but its polkit rule lets
`prDeployments.deployUser` start a unit of that name.

**Out of memory: make the runaway the likely victim (best effort).** Every agent
process runs in the unit's cgroup. On 2026-09-30 a global OOM kill of an agent's
35 GB `pytest` made systemd stop the whole unit under the default
`OOMPolicy=stop`, taking down the server and every session. Production and each
`pa-pr@` preview now set `OOMPolicy=continue`, so a kernel OOM kill of one
process is logged and the unit keeps running. `OOMScoreAdjust` (option
`oomScoreAdjust`, default -900) makes the server the kernel's last choice. The
kernel adds `oom_score_adj` thousandths of the memory it chooses within to each
process's RSS + swap: RAM + swap for a global OOM, `MemoryMax` + `MemorySwapMax`
for a cgroup-local one. Children inherit the value. On a 47 GB host with 52 GB
of swap, an inherited -900 is about -89 GiB, which would shield a runaway and
kill everything outside the unit first. So children are handed back 0
(`app/server/src/childOomScore.ts`):

- the server raises the children it spawns itself right after the spawn;
- the spawn broker raises itself at start, so every git it runs starts at 0;
- a once-a-second sweep of the server's cgroup catches what vendor code starts
  (the Claude CLI and its tools, pi's bash tool).

All of it only raises, so a child that chose a higher score keeps it. -1000 is
refused because an unkillable, leaking server would stall the unit instead of
restarting. The kernel lets these unprivileged processes move between -900 and
1000 but no lower: systemd's privileged write records -900 as the floor.

`memory.{high,max,swapMax}` and `prDeployments.memory.*` (per preview instance)
render `MemoryHigh`/`MemoryMax`/`MemorySwapMax`. They are unset by default
because the values depend on the host.

- **`max`** makes the unit usually hit its own limit first. The resulting
  cgroup-local OOM then normally kills the biggest agent process.
- **`swapMax`** stops a runaway from thrashing tens of gigabytes into swap
  before any kill.
- **`high`** throttles the whole cgroup, server included, and never kills. Leave
  it unset unless that is what you want.

Budget the caps against RAM: production, plus the previews you actually run at
once times their cap, plus the host baseline, plus CI and nix-build headroom.
`pa-pr` has no concurrency limit.

None of this is a guarantee, so do not read it as "the service cannot die":

- Pressure outside the unit (other services, CI containers, nix builds,
  previews) can cause a global OOM before any cap is reached.
- The victim is the highest score, which is usually but not always the runaway.
- A process forked in vendor code keeps -900 until the next sweep, which can run
  late while the host is reclaiming.
- If the server itself is killed, `Restart=on-failure` restarts it and every
  session goes with it.
- `ManagedOOMPreference=avoid` asks systemd-oomd, which kills whole cgroups (the
  entire service), to pick anything else first. It still picks the service when
  nothing else qualifies. NixOS's defaults have oomd manage no slice, so this
  matters only once a host enables `systemd.oomd.enableSystemSlice` or
  `enableRootSlice`.

A possible follow-up, not built: run agent processes in their own delegated
sub-cgroup or scope with its own limit and `memory.oom.group`. That would
contain them far more strongly than scores can.

The server needs no special handling when something is killed:

- A shell or tool whose child is killed reports exit 137 or "killed by a
  signal".
- A killed Claude CLI fails its turn and marks its background work host-lost.
- A killed spawn broker SIGKILLs its process group, fails in-flight requests,
  and restarts on the next request.

`unitConfig.StartLimitBurst`/`StartLimitIntervalSec` (5 in 300s) make the unit
give up rather than retry a failure restarting cannot fix — the pre-bind
refusals above. Know what that state costs: systemd then refuses MANUAL starts
too, so `systemctl start` answers "start request repeated too quickly" until
`systemctl reset-failed personal-assistant.service`. A host-provided
force-restart oneshot should run that reset before it starts the unit; a bare
`systemctl restart` from a shell does not. README has the sequence. It runs as
`cfg.user` with `HOME` set, so file-based config (`~/.gitconfig`, `~/.ssh/*`) is
already used; git clone/pull over `ssh://` remotes runs with a non-interactive
`GIT_SSH_COMMAND` (`projectProvision.ts` `PROVISION_ENV`) so a passphrase-less
key in `~/.ssh` is required. The service `path` is the HOST's, and only the
host's: the user's Nix profile dirs (`/etc/profiles/per-user/<user>`,
`/run/current-system/sw`) so spawned agents see roughly the login-shell toolbox.
There is no `extraPackages` option and no pinned base — see "Host tools" below.
A systemd service is not a login shell: shell aliases/functions are never
inherited and rc-exported env vars are absent. Nonsecret agent environment may
go in `extraEnvironment`; those values are rendered into the systemd unit and
Nix store. Secrets belong in the host-managed `tokenFile`, which systemd reads
when it starts production. Despite its historical name, this EnvironmentFile may
carry `ASSISTANT_TOKEN`, `ASSISTANT_SLACK_CLIENT_SECRET`,
`ASSISTANT_SLACK_APP_TOKEN`, `ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET`, and
`ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET`; `docs/credential-distribution.md` owns
the full contract. Use a string runtime path such as `/run/secrets/...`, not a
Nix path literal or generated attribute values, so Nix stores only the path and
never the secret value. The package's own wrapper carries one variable of its
own, `ASSISTANT_BUILD_COMMIT` (`self.rev`, also set during the build so the web
bundle carries it): the source tree it was built from is gitignore-filtered and
has no `.git`, so this is the only way the running server can name its commit
for Settings → About (`docs/ci-cd.md`). The server captures the instance values
and four integration secrets it needs once, then `instanceEnv.ts` deletes them
from `process.env` before the build-info git lookup and host-tool probes, and
before the socket binds. This includes `DATA_DIR`, `ASSISTANT_TOKEN`, host/port,
origins, build identity, `ASSISTANT_CONFIG`, `APNS_CREDENTIAL_FILE`, and the
four integration secret variables named above. A dev server or external tool
started later must not inherit production's data or credential identity.
Applying schema from a checkout is separately refused by `db/migrationOwner.ts`;
see `docs/migrations.md`. `/run/wrappers` (setuid sudo) is intentionally off
PATH.

**Deployment config is the host's, not the package's.** The packaged
`config/app.json` is neutral (only `dataDir`), so a build carries no
deployment's Atlassian site, Slack workspace, or OAuth client ids. The module's
`settings` option takes that `config/app.json` shape (`jira.host`,
`google.oauthClientId`, `tempo.oauthClientId`,
`slack.{workspaceHost,teamId, clientId}`, …), renders it with `builtins.toFile`
— a path fixed by name and content, so it cannot churn the unit — and hands it
to production AND previews as `ASSISTANT_CONFIG`, the same nonsecret metadata
every build used to carry. Evaluation fails on a secret-shaped field name (the
rule `scripts/check-package-config-secrets.mjs` applies to the packaged file),
and on `dataDir` or `publicBaseUrl`, which have their own options.
`publicBaseUrl` and `apnsCredentialFile` become `ASSISTANT_PUBLIC_BASE_URL` and
`APNS_CREDENTIAL_FILE` on the production unit only. `user` and
`prDeployments.domain` have no defaults: a host names its own.

The production unit also sets `ASSISTANT_BACKGROUND_FETCH=1` and
`ASSISTANT_BACKGROUND_PR_SYNC=1`. They assign the one production process as the
owner of periodic remote Git and pull-request provider reads. Preview units get
neither flag, so N previews cannot multiply those reads against repositories or
hosting APIs they share with production.

## Host tools

The agents' toolchain is the HOST's, not vendored. The service PATH is exactly
`/etc/profiles/per-user/<user>` then `/run/current-system/sw` — two hash-free
paths, which is what keeps the unit invariant under host input updates. The
module offers no `extraPackages`: a host `pkgs` derivation on this PATH was the
last remaining way to move the unit on an unrelated update, and adding a tool to
the host's `environment.systemPackages` or the service user's profile reaches
the service through those same two entries without touching the unit at all. The
one exception is the package wrapper, which prefixes its own pinned `git` and
`openssh`. Note the scope: `--prefix PATH` applies to the whole server process
environment, which children inherit, so an agent's shell resolves the vendored
pair too. `git` and `ssh` are therefore the two documented exceptions to "agent
tools are host tools" — guaranteed regardless of the host, and the only case
needing precedence over it.

### External MCP subprocess environment

External MCP processes do not receive a copy of the server's environment. Their
inherited base is an allowlist of host/runtime settings: PATH, HOME, temporary
directories, locale and timezone, proxy and CA configuration, desktop display
variables, and the Playwright browser cache. Integration credentials, model
provider credentials, administrator variables, and unknown names are omitted.
Server-owned call sites may add a `trustedEnv` overlay for a specific MCP
process. That parameter is internal configuration, never a user-supplied map.

This boundary applies to external MCP launches only. Agent sessions and other
arbitrary-code subprocesses still have separate inheritance paths; tightening
those is follow-up work. Do not read the MCP allowlist as universal
child-process isolation.

`config/host-tools.json` is the contract that replaces the vendored closure.
`hostTools.ts` resolves each required binary on PATH, parses its own `--version`
output and compares against a dotted floor, and `verifyRequiredHostTools()` runs
once in `index.ts` immediately after `assertPromptAssets()` — before the socket
binds, so a host below the floor fails the boot with every failure named at once
instead of surfacing inside somebody's first agent turn. Checked ONCE by design:
a host update can change a tool under a running agent, which is the accepted
cost of using host tools, and re-checking per invocation would cost more than it
protects.

OPTIONAL capabilities are deliberately NOT in that table. Each is discovered by
the subsystem that needs it and reported as a status carrying a reason the UI
can show — dictation (below) is the reference implementation; `docker` for
container image pulls and `java`/`keytool` for the package proxy's JDK
truststore work the same way. pi's grep/find binaries (`rg`, `fd`) are optional
too: when they are on PATH, boot links them into pi's bin dir so each tool call
skips a forking PATH probe (`docs/child-processes.md`). When they are missing,
pi downloads its own. Adding one to the required tier is a one-line table entry,
so promoting a capability to a hard requirement never means new plumbing.

## Container image pulls

Container image pulls (`container_image_pull`, contract:
`docs/container-images.md`) depend on the HOST docker: the `docker` CLI comes
from the user's Nix profile dirs on the service path (not the hermetic base),
and the service user must be in the `docker` group to reach the socket. The
flake adds nothing for this — a missing runtime is reported as an actionable
error by the tool and in Settings → GitHub's connection test. Pulled images live
in the host-global Docker store shared with previews and the user's own shell;
nothing prunes them automatically.

## Package proxy

The package proxy (contract: `docs/package-proxy.md`) authenticates GitHub
Maven/npm/NuGet package registries for in-build dependency resolution (Gradle,
npm, …) with the GitHub integration token, without the token ever reaching an
agent shell. It needs no flake change — it is plain JavaScript on Node
built-ins, which Bun provides, plus the `node-forge` catalog dependency,
generating its own CA under `DATA_DIR/package-proxy/` (0600 key) and locating a
JDK by looking for `java` on the service PATH — one of the optional host
capabilities the app discovers rather than declares. Every PR preview starts
with an empty DATA_DIR, so its proxy mints a separate CA lazily.

## Speech to text (dictation)

Composer dictation (speech to text) runs FULLY LOCAL on CPU and is an **optional
host capability**: this flake's nixosModule installs neither the recognizer nor
any weights, so it cannot put a ~311 MB binary closure or ~631 MB of weights
into the unit. The operator puts `sherpa-onnx-offline-websocket-server` on the
service PATH and the weights of one catalogued model in a directory; the server
discovers both at startup (`ASSISTANT_STT_SERVER_BIN` else a PATH lookup;
`ASSISTANT_STT_MODELS`, then `ASSISTANT_STT_MODEL_DIR`, then the dev
`DATA_DIR/models/stt/<id>` slot) and reports `configured: false` with a specific
reason when either is absent, which is what disables the mic button. The
module's only speech options are the paths `speech.modelDir` and
`speech.logFile`.

Obtaining the weights is entirely the host's business — this flake neither
fetches nor installs them. The recommended arrangement is a host `fetchzip`
package carrying the URL and hash, with `speech.modelDir` pointing at it: Nix
verifies the download, nothing lands in the backed-up `DATA_DIR`, and because a
**fixed-output** derivation's path is a function of its name and output hash
alone it survives host nixpkgs updates unchanged (verified: two unrelated
nixpkgs revisions evaluate to the identical path). An input-addressed
`mkDerivation` from the host's `pkgs` would NOT — it moves on every host input
update and drags the unit with it.

The catalog's `sha256` is the hash of the TARBALL, so a host `fetchzip` needs
the NAR hash of the unpacked tree instead — a deliberately different value. That
is the one duplication this arrangement accepts: the app keeps URL and hash for
its own `stt-model-<id>` packages (which `pnpm run stt:model` uses in dev), and
the host keeps its own for production. If they drift, the app's filename
validation still governs: a mismatched directory reports "not configured" rather
than misbehaving.

Previews set `ASSISTANT_STT_DISABLED = "1"` explicitly. Withholding the
recognizer path from them is no longer enough, because the binary is found by a
PATH LOOKUP: once the host has it, every preview would otherwise be able to warm
its own ~1.9 GB recognizer. The kill switch is checked before any discovery.

The recognizer is a warm child process the server starts lazily on first
dictation (~2 s model load) and stops after an idle timeout; it decodes at
~0.05x realtime on a desktop-class CPU (no GPU is used). Dictation is not an
agent turn, so graceful shutdown rejects new utterances and releases the child
rather than draining it; `sttEngine.dispose()` runs in the shutdown path so no
stray process is left for `ExecStop`'s cgroup sweep. Model WEIGHTS never live in
`config/` or in `DATA_DIR`: they have no business in the daily `DATA_DIR`
backup, so `speech.modelDir` points outside it. Note what does and does not
matter about that value: the path string lands in the unit's environment either
way, so what counts is only whether it MOVES. A fixed-output derivation does
not; an input-addressed one built from the host's `pkgs` does, and that is the
churn this design removes.

The app still ships the RECIPE even though it deploys nothing: the committed
`config/stt-models.json` catalog names each model's URL, hash and the four files
it must contain, and `packages.<system>.stt-model-<id>` derivations built from
it give the operator a hash-verified copy via `nix build .#stt-model-<id>` (also
what `pnpm run stt:model` uses in dev). Those packages stay OUT of the
`personal-assistant` closure so CI's `nix-build` never pulls ~500 MB of weights.
The server matches a discovered directory against the catalog and treats a
partial one as absent rather than handing it to the recognizer, which would fail
much later with an opaque error. A model bump is therefore a one-file catalog
edit (hash via `nix hash file --sri --type sha256`), and because both the
recognizer and the weights are now host-owned they can be updated without
touching the app — with the accepted risk that they are a compatible PAIR, which
the operator now owns. Browser capture needs a secure context, so dictation
works over the deployment's https URL but not against the plain-http dev server
from another device.

## PR previews

PR previews are opt-in through `services.personal-assistant.prDeployments`. A PR
`<n>` gets a `pa-pr@<n>` instance at `pr-<n>.<domain>` (option
`prDeployments.domain`, e.g. `pr-42.assistant.example.net`), listening on
`portBase + n` behind Caddy, only after someone runs `sudo pa-pr deploy <n>`
(directly or through the `pa-pr-deploy@<n>` oneshot). Opening a PR does not
create one.

The `pa-pr` root script resolves `refs/pull/<n>/head`, builds that revision, and
provisions `stateDir/<n>` on the first deploy. Provisioning is clean: it creates
an empty DATA_DIR and a preview-local HOME/XDG directory tree. It does not clone
the production database, sessions, settings, tokens, credential profiles, web
push state, package-proxy CA, or any other production application data. There is
no safe general allowlist yet. SQLite rows and apparently nonsecret settings can
contain copied messages, tool output, URLs, or credentials, so Phase 0 preserves
none of them. Later deploys retain state created by that preview.

The preview unit inherits the host-tool PATH because previews still need the
host toolchain. It does not inherit production's `tokenFile`,
`extraEnvironment`, HOME, or DATA_DIR. The server mints its own browser token in
the empty preview DATA_DIR. Provider accounts require an explicit isolated login
in the preview; neither `~/.claude` nor `~/.pi` is imported. Slack app mode and
speech recognition remain explicitly disabled as extra guards.

Independent preview credentials require deliberate host configuration. Set
`prDeployments.credentialEnvironmentFile` to a runtime secret path such as
`/run/secrets/personal-assistant-preview-%i`. The option requires `%i`, which
systemd expands to the PR number, so each preview has a separate file. It also
rejects the production `tokenFile` path. The file must belong to a preview
identity and must not contain production's `ASSISTANT_TOKEN` or integration
secrets. The module cannot compare secret contents without exposing them, so the
host secret manager must enforce that last rule. Nix puts only the path in the
unit. The default is null: no external preview credential file, and no optional
file lookup. Such a preview remains credential-empty apart from state it creates
itself.

This is credential-distribution hardening, not a process sandbox. The preview
still runs as the production Unix uid and receives the same host filesystem and
network access. PR code can address files outside HOME directly if that uid can
read them. Treat preview deployment as execution of reviewed code until a later
phase provides OS-level isolation.

State created by the old production-seeding design has no isolation marker. A
state guard runs before every preview process start, including a direct
`systemctl start pa-pr@<n>`, and refuses a missing/obsolete marker or incomplete
HOME/DATA_DIR without changing it. `pa-pr deploy` prints the exact recovery
steps and stops the old preview but leaves the directory untouched. Copy out
anything that must be kept, then run `sudo pa-pr teardown <n>` and
`sudo pa-pr deploy <n>` to delete it by an explicit operator action and
provision a clean instance. Do not add the marker by hand; that would relabel
copied production state as isolated.

NixOS activation never restarts an unchanged preview or a running
`pa-pr-deploy@`/`pa-pr-teardown@` oneshot. All have `restartIfChanged = false`;
`pa-pr` owns preview lifecycle, so a stale preview cannot block production
deployment. Teardown is path-guarded to `stateDir/<n>`, removes that preview's
data, and does not touch production.

Wildcard DNS must map `*.<domain>` (e.g. `*.assistant.example.net`) to the
host's private-network address. `pa-pr` maintains one wildcard Caddy site and
per-PR routes, so previews share a single certificate from the global DNS-01
issuer. It serializes Caddy mutations and waits for the wildcard certificate on
the first change. Do not restore per-PR site blocks; concurrent certificate
challenges can be canceled by reloads and leave DNS records that suppress
wildcard resolution.

These module changes do not deploy themselves. Before the first release that
removes packaged credential fallbacks, the operator must provision the new
production runtime environment file and update the host module to list it. After
deployment, review historical runtime copies and backups and rotate any
credential that may have been copied previously. No host data, deployment, or
credential was changed as part of this source update.
