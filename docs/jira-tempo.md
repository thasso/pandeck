# Jira & Tempo integrations

Jira and Tempo are two **independent** integrations that ship together because
Tempo reuses Jira credentials for issue enrichment. This document is the split
contract for the work tracked under the "Split Jira and Tempo into independent
integrations" epic; it is the source of truth the implementing slices reference.

## Two integrations at a glance

|                          | Jira                                                                                                                                                                                                         | Tempo                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Auth model               | Token / Basic (`atlassianEmail:atlassianToken`)                                                                                                                                                              | OAuth 2.0 (connect / reauthorize / disconnect)                                                    |
| Runtime settings file    | `DATA_DIR/settings/jira.json`                                                                                                                                                                                | `DATA_DIR/settings/tempo.json`                                                                    |
| Static deployment config | `jiraHost` (`config.ts`)                                                                                                                                                                                     | OAuth client id/secret (`config.ts`)                                                              |
| Tool gate                | `jira`                                                                                                                                                                                                       | `tempo`                                                                                           |
| Owning module            | `app/server/src/jiraSettings.ts`                                                                                                                                                                             | `app/server/src/tempoSettings.ts`                                                                 |
| Agent tools              | 4: `jira_get_issue`, `jira_search_issues`, `jira_lookup` (kind=fields\|projects\|users\|issueLinkTypes), `jira_mutate_issue` (create/edit/comment, Markdown→ADF, transitions/fields + issue-link add/remove) | 4: `tempo_list_worklogs`, `tempo_export_worklogs`, `tempo_export_report`, `tempo_mutate_worklogs` |

The two integrations enable, configure, test, and gate their tools
independently.

## Dependency: Tempo needs Jira

Tempo's OAuth token authorizes only the Tempo API. Tempo reuses the Jira
integration's Basic credentials for:

- **Worklog issue enrichment** — resolving issue key, summary, and URL for the
  issue ids returned by Tempo worklogs.
- **Author resolution** — resolving `authorAccountId` from Jira
  `GET /rest/api/3/myself`.

`getTempoToolConfig()` composes the Tempo OAuth credentials with the Jira
credentials read from `jiraSettings`. When Jira is disabled/unconfigured and no
`authorAccountId` is cached in `tempo.json`, the two tools degrade as follows
(Tasks 34–36 implement this consistently):

- **`tempo_list_worklogs`** — never throws solely because Jira is off. Author
  resolution is skipped, so the call behaves as `includeAllAuthors` (all visible
  authors, no author filter) and says so in its output. Issue enrichment is
  skipped: worklogs carry raw Tempo issue ids only, with no
  key/summary/`issueUrl` and no `jiraHost` links, plus guidance to enable Jira
  for enrichment. A **cached** `authorAccountId` (from a prior Jira resolution)
  still lets the default author filter work even while Jira is off, but
  enrichment stays unavailable.
- **`tempo_mutate_worklogs`** — **requires the Jira integration enabled and
  configured, regardless of any cached `authorAccountId`.** It validates each
  row's issue key and Tempo activity through live Jira calls (`jiraGet`
  issue/editmeta) before proposing writes, which a cached author id cannot
  substitute for. When Jira is disabled or unconfigured it fails fast with a
  clear "enable the Jira integration" message rather than proposing an
  unvalidated write. (The `authorAccountId` cache only helps
  `tempo_list_worklogs` author filtering; it never makes mutation available.)

## Jira (token auth)

Static deployment config (`config.ts`, never committed as a real value):

- `jiraHost` — the Atlassian host, e.g. `example.atlassian.net`. Sourced from
  `ASSISTANT_JIRA_HOST` env → the app config's `jira.host`, with no default:
  without one, Jira, Confluence, and Tempo report themselves unconfigured. It is
  **not** user-editable in Settings.

Runtime settings (`jira.json`, owned by `jiraSettings.ts`):

- `enabled`, `atlassianEmail`, `atlassianToken`.
- Public projection hides the token (`atlassianTokenConfigured`); the token
  itself is never sent to the browser.

`jiraSettings.ts` owns:

- `getJiraSettings()` — public projection (includes `jiraHost` for display,
  `enabled`, `atlassianEmail`, `atlassianTokenConfigured`).
- `getJiraToolConfig()` — full credentials for tools (moved here from the
  combined module); throws with a `Settings → Jira` hint when disabled or
  missing creds.
- `updateJiraSettings(patch)` — persists
  `enabled`/`atlassianEmail`/`atlassianToken` (with `clearAtlassianToken`).
- `testJiraSettings()` — `GET /rest/api/3/myself` with Basic auth; resolves and
  reports display name + `accountId`.
- `isJiraConfigured()` — background-workflow predicate (`enabled` + `jiraHost` +
  `atlassianEmail` + `atlassianToken`), mirroring `isGoogleConfigured()`. It is
  the Jira analog of the readiness predicate the calendar day scan already
  surfaces for Google (`dayScan.ts` currently exposes only `googleConfigured`);
  background workflows can consume `isJiraConfigured()` where Jira readiness
  matters. Wiring it into any specific background workflow (e.g. adding a
  `jiraConfigured` field to day-scan state) is out of scope for the contract and
  only happens if a later slice needs it.

Jira has no OAuth; the token approach stays for now (Atlassian OAuth deferred).

Tempo is not the only consumer of these credentials: the Confluence integration
borrows the same email and token for the same Atlassian site. Its contract is
`docs/confluence.md`; Jira and Confluence remain independent gates.

### Ticket content and creation

`jira_mutate_issue` prepares approval-gated creates, edits, comments, and
backlog ranks. Descriptions and comments accept CommonMark/GFM and are converted
by `app/server/src/tools/jira/jiraMarkdown.ts` to Atlassian Document Format.
Native ADF is used for headings, emphasis/strike, links, lists and task markers,
blockquotes, code, rules, and tables. Since Jira descriptions cannot embed
arbitrary Markdown HTML or remote Markdown images directly, raw HTML is
preserved visibly as an HTML code block and images become linked alt text rather
than being dropped.

Create items support `parentIssue` (including `Sub-task` creation), known and
advanced fields, and post-create `linkChanges`. Edit items expose `summary` and
`description` directly; `description: null` clears it. Markdown content links
remain clickable text; they are separate from native Jira issue relationships.

Before staging an approval, optional create fields check expanded Jira
`createmeta`, comment and native-link requests check Jira's issue-scoped
`COMMENT_ISSUES`/`LINK_ISSUES` permissions (including the target of a new link),
and first-class summary/description edits check the issue's `editmeta` fields.
These checks turn known permission/screen restrictions into an immediate
actionable tool error instead of an approval that can only fail. Jira may still
reject a write after staging if configuration changes concurrently. A create is
itself successful once Jira returns the new key: if a subsequent requested
native link fails, the approval reports the created key plus a non-fatal warning
rather than claiming that no issue was created.

The approval card (`app/web/src/components/JiraIssueApprovalBody.tsx`) shows a
create as the ticket it will become: project and type, summary, parent, every
requested field, the description rendered as Markdown (clipped in the card,
never on the wire), and any native links. A comment renders its body the same
way. "Read full ticket" / "Read full comment" opens the whole proposal in a
modal-band dialog with the card's own Approve/Reject, so a decision from there
is the same act as one on the card. The dialog is not a document-viewer route:
until Jira accepts it the ticket exists only on the card.

### Issue links

Native Jira issue-link relationships (Blocks, Relates, Duplicate, Cloners, …)
are supported for reading, discovery, and approval-gated mutation:

- **Link types are site-global, not per-project.**
  `GET /rest/api/3/issueLinkType` returns every type available on the whole Jira
  site; company- and team-managed projects draw from the same set. They are
  cached per-host in `jiraIssueLinkTypeCache.ts` (7-day TTL, mirroring
  `jiraFieldCache.ts`) — no per-project keying.
- **Discover:** `jira_lookup kind=issueLinkTypes` returns
  `{ id, name, inward, outward }` (cache-backed), so an agent learns the exact
  type name and its inward/outward phrases.
- **Read:** `jira_get_issue` always includes normalized `issueLinks` for the
  issue (each: `id`, `type`, `direction` inward/outward, `relationship` phrase,
  and the other issue). The `id` is required to remove a link.
- **Mutate:** each `jira_mutate_issue` item may carry `linkChanges`, alongside
  its transition/field edits, under the same approval flow.
  `{ op: "add", type, direction, issue }` creates a link
  (`POST /rest/api/3/issueLink`; for `direction: "outward"` the subject issue is
  the `outwardIssue`, e.g. "A blocks B"). `{ op: "remove", linkId }` deletes a
  link (`DELETE /rest/api/3/issueLink/{id}`). Per-link execution results are
  surfaced back on each change.

### Backlog ranking

Jira's own ordering is the Agile rank API; the LexoRank value behind it is
opaque and is never written as a field. `jira_mutate_issue` carries it as
`operation: "rank"` under the same approval gate as every other Jira write:

- **Request:** `rankIssues` lists the issue keys to move IN THE ORDER THEY
  SHOULD END UP; `rankPosition` is `before`/`after` (with `rankTargetIssue`) or
  `top`/`bottom` (bounded by `rankBoardId` or `rankParentIssue`).
- **Top and bottom are resolved, not requested.** Jira has no "move to top"
  call, so the server reads a BOUNDED ordering — the board's backlog
  (`GET /rest/agile/1.0/board/{id}/backlog`), its epic list
  (`…/board/{id}/epic`) when the issues are epics, or
  `parent = X ORDER BY Rank ASC` — and ranks against whichever issue currently
  sits at that end. The read stops at 100 issues; a `bottom` that hits the
  ceiling returns a warning saying so, because the end of the window may not be
  the end of the backlog.
- **A batch is a CHAIN, not one call.** The first issue takes the requested
  position, every later issue is ranked after its predecessor
  (`PUT /rest/agile/1.0/issue/rank`, one issue per call). Jira leaves the
  resulting order of a multi-issue rank unspecified; a chain states it, and a
  step that fails leaves the applied prefix in the requested relative order with
  the remaining issues untouched rather than ranked against an issue that never
  moved. Execution stops at the first failure and the error names what applied
  and what was not attempted; each step also carries its own outcome.
- **Validated before staging:** every issue (and target) exists, they share one
  project and one hierarchy level (epics, standard issues and sub-tasks are
  separately ranked lists), a given board covers that project, a given parent
  owns every issue, and Jira grants `SCHEDULE_ISSUES` on each. Each of these is
  an immediate tool error rather than an approval that can only fail.
- **Result:** after execution the item carries `rankResultOrder`, the ordering
  Jira reports for the scope (or for the issues involved, when the position was
  relative), and the approval summary repeats it.

## Tempo (OAuth 2.0)

Static deployment config (`config.ts`):

- Client id: the app config's `tempo.oauthClientId`, overridden by
  `ASSISTANT_TEMPO_OAUTH_CLIENT_ID` or `TEMPO_OAUTH_CLIENT_ID`.
- Client secret: only `ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET` from the private
  deployment environment. The former `TEMPO_OAUTH_CLIENT_SECRET` alias is
  discarded, not accepted. A `configured` projection reports whether the id and
  secret are both present.

Runtime settings (`tempo.json`, reworked by `tempoSettings.ts`) — Tempo-only:

- `enabled`, `apiBaseUrl` (defaults to the public Tempo Cloud API).
- OAuth state: `accessToken`, `refreshToken`, `accessTokenExpiresAt`,
  `oauthState`, `oauthStateCreatedAt`, `oauthRedirectUri`.
- `authorAccountId` (cached after first Jira resolution).
- Public projection: `enabled`, `apiBaseUrl`, `redirectUri`,
  `oauthClientConfigured`, `refreshTokenConfigured`, and the connected account
  id when known. Tokens are never sent to the browser.

The reworked module drops the combined shape's `tempoToken`, `jiraHost`,
`atlassianEmail`, and `atlassianToken` — those now belong to Jira. There is **no
migration**: the stale combined `tempo.json` is wiped and the app starts clean.

### OAuth flow (mirrors Google Workspace)

- HTTP routes in `index.ts`: `GET /api/tempo/oauth/start` (302 redirect to the
  Tempo authorization URL) and `GET /api/tempo/oauth/callback` (renders
  `oauthHtml`). Both are added to the unauthenticated-path allowlist alongside
  the Google/Slack callbacks, and `oauthHtml`'s provider union gains `"tempo"`.
- CSRF `state` validation, authorization-code exchange, access + refresh token
  persistence in `tempo.json`, and refresh-on-expiry (`ensureTempoAccessToken`).
- **Connect** and **Reauthorize** both navigate to `/api/tempo/oauth/start`.
  **Disconnect** is a settings patch that clears the stored tokens/state.
- Connection test / token refresh: `ensureTempoAccessToken` refreshes when the
  access token is missing or within 60s of expiry, then the test calls Tempo
  `GET {apiBaseUrl}/worklogs?limit=1` with the bearer token.
- Registered redirect URL: `<public assistant origin>/api/tempo/oauth/callback`.

Concrete Tempo OAuth 2.0 (authorization code) endpoints, pinned against Tempo's
docs:

- **Authorize** (instance-hosted, on the Atlassian site = `JIRA_HOST`):
  `https://<JIRA_HOST>/plugins/servlet/ac/io.tempo.jira/oauth-authorize/` with
  `client_id`, `redirect_uri`, `response_type=code`, `state`, and
  `access_type=tenant_user` (user-scoped authorization; Tempo uses `access_type`
  instead of OAuth scopes).
- **Token** (`POST https://api.tempo.io/oauth/token/`,
  `application/x-www-form-urlencoded`): code exchange
  (`grant_type=authorization_code`, `client_id`, `client_secret`,
  `redirect_uri`, `code`) and refresh (`grant_type=refresh_token`, …,
  `refresh_token`); response carries `access_token`, `expires_in`, and
  `refresh_token`.
- No OAuth `scope` parameter is sent.

## Reading worklogs at scale

Tempo's list endpoint is paged and never reports a total, and Jira answers bulk
enrichment with HTTP 429. The read tools therefore share one contract
(`tools/tempo/tempoWorklogFetch.ts`, `tempoJiraJoin.ts`, `tempoReportRows.ts`):

- **Never silently truncate.** `tempo_list_worklogs` takes `offset` and
  `maxResults` (page size, ≤ 1000) and answers `nextOffset`/`exhausted`; a
  non-null `nextOffset` is the raw Tempo offset to continue from, also when a
  client-side author filter dropped part of a page. Ranges longer than a page
  belong to `tempo_export_worklogs`.
- **Server-side filters.** `projectKeys`/`issueKeys` are resolved to Jira ids
  (project ids cached a week under `DATA_DIR/cache/jira/projects-<host>.json`,
  issue ids through `POST /rest/api/3/issue/bulkfetch`) and sent to Tempo's
  `POST /worklogs/search`; numeric ids pass through so the filter also works
  with Jira off.
- **Jira is optional per call.** `jiraEnrichment: false` skips every Jira call
  (raw issue ids only; symbolic key filters and uncached own-author filtering
  are refused with guidance) so a Tempo read cannot fail on a Jira rate limit.
- **Compact output.** `output: "totals"` with `groupBy` (issue, project, author,
  date, month, activity, issueType) returns aggregate rows and no worklogs.
- **Retry, reads only.** `jiraClient` and the Tempo fetch go through
  `httpRetry.ts#fetchWithRetry`: 429/502/503/504 and network errors retry up to
  five times, honoring `Retry-After`, otherwise exponential backoff with jitter;
  an aborted tool call stops the wait. GETs retry by default; a POST gets one
  attempt unless the caller opts in (`retry: true` on Jira JQL search and
  bulkfetch, and on Tempo `/worklogs/search`), so an issue, comment, link or
  worklog the server already committed is never replayed.

### Exports (`tempo_export_worklogs`, `tempo_export_report`)

`tempo_export_worklogs` extracts a whole range (all authors by default) into
`DATA_DIR/tempo-exports/<exportId>/`:

- `checkpoint.json` — parameters (resolved project/issue ids, author filter,
  requested `jiraFields`, unioned with any later request) and the date windows
  (`windowDays`, default 7) with their status. Each window is fetched completely
  (all pages), appended to `worklogs.jsonl`, then marked done. A failure throws
  with the `exportId`; calling again with `exportId` resumes at the first
  pending window. A crash between append and checkpoint repeats one window,
  which the read-side dedup (last write per worklog id wins) absorbs.
- `issues.json` / `users.json` — the Jira join cache: issue key, summary, type,
  status, project, labels and any requested `jiraFields` (`customfield_<id>`,
  flattened to display strings) plus account id → display name
  (`GET /rest/api/3/user/bulk`). The join runs after extraction, persists after
  every 100-issue batch, and on failure marks the export
  `jiraEnrichment: "partial"` instead of throwing — the Tempo rows are already
  on disk and a re-run with the same `exportId` completes the join without
  touching Tempo.
- `worklogs.csv` / `worklogs.json` / `manifest.json` — the deliverables: one row
  per worklog (date, start time, seconds/hours, issue id/key/summary/type/
  project/labels/URL, author id/name, activity, description, timestamps, extra
  fields), and the manifest with row count, total seconds, an order-independent
  sha256 over `worklogId:seconds` pairs, duplicates removed, issue/author counts
  and enrichment state. Links are `/api/files/...` download URLs; the files are
  never copied into chat.

`tempo_export_report` aggregates a complete export by the same dimensions plus
any joined `customfield_<id>`, with filters for a date sub-range (exact 2025
hours of an issue opened in 2024), issue keys, projects, authors, activities and
include/exclude labels; missing fields are joined into the cache first.
`persist: true` writes the whole aggregate as `report-<stamp>.csv` beside the
export. Without `exportId` it lists the exports and their state. Neither tool
writes to Tempo or Jira.

## Tool gates

`IntegrationToolGates` replaces the single `jiraTempo` gate with independent
`jira` and `tempo` booleans:

- `integrationToolsForGates`: `jira` gates the four Jira tools
  (`jira_get_issue`, `jira_search_issues`, the consolidated `jira_lookup`,
  `jira_mutate_issue`); `tempo` gates the four Tempo tools.
- `assistantIntegrationTools()`: `jira: getJiraSettings().enabled`,
  `tempo: getTempoSettings().enabled`.
- Tool-level credential checks remain defense in depth. Tempo tools additionally
  consume the Jira config for enrichment and degrade (raw ids) rather than
  failing when Jira is off.

## Protocol (`app/shared/protocol.ts`)

- **Jira (new):** `JiraSettings`, `JiraSettingsPatch`, `JiraConnectionStatus`.
  Client messages: `updateJiraSettings`, `saveAndTestJiraSettings`,
  `testJiraSettings`. Server message: `jiraStatus`.
- **Tempo (reshaped):** `TempoSettings` (OAuth-shaped, analogous to
  `GoogleSettings`), `TempoSettingsPatch` (`enabled?`, `apiBaseUrl?`,
  `clearTokens?`), `TempoConnectionStatus`. Server message: `tempoStatus`.

  The Task-32/33 deliverable "OAuth connect / reauthorize / disconnect + update
  apiBaseUrl + status" is realized **exactly like Google Workspace** — there are
  **no** dedicated connect/reauthorize WebSocket messages; the protocol is:
  - **Connect / Reauthorize** — the Settings UI navigates the browser to the
    HTTP route `GET /api/tempo/oauth/start` (both use the same route;
    reauthorize re-runs consent). This is deliberately not a WebSocket message.
  - **Disconnect** — client message `updateTempoSettings` (or
    `saveAndTestTempoSettings`) with a `TempoSettingsPatch` carrying
    `clearTokens: true`.
  - **Update apiBaseUrl / enabled** — `updateTempoSettings` /
    `saveAndTestTempoSettings` with the non-secret fields.
  - **Status / test** — client message `testTempoSettings` → server
    `tempoStatus`.

- `AppSettings` in `settings.ts` gains `jira: getJiraSettings()` alongside the
  reshaped `tempo: getTempoSettings()`.

## Settings UI (`app/web`)

The single "Jira & Tempo" section becomes two independent settings pages —
`jira` and `tempo` nav entries (`settingsSections.tsx` + the `SettingsSection`
ids in `useSessionRouting.ts`), each rendering its own card in
`SettingsPage.tsx`, matching Google/Slack styling and status affordances. Both
auto-verify existing credentials when opened:

- **Jira page:** enable toggle, `atlassianEmail`, API token paste + clear, Save
  & Test with status. `jiraHost` is shown read-only (static config), not edited.
  Jira keeps the explicit token-entry + test in its primary flow because it has
  no OAuth round-trip.
- **Tempo page:** enable toggle, `apiBaseUrl`, OAuth Connect / Reauthorize /
  Disconnect (popup + auto-verify on completion) with connection status, and a
  note that Tempo needs the Jira integration for issue enrichment (raw issue ids
  when Jira is disabled).
