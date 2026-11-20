# Desktop local mode

The macOS app can run Pandeck itself instead of connecting to a server. A build
that carries the packaged server starts it as a child process, waits for it, and
opens its windows on `http://127.0.0.1:<port>`. The same app can still be
pointed at a remote server, so one install covers both.

This is the first step toward a downloadable single-machine Pandeck. It uses the
trust model of running Pandeck under your own account. It is not the hardened
desktop mode in `workers.md`, which keeps secrets away from agents running as
the same user.

## What the app bundles

`pnpm run desktop:runtime` builds the web UI, then runs
`scripts/build-bun-server-bundle.mjs` under Bun 1.4.2 into
`app/shell/local-runtime/`. That is the Bun package from
`deployment.md#bun-package`, built for the host: Linux x64/arm64 (glibc) or
Darwin arm64 (`scripts/bun-package-platform.mjs`). The builder refuses native
files for another platform before it writes anything.

`app/shell/tauri.bundled-server.json` copies that directory into the app as
`Contents/Resources/pandeck-runtime/`. A build without the merge config has no
server and behaves exactly as before.

## Lifecycle

`app/shell/src/local_server.rs` owns the child. It provides what the systemd
unit provides on Linux and adds no protocol of its own:

- **Start.** It runs
  `pandeck-runtime/personal-assistant-server pandeck-runtime/server.js` with
  `NODE_ENV=production`, `ASSISTANT_RUNTIME_DIR`, `ASSISTANT_HOST=127.0.0.1`,
  `ASSISTANT_PORT`, `DATA_DIR` and `ASSISTANT_DESKTOP_SHELL=1`. `PATH` comes
  from the user's login shell (`$SHELL -l`), because a Finder launch only
  inherits the system directories.
- **Ready.** It polls `GET /api/health` until it gets a 200, for up to two
  minutes, and fails early if the child exits. Only then does the first window
  open. No window shows while the server starts.
- **Stop.** On quit it closes the child's stdin and waits up to 15 seconds, then
  kills it. `ASSISTANT_SHUTDOWN_GRACE_MS=10000` makes the server's drain fit
  inside that. Running turns are cut short. The server drain for a deploy takes
  up to an hour, which is too long for closing a laptop.
- **Shell crash.** The shell holds the write end of the child's stdin and never
  writes to it. When the shell dies for any reason, the pipe reaches end-of-file
  and the server stops itself the same way.
- **Failure.** When the server cannot start, the shell opens the bootstrap page
  with the reason and the log path instead of an app window.

Data lives in `~/Library/Application Support/<identifier>/data`, outside the
bundle, so replacing the app keeps it. The server's output goes to
`~/Library/Logs/<identifier>/server.log`, and the previous launch's log is kept
as `server.log.1`. The server's existing boot lock refuses a second server on
the same data directory.

The port is chosen once and stored in `shell.json` as `localPort`. The page's
`localStorage` belongs to its origin, so a new port on every launch would lose
its preferences. When the stored port is taken, the shell picks a free one and
stores that instead.

## Server side

`app/server/src/desktopShell.ts` applies only under `ASSISTANT_DESKTOP_SHELL=1`,
which `instanceEnv.ts` removes before any agent starts:

- Every HTTP request and WebSocket upgrade must name a loopback host
  (`localhost`, `127.0.0.1`, `[::1]`), or it gets a 421. With no reverse proxy
  in front, a site that rebinds its own name to 127.0.0.1 would otherwise pass
  the same-host origin check and read the token injected into `index.html`.
- End-of-file on stdin starts the normal graceful shutdown.
- Callback URLs default to `http`, since no TLS proxy is in front.

Token authentication, origin checks and the boot lock are unchanged.

## Host tools

`config/host-tools.json` is GNU-shaped (Bash 5, GNU coreutils 9). Production
fails the boot on Linux only. On macOS the check warns, so the app starts with
the stock Bash 3.2 and BSD tools. Whether agents need more than that on a Mac,
and what to bundle or require, is still open.

## Choosing local or remote

`shell.json` stores `mode` (`"local"` or `"remote"`). When it is unset, the app
runs locally if the build carries a server. Otherwise it uses `serverUrl` as
before.

- **Server…** opens the bootstrap page on its server form (`#choose`) rather
  than reconnecting to the current server. **Connect** there probes a URL and
  switches to remote mode (`set_server_url`), stopping the local server.
- **Run Pandeck on this Mac** appears when the build carries a server.
  `use_local_server` starts the server, or reuses a running one, and answers its
  URL once it is ready.
- `local_server_info` tells the page whether local mode is available and
  selected, and why the last start failed.

All three commands are bootstrap-only (`capabilities/default.json`).

## Building

On an Apple Silicon Mac with Rust, the Tauri CLI and Bun 1.4.2:

```bash
pnpm install
pnpm run desktop:runtime
cd app/shell
cargo tauri build --bundles app \
  --config tauri.bundled-server.json --config tauri.preview.json
```

`tauri.preview.json` gives the build its own name ("Pandeck Preview"), its own
bundle identifier, and therefore its own settings, data and WebKit storage. It
also registers no `pa://` scheme, so it cannot take links from an installed
Pandeck app. Leave it out to build the app under its normal identity.

CI's `desktop-macos` job does the same on a macOS 15 arm64 runner and uploads
the disk image as `pandeck-preview-macos-arm64`. It first smoke-tests the
packaged server the way the shell starts it: health on loopback, a 421 for a
foreign Host, and shutdown when stdin closes. The image is ad-hoc signed and not
notarized. After copying the app out of the image, remove the quarantine
attribute (`xattr -dr com.apple.quarantine "Pandeck Preview.app"`) to open it.
The job is not part of the required `ci` gate.

## Not yet

- Developer ID signing, notarization and a release workflow.
- An Intel build.
- Cleaning up agent processes that a killed server leaves behind. A normal quit
  and a shell crash both go through the server's own shutdown.
- A window while the server starts.
- Gateway enrollment from the app (Task-1421).
