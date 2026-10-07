# Subscription usage

Three surfaces show how much of a provider subscription an account has consumed:
the **Usage page** (full detail per account), the **new-session provider cards**
(a two-row meter per account) and the **workflow start sheet's** expanded
runtime row, which offers the same account cards. They read one server-owned
cache; none queries a provider on render. This document is the contract for that
cache — ownership, delivery, refresh policy, and what each state means.

## Sources

| Provider       | Source                                              | Windows                                                                   | "No data" case                                        | Fetch cost                 |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------- |
| `claude`       | Claude Agent SDK experimental usage control request | 5-hour, weekly, per-model weekly, generic `limits[]`, extra-usage credits | `rateLimitsAvailable: false` (API key/Bedrock/Vertex) | CLI subprocess, seconds    |
| `openai-codex` | ChatGPT backend `GET /backend-api/wham/usage`       | 5-hour, weekly, named model caps, spend control, reset credits            | `available: false` (missing/expired token)            | one HTTPS call, sub-second |

Those are the only two `CredentialProfileSummary.provider` values, so both card
types show real data. Fetchers live in `claudeSdk/usageQuery.ts` and
`piSdk/openaiUsageQuery.ts`; both read credentials that never leave the server,
keyed by credential-profile id (accounts are isolated per profile directory).

## Ownership

`app/server/src/usageCache.ts` owns every snapshot:

- **In memory**, keyed by credential-profile id. Several tabs plus the Usage
  page share one snapshot.
- **Persisted best-effort** to `DATA_DIR/cache/usage/<profileId>.json`
  (tmp+rename, file mode `0600`, tolerant of corrupt files — the same shape as
  `DATA_DIR/cache/jira`), so a restart does not blank every card. A file whose
  recorded provider no longer matches the account is ignored. What is stored is
  the RAW provider snapshot, so it holds more than the card payload does (an
  OpenAI file includes the account email and spend-control detail); it never
  holds a token.
- Deleting an account removes its entry **and** its file.

It is server-owned because the credentials are: the Claude fetch spawns a
process and must be single-flighted globally, and no browser may hold provider
tokens.

## Delivery

`usage` is a `BroadcastTopic`. Subscribing is the authoritative read, so page
open = subscribe = instant cached snapshot, and every later refresh pushes to
all subscribers with no polling and no extra HTTP round trip. Only the metering
surfaces subscribe (`lib/broadcastTopics.ts`): the two ROUTES by name, and the
workflow start sheet as a metering OVERLAY (`meteringOverlayOpen`), which adds
`usage` on top of whatever route it was opened over and drops it again when the
sheet closes.

The wire payload is `UsageIndicator` (`app/shared/usage.ts`): profile id,
provider, `short`/`long` window `{usedPct, resetsAt}`, `limitsAvailable`,
`refreshing`, `fetchedAt`. It is never the raw snapshot — account email, spend
control and credit detail stay off the card path. Disabled accounts never appear
in the indicator list and none of the cache's own triggers fetch them (an
explicit `/api/usage/*` read for a disabled account's id is still answered — the
account stays resolvable for sessions already bound to it).

`GET /api/usage/claude`, `GET /api/usage/openai` still serve the Usage page's
full detail. They read the same cache; `?refresh=1` forces a live fetch and
writes through.

## Refresh policy

Always serve the cache instantly and revalidate in the background — a fetch
never blocks a render.

|                                  | Claude | OpenAI |
| -------------------------------- | ------ | ------ |
| Fresh (serve, no revalidate)     | 5 min  | 2 min  |
| Stale badge (dimmed + `⟳`) after | 15 min | 10 min |
| Min interval between fetches     | 60 s   | 20 s   |
| Hard-invalid → `—`               | 60 min | 30 min |

The fetch half of that table lives in `usageCache.ts`; the display half
(`USAGE_STALE_MS`, `USAGE_HARD_INVALID_MS`) lives in `app/shared/usage.ts`,
because the **client derives staleness from `fetchedAt`** rather than being told
it: a snapshot ages by the clock, with nothing happening on the server to push a
new value, and an account stuck in failure backoff would otherwise keep claiming
to be fresh.

One more hard-invalid rule for both providers: once `now` passes the displayed
window's own `resetsAt`, the cached percent is known-wrong (the window rolled
over), so that row degrades to `—` rather than showing a stale number. Within a
window a stale percent is only ever a lower bound, which is what makes dimming
it safe.

### Triggers

1. **Page open** — the primary path. Render from cache, kick a background
   refresh when not fresh.
2. **Turn end** — `subscribeSessionRunCompleted` fires once per provider run:
   the run's credential profile is marked dirty and refreshed after a 30 s
   debounce, still respecting the min interval — but **only while a client is
   connected**. With no client attached nothing is fetched for any provider; the
   account stays dirty and the next page open pays for the refresh. The cache
   itself therefore never does headless work (the auto-redeem sweep below is the
   bounded, OpenAI-only exception), which is also why persisting it matters.
3. **Session end** needs no trigger: a session's last turn is already a run
   completion. `setSessionIdleHook` is deliberately **not** used — it is a
   superset (host commands included) and would double-fetch.
4. **Visible heartbeat** — while a metering page is mounted and
   `document.visibilityState === "visible"`, the client nudges the server once a
   minute. It is only a hint: the cache no-ops while fresh. Hidden tabs stop.
5. **Manual** — the Usage page's refresh button (`?refresh=1`) bypasses
   freshness and writes through. Redeeming an OpenAI reset credit forces the
   same, since it resets a window.
6. **Auto-redeem sweep** — the ONE headless exception, OpenAI only; see
   [Reset credits](#reset-credits) below.

### Concurrency and failure

Single-flight per account. At most **one Claude subprocess at a time globally**
(the rest queue) and **two concurrent OpenAI fetches**. The Claude fetch keeps
its 20 s timeout; OpenAI gets 10 s. On failure the last good snapshot is kept,
the account stays dirty if a turn had marked it (a failed attempt learned
nothing), and it backs off 1 → 5 → 15 min, capped at 30 min. A logged-out or
mid-login Claude account can hang to its timeout, so the backoff applies to
timeouts exactly as to errors.

The global Claude gate is a deliberate trade: pressing Refresh with several
Claude accounts serializes them, so worst case is roughly N × 20 s where it used
to be parallel. One subprocess at a time is worth more than a fast refresh of a
page nobody watches per-account.

An unforced HTTP read prefers an older snapshot over an error — it only fetched
because it had nothing fresh. A **forced** read (`?refresh=1`) reports the
failure instead: it is a user pressing Refresh, and answering 200 with the
numbers already on screen would make the button look like it did nothing. The
page keeps showing its last snapshot next to the error.

## Reset credits

OpenAI grants "Full reset" credits that clear a currently-hit window early. A
credit lapses thirty days after its grant — at the grant's time-of-day in UTC,
so "expires Sep 21" typically means 04:21 that morning in Berlin — and the
backend then DROPS the row from `/wham/rate-limit-reset-credits` (there is no
`expired` status to show). `applicableCount` from `/wham/usage` is how many are
usable right now; it is 0 unless a window is actually hit.

### Redeeming

`POST /api/usage/openai/redeem-reset` `{ creditId, profileId?, force? }`.
Without `force` the server re-reads `/wham/usage` and refuses with 409 unless
`applicableCount > 0` — redeeming with nothing hit may spend the credit for
nothing. The Usage page's button is enabled whenever a credit is banked; when
nothing is hit the confirm dialog carries that warning and sends `force: true`
("Redeem anyway"). A 409 to an unforced attempt (the snapshot's "usable now" was
stale) switches the open dialog to that same warned path rather than looping.
The choice is the user's, not the button's: an unspent credit is worth exactly
nothing once it lapses.

### Expiry rendering

Expiry is banded by `resetCreditExpiryLevel` (`app/shared/usage.ts`), and the
countdown is `formatUsageReset`'s banded duration, never a rounded-up day count
(the `in 1d` that hid eight remaining hours):

| Level      | Remaining          | Row reads                                              | Tone    |
| ---------- | ------------------ | ------------------------------------------------------ | ------- |
| `ok`       | > 5 days           | `expires Oct 4 · in 13d`                               | faint   |
| `soon`     | ≤ 5 days           | `expires Sep 24, 04:21 · in 2d 22h`                    | warning |
| `imminent` | ≤ 24 h             | `expires today 04:21 · in 7h 40m · auto-redeems 22:21` | danger  |
| `pending`  | ≤ auto-redeem lead | `expires today 04:21 · in 2h · auto-redeem due`        | danger  |
| `expired`  | past               | `expired …`                                            | faint   |

Clock times are the browser's zone and locale; the raw ISO expiry rides on the
row's `title`. Spent rows the backend still lists render dimmed as
`redeemed <when>`.

### Auto-redeem

`app/server/src/openaiResetAutoRedeem.ts` spends a still-available credit on its
own once it is within `OPENAI_RESET_AUTO_REDEEM_LEAD_MS` (6 h) of expiry,
applicability guard OFF: the worst case equals letting it slip, the best case is
a weekly window back at zero. Six hours leaves the whole preceding day for a
deliberate redemption and still absorbs a server that was down for an evening.

This is the one usage job that runs with NO client attached, and it must: the
no-headless rule exists for the Claude subprocess, while a 04:00 expiry is
exactly what a client-driven refresh never sees. Its cost is bounded:

- Sweep at boot and every 15 minutes, one invocation at a time, best-effort.
- Per enabled OpenAI account it looks at the cache and fetches only when the
  snapshot is older than the lead (so a credit granted since the last look is
  discovered — credits live thirty days), already names a due credit (a live
  re-read before the irreversible POST, in case it was spent in the ChatGPT
  app), or is counts-only (`availableCount` above the available rows it lists:
  `fetchOpenAiUsage` degrades a failed detail read that way for the page, but
  for the sweep it is no answer about expiries). The last two force the read,
  since an unforced one serves a fresh cache as is. Idle, that is one sub-second
  GET per account per six hours.
- A failed or counts-only re-read does not stop a redemption the cache calls
  for: cached due rows are kept, because the provider refuses a spent credit for
  free, whereas an unspent one lapses.
- Every consume for an account+credit carries ONE `redeem_request_id` for the
  life of the process, so a failed POST is retried by the next sweep as the same
  request rather than a second spend; a confirmed redemption is never POSTed
  again, even if a failed follow-up refresh leaves it looking available.
- After a redemption the account is force-revalidated, so open cards see the
  reset window. Claude accounts are never touched.

The outcome is logged (`[usage] auto-redeemed …`); there is no separate journal.

## What the card shows

The provider card (`common/RuntimePicker.tsx` → `common/UsageCycleMeters.tsx`,
shown by the new-session landing and the workflow start sheet) keeps the account
icon **and** name — several accounts can share one provider, so the provider
word moves into the card's label. Below it sits a fixed-height slot of two
generic cycle rows, `5h` and `wk`, each a micro meter with the number
right-aligned (`62% · 14:00`; time-of-day for the short cycle, weekday for the
long). Each provider adapter maps its own windows into those two slots, or one,
or none.

- Fill is **used**, never remaining. Length, colour and the printed number are
  redundant channels, so the meaning survives without colour.
- Colour thresholds are shared with the Usage page (`usageLevel`): green below
  70, amber 70–90, red at 90 and above.
- The slot keeps its height in every state, so a card never reflows: fresh =
  solid; stale = dimmed fill + `⟳`; nothing trustworthy = `—`, shimmering (the
  shared `Skeleton` primitive at the track's geometry) only while `refreshing`
  says a fetch is actually running — a flat track next to `—` is the honest
  other case (nothing known, nothing being done about it, e.g. an account deep
  in failure backoff). Where there is no meter the row says why rather than
  showing an empty one — `no plan limits` (Claude API key/Bedrock/Vertex),
  `sign in` (OpenAI credentials missing/expired), `no weekly limit` (a provider
  with a single window).
- Errors never reach the card: the last good value stays, marked stale. Error
  text belongs on the Usage page.
- Nothing depends on hover, and the existing snap-scroll row carries the mobile
  affordance.
- The card carries NO `aria-label`: one would replace the accessible name
  computed from its content and take the meters — the numbers and the reason
  lines — away from a screen reader. The provider word rides on the card's
  `title` and the provider icon's own label instead.
- Meters are for the PERSON reading them. The workflow start sheet shows them so
  a user can pick which account a run burns, and never passes them to the run:
  the coordinator chooses from the role sets it was given, and a usage-aware
  choice would make the same Task run differently from one hour to the next
  (`docs/agent-workflows.md`).
