# Container image pulls

Some projects build inside a private container image — for example a
documentation build in `ghcr.io/example-org/sphinx-build:7.24.2`. An agent
working in a worktree cannot authenticate to that registry: it has no registry
credentials, and it must not get any. This document is the contract for how such
images become available.

For the sibling problem — a build that needs private _package_ registry
credentials mid-build (Gradle/npm resolving dependencies, where there is no
single artifact to pre-fetch) — see [`package-proxy.md`](package-proxy.md). Both
share the same GitHub integration token as their credential source and the same
"never in the agent's environment" posture; container pulls go through the
Docker daemon, package resolution goes through a local authenticating proxy.

## Model

|                        |                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Agent surface          | `container_image_pull` (catalog group `container-images`, coding personas only, gate `github`)                     |
| Credential             | The existing GitHub integration token (`DATA_DIR/settings/github.json`) — no separate registry credential          |
| Authenticated registry | `ghcr.io` only                                                                                                     |
| Owning modules         | `app/server/src/containerImages.ts` (pull service), `app/server/src/tools/container/containerImageTools.ts` (tool) |
| Runtime requirement    | A `docker` CLI on the server PATH whose daemon socket the service user can reach                                   |

The agent asks for an image; the **server** pulls it; the image lands in the
host-global Docker image store. Everything after that is ordinary: `docker run`,
`docker build`, or a project script such as
`IMAGE=ghcr.io/owner/name:tag ./scripts/build-local.sh html` finds the image
locally and needs no credentials at all.

There is deliberately **no allowlist, no digest pinning, and no approval card**:
pulling an image is treated as ordinary build tooling. The security boundary is
the credential, not the image list.

## Credential handling

`containerImages.ts` is the only module allowed to hand registry credentials to
the CLI, and it holds these invariants (each covered by
`containerImages.test.ts`):

- **GHCR only.** A credential provider is consulted only when the reference
  resolves to `ghcr.io`. Every other registry — Docker Hub, quay.io, a local
  registry — is pulled anonymously even if a provider was passed.
- **Stdin only.** The token reaches `docker login --password-stdin` on standard
  input. It never appears in argv, in the process environment, or in the
  returned result.
- **Private, temporary `DOCKER_CONFIG`.** Every docker invocation runs against a
  fresh `0700` temp directory, so the user's `~/.docker/config.json` and any
  credential helper are never consulted, and the credential docker writes is
  discarded. The directory is removed in a `finally` — success, login failure,
  pull failure, timeout, and abort.
- **Redaction.** Nothing raw from docker is surfaced. Output goes through
  `redactRegistrySecrets` (known token, its base64 form, token-shaped strings,
  and `Authorization`/`Bearer`/`Basic` payloads) and is bounded to the last 20
  lines.

References are parsed and normalized before use (`parseImageRef`): printable
ASCII only, no leading `-`, strict repository/tag/digest grammar, and the pull
runs as `docker pull -- <normalized>`, so a crafted "image" cannot become a
docker flag.

## Setup (least privilege)

1. Settings → GitHub: enable the integration and save a **classic** personal
   access token (see [GitHub token scopes](github.md)).
2. The token needs **`read:packages`** for private GHCR images. For SSO
   organizations the token must also be **SSO-authorized** for that
   organization.
3. Press **Test** in Settings → GitHub. The result reports both halves of the
   story, for example
   `Authenticated as octo. Container image pulls ready (docker 29.6.1, token has read:packages).`
   A missing scope or an unreachable runtime is named there.

No other configuration exists — the tool appears for coding personas whenever
the GitHub integration is enabled.

## Behavior

- A pull is a no-op when the image is already present
  (`status: "already-present"`); pass `refresh: true` to re-fetch a moving tag.
- Concurrent requests for the same reference share one docker invocation; at
  most two pulls run at a time. Only the first caller sees progress updates.
- The result carries safe metadata only: normalized reference, registry, status,
  digest, image id, size, whether credentials were used, and duration.
- Default timeout is 15 minutes; the call honors turn cancellation.

## Troubleshooting

| Symptom                                                                | Cause / fix                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Pulling from ghcr.io needs the GitHub integration…`                   | The integration is disabled or has no token — Settings → GitHub.                                                                                                               |
| `denied` / `unauthorized` on a GHCR image                              | The token authenticated but cannot read the package: add `read:packages`, and SSO-authorize the token for the owning organization.                                             |
| `manifest unknown`                                                     | Wrong tag or digest; the reference does not exist in the registry.                                                                                                             |
| `No usable container runtime…` / `Cannot connect to the Docker daemon` | The service user cannot reach the docker socket. It must be in the `docker` group, and `docker` must be on the service PATH (for example from the service user's Nix profile). |
| An agent ran `docker pull` in its shell and got `unauthorized`         | Expected — shells have no credentials. Use `container_image_pull`.                                                                                                             |

## Bind mounts and file ownership

A `docker run` with no `--user` runs as uid 0, so everything it writes into a
bind-mounted directory belongs to root. The server runs as an ordinary user and
can then neither chmod nor delete it: the checkout becomes unremovable, and
`git worktree remove` makes it worse, because it deletes its administrative
directory even when removing the working tree failed (Task 659).

So a container that mounts a checkout runs as the host user:

```
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack \
  -v "$PWD:/w" -w /w <image> …
```

`HOME` has to be overridden because a uid with no passwd entry has none, and
corepack and every package manager need a writable one. Two measured traps for
pnpm specifically: `PNPM_STORE_DIR` and `npm_config_store_dir` are IGNORED (only
`--store-dir` or `store-dir` config move the store), and a store on a different
device from the project is silently relocated INTO the project, which is exactly
how a root-owned `.pnpm-store` appears inside a worktree. A store mounted from
the host, on the same filesystem as the checkout, keeps it out.

## Reclaiming container residue

`containerResidue.ts` is the one place the app RUNS a container rather than
pulling one. When a removal finds a directory owned by another uid, it asks the
daemon — already effective root, and how the files got that owner — to hand the
tree back with `chown -R`. No privileged server, no sudo, no credentials.

It runs as a cleanup step on a removal the user already asked for, so it needs
no separate confirmation, and it holds these invariants (each covered by
`containerResidue.test.ts`):

- **App-derived path only.** The directory comes from a registered worktree row
  and must resolve strictly inside a configured worktree root. A path equal to a
  root, outside every root, or gone is refused before any docker call.
- **One mount.** Only that directory is mounted, at `/target`. No network, no
  environment, no stdin, and a bounded timeout.
- **Our own ownership.** The uid/gid written is the server process's own; there
  is no parameter that could name a third user.
- **Chown, never delete.** Deletion stays on the host path with its git guards,
  so a failed reclaim leaves a tree that is merely owned again.
- **The device and inode are verified inside the container.** A path is not an
  object: a live agent child runs as the same uid as the server and could rename
  the checkout and leave a symlink to `/dev` or `/etc` in its place between our
  check and the daemon's mount, which would aim a root-capable `chown -R`
  outside the worktree. So the expected `st_dev`/`st_ino` pair travels into the
  container, which compares it against the mounted `/target` in the daemon's own
  namespace and exits 3 without touching anything on a mismatch. Both numbers
  are load-bearing: inode numbers are unique only within one filesystem, and
  `/dev`, `/dev/shm`, `/proc`, `/sys` and `/run` all carry inode 1, while an
  attacker-writable tmpfs hands out low, guessable numbers. A bind mount
  preserves both, which is what makes the comparison decisive. The path is also
  re-resolved immediately before the mount, after the runtime probe and the
  image pull.

  Verified against the real daemon: with the path swapped for a symlink to
  `/dev` in exactly that window, the container saw `6 1` instead of the expected
  pair, exited 3, and `/dev` kept its owner.

A missing runtime or a failing chown is a REASON, not an exception: the removal
reports it next to the `sudo` fallback rather than failing opaquely. The image
is small and replaceable (`alpine:3.22` by default,
`ASSISTANT_CONTAINER_RECLAIM_IMAGE` overrides it for a host that cannot reach
Docker Hub).

Pulled images are never garbage-collected by the app; disk reclamation
(`docker image prune`) stays an operator task.
