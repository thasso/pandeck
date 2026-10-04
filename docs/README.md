# Documentation index

Durable product and architecture contracts for Pandeck, the self-hosted agent
app: a Node/WebSocket server that orchestrates pi and Claude SDK agent sessions,
shared TypeScript protocol types, and a Vite/React web UI. `app/shared/`,
`app/server/` and `app/web/` are private ESM TypeScript packages in one pnpm
workspace; `app/shell/`, the Rust/Tauri wrapper built for macOS and iOS from one
crate, is deliberately outside it. Agent instruction files (`CLAUDE.md`) carry
only binding rules; everything else lives here.

## Contracts

- `tasks.md` — what a Task is and the boundary between the user's durable Task
  and agent execution state: where a piece of work belongs (Task, description,
  comment, Workflow Run, or nowhere), who owns status, why a subtask's project
  follows its parent, and the audit numbers behind the boundary.
- `agent-workflows.md` — the agreed v1 Workflow Run architecture: a durable run
  with append-only steps and events, one code-delivery recipe as recipe code
  over generic step rows, structured results via `session_submit_result`,
  commit-bound review evidence, the review loop that returns findings to their
  author and lets nothing ship without fresh eyes on it, the two ceilings only
  the user may raise, safety/recovery invariants, UX, phases, and the explicitly
  deferred generalizations.
- `knowledge-base.md` — the first-class Knowledge Base product/storage contract
  and reset boundary.
- `skills.md` — the user-owned Git-backed skills library, its dual
  hand-authoring/validated-agent-authoring contract (clean-tree refusal, one
  commit per mutation with provenance, rename/delete consequences, limits, and
  bounded history/diff), the read-only recursive file browser and bounded
  viewer, source scanning diagnostics, the global on/off map and the insert-only
  per-session freeze, injection into both coding harnesses, and deterministic
  shared runtime layouts with their source-of-truth/garbage-collection boundary.
- `comments.md` — the one comment anchor model shared by KB entries, worktree
  diffs and chat: the selector bundle, the resolution ladder and its two
  refusals (ambiguity, the short-quote guard), the raw-offsets/normalized-
  comparison contract, derived lines, and the lifetime class per target.
- `agent-memory.md` — the agent memory system: card storage/lifecycle,
  multidimensional scope, the singleton `personal-assistant` persona
  distinction, temporal semantics, selection and sticky-snapshot delivery,
  cadence/settings/safety ceilings, tool and prompt rules, observability, known
  limitations, and the reset boundary.
- `user-profile.md` — who the app works for: the profile display name and the
  one timezone every user-local day and time resolves in, its host fallback,
  use-time resolution, and where the name appears.
- `day-scan.md` — the Daily Scanner v2 pipeline: staged collection/synthesis,
  the disposition-vs-result and delta contracts, origin-tagged self-exclusion,
  per-source semantics, the privacy hybrid, and day-entry conventions.
- `ui-shell.md` (under `app/web/docs/`) — the binding UI shell concept: the
  three-pane layout, navigation rules, object linking, the right object panel,
  and the small-screen screens model.
- `loading-states.md` (under `app/web/docs/`) — the binding loading-state model:
  the five states every async region renders, R1–R6 (empty is not loading,
  stale-while-refresh, a different object gets a placeholder, reserved layout,
  per-control busy, a11y/motion), the shared `ui/load.tsx` vocabulary, the
  inline-vs-toast error rule, and the audit that enforces it.
- `messaging.md` — the binding model for what the app SAYS: the three questions
  that pick a channel, the channels themselves and the absence of a banner among
  them, failures living on their object, silence as the default for success,
  conditions and the single app status slot, the push policy, and how it docks
  with `loading-states.md`.
- `steering-and-queueing.md` — what becomes of a message sent while a turn runs:
  pi's immediate steer, Claude's deferred acceptance (folded, follow-up within
  the same run, or withdrawn on Stop), why Claude never offers `steerOnly`, and
  the `delivery` marker the transcript renders; and the user's server-side
  prompt queue: ordering ahead of agent traffic, Stop and failure pauses, queued
  commands, and the composer's per-device Steer/Queue choice.
- `child-processes.md` — why the server never forks itself for per-request work
  (fork cost grows with the server), the spawn broker that starts git instead
  and its fallback contract, the caches that avoid spawns altogether, what the
  worktree watcher watches (git-ignored and submodule paths skipped, lingering
  and capped subscriptions, tool-call rescans, measured), and what a worktree
  removal stops — tracked background work, then our own processes still running
  in the checkout — before it deletes it.
- `session-loading.md` — what opening a session costs and the three rules that
  keep it independent of the session's size: showing a session reads storage
  only (`ViewSession` + the detached runtime adapter, with the harness opening
  on the first command that drives it), a snapshot builds bodies only for the
  rows it sends, and what travels with it is walked in from the session rather
  than filtered out of a whole-table list and carries what is rendered rather
  than what it was rendered from. Plus letting go — a detached session belongs
  to its views and a harness to its store, each released after a grace — what a
  coordinator's siblings cost, and what the reader sees while it happens.
- `session-list.md` — what one session-list rebuild costs, part by part, and the
  rules that bound it: one read per relation, link-derived maps memoized on the
  `links` write counters, `PRAGMA data_version` and the connection, disk-state
  probes read per build, Task progress from one join, and `onlyIds` bounding the
  store read of a one-row refresh. Plus why neither a new index nor a
  touched-rows rebuild was added.
- `agent-harnesses.md` — how app code reaches the two engines (pi, Claude SDK):
  the target seam (`harnesses/`: registry, `LiveSession`, `runOneShot()`, models
  and usage ports), the shared `HARNESSES` descriptor, the boundary ratchet that
  pins remaining engine imports and harness-id comparisons, and the step-by-step
  migration status.
- `claude-session-records.md` — how a Claude SDK session's own record is stored:
  small atomically-replaced metadata beside an append-only timeline log, why it
  is not derived from the app-owned log, the byte-exact extent and crash-safety
  rules (the metadata rename commits; a tail past the extent is cut off, a
  shorter log is salvaged entry by entry; only a missing file is absent, an
  unreadable one fails closed), what a live file-level backup restores, the
  one-writer backstop that refuses rather than clobbers, lazy migration of
  legacy single-file records, and the measured cost per persist.
- `session-retention.md` — automatic archival of settled sessions: the seven-day
  policy on the latest settlement, the projected and durable eligibility halves
  (shared `settleBlockedReason`, Workflow Run ownership, viewed sessions), the
  boot/hourly best-effort schedule, the one-transaction backfill, the unarchived
  default list query, and reversible recovery through the archive view, direct
  links and Restore.
- `state-sync.md` — the state-change event model for domain list state:
  per-object revisions applied idempotently on both sides, optimistic dispatch
  with authoritative recovery, the batched `stateEvents` wire shape, the
  notify-with-ids revision bump on the server, the per-topic seq tripwire,
  digest resync, and the zero-identity-changes-on-echo enforcement.
- `usage.md` — subscription-usage indicators: the server-owned snapshot cache
  (ownership, persistence, TTL/refresh triggers, concurrency and backoff), the
  `usage` broadcast topic and its narrow `UsageIndicator` payload, and what each
  card state means.
- `notifications.md` — the three delivery routes for one alert (Declarative Web
  Push, APNs, the live socket), which runtime acts on the socket copy and why
  exactly one may, the shared `paTarget`/`navigatePath` tap contract, and the
  APNs credential and environment setup.
- `credential-distribution.md` — which config may be packaged, the four
  core-only integration secret variables and startup scrub, the separate
  model-credential boundary, the same-UID limitation, and the provision,
  release, rotation, and revocation runbook for credentials that previously
  entered Git or build outputs.
- `port-forwarding.md` — the authenticated macOS loopback forwarding contract:
  fixed same-port targets, short-lived grants, the dedicated binary WSS route,
  limits and backpressure, native confirmation, shell command boundaries, the
  Settings section, and which `localhost` links in content are forwarded.
- `slack.md` — Slack app-side configuration and the private Socket Mode
  interaction contracts.
- `jira-tempo.md` — the Jira/Tempo split: two independent integrations (Jira
  token auth, Tempo OAuth), Tempo's dependency on Jira for enrichment,
  settings/gates/protocol shapes, the OAuth flow, and the worklog read contract
  (paging that never truncates, server-side filters, optional Jira, 429 retry,
  checkpointed full-range exports with cached metadata joins and reports).
- `confluence.md` — the Confluence integration: its own gate over Jira's
  Atlassian credentials, the v1/v2 API split, the shared ADF converters and the
  storage-format fallback, why appends splice ADF instead of round-tripping a
  page through Markdown, the version guards on approved page and attachment
  writes, frozen upload bytes, and the five agent tools.
- `pull-requests.md` — the host-driven `/pr` pipeline and checked agent-facing
  managed PR creation, merge and close, their provider/base/draft and
  Task-context rules, repository merge capabilities, the default-branch merge
  approval, dedicated draft agent, and canonical live card (storage and the
  one-time JSON import, states, observer, actions, and CI-conclusion push).
- `approvals.md` — the approval cards every agent-proposed mutation goes
  through, which tool raises which card, and "Approve for session" grants:
  operation-level keys, full-coverage rule, idle-edge execution, revocation,
  lifetime and where the user sees them; and their SQLite storage.
- `projects.md` — how a Project comes into existence: the user directly, an
  agent only through the `project_create` approval card, what approval creates
  on GitHub/Forgejo, registers and clones, and why a repository never stays
  without a commit.
- `container-images.md` — the `container_image_pull` capability: GHCR-only
  credential reuse of the GitHub token, the stdin/temporary-`DOCKER_CONFIG`/
  redaction invariants, least-privilege token setup, and troubleshooting.
- `package-proxy.md` — the loopback forward proxy with selective TLS
  interception that authenticates GitHub package registries for in-build
  dependency resolution, the proxy/CA/JVM env bundle, the
  combined-trust-material and placeholder-credential invariants, and
  troubleshooting.
- `migrations.md` — SQLite schema migrations: the version number as identity,
  adding one, which migration to renumber when a rebase collides (and why the
  other choice breaks production), the guards that enforce append-only across
  commits, who may migrate a deployed data directory, and the repair runbook.
- `deployment.md` — packaging and hosting: the production Bun package and nixos
  module (its shims, what its install check proves against dev and tests on
  Node, where Bun behaves differently, running the server suite under Bun, and
  heap snapshots), the NixOS service's lifecycle and PATH/environment, the
  one-server-per-DATA_DIR lock, its host dependencies, and the PR-preview
  instances.
- `ci-cd.md` — the GitHub Actions workflow: its jobs and the `ci` gate, test
  sharding, the gate order and measured parallelism, the cache rules, SemVer and
  changelog preparation, publishing a release tag, and what a build reports
  itself as (the three independent `BuildInfo` answers behind Settings → About
  and the desktop About panel).
- `linting.md` — the static-analysis contract: the shared `tsconfig.base.json`
  and which strictness flags are on where, why the gate is oxlint rather than
  type-aware ESLint (with the measurements), the oxlint ruleset and why it
  carries no stylistic rules, the staged rules with their measured backlogs, and
  the escape-hatch policy. It also holds the dead-code contract — why
  `noUnusedLocals` cannot see an export with no importer, the knip config, and
  the staged per-category counts whose enforced numbers live in
  `config/deadcode-budgets.json` — and the `exactOptionalPropertyTypes`
  contract: the guard idioms for new code, the only two declarations that may
  say `?: T | undefined`, and `Patch`/`applyPatch` for a patch where `undefined`
  CLEARS a field.
- `instruction-docs.md` — the policy for agent instruction files: scope, size
  budgets, what justifies a child file, the Prettier formatting contract, the
  exception marker, and how the budget check enforces them. The enforced numbers
  live in `config/instruction-budgets.json`.
- `tool-discovery.md` — deferred loading tiers, pi's exact/candidate discovery
  contract, search metadata, the measured cache rationale for reopen filtering
  and six-hour pruning, diagnostics, and `measure:tools`.
- `prompt-budgets.md` — the budgets on what a session's first request carries
  per persona and harness: what is measured and how it is normalized, the
  committed size snapshot, when raising a budget is the right answer and how to
  record it, and how the check enforces them. The enforced numbers live in
  `config/prompt-budgets.json`.
- `output-budgets.md` — bounded native read/shell/search, diff, log, and quality
  gate results across Claude and pi: budgets, navigation, retained raw-output
  artifacts, diagnostic trade-offs, exemptions, and the repeatable benchmark.
- `served-files.md` — how a file on the host reaches the user: the
  absolute-path, grant and session-artifact URL families, why there is no path
  allow-list, the delivery rules that keep served content from executing on the
  API origin, and the sandboxed grant HTML runs under.
- `component-previews.md` — the build-and-embed loop for rendering production
  React components with typed fixtures directly in chat, including the classic
  bundle shape required by the opaque HTML sandbox.
- `document-presentation.md` — the typed internal document targets, the
  link/card/embed intent boundary, worktree file and explicit-diff links, line
  anchors, source-preserving resolution, and the shared viewer navigation shell.

## Implementation reference

`reference/` holds descriptive per-subtree snapshots relocated out of the
instruction files ([Task-274](pa://task/274)): what each module owns, plus the
rationale behind the rules. They are documentation, not instruction, and never
required reading — the binding rules live in each subtree's `CLAUDE.md`, and the
table below is the only folder-to-document mapping, since an instruction file
does not spend its budget repeating its own pointer. Several subtrees
(`app/server/`, `components/ui/`, `components/review/`, `mcp/`,
`config/prompts/`, `scripts/`) have no instruction file at all, so their
reference document is the only written record. The two largest
(`web-components.md`, `server-modules.md`) are longer than one bounded read —
search them for the module you need rather than reading them whole.

| Reference                             | Subtree                            |
| ------------------------------------- | ---------------------------------- |
| `reference/web-package.md`            | `app/web/`                         |
| `reference/web-app.md`                | `app/web/src/`                     |
| `reference/web-components.md`         | `app/web/src/components/`          |
| `reference/web-shell.md`              | `app/web/src/components/shell/`    |
| `reference/web-ui-primitives.md`      | `app/web/src/components/ui/`       |
| `reference/web-diff.md`               | `app/web/src/components/diff/`     |
| `reference/web-review.md`             | `app/web/src/components/review/`   |
| `reference/web-calendar.md`           | `app/web/src/components/calendar/` |
| `reference/web-tool-cards.md`         | `app/web/src/components/tools/`    |
| `reference/web-hooks.md`              | `app/web/src/hooks/`               |
| `reference/web-lib.md`                | `app/web/src/lib/`                 |
| `reference/shared-protocol.md`        | `app/shared/`                      |
| `reference/server-package.md`         | `app/server/`                      |
| `reference/server-modules.md`         | `app/server/src/`                  |
| `reference/server-tools.md`           | `app/server/src/tools/`            |
| `reference/server-mcp.md`             | `app/server/src/mcp/`              |
| `reference/server-session.md`         | `app/server/src/session/`          |
| `reference/server-db.md`              | `app/server/src/db/`               |
| `reference/server-worktrees.md`       | `app/server/src/worktrees/`        |
| `reference/server-background-work.md` | `app/server/src/backgroundWork/`   |
| `reference/server-claude-sdk.md`      | `app/server/src/claudeSdk/`        |
| `reference/server-pi-sdk.md`          | `app/server/src/piSdk/`            |
| `reference/server-memory.md`          | `app/server/src/memory/`           |
| `reference/server-day-scan.md`        | `app/server/src/dayScan/`          |
| `reference/server-speech.md`          | `app/server/src/speech/`           |
| `reference/server-package-proxy.md`   | `app/server/src/packageProxy/`     |
| `reference/native-shell.md`           | `app/shell/`                       |
| `reference/config.md`                 | `config/`                          |
| `reference/prompts.md`                | `config/prompts/`                  |
| `reference/scripts.md`                | `scripts/`                         |
