# Desktop local mode

The macOS app can run its own Pandeck server instead of connecting to a remote
one. This document is the contract for that mode as the spike ships it: how the
shell chooses a server, how it starts, trusts and stops the bundled one, where
its data lives, what fails and how the user recovers, and what is left for later
slices. The rules agents must not break are in `app/shell/CLAUDE.md`; the
supervision variables are also listed in `deployment.md`.

## Configurations

Pandeck on a desktop will eventually run in three configurations:

1. **Local Pandeck, local gateway.** Server and credential gateway both run on
   the Mac.
2. **Local Pandeck, remote gateway.** The server runs on the Mac; model
   credentials stay behind a gateway elsewhere, reached over the relay with TLS
   enrollment.
3. **Thin client.** The app loads a remote Pandeck server, as it always has, and
   as iOS still does.

The spike delivers the choice between local Pandeck and the thin client.
Configuration 3 is unchanged. In local mode the bundled server uses whatever
gateway its own settings name, which by default is none. Choosing or enrolling a
gateway from the app is not part of this spike: it belongs to Task-1421 (see
[Next slice](#next-slice)).

## Choosing a server

The shell keeps the MODE (`local` or `remote`, `config::ServerMode`) apart from
the remembered remote URL, both in `shell.json` in the app's config directory.
Switching to local leaves the remote URL in place, so switching back finds it.
Gateway settings belong to the server and are not part of either.

When no mode is stored, a build with a bundled server starts in local mode
unless a remote URL is already stored, so an existing thin-client install keeps
connecting where it did. A stored `local` in a build without a runtime falls
back to remote without erasing the stored choice. An unknown value counts as
unset.

The bootstrap page is where the choice is made: on first start of a build
without a runtime, from **Server…** in the menu, and on any failure. It offers
"Use Pandeck on this Mac" when a runtime is bundled, beside the remote URL
field. The three commands behind it (`get_server_choice`, `use_local_server`,
`local_server_status`) are granted to the bootstrap origin only
(`capabilities/default.json`), never to a hosted page, like the existing
repointing commands. Choosing a remote server stops the local one. iOS compiles
these commands as stubs and never offers local mode.

## Lifecycle

The shell's launcher is `app/shell/src/local_server.rs`. One thread in
`local_mode.rs` owns the child for its whole life, so a restart can begin only
after the previous process tree is gone and its data lock is free.

**Resources.** The runtime is `Contents/Resources/pandeck-runtime`, resolved
through Tauri's resource directory, never the working directory or PATH. Before
launching, the shell checks that the directory is absolute and complete
(`REQUIRED_RUNTIME_FILES`) and that the server binary is executable. A missing
piece is reported by name. A debug build may point elsewhere with
`PA_SHELL_LOCAL_RUNTIME_DIR`.

**Data.** Everything the local server writes lives under
`~/Library/Application Support/<bundle id>/local-server/`: `data/` is its
`DATA_DIR`, and `logs/server.log` collects its output and the shell's lifecycle
lines, rotated at 5 MB. Directories are created `0700` and the log `0600`.
Nothing is written into the bundle, so replacing the app (an update, a copy to
`/Applications`) and switching modes keep the data. The path is keyed by the
bundle identifier: a build with a different identifier starts with empty data.
The server's working directory for agents (`ASSISTANT_CWD`) is the home
directory.

**Launch.** The child starts in its own process group with a cleared
environment: an allowlist of ambient variables (PATH, HOME, locale, proxies, CA
bundles) plus the server's own settings: `NODE_ENV=production`, `DATA_DIR`,
`ASSISTANT_HOST=127.0.0.1`, `ASSISTANT_PORT`, `ASSISTANT_RUNTIME_DIR` and a 5 s
drain. No secret is passed in arguments or through shell configuration. The
server still runs every boot check a hosted server does, including the host-tool
gate and the one-server-per-`DATA_DIR` lock.

**Readiness.** The shell trusts a single line, never a port that merely answers.
It hands the child a pipe on fd 3 and a fresh random nonce:

| Variable                        | Meaning                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `ASSISTANT_SUPERVISOR_READY_FD` | Descriptor (≥ 3) to write readiness to, then close       |
| `ASSISTANT_SUPERVISOR_NONCE`    | 32–128 hex digits the line must echo                     |
| `ASSISTANT_SUPERVISOR_LIFELINE` | `stdin`: EOF on stdin means the shell is gone; drain now |

After `listen` succeeds, the server writes
`{"type":"pandeck-ready","nonce":…,"pid":…,"port":…}` with the port it actually
bound. The shell accepts it only if the nonce matches, the pid is its child, and
the port then answers `/api/health` and refuses an unauthenticated API call
with 401. A partial or malformed set of these variables is a boot error, not an
unsupervised start. The server scrubs them, with the other instance variables,
before it spawns anything.

**Port.** The first launch asks for port 0, so the OS picks a free one. The
shell remembers the bound port (`localPort` in `shell.json`) and asks for it
again next time, because the origin is what keeps the page's storage. If another
process holds that port, the supervised server binds a fresh one and reports it.
It never attaches to the other listener.

**Trust.** The origin `http://127.0.0.1:<port>` is added to the runtime
navigation and IPC patterns only after readiness is verified, and the status
turns `ready` only after that. Neither the bootstrap page nor a new window can
learn the URL earlier. On ready, the main window loads the server directly,
hidden until it reports in, exactly as it does for a remote server.

## Failure and recovery

| What happens                                        | What the user sees                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Runtime missing or incomplete                       | Bootstrap page naming the missing file                              |
| Server exits during startup (e.g. host-tool gate)   | Bootstrap page with the server's last log lines and the log path    |
| No readiness within 90 s                            | Bootstrap page; the child tree is stopped                           |
| Bad readiness: wrong nonce or pid, or not our port  | Bootstrap page; the child tree is stopped                           |
| Server exits after it was ready                     | Bootstrap page "stopped unexpectedly"; open windows lose the server |
| User chooses remote, or quits, while it is starting | Start is cancelled and the child stopped                            |

Every failure sets the status to `failed` and opens the bootstrap page unless
one is showing. Nothing restarts on its own: "Use Pandeck on this Mac" tries
again, and the remote option stays available.

## Shutdown

Quitting the app, choosing remote and a failed start all stop the child the same
way. The shell records the child's descendants, sends SIGTERM to the process
group, waits up to 8 s (the server drains for at most 5 s), then sends SIGKILL
to the group. Recorded descendants that left the group get SIGTERM, then SIGKILL
2 s later. At quit the shell waits for this, boundedly, before exiting.

If the shell itself dies (crash, SIGKILL, force quit), the server sees EOF on
its stdin lifeline and drains as if it had been sent SIGTERM.

## Security posture

The local server keeps the hosted server's protections: loopback-only binding,
the auth token on every API and WebSocket call, and the hostile-origin check.
Under supervision it also refuses any request whose `Host` is not a loopback
name on its exact port (421), so a DNS-rebinding page cannot read the token the
served HTML carries. The readiness line never reaches the log, and no
supervision value is exposed to a web origin.

This spike adds NO protection against other processes of the same user. Any
local process can fetch the served page and read its token, as with a server on
loopback today; agents can read and write `DATA_DIR`. The hardened design
(Keychain access groups, hardened runtime, launch constraints, separately signed
launchd agents) is `workers.md`'s "Bundled desktop mode" and is not attempted
here.

## Prerequisites and limits

- **Host tools.** The server's host-tool gate (`config/host-tools.json`) needs
  Bash 5+ and GNU `env`. An app opened from Finder gets LaunchServices' PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), so stock macOS fails the gate even when
  Homebrew has the tools. The user sees the gate's message, naming each missing
  tool and why it is needed, with the log path. How the app will supply or find
  these tools is an undecided distribution policy; the spike does not choose
  one. CI provides them on PATH for its launches only.
- **Git, OpenSSH, browsers, compilers, speech models** are not bundled, as for
  the Darwin runtime package (`deployment.md`).
- **Signing.** Builds are ad-hoc signed and not notarized. A downloaded copy is
  quarantined, so Gatekeeper refuses it until the user clears the attribute
  (`xattr -dr com.apple.quarantine Pandeck.app`) or allows it in System
  Settings. The bundled runtime's Mach-O files are not signed separately.
- **Crash cleanup.** After the shell crashes, or the server exits on its own,
  only the server's process group is reachable. A descendant that started its
  own group can outlive it.
- **Readiness descriptor.** A process the server starts before it reports
  readiness can inherit fd 3. It cannot forge readiness, because the nonce is
  scrubbed before anything is spawned.
- **Apple Silicon only**, macOS 15 on CI. No universal or Intel build, no
  auto-updater.

## Building

On an Apple Silicon Mac with the prerequisites from
`deployment.md#macos-apple-silicon-package-spike` and `cargo-tauri` 2.11.5:

```bash
pnpm run build
bun scripts/build-bun-server-bundle.mjs app/shell/local-runtime
cd app/shell
cargo tauri build --bundles app --config tauri.local-runtime.json
```

`tauri.local-runtime.json` adds the runtime as a bundle resource; without it the
build is a thin client exactly as before. `local-runtime/` is ignored by git.

## Evidence

CI's `desktop-macos-arm64` job (`ci-cd.md`) builds the bundle and records three
kinds of receipt, labelled by what they prove:

- **Bundle verification.** Architectures, linked libraries (OS only), the ad-hoc
  signature as recorded (not enforced), and the runtime package smoke run
  against the copy inside the bundle.
- **Headless launcher receipt.** `cargo test bundled_runtime_lifecycle` drives
  the bundled runtime through the shell's launcher without the app: readiness,
  401, 403, 421, lock refusal, graceful stop, restart on the same port, lifeline
  stop, busy-port fallback, no writes into the runtime.
- **CI GUI-session receipt.** `app/shell/scripts/smoke-macos-app.sh` opens the
  app in the runner's logged-in session. It checks that the bundled server is
  the app's child, loopback-only, and answers 200/401/421. It then quits the app
  and checks nothing is left. A copied app must reuse the data and origin. An
  informational launch without the CI PATH records what a Finder launch sees.

None of these is a signed, notarized or clean-Mac receipt. The app is uploaded
unsigned (ad-hoc) as `pandeck-desktop-darwin-arm64-unsigned-<sha>`.

## Next slice

Configuration 2 joins local mode to the relay and gateway work in Task-1421,
reusing its contract rather than adding a second one:

1. The local server enrolls with a remote gateway through Task-1421's relay with
   TLS enrollment, started from the bootstrap page's local option ("Use a remote
   gateway…"), while the mode stays `local`.
2. The macOS connect flow and the relay LaunchAgent come from Task-1421. The
   shell registers that LaunchAgent and does not manage a second relay process.
3. A host-tool distribution decision (bundle, detect Homebrew, or guided setup)
   replaces the Finder PATH failure with a working first launch.
4. A signed and notarized build produces the first real-Mac receipt.
