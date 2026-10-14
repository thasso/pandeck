# Account routing

Credential profiles are accounts. Claude and OpenAI accounts never mix. This
contract currently ships health and login alerts. Selection, benching and live
switching follow in later parts.

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

Pending. New sessions and background agents will rank eligible accounts within
the model's provider and enterprise requirement.

## Limit benching

Pending. Provider-stated reset times will bench accounts and survive restart.

## Live account switching

Pending. A failed session will move to another eligible account without losing
its transcript. Switch markers belong only in the user's display, not model
context.
