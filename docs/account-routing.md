# Account routing

Credential profiles are accounts. Claude and OpenAI accounts never mix. This
contract ships health, login alerts and account selection at session/run start.
Benching and live switching follow in later parts.

## Health and login evidence

`CredentialProfileSummary.health` is `AccountHealth`: state `ok`, `needs-login`
or `unknown`, `since` as epoch milliseconds or null when not observed, and an
optional short app-owned reason. Never persist provider messages or tokens in
health. The union can grow a limit state when benching ships.

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
pure; limit benching can supply its candidate fact later without adding bench
state here.

Accounts carry `enterprise: boolean`, default false in the registry and wire
summary. Settings changes it with `PATCH /api/credential-profiles/:id`
`{ enterprise }`; this is metadata only and does not alter login provisioning. A
PATCH may include `name`, `enabled` and `enterprise` together. The server
validates every supplied field before one metadata write and publication. A
session's `requiresEnterprise` is durable, defaults to false and survives
restore and forks. Regular sessions may choose enterprise or personal accounts.
The enterprise requirement constrains the account executing the session and
automatically derived work. Neither normal ranking nor degradation may select a
personal account. An explicit personal pick is refused when the requirement is
set. This is an account constraint, not end-to-end data confinement.

Every session turn passes the shared `session/runtimePrompt.ts` admission check,
including restored sessions, first prompts and spawned peers on both engines. An
enterprise-required session whose bound account is missing or no longer
enterprise is refused before any append. Disabled bound accounts still run if
they satisfy the enterprise requirement. Enterprise flag changes apply to runs
and one-shots admitted after the change; an already admitted run may finish.
Policy is not rechecked inside provider engines. Manual compaction on both
engines checks the same enterprise assertion at the shared host-command entry,
before flushing memory or making its model call.

Enterprise scope follows work the session starts automatically. Spawned peers
inherit `requiresEnterprise: true`, including approval-delayed creation. An
explicit approved runtime naming a personal account is refused with a clear
reason, not replaced. Unpinned spawn proposals and named agent-definition spawns
use the picker at their fixed model and effort, within enterprise accounts of
the model's provider when the source requires it, without preferring the
proposer's account. Named definitions capture scope before library awaits,
re-resolve immediately before creation, and propagate it to the child. Approved
peer runtime definitions always name an explicit account and never route.
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
disabled-default fallbacks; usage exhaustion remains a ranking preference, not a
new hard eligibility rule.

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

Within a tier, prefer the earliest known future weekly reset, then the lowest
known 5-hour usage, then the stable account id. Unknown values sort last; stale
values do not claim a reset or headroom. Shared `USAGE_STALE_MS` determines age,
and `usageWindowPct` invalidates a cycle after its reset. Thresholds are
consumed percentages in `AppSettings.accountRouting`: `fiveHourUsedThreshold`
defaults to 90 and `weeklyUsedThreshold` to 95. Room means strictly below both.
Settings exposes these under Models; storage normalizes each to 0–100.

If health/model/effort/bench filters leave none, prefer remaining enabled
accounts without `needs-login`, then accounts offering the fixed model and
effort, before comparing usage. Provider and enterprise scope still apply. Mark
the result `no-eligible-account`. Needs-login accounts are the last resort even
when their cached usage looks better or every model snapshot failed. Background
automation alone may finally use that provider's protected default, even
disabled, marked `disabled-default`. Exclusions and enterprise constraints still
apply to that fallback. Interactive creation with no enabled account fails
clearly, including the no-enterprise-account case. The pick result carries the
degradation; it never silently crosses provider or enterprise boundaries.

New-session and settings-slot selectors default to Automatic. At creation,
Automatic applies only when no account is already bound or explicitly selected.
The server picks once when the session or background run starts; the resolved
account is then pinned for the session's lifetime. Bound drafts and forks keep
the parent's account, even if it is disabled or unhealthy, when it belongs to
the child's provider; otherwise Automatic picks one within the same enterprise
requirement. An enterprise-required child still refuses if that bound account is
no longer tagged enterprise. Restoring an existing session keeps its native
account affinity, not today's Automatic choice. Explicit session picks, approved
peer runtimes and workflow role accounts remain explicit. Settings slots keep
pins saved before Automatic existed until the user changes them in Settings.
Slots with no pin resolve afresh on every run; an unusable pin degrades under
the existing background-automation policy: missing, disabled or
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
be picked, the original outcome is preserved. This does not remember a bench and
does not switch interactive sessions; those remain later parts.

## Limit benching

Pending. Provider-stated reset times will bench accounts and survive restart.

## Live account switching

Pending. A failed session will move to another eligible account without losing
its transcript. Switch markers belong only in the user's display, not model
context.
