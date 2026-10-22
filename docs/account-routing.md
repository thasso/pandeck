# Account routing

Credential profiles are accounts. Claude and OpenAI accounts never mix. This
contract covers health, login alerts, temporary limit benches, account selection
at session/run start and live-session failover.

## Health and login evidence

`CredentialProfileSummary.health` is `AccountHealth`: state `ok`, `needs-login`,
`limited` or `unknown`, `since` as epoch milliseconds or null when not observed,
and an optional short app-owned reason. `limited` carries `until` and optionally
`model`. The process-local `benchRevision` invalidates previews for changes to
any scope, including a shorter cap hidden by the card's primary bench. Missing
credentials and login rejection take precedence over limits. Never persist
provider messages or tokens in health.

`app/server/src/accountHealth.ts` owns health in memory and persists best-effort
to `DATA_DIR/cache/account-health.json`, using a private `0600` temporary file
and rename. Missing or corrupt files start unknown. A restart retains observed
login failures and whether an account ever had credentials. Only
`wasConnected: true` restores connection history. Deleted accounts are
forgotten; late evidence for deleted ids is ignored. Disabled accounts retain
health but never alert or push.

Evidence rules:

- Missing credentials derive `needs-login` with "Not connected." on Settings
  cards, independent of setup status and overriding observed `ok`.
  Never-connected accounts, including unused default accounts, do not raise
  app-wide alerts. An account whose credentials were previously present does
  alert when they vanish, including through Connect, failure and cancellation.
  The derived condition is never persisted or pushed; only its prior connection
  history is durable. Health reads are pure lookups. Registry listing is the
  single publication point: it reads credential presence, records connection
  history and broadcasts only a changed alert projection. Runtime success never
  establishes credential-presence history. A default Claude account using an API
  key or apiKeyHelper without an OAuth credential file remains card-only "Not
  connected.", even after successful runs or usage and across restart. Every
  health mutation ends with one listing. File changes alone have no filesystem
  watch; the next listing clears a derived alert when credentials reappear, even
  without a registry event. Observed rejection remains until positive proof.
- OpenAI usage with `available: true` marks the account `ok`; `rejected` marks
  it `needs-login`. `not-signed-in` is not runtime evidence because an
  unreadable or partially rewritten auth file also produces it. Credential
  absence is derived separately. `expired` changes nothing: the read-only reader
  sees an old access token, while pi can refresh it on use. `forbidden` changes
  nothing: the usage endpoint may be restricted.
- Claude usage proves `ok` only when `rateLimitsAvailable === true`. Missing
  rate limits and timeouts change nothing. Only an error clearly identifying a
  dead login marks it `needs-login`.
- A session failure must carry normalized kind `auth` and the structured
  `RunFailureFacts.loginDeath` fact, classified from raw provider evidence
  before display sanitization. The classifier's narrow wording is: 401,
  unauthorized, authentication_error, invalid API key, "please run /login", not
  logged or signed in, OAuth token expired/revoked, rejected/expired/revoked
  refresh credentials, no API key, or invalid_grant. A refresh-failed wrapper
  alone proves nothing. Known HTTP status overrides wording. Claude sessions and
  one-shots preserve `api_error_status` independently of the provider's text;
  the classifier also recognizes an explicit `API Error: NNN` wrapper. A 5xx
  response never proves login death, whatever its wording. A 401 response
  classifies as auth and proves login death even with a non-auth body. Claude
  403 proves login death only when the wording explicitly says a token or
  credential was revoked, expired or rejected. Generic Unauthorized,
  authentication_error or permission wording on a 403 does not. OpenAI/Codex
  keeps its stricter rule: a run failure without a known HTTP status never
  proves login death. The installed pi-ai 1.1.0 Codex SSE transport drops HTTP
  status and returns only `error.message`, so bare Unauthorized cannot
  distinguish a 401 from a 403 or 503. Status-bearing token-refresh failures
  prove rejection on 401, or on 400 with invalid_grant or explicitly
  revoked/expired/rejected credentials. Codex 403 never proves login death.
  Preserved structured HTTP status still takes precedence over wording. A
  normalized session completion, including failure, marks account usage dirty.
  With a browser connected, the cache revalidates after its 30-second debounce,
  respecting minimum intervals and backoff. The usage reader's 401 `rejected`
  supplies login-death evidence and publishes the alert to that connected
  client. Read-only expiry and forbidden usage remain non-evidence. The same
  status-aware predicate sets the login-death fact; auth classification alone
  does not. Only the classifier sees provider wording, in memory.
- Sessions and one-shots count only when their actual model provider is the
  account's own subscription provider: `openai-codex` or `claude-sdk`. Copilot,
  compatible-key and other pi providers can share the account directory, but
  neither their failures nor their successes change subscription health.
- A session ending `end`, a successful one-shot, or genuine completion of a
  login marks the account `ok`. Cleanup, reconnect start, cancellation, failure,
  and `connecting` returning to `ready` with an old credential do not clear it.
  Claude clears on the official CLI's successful completion. OpenAI clears on
  the device flow's own credential-store commit or resolved login. A dedicated
  login-only SDK facade captures its own successful OAuth result and matches it
  to the SDK-serialized credential before post-login snapshot synchronization.
  An unrelated runtime's token rotation cannot complete the flow. Errors or
  timeouts after commit do not reinstall setup errors; the operation still
  serializes another login until SDK synchronization settles. Completion also
  force-refreshes the account's session runtime snapshot best-effort,
  independently of the login-only facade. Deletion invalidates pending snapshot
  refresh and removes any SDK files it writes late.

Health evidence entry points are best-effort. Registry, credential-presence or
notification failures cannot change a session, one-shot or usage-fetch outcome.
Synchronous evidence failures log an app-owned warning without the dependency's
error prose.

Every async observation captures a monotonic per-account order and credential
generation before it reads credentials. Completed login advances the generation.
Older generations or operation orders cannot undo newer evidence. Session and
one-shot failures share report-time ordering while retaining their start
credential generation. Intervening usage cannot hide a later login-death
failure. Success keeps its start order. Clocks are process-local: no observation
survives restart, so a fresh clock suffices. Only state, since, reason and
wasConnected persist, and only when one changes. Wall clocks and snapshot
fetchedAt never determine precedence, so a clock rollback cannot block a
completed login.

Session health tracking uses the adapter's live model provider at the start of
each turn, and only the session's explicit credentialProfileId binding. Unbound
legacy sessions report no health; today's automatic account is irrelevant.
Tracking matches reports by run id and drops entries on every turn closure or
session disposal, even without native completion. Only a normalized provider
`end` supplies success evidence; a synthetic, fallback or disposal closure does
not.

Runtime run-failure subscribers are independent, isolated and notified once per
run. They do not replace the durable failure hook or repeat when it retries.

## Alerts

`accountLoginAlerts` is app-wide lifecycle state, replayed after `ready` to each
new connection and broadcast on change. Only enabled accounts with an observed
rejected/dead login or previously present credentials that disappeared qualify.
It carries affected account ids, labels and providers, sorted by id. The browser
stores it in `useAssistant`.

The existing app status slot always displays a connected account-login alert,
ranked below restart and connection states. One affected account is named;
several show a count. Only this pill is interactive, linking to the first
affected account's `/settings/claude-sdk` or `/settings/openai` section.
Unmodified primary clicks use SPA navigation; the href remains for modified
clicks and accessibility. Other status pills keep passing pointer events through
to native title-bar dragging. Settings account cards show "Needs login" and the
app's short reason beside setup status, and re-read account summaries when the
login-alert projection changes while Settings is open.

Runtime evidence from usage, a session or a one-shot sends one app notification
per transition into `needs-login` for an enabled account. Repeated failures,
registry discovery and startup replay send none. A successful login or run
clears the transition, so a later dead login can notify again. Push taps open
provider settings. Delivery and foreground handling remain the existing
`deliverAppNotification` policy. This is the user's explicit exception to the
object-only messaging rule, documented in `messaging.md`.

## Account picker

`app/server/src/accountRouter.ts` owns automatic selection. Gathering reads
account summaries, the official per-account model snapshots through the harness
models port, and `usageCache.ts`'s cached indicators. It never fetches usage or
changes the model, effort, workflow plan or provider. The ranking function is
pure; the health owner's bench store supplies the candidate fact without owning
bench state here.

Accounts carry `enterprise: boolean`, default false in the registry and wire
summary. Settings changes it with `PATCH /api/credential-profiles/:id`
`{ enterprise }`; this is metadata only and does not alter login provisioning.
Accounts also carry an integer `priority` (default 0; `{ priority }` on the same
PATCH, an integer field on the Settings account card). A PATCH may include
`name`, `enabled`, `enterprise` and `priority` together. The server validates
every supplied field before one metadata write and publication. A session's
`requiresEnterprise` is durable, defaults to false and survives restore and
forks. Regular sessions may choose enterprise or personal accounts. The
enterprise requirement constrains the account executing the session and
automatically derived work. Neither normal ranking nor degradation may select a
personal account. An explicit personal pick is refused when the requirement is
set. This is an account constraint, not end-to-end data confinement.

Every session turn passes the shared `session/runtimePrompt.ts` admission check,
including restored sessions, first prompts and spawned peers on both engines. An
enterprise-required session whose bound account is missing or no longer
enterprise is refused before any append. A turn starting on a disabled bound
account first moves the session; see
[Live account switching](#live-account-switching). Enterprise flag changes apply
to runs and one-shots admitted after the change; an already admitted run may
finish. Policy is not rechecked inside provider engines. Manual compaction on
both engines checks the same enterprise assertion at the shared host-command
entry, before flushing memory or making its model call.

Enterprise scope follows work the session starts automatically. Spawned peers
inherit `requiresEnterprise: true`, including approval-delayed creation. An
agent may also request it per `session_spawn` row, on `spawn` and `propose`, for
approved runtimes and named definitions alike. A row's effective requirement is
the source's OR its own `requiresEnterprise: true`; `false` never relaxes an
inherited one, and a batch may mix enterprise and ordinary rows. A proposal
seals the effective value on each card item, so approval edits cannot clear it
and both settlement and creation enforce it. An explicit approved runtime naming
a personal account is refused with a clear reason, not replaced. Unpinned spawn
proposals and named agent-definition spawns use the picker at their fixed model
and effort, within enterprise accounts of the model's provider when the source
requires it, without preferring the proposer's account. Named definitions
capture scope before library awaits, re-resolve immediately before creation, and
propagate it to the child. For a direct named-agent spawn without `modelId`,
`agents/agentSpawn.ts` may respond to a default model's `no-eligible-account`
pick by trying the next listed model with a non-degraded pick. Every attempt
uses the same router and enterprise requirement; the spawn layer owns no health
or bench state. Unresolved alternatives are skipped. Explicit `modelId` and
account pins never substitute a model. No healthy alternative leaves the
original degraded default policy intact. The spawn result names the selected
model and explains the substitution, and the frozen session-agent record keeps
`modelFallbackReason`. See
[Model and effort](agent-definitions.md#model-and-effort) for the
resolution-failure boundary. This does not change the router's same-provider
live-switch policy.

Approved peer runtime definitions may approve Automatic or a specific account.
Automatic resolves at spawn time for the fixed provider, model and thinking
level, within the source's enterprise requirement. A selected account must still
offer that exact runtime, including after a degraded router pick. Explicit peer
account pins never route or degrade to Automatic. Approval edits during account
selection refuse the stale resolution; a new spawn reads the current approval.
Tombstoned source rows retain their requirement; a missing source row fails
closed. Automatic helpers reading its transcript, including naming, retitling,
status, refinement and commit/PR context, also require enterprise accounts.
Commit review override approvals retain the captured requirement in their
server-side context; execution captures it again before worktree/git awaits and
forwards it to the repeated review. A helper reading several sessions requires
enterprise if any input session does. If no eligible enterprise account is
available, skip that helper and keep its existing fallback, such as leaving the
title unchanged. Source requirements cannot be cleared by omitting a child flag
or passing false. Enterprise transcript helpers do not use degraded or
disabled-default fallbacks. Below 100%, usage remains a ranking preference;
exhausted windows with a future reset are hard-filtered as benches.

Enterprise-required sessions are excluded from memory capture entirely. Their
transcripts produce no memory observations and never enter memory processing.
There are no enterprise markers on memory cards or general data-taint tracking.

Human workflow launches are standalone, source-free user authorization. They do
not inherit requirements from the session on show. The web start sheet always
names each role's account, including enterprise accounts, so the user compares
usage meters and picks explicitly; it offers no Automatic choice. The server
still routes unpinned roles, such as those from saved configs, at their fixed
model and effort. No production caller starts a workflow from an agent session,
so workflow config carries no latent source requirement.

Deliberately outside this boundary are messages to pre-existing sessions, KB
writes, Tasks, files and other content a user or agent explicitly sends
elsewhere. The app neither restricts those actions nor tracks the content
through them. Unrelated sessions and source-free background work do not inherit
a requirement from a global setting. An unbound document-comment draft has no
session requirement until a source or enterprise intent is declared; the
existence of another enterprise session does not constrain its refinement.

Automatic candidates must be enabled, belong to the model's account provider,
not need login, offer the exact model and requested effort, and not be benched.
Claude shares its curated model list; pi availability comes from each account's
isolated SDK runtime. Ranking is:

1. Fresh usage with room in both plan windows.
2. Missing, partial, unavailable or stale usage.
3. Fresh usage at or beyond either threshold, even if the other window is
   unknown.

Within a tier, the higher manual `priority` wins first, so it never lifts a
stale, missing or exhausted account over one with fresh room. Priority never
readmits a filtered account or crosses the enterprise requirement.

Then prefer the earliest known future weekly reset, then the lowest known 5-hour
usage, then the stable account id. Unknown values sort last; stale values do not
claim a reset or headroom. Shared `USAGE_STALE_MS` determines age, and
`usageWindowPct` invalidates a cycle after its reset. Thresholds are consumed
percentages in `AppSettings.accountRouting`: `fiveHourUsedThreshold` defaults to
90 and `weeklyUsedThreshold` to 95. Room means strictly below both. Settings
exposes these under Models; storage normalizes each to 0–100.

If health/model/effort/bench filters leave none, prefer remaining enabled
accounts without `needs-login`, then unbenched accounts, then accounts offering
the fixed model and effort, before comparing usage. Provider and enterprise
scope still apply. Mark the result `no-eligible-account`. Needs-login accounts
are the last resort even when their cached usage looks better or every model
snapshot failed. Background automation alone may finally use that provider's
protected default, even disabled, marked `disabled-default`. Exclusions and
enterprise constraints still apply to that fallback. Interactive creation with
no enabled account fails clearly, including the no-enterprise-account case. The
pick result carries the degradation; it never silently crosses provider or
enterprise boundaries.

New-session and settings-slot selectors default to Automatic. At creation,
Automatic applies only when no account is already bound or explicitly selected.
The server picks when the session or background run starts. A session keeps that
binding until an own-subscription limit or dead login triggers live failover
below. Bound drafts and forks keep the parent's current account, even if it is
disabled or unhealthy, when it belongs to the child's provider; otherwise
Automatic picks one within the same enterprise requirement. An
enterprise-required child still refuses if that bound account is no longer
tagged enterprise. Restoring an existing session keeps its native account
affinity, not today's Automatic choice. Explicit session picks, pinned peer
runtimes and workflow role accounts remain explicit. Existing peer rows keep
their account until the user selects Automatic. An unpinned peer row stores no
`credentialProfileId`, and an empty string also means Automatic. The roster
reports its account policy as Automatic; spawn results name the actual account.
Settings slots keep pins saved before Automatic existed until the user changes
them in Settings. Slots with no pin resolve afresh on every run; an unusable pin
degrades under the existing background-automation policy: missing, disabled or
provider-mismatched pins. An enabled, provider-matching pin remains explicit
despite login health or model/effort availability; failures alert on that
account, not a different one. `automaticProfileIdFor` remains only a
first-enabled hint for non-routing login/usage UI, not a routing function. When
the saved model has no Automatic option, a Settings slot offers **Use
Automatic** to clear its pin without changing the model or effort.

`POST /api/account-router/pick` accepts `AccountPickPreviewRequest` and returns
`AccountPickPreviewResult`, so a selector can show Automatic's current account
without duplicating ranking in the browser. It uses cached usage and model
snapshots, not a usage fetch. A preview is informational: the actual start
resolves again and the account may have changed meanwhile. Browsers cannot
affect retry exclusions through this API. Its optional `scope: "background"`
previews the protected-disabled-default policy for settings slots; it never
authorizes interactive creation on a disabled account.

An automatically chosen background one-shot that reports `quota`, `rate_limit`
or a structured `loginDeath` retries once on another picked account, excluding
the failed account. Plain auth classification is not sufficient. A slot that
names an explicit pin never retries across accounts, even if that pin had to
degrade. Both attempts' reported consumption is recorded. If no replacement can
be picked, the original outcome is preserved. Each attributed limit failure also
benches its failed account, including pinned runs. Existing sessions use the
separate live-failover policy below; one-shot explicit pins remain exact.

## Limit benching

`accountHealth.ts` owns `accountBench.ts`. An explicitly attributed session turn
or background attempt on the account's own subscription provider benches on
`quota` or `rate_limit`. Other model providers, missing/deleted bindings, aborts
and unrelated errors supply no limit evidence. A future provider `resetAtMs`
wins; without one, `QUOTA_BENCH_MS` is 30 minutes and `RATE_LIMIT_BENCH_MS` is 5
minutes. A past stated reset never creates a live bench. A later limit error
does not shorten an already active bench of the same scope.

Only evidence that identifies a named model cap supplies `limitModel`. The run's
model id alone does not imply a per-model cap. Named caps bench account+model;
otherwise the whole account is benched. There is no invented JSON field or fixed
family inventory: explicit model-cap wording supplies the name, whose normalized
words must be a subset of the executing model id's words in every parsing branch
(provider branding is ignored). Without a model id, no model scope is inferred.
Generic session, request and API limits remain whole-account benches;
capitalization and digit-only normalized caps are not model evidence. Runtime
fallback classification supplies the adapter's live model id. Successful turns
carry the adapter's live model id; a success clears its whole-account bench and
matching model cap, not other model caps. A successful login alone is not proof
of quota room.

Claude HTTP 429, whether structured or in an explicit `API Error: 429` wrapper,
classifies as a limit even when the wording omits rate-limit terms. Its CLI
quota wording, including `Opus weekly limit reached ∙ resets Oct 20, 3pm` and
`You've hit your Opus limit · resets 3pm`, classifies as quota; a named cap
still requires a matching executing model. Human reset text uses the fallback
duration. The pipe suffix in `Claude AI usage limit reached|1900000000` is an
explicit epoch seconds field, forwarded as `resetAtMs: 1900000000000`.

The installed `@anthropic-ai/claude-agent-sdk` 0.3.296 manifest identifies CLI
2.1.296, commit `fdb6c17a97b6e0e3cf15e3566663fca58e7c43a9`. Its bundled
`@anthropic-ai/claude-agent-sdk-linux-x64/claude` constructs
`You've hit your ${name} · resets ${time}`, where the name is a session, weekly,
Opus or Sonnet limit. The exact pipe-form literal is not present in that build;
it is covered separately as provider error input.

Freshly fetched OpenAI/Claude windows at or above 100% with a future reset also
bench. Cold cached snapshots never hydrate bench state. Generic windows affect
the whole account. OpenAI spend control never benches: it budgets only
extra-credit usage beyond the included windows, which the provider consumes
first, so a reached or zero budget is no evidence the subscription is out. An
account whose included windows are exhausted is still benched by those windows,
which leaves its extra credits as the degraded last resort below. A usage bench
persisted from an earlier spend-control reading clears like any usage bench.
OpenAI's missing-label mapper fallback `Model limit`, generic counter titles and
numeric-only labels also affect the whole account. Counter words and units are
removed before normalizing named windows, so `Codex Spark weekly limit` still
names Spark. Named windows and active named Claude limits affect only that
model. Multiple exhausted windows of one scope use the latest reset. Missing
percentages or resets cannot create a usage bench. This consumes existing fetch
results; it adds no fetching. Each bench records its source: `usage`, `quota` or
`rate_limit`. Fresh usage clears only a usage-sourced scope, and only when all
its present windows show valid room below 100%, not when a cap disappears or
data is unavailable. Usage cannot clear, re-label or replace an active
failure-sourced bench, even at 98–99% usage; those benches end at their reset or
on a later successful own-provider run on that account/model. A failure upgrades
a usage bench's source even if its reset is unchanged. Absent generic Claude
windows are not fabricated as unknown windows.

Failures refresh their order at report time while retaining the run-start
credential generation check, just like login-death reports. Success and usage
retain their operation-start order. A concurrently running success that started
before a quota report cannot hide that report, even if it completes later.
Positive evidence and per-scope ordering stay process-local; stale positive
evidence cannot clear or resurrect a newer decision.

One unref'd timer publishes at the earliest live reset, removes expired benches
and reschedules for the next reset, so open cards and previews refresh without
another user action. Reads also ignore expired benches. Persistence in
`DATA_DIR/cache/account-health-benches.json` is best-effort, private `0600`
tmp+rename under the private cache directory, and writes only when live bench
state changes. Bench sources are persisted privately and retained across
restart; health/card summaries project only the safe limit time and model. Only
live benches are persisted: no cleared records, hydration fences, ordering
tickets or provider text. Expired benches are not restored; deleted accounts are
forgotten.

Automatic hard-filters applicable benches before normal ranking, within the same
provider/enterprise scope. If no eligible account remains, its existing degraded
policy ranks needs-login last, then benches, then model/effort and usage.
Explicit pins remain exact and do not reroute or interrupt admitted work.
`limited` is a card/preview state: “Limited until <time>”, optionally naming the
model. A live whole-account bench takes card precedence over longer model caps.
Every scope change increments `benchRevision` and publishes
`accountHealthChanged`, even if the primary card bench stays unchanged. Its
socket event refreshes both account projections and mounted Settings cards;
preview keys include the revision. Limits never enter the app-wide login alert
or push notification projection.

## Live account switching

A turn that starts on a disabled bound account moves first
(`moveOffDisabledAccount`, called by `session/runtimePrompt.ts` after skill
admission). It picks a non-degraded account for the session's model, effort and
enterprise requirement, moves the idle session through the same
`driver.switchAccount` as failover below, and appends the display-only marker
`Switched from A to B — A is disabled.` With no eligible account the turn is
refused before any append with a message naming the disabled account. A running
turn, a steer into it, a recovery continuation and a provider-initiated turn
(`beginRuntimeProviderTurn`) are never moved this way. Disabling an account
therefore takes effect on each bound session's next turn.

An explicitly bound session can also move after its own subscription provider
reports `quota`, `rate_limit` or structured `loginDeath`. Plain auth errors,
unrelated providers/errors and Stop or abort never trigger a move. This applies
to interactive, background and provider-initiated runs, including explicitly
selected session accounts. Existing Settings one-shot pins keep their policy
above.

`sessionAccountSwitch.ts` observes the normalized native run lifecycle. Health
and bench reporting happens first. At failed-run closure it reserves admission
before run waiters and idle queues can start another prompt. The engine must
finish unwinding before it changes accounts. Stop generations, automatic-turn
holds, worktree admission, model/effort and the session's enterprise requirement
are rechecked across asynchronous work and immediately before continuation.

The picker receives the current provider, model and effort, the persisted
enterprise requirement, and all accounts attempted during this turn. A degraded
result is never a replacement. Each account is selected once for failover; an
exhausted turn keeps its last failure and binding with a display note saying no
other eligible account is available. A new genuine turn resets the attempt set.

A successful move updates the live binding, session row and engine record before
broadcasting state. Forks, drafts, health and usage attribution therefore follow
the current account. Ordinary metadata upserts cannot change this binding;
`sessionStore.switchCredentialProfile` is a compare-and-set against the prior
account on a nondeleted row.

Claude closes and awaits its old query epoch, copies the native JSONL and entire
subagent directory between profile roots, then resumes the same provider session
id. After the binding CAS commits, the source JSONL/subagent tree is removed
best-effort; an aborted move instead removes its destination copy. Cleanup
failures warn without transcript content or paths. Session DELETE sweeps that
native id's JSONL and subagent directory across every Claude profile and project
key, including disabled profiles and `.account-switch-*` staging directories
left by a crash, to remove leftovers. Missing native identity, missing history
or unsafe history refuses the move. See
[Claude session records](claude-session-records.md#account-failover). Pi
prepares a new account runtime and model registry on the same account-neutral
session file, preserving its id, cwd, persona, skills, mode and live wrapper.
Tool activation and its exposure/prune registrations swap only when the
replacement is admitted, then reapply the live mode so a Build/Plan change
during staging takes effect. An abandoned staged runtime leaves the old
registrations intact. Pi refuses the move if the native leaf changes during
reopen, including a late naming write, or the replacement loaded a different
leaf.

The retry needs no user message. `RuntimePromptOptions.continuation` suppresses
app-owned and Claude-record user entries. Claude receives a minimal model-only
continuation instruction. Pi uses a hidden SDK custom-message turn rather than
bare `Agent.continue`, which bypasses SDK settlement, retries, compaction and
queues. The original user input is not appended again. The failed assistant
response stays in pi's physical file; an append-only SDK context edit omits it
from the replay request. A completed pi continuation binds its trailing native
custom-message prompt without inventing an app user row. The completed-turn
boundary and scanned prompt must both explicitly flag the continuation; ordinary
turn structure and call-id checks still apply all-or-nothing. Its recovered
reply is forkable at its terminal native id, and a fork before the next user
message keeps that reply. Ordinary steering joins the open continuation without
changing its continuation boundary, including tool work completed before the
steer.

If a replacement OpenAI account explicitly rejects encrypted reasoning, one
same-account retry removes only opaque OpenAI thinking blocks from model context
through append-only edits. It retains the physical transcript, text and tool
calls/results. The fallback filters current projected message content,
preserving prior context-edit omissions and replacements rather than reviving
raw entries. No reasoning is removed preemptively, and unrelated errors cannot
activate this fallback.

Switch and refusal notices persist as app-owned `provider.notice` rows without
provider diagnostics. Reset times use the user's configured time zone. They are
display-only, never native history, model context or another user turn. Native
attempts retain their own audit/health facts, but caller waiters and failure
notices remain pending while recovery decides. Each successful move marks its
source account's usage dirty; the deferred final completion marks the current
account, so every account that ran is refreshed. Without a continuation they
receive the original failure; after switching they receive the continuation's
outcome, not a premature interruption. Continuations open new native runs
through the same admission door. Recovery is a typed busy state to queues,
peers, handoffs and host commands. It stays reserved through continuation
settlement, then release re-offers the idle edge. An unrelated idle turn cannot
replace the original caller's outcome. Claude retained hosts close only through
the background supervisor; active work refuses the switch. Pi background
processes are supervisor-owned and keep running independently of its SDK
runtime. No switch interrupts admitted work or changes running credentials.
