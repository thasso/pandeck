# Credential distribution and cutover

This document defines which credentials may enter the package, how the server
receives boot-time integration secrets, and how to remove credentials that were
previously committed. It does not cover provider-specific OAuth flows except for
the boundary between deployment credentials and returned authorization state.

## Storage contract

`config/app.json` is packaged with the server as a neutral default and carries
no deployment's values. A deployment's nonsecret static metadata — OAuth client
ids, workspace ids, hosts, scopes, time zones, result limits — comes from the
file named by `ASSISTANT_CONFIG` (the Nix module's `settings` option,
`docs/deployment.md`). Neither file may contain passwords, client secrets,
private keys, app tokens, access tokens, refresh tokens, session cookies, or
realistic credential examples.

The core server accepts these boot-time integration secrets only from the named
deployment variables:

| Variable                               | Consumer                      |
| -------------------------------------- | ----------------------------- |
| `ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace OAuth client |
| `ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET`  | Tempo OAuth client            |
| `ASSISTANT_SLACK_CLIENT_SECRET`        | Slack OAuth client            |
| `ASSISTANT_SLACK_APP_TOKEN`            | Slack Socket Mode connection  |

Unprefixed Google and Tempo secret variables are not supported. Startup deletes
these former aliases without using their values. Secret-shaped fields in
`config/app.json` are ignored. The package check rejects field names ending in
`secret`, `token`, `password`, `privateKey`, `cookie`, `credential`, or
`apiKey`, including plural and punctuation variants. It does not inspect values
and cannot recognize a credential hidden under a misleading field name, so
review remains required. Tests use obvious sentinel strings rather than
credentials or credential-shaped examples.

`integrationSecrets.ts` captures these four values once and immediately deletes
their variables from `process.env` during module initialization. `config.ts`
uses only that captured object and never rereads the environment. The later
instance environment scrub also covers these names as a defensive check. Spawned
agents and their subprocesses therefore do not inherit the four approved names,
the two discarded aliases, or the instance variables listed in
`INSTANCE_OWNED_ENV_VARS`. This is not universal child-environment isolation.
Other inherited variables need a call-site allowlist or a separate isolation
boundary. Code must not log the captured values or include them in status
payloads and errors.

OAuth authorization results have a different lifecycle. Access and refresh
tokens obtained from Google, Tempo, or Slack remain in their integration files
under `DATA_DIR/settings/`. They are runtime state, never bootstrap config.
`ASSISTANT_TOKEN` and the APNs credential follow their existing file-backed
contracts in `authToken.ts` and `docs/notifications.md`.

Model-provider credentials are separate. Named Claude and OpenAI profiles live
under `DATA_DIR/credential-profiles/`, while a default Claude login may come
from the service user's home directory. Moving the four integration secrets
above does not isolate model credentials. Apply the credential-profile filters
and preview rules independently.

## Supplying the service environment

Use the deployment's existing systemd `EnvironmentFile` mechanism rather than
putting secret values in Nix expressions, the repository, the package, or the
Nix store. The file may define the four variables above alongside
`ASSISTANT_TOKEN`. Keep it outside the repository, owned by the service user or
root, and readable only by the account that needs it. Secret-manager templates
such as sops-nix may render that file.

Do not place these values in `extraEnvironment`. Nix-rendered environment values
can become world-readable store content. Do not copy production values into a
worktree, preview environment, test fixture, shell transcript, or deployment
log.

A host whose environment file still carries only `ASSISTANT_TOKEN` must add the
four integration variables to it before it deploys a release that no longer
reads secrets from `config/app.json`. Repository changes never edit a host's
live secret template, copy its values, or deploy it.

A scrubbed environment stops accidental inheritance. It is not a security
boundary against every process running as the same Unix user. A process with
full same-UID access may read the service's files, inspect or control the
service process where host policy permits it, or invoke the service through its
normal interfaces. Strong isolation needs a different Unix identity or a sandbox
with an explicit broker. Secret relocation alone does not provide that
isolation.

## Cutover runbook

Treat every credential that appeared in committed or packaged config as exposed.
Removing the field prevents new packages from carrying it, but does not
invalidate an old value. Older server versions also printed `ASSISTANT_TOKEN` at
startup, so systemd journals, exported service logs, caches, and log backups
belong in the exposure inventory. Do not delete live logs to hide the old value;
rotate the token and preserve the audit record.

1. **Provision runtime credentials.** Put the current Google, Tempo, and Slack
   values in the private systemd environment file under the four approved names.
   Check ownership and permissions without printing the file. Do not remove the
   existing copies or rotate provider credentials yet.
2. **Check isolation before release.** Confirm the candidate captures and scrubs
   the four variables before agent startup, rejects secret fields in package
   config, and keeps model-provider credentials under their separate profile
   rules. Build the candidate without inspecting or logging secret values.
3. **Release.** Deploy the hardened package through the normal release path and
   restart the service so it reads the environment file. Do not deploy a build
   that still needs a secret fallback from `config/app.json`.
4. **Verify.** Check that Slack Socket Mode connects and that new Google, Tempo,
   and Slack OAuth operations can start or complete as appropriate. Inspect
   status booleans and provider responses, not credential values. Check service
   logs for accidental credential output.
5. **Rotate.** Create replacement credentials at each provider, update the
   private environment file, restart, and verify again. Rotate
   `ASSISTANT_TOKEN`, refresh the browser, and verify that the old API token is
   rejected. Revoke each old provider credential only after its replacement
   works. Record provider-side revocation evidence and time; a local file edit
   is not evidence of revocation.
6. **Retire old copies.** Remove obsolete plaintext copies from current
   checkouts, package inputs, build caches, Nix store roots where safe, and
   backups according to their retention policy. Inventory historical service
   logs and exports, but do not mutate or delete live logs during this cutover.
   Old Git objects, existing Nix store paths, caches, clones, logs, and backups
   may retain bytes. Rotating the API token and revoking provider credentials is
   what makes those copies unusable.

Backups of `DATA_DIR` (`docs/deployment.md#host-and-data`) may hold old
credentials too, and unencrypted archives rely on filesystem permissions alone.
The outer directory mode does not prove that archive contents are readable or
unreadable. Audit effective access to the backup tool's config, data, staging
and archive files, and to its commands, separately. Do not delete archives
outside the retention policy merely to complete this cutover. Rotate and revoke
exposed provider credentials first, then let retention age out old bytes.

Do not rewrite Git history as part of this cutover. A rewrite cannot reach every
clone, store path, cache, or backup, and it can make audit and recovery harder.
Do not claim an old credential is revoked until the provider confirms it. If a
provider cannot confirm revocation, record that gap and continue to treat the
old value as live.
