# Pandeck

Pandeck is a self-hosted web app for running and supervising AI agent sessions.
One server on your own machine drives Claude (through the Claude Agent SDK) and
pi coding agent sessions, keeps their state in a local data directory, and
serves a browser UI (plus an optional macOS/iOS shell) from which you chat with
them, review their work, and approve what they want to change.

Pandeck is licensed under the [Apache License 2.0](LICENSE); see
[NOTICE](NOTICE) for attribution.

## What it does

- **Chat personas.** A general Assistant, a permanent Personal Assistant that
  keeps track of your day across the integrations you connect, and coding
  personas for arbitrary repositories (Developer) and for this app itself
  (Workshop, dev only).
- **Coding sessions in managed git worktrees.** Each piece of work gets its own
  worktree, a review surface with diffs and comment threads, and a commit, push
  and pull-request flow with CI watching (`docs/pull-requests.md`,
  `docs/agent-workflows.md`).
- **Approvals.** Agent-proposed changes that need your consent (a Jira edit, a
  Slack message, a Tempo worklog, a release, a merge into a default branch)
  become approval cards you accept or reject. Managed delivery from a coding
  session's own worktree is pre-authorized: pushing its branch, opening its pull
  request, merging into a non-default base, and closing with a reason. Some
  low-risk writes, such as re-running CI, go straight through, and session
  grants can pre-approve more (`docs/approvals.md`).
- **Tasks, Projects, Knowledge Base, memory and skills.** A task inbox, a
  project registry, a versioned Markdown Knowledge Base, small long-term agent
  memories and a Git-backed skills library, all stored under your data directory
  (`docs/tasks.md`, `docs/projects.md`, `docs/knowledge-base.md`,
  `docs/agent-memory.md`, `docs/skills.md`).
- **Integrations**, each optional: GitHub, Forgejo, Jira, Confluence, Tempo,
  Slack, Google Workspace (Calendar, Gmail, Drive, Meet), web search and docs
  search, local dictation and push notifications (see
  [Integrations](#integrations)).
- **Peer sessions and background work.** Sessions can start helper sessions on
  other runtimes and supervise dev servers and watchers they launch.

## Security model

Read this before you expose the app anywhere. Agent sessions run as the Unix
user that runs the server, with that user's files, shell and network. A token
gates `/api/*` and the WebSocket, but the server hands that token to every
browser that loads the UI. So whoever can reach the UI port can run arbitrary
commands as that user.

- Production binds to `127.0.0.1` by default. Put it behind a reverse proxy
  (Caddy, nginx) on a private network: a VPN such as Tailscale, or a LAN you
  trust. Do not publish it on the internet.
- In development BOTH processes bind to `0.0.0.0` so you can open the app from a
  phone on your LAN: the API server on `:8787` and the Vite UI on `:5173`, which
  injects the token too. `ASSISTANT_HOST` moves only the API server. On a
  network you do not trust, bind both to loopback in two terminals:

  ```bash
  ASSISTANT_HOST=127.0.0.1 pnpm run dev:server
  pnpm --filter @assistant/web exec vite --host 127.0.0.1
  ```

  Otherwise keep both ports behind a firewall or on a private network.

- Integration secrets never enter the repository or the Nix store
  (`docs/credential-distribution.md`).

## Requirements

- Linux or macOS for development. The production package and the NixOS module
  target Linux; the project deploys and tests on x86_64-linux.
- Node.js `^22.22.2`, `^24.15.0` or `>=26`, and pnpm `>=11.9` (`corepack enable`
  picks the pinned version from `package.json`).
- `git`, `bash` 5+ and GNU coreutils on `PATH`. Production refuses to start
  below the floors in `config/host-tools.json`.
- At least one model provider: a Claude account (Claude Code login), an
  OpenAI/Codex account, or an OpenAI-compatible endpoint (llama.cpp, vLLM,
  Ollama or a hosted gateway).
- Optional: Nix (flakes) for the production package, the NixOS module and the
  dictation model; Docker for container image pulls; a JDK for the package
  proxy's truststore; `rg` and `fd` for faster agent search.

## Quickstart (development)

No integration is needed to get a working app.

```bash
git clone <this repository> pandeck
cd pandeck
pnpm install
pnpm run dev
```

- Web UI (Vite, HMR): http://localhost:5173
- Server (API + WebSocket): http://localhost:8787. Vite does not proxy it: the
  page calls the server directly on the same hostname at port 8787. If you move
  the server with `ASSISTANT_PORT`, tell the UI with `VITE_SERVER_ORIGIN`
  (`host:port`), e.g.
  `ASSISTANT_PORT=8788 VITE_SERVER_ORIGIN=localhost:8788 pnpm run dev`.
- The server runs under a supervisor, so server-side edits reload between
  requests while the web UI stays live.

The browser token is created on first start at `assistant-data/.assistant-token`
and injected into the page, so there is nothing to log in to. Then open
**Settings → Models & providers** and connect a provider:

- **Claude SDK**: the Default Claude profile uses the server user's normal
  `~/.claude` login. You can also connect any Claude profile from the browser,
  which streams the official `claude auth login` flow.
- **OpenAI**: OpenAI/Codex profiles.
- **OpenAI-compatible**: a self-hosted or hosted endpoint.

Start a session from the sidebar. Coding sessions work in git worktrees; set the
worktree root under **Settings → Worktrees**.

The agent is rooted at the directory you launch from (`pnpm` exposes it as
`INIT_CWD`). Override it with `ASSISTANT_CWD=/path/to/workdir pnpm run dev`.
Persona prompts are packaged assets and do not follow that directory: they load
from the `config/prompts` beside the running app, or from
`ASSISTANT_PROMPTS_DIR` (an absolute path) if you point it elsewhere.

## Configuration

Runtime state (sessions, settings, the project registry, Tasks, the Knowledge
Base, OAuth tokens) lives in one data directory, `assistant-data/` by default.
It is local output: never commit it, and back it up
(`docs/deployment.md#host-and-data`).

Static, nonsecret deployment config comes from one JSON file. The committed
`config/app.json` is a neutral default that sets only `dataDir`. Keep your own
integration hosts and OAuth client ids in a file outside the repository and
point `ASSISTANT_CONFIG` at it. That file replaces `config/app.json` rather than
merging with it:

```json
{
  "dataDir": "/home/alice/assistant-data",
  "publicBaseUrl": "https://assistant.example.net",
  "jira": { "host": "example.atlassian.net" },
  "confluence": { "host": "example.atlassian.net" },
  "google": { "oauthClientId": "1234-abc.apps.googleusercontent.com" },
  "tempo": { "oauthClientId": "…" },
  "slack": {
    "workspaceHost": "example.slack.com",
    "teamId": "T0123456789",
    "clientId": "1234.5678"
  }
}
```

Every field is optional. The file must not contain secrets: secret-shaped field
names are ignored, and the package check rejects them.

| Variable                               | Purpose                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `ASSISTANT_CONFIG`                     | Path to your config file (replaces `config/app.json`)                        |
| `DATA_DIR`                             | Data directory; overrides `dataDir`                                          |
| `ASSISTANT_CWD`                        | Directory the agent is rooted at                                             |
| `ASSISTANT_HOST`, `ASSISTANT_PORT`     | Bind address (`127.0.0.1` in production, `0.0.0.0` in dev) and port (`8787`) |
| `ASSISTANT_TOKEN`                      | Pin the browser/API token instead of the generated one                       |
| `ASSISTANT_PUBLIC_BASE_URL`            | Base URL for OAuth callbacks when forwarded headers are missing              |
| `ASSISTANT_ALLOWED_ORIGINS`            | Extra browser origins allowed to call the API                                |
| `ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace OAuth client secret                                         |
| `ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET`  | Tempo OAuth client secret                                                    |
| `ASSISTANT_SLACK_CLIENT_SECRET`        | Slack OAuth client secret                                                    |
| `ASSISTANT_SLACK_APP_TOKEN`            | Slack Socket Mode app token                                                  |
| `APNS_CREDENTIAL_FILE`                 | Apple Push key for the iOS app (`docs/notifications.md`)                     |

The server reads the four integration secrets once at startup and removes them
from its environment before any agent starts. Supply them through a private
environment file (a systemd `EnvironmentFile` in production), never through the
config file (`docs/credential-distribution.md`). Everything else, such as API
tokens for GitHub, Forgejo, Jira, Brave or Context7, is entered in Settings and
stored under `DATA_DIR/settings/`.

## Integrations

All integrations are off until you configure them, and the app works without any
of them.

| Integration                                  | You provide                                                                                                   | Documentation                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| GitHub                                       | A personal access token in Settings → GitHub                                                                  | `docs/pull-requests.md`, `docs/container-images.md`                                   |
| Forgejo                                      | Instance URL and access token in Settings → Forgejo                                                           | `docs/pull-requests.md`                                                               |
| Jira                                         | `jira.host` in the config file; email and API token in Settings → Jira                                        | `docs/jira-tempo.md`                                                                  |
| Confluence                                   | `confluence.host` (or the Jira host); uses the Jira credentials                                               | `docs/confluence.md`                                                                  |
| Tempo                                        | `tempo.oauthClientId` plus `ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET`; connect in Settings                         | `docs/jira-tempo.md`                                                                  |
| Slack                                        | A Slack app: `slack.*` in the config file plus the two Slack secrets                                          | `docs/slack.md`                                                                       |
| Google Workspace                             | An OAuth client (redirect URI `<base URL>/api/google/oauth/callback`): `google.oauthClientId` plus its secret | `docs/credential-distribution.md`, `docs/day-scan.md`                                 |
| Web search, docs search                      | A Brave Search or Context7 API key in Settings                                                                | `docs/reference/server-tools.md`                                                      |
| Dictation                                    | A local sherpa-onnx recognizer and model weights                                                              | [Dictation](#dictation-speech-to-text), `docs/deployment.md#speech-to-text-dictation` |
| Push notifications                           | Web Push works in the browser; APNs needs an Apple Push key                                                   | `docs/notifications.md`                                                               |
| Container image pulls, private package reads | The GitHub token, plus Docker or a JDK on the host                                                            | `docs/container-images.md`, `docs/package-proxy.md`                                   |
| macOS/iOS app                                | A local Rust/Tauri build of `app/shell/`                                                                      | `docs/reference/native-shell.md`                                                      |

## Run in production

### Single process from a checkout

```bash
pnpm run build      # builds the web app into app/web/dist
pnpm start          # server serves the built UI + WebSocket on 127.0.0.1:8787
```

Then open http://localhost:8787. This runs the sources on Node through tsx and
suits a quick test. The supported production runtime is the Bun package below.

### Nix package

`nix build .#personal-assistant` produces the production package: a Linux Bun
bundle with the web UI, prompts, migrations and the Claude CLI, wrapped as
`result/bin/personal-assistant-server` (`docs/deployment.md#bun-package`).

### NixOS module

The flake exports `nixosModules.default`, which runs the package as a user-space
systemd service `personal-assistant`. Add the flake as an input and configure
the service:

```nix
# flake.nix of your host
inputs.personal-assistant.url = "git+https://git.example.com/you/personal-assistant?ref=refs/tags/v0.51.0";
# Do NOT set inputs.personal-assistant.inputs.nixpkgs.follows (docs/deployment.md).

# configuration.nix
imports = [ inputs.personal-assistant.nixosModules.default ];
services.personal-assistant = {
  enable = true;
  user = "alice";                                  # runs as this user, with their $HOME
  dataDir = "/home/alice/assistant-data";          # default: ~/.local/share/personal-assistant
  publicBaseUrl = "https://assistant.example.net";
  tokenFile = "/run/secrets/personal-assistant.env"; # ASSISTANT_TOKEN + integration secrets
  settings = {                                     # becomes ASSISTANT_CONFIG; no secrets
    jira.host = "example.atlassian.net";
    google.oauthClientId = "1234-abc.apps.googleusercontent.com";
  };
};
```

The service listens on `127.0.0.1:8787` (options `host`, `port`); front it with
your reverse proxy. `settings` is rendered into the world-readable Nix store, so
the module refuses secret-shaped fields there; secrets go into `tokenFile`, a
runtime path written by your secret manager (for example sops-nix). Other
options cover the agent working directory, memory caps, dictation, APNs and
per-PR preview instances. The option descriptions in `flake.nix` and
`docs/deployment.md` are the reference. The host provides the agents' toolchain
(`docs/deployment.md#host-tools`).

The project's own pipeline (Forgejo Actions with a runner on the NixOS host,
release by tag, opt-in PR previews) is described in `docs/ci-cd.md`. You need
none of it to run the app.

## Develop

```
app/shared/      # wire protocol types shared by server + web
app/server/      # agent runtime + WebSocket bridge: tsx on Node in dev, a Bun bundle in production
app/web/         # Vite + React 19 + Tailwind v4 web UI
app/shell/       # Rust/Tauri macOS/iOS shell, outside the pnpm workspace
docs/            # contracts and implementation reference (index: docs/README.md)
```

`CLAUDE.md` files hold the binding rules for agents working in this repository,
and `docs/README.md` indexes the rest.

```bash
pnpm run format      # format the repo with Prettier (check: format:check)
pnpm run lint        # type-aware ESLint (blocking)
pnpm run typecheck   # shared + server + web TypeScript checks
pnpm run test        # the full test gate (instructions, migrations, lint, dead code, suites)
pnpm run build       # build the production web bundle
pnpm run measure:web # build and report the web bundle size
pnpm run version:set 0.3.0         # keep all version declarations aligned
pnpm run changelog:generate 0.3.0  # draft + format first-parent release notes
pnpm run release:notes 0.3.0       # preview one release body from CHANGELOG.md
pnpm run check:prompts   # hold prompt/tool sizes against config/prompt-budgets.json
pnpm run measure:prompts # per-persona prompt and tool-schema sizes
pnpm run measure:tasks   # what Task bookkeeping costs a session (read-only)
pnpm run stt:model       # fetch the dictation model for dev (needs Nix)
```

## Operations

Commands for a NixOS deployment through the module above. Paths and unit names
are the module's defaults.

### Existing pi and Claude logins

On its first start, the server makes a one-time private copy of the existing
`~/.pi/agent/` state into `DATA_DIR/credential-profiles/default/pi-agent/`, then
marks the import complete. This preserves existing pi provider logins, model
settings, extensions, skills, and prompt templates (not old terminal transcripts
or caches) without retaining a runtime dependency on `~/.pi`. Set
`ASSISTANT_LEGACY_PI_AGENT_DIR` to an alternate source directory (or a
nonexistent path to disable the seed, as PR previews do). Back up or remove the
old directory only after confirming the service starts normally.

Claude's protected **Default Claude** profile reflects the service user's normal
`~/.claude` login. Settings → Claude SDK can connect or reconnect any Claude
profile from a desktop or phone: it streams the official bundled
`claude auth login --claudeai` command, offers Claude's authorization URL as a
tappable link, and forwards the pasted authorization code directly to the CLI
without displaying or storing it. PA does not implement the OAuth exchange.
Settings marks the profile Ready as soon as Claude writes `.credentials.json`.
Plain `claude` (Default Claude) and the displayed isolated
`CLAUDE_CONFIG_DIR=… claude` command (named profiles) remain terminal fallbacks.
Automatic Claude workflows use the first enabled Claude profile. PR previews use
a separate per-instance HOME, so their Default Claude and named profile
directories start empty and require preview-local setup. They do not inherit the
service user's normal `~/.claude` login.

### Status and logs

```bash
systemctl status personal-assistant          # state + process tree (CGroup)
journalctl -fu personal-assistant            # follow app logs
journalctl -fu 'personal-assistant-release@*'  # a running deploy (project pipeline)
```

### Memory and heap snapshots

At boot and every 10 minutes after, the server logs a line like
`[memory] runtime=bun-1.3.13 rss=250MB heapUsed=… heapTotal=… external=… arrayBuffers=…`.
Watch `rss`: it is what the host pays, and the only figure comparable with a dev
server, which runs on Node. The heap figures are JavaScriptCore's under Bun and
V8's under Node.

```bash
journalctl -u personal-assistant -g '\[memory\]' --since -1d   # the trend
kill -USR1 "$(systemctl show -p MainPID --value personal-assistant)"  # heap snapshot
journalctl -u personal-assistant -g 'heap snapshot' -n 5          # where it went
```

The snapshot is written to
`$TMPDIR/personal-assistant-heap-snapshots/heap-<pid>-<ms>.heapsnapshot` (0600),
never to `DATA_DIR`. It blocks the server for a few seconds, a second signal
within 60 s is skipped, and at most two files are kept. It holds every token the
server has read: load it in Chrome DevTools (Memory → Load) and delete it when
done. Details: `docs/deployment.md#diagnostics-under-bun`.

### Release and rollback

The module only runs a package; how a new version reaches the host is up to you.
The simplest route is to point the flake input at a release tag, update the lock
and rebuild:

```bash
nix flake update personal-assistant     # after moving the input to the new tag
sudo nixos-rebuild switch
```

The switch restarts the service when the package changed, and a stop drains
running agent turns for up to an hour. To restart only when you mean to, set
`systemd.services.personal-assistant.restartIfChanged = false` in your host
configuration and restart by hand (`sudo systemctl restart personal-assistant`).
The unit's store paths do not move on unrelated host updates
(`docs/deployment.md#service-lifecycle-and-environment`).

Roll back the same way, to an older tag. Neither direction undoes a data
migration, so a release that migrates `DATA_DIR` is not reversible by rollback
alone (`docs/migrations.md`).

The project's own pipeline automates this: publishing a release on its Forgejo
starts a host oneshot that pins, switches, restarts and waits for `/api/health`,
and **Actions → Preview** brings up an isolated per-PR instance
(`docs/ci-cd.md`, `docs/deployment.md#pr-previews`). A new preview starts with
empty application state and a separate HOME; production data and credentials are
not copied.

### Stuck stop / hanging deploy

On stop, the service drains active agent turns for up to 1h (`TimeoutStopSec`).
A deploy that needs to restart the service waits on that stop, so a stuck stop
looks like a hanging deploy. Diagnose with:

```bash
systemctl status personal-assistant
```

- `deactivating (final-sigterm)` with the main process already exited but other
  processes listed under `CGroup` means stray processes (spawned by an agent
  session, e.g. a background dev server) are holding the stop. The service's
  `ExecStop` sweeps these automatically after the drain; if something still
  survives, force it (below).
- While a deploy is mid-switch, a second one will fail or block — unstick the
  service first, then let the pending deploy finish (or re-run it).

### Force stop / force restart

```bash
# SIGKILL everything in the service cgroup, letting a pending stop/deploy proceed:
sudo systemctl kill --kill-whom=all --signal=SIGKILL personal-assistant.service
sudo systemctl start personal-assistant.service   # if nothing restarts it
```

This discards any in-flight agent turns but never touches data on disk
(`DATA_DIR`). The project's pipeline wraps the same steps in a host-provided
`personal-assistant-force-restart` oneshot that CI may start (**Actions → Ops**,
`docs/ci-cd.md`).

### "start request repeated too quickly"

The unit gives up after `StartLimitBurst` starts in `StartLimitIntervalSec` (5
in 300s) rather than retrying forever, because the two things it refuses to
serve on — a host below the `config/host-tools.json` floors, and unusable
packaged prompt assets — are not fixed by restarting. It then sits in
`failed (start-limit-hit)`, and in that state systemd **refuses manual starts
too**:

```bash
systemctl status personal-assistant            # look for "start-limit-hit"
journalctl -u personal-assistant -n 50         # the refusal reason is here
sudo systemctl reset-failed personal-assistant.service   # required before any start
sudo systemctl start personal-assistant.service
```

Fix the underlying cause first — the journal names the missing tool or asset.

### Dictation (speech to text)

Composer dictation transcribes locally on CPU — no audio leaves the machine. It
is an **optional host capability**: the app installs neither the recognizer nor
any weights. Put `sherpa-onnx-offline-websocket-server` on the service PATH and
one catalogued model's weights in a directory, then point
`services.personal-assistant.speech.modelDir` at it. Missing either, the server
reports `configured: false` with a reason and the mic button stays disabled —
nothing else breaks.

How the weights get there is the host's business. The recommended arrangement is
a host-side `fetchzip` package holding the URL and hash
(`docs/deployment.md#speech-to-text-dictation`): Nix verifies the download, and
because a fixed-output derivation's path depends only on its name and hash it
survives host updates without moving the unit. `nix build .#stt-model-<id>` here
builds a catalogued model too, which is what `pnpm run stt:model` uses in dev.

```bash
# is it configured? (also visible as the mic button's disabled reason)
journalctl -u personal-assistant | grep '\[stt\]'   # "recognizer ready on …" / exits
ps -o rss=,args= -C sherpa-onnx-offline-websocket-server   # RSS while warm
cat /tmp/personal-assistant-stt.log                  # recognizer connect/disconnect log
```

Expect the recognizer to be ABSENT most of the time: it starts on the first
dictation (~2 s model load) and stops after ~10 min idle, because it holds ~1.9
GB resident (up to ~2.6 GB after a long utterance). Decoding then runs at
roughly 0.05x realtime — a 10 s utterance transcribes in well under a second.
Dictation is not an agent turn, so it never delays a deploy's drain.

Preview (`pa-pr@<n>`) instances deliberately ship WITHOUT the model: their mic
button is disabled with that reason, so previews cannot each pin ~2 GB.

Local dev needs the model once (a symlink into `assistant-data/`, plus a Nix GC
root — not a copy):

```bash
pnpm run stt:model
```

Capture needs a secure context, so dictation works over the deployment's https
URL but NOT against the plain-http dev server from another device. For a phone,
test the deployed app; for a laptop, forward the dev ports and use
`http://localhost:5173`, which counts as secure.

### Container image pulls

Coding sessions can ask the server to pull a build image (including private
`ghcr.io` ones) with the `container_image_pull` tool; the registry credential is
the GitHub integration token and never reaches an agent shell. Full contract:
`docs/container-images.md`.

```bash
# does the service see a usable docker? (also reported by Settings → GitHub "Test")
sudo -u alice docker version --format '{{.Server.Version}}'  # alice = the service user
id -nG alice | tr ' ' '\n' | grep docker    # socket access
docker image ls                              # pulled images are host-global
```

Images are pulled onto the host store shared by production, previews, and your
own shell, and nothing prunes them — reclaim space with `docker image prune`.
