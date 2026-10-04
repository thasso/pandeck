# Server agent tools — implementation reference

Relocated from `app/server/src/tools/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

The app's domain tool modules (Google Workspace, Jira, Tempo, Slack, tasks,
knowledge, question, …), all defined on the harness-neutral `AgentTool`
interface from `../mcp/tool.ts`, plus the tool catalog that composes them into
persona toolsets.

## Module ownership

- `catalog.ts` owns the tool catalog: persona toolsets composed of `ToolGroup`s
  (`toolGroupsFor`/`agentToolsFor`), each carrying `loading` ("eager" = initial
  model context, "deferred" = discovered on demand), the `family` ("integration"
  groups form the assistant integration universe reused by one-shot allowlists),
  optional integration `gate`, and the exhaustive per-tool `sideEffects`
  classification (`none`/`local`/`external`). Catalog construction fails when a
  newly registered tool has no classification; `modeGatedActiveToolNames`
  preserves Build exposure and lets Plan expose `none`, `task_manage`, and
  `session_spawn` for read-only runtime-profile inspection. The latter refuses
  its `spawn`/`propose` operations against persisted Plan mode before any side
  effect. These deliberate exceptions organize durable Tasks or inspect the
  roster without changing a repository or product. It owns the gate helpers
  (`integrationToolsForGates`, `assistantIntegrationTool*`,
  `integrationGatedActiveToolNames` — takes the persona explicitly so a
  coding-only gated group like `browser-raw-mcp` is actually enforced, not
  silently bypassed by an assumed "assistant" persona); callers import them from
  here, never through `../agents.ts`, whose re-export put the persona registry
  in a cycle with this module. Coding personas receive the ungated deferred
  `worktrees` lifecycle group, including local `worktree_set_base`, and the
  ungated deferred `managed-delivery` group: checked local `worktree_commit`,
  external `worktree_push`, external `worktree_create_pull_request`, and
  external `worktree_finish_pull_request`; Plan excludes all four, since the
  none/local policy allows only what its classifications permit (in practice
  none of the mutating delivery sequence). Coding personas also receive the
  ungated, shared, deferred `workflow` group containing `session_submit_result`;
  it stays out of every ordinary coding session's eager block, while Workflow
  Run assignments explicitly tell their session to load it through tool search.
  The two browser tool groups (`browser`, `browser-raw-mcp`) are ordinary
  catalog groups sourced from `../mcp/toolGroups/registry.ts`
  `toolsForToolGroup` — `browser` is ungated, `browser-raw-mcp` carries
  `gate: "browserRawMcp"`; neither has a separate per-session enable step.
  Developer persona exclusions (`workshop_defer_after_reload`,
  `workshop_draft_handoff`) are applied here. Guarded by `catalog.test.ts`
  (one-group membership, metadata shape, complete side-effect classification,
  Build/Plan projection, decided eager sets, and a per-persona CHARACTER ceiling
  on the eager block, ratcheted to what the Task-285 trim achieved).
- `toolExposure.ts` owns the harness-neutral Tools-inspector projection builder
  (`buildToolExposure`): every persona catalog tool with group, loading tier,
  usability, loaded/used state, exact definition characters and optional token
  sizes, loaded-but-unused totals, plus the bounded load-event trail. pi feeds
  it from `piSdk/toolActivation.ts`; Claude uses CLI context usage plus
  committed tool calls. Both carry it on `SessionState.toolExposure`.
- `toolPolicy.ts` owns the tool policy that does NOT depend on which tools
  exist: `currentIntegrationToolGates` (Settings-driven, including the
  `browserRawMcp` gate via `../browserSettings.ts`) and `isPlanModeToolAllowed`,
  read off a tool's own `sideEffects`. It is a leaf on purpose — the harness
  option builders and `../promptConditions.ts` apply the policy from BELOW the
  catalog, which composes every tool module (`docs/linting.md`, the cycle
  gates).
- `findTools.ts` owns pi's `find_tools`: exact `names` activation and
  whole-token IDF/phrase/group-coherent query ranking with a relative floor, a
  four-tool default bound, an evidence-gated second group, and candidate-only
  fallback when confidence is low. Unknown or gate-disabled exact names are
  reported. Activation remains inside execute. Claude never lists this tool;
  native ToolSearch receives the same catalog family hints through
  `catalogSearchHintFor`, which `../claudeSdk/toolServer.ts` hands to the
  session tool server as its `searchHint` — the MCP server never reads the
  catalog. The full contract and measurements are in `docs/tool-discovery.md`.
- `core/contactsTools.ts` owns the contacts family shared by every persona
  (catalog group `contacts`, `family: shared`, deferred): `contacts_lookup`
  (read: identity/area/free-text) and `contacts_manage` (`upsert` = create/merge
  by identity unioning arrays/ids; `setFields` = REPLACE roles/areas for
  corrections; `delete`). Both route through `../../contacts.ts`. Prompt
  guidance encourages proactive self-enrichment in ANY session (a newly
  discovered person or a new id for a known person), work-relevant facts only.
- `core/lsTool.ts` owns `ls` (catalog group `listing`, `family: shared`, EAGER,
  coding personas only): a bounded directory listing PORTED from pi's `ls`
  builtin — one `readdir`, case-insensitive sort, a `stat` per entry for the `/`
  suffix (unstattable entries are skipped), dotfiles included, no gitignore
  filtering, no subprocess. `path` resolves against `ctx.session.cwd` (falling
  back to the app `CWD`), expands `~`, accepts absolute paths and is
  deliberately not clamped — the same reach the harness's own `bash`/`read`
  already have. Bounds: `limit` entries (default 500), then head truncation at
  50KB, each adding an actionable notice to the text and a
  `details.entryLimitReached` / `details.truncation` field; `details.path` (the
  resolved directory) rides on every outcome, empty listings included. An empty
  directory returns `(empty directory)`, and a missing path, a non-directory or
  an unreadable directory throws. The entry-limit notice is raised on the first
  name past `limit`, so it can overstate what a larger limit would return when
  the remaining names are all unstattable — pi's behaviour, kept deliberately
  because counting survivors first costs the `stat` per entry the limit exists
  to avoid. [Task-319](pa://task/319) made it a copy rather than an import of
  `createLsToolDefinition` (`architecture.test.ts` bars `@earendil-works/*` from
  `tools/`) and dropped pi's prompt snippet and `pi-tui` renderers. `ls` is also
  removed from `piSdk/options.ts` `PI_SEARCH_BUILTIN_TOOLS`: this tool SHADOWS
  pi's same-named builtin (pi's registries are Maps keyed by name, with
  `customTools` `set()` last), so listing the builtin could never have produced
  a duplicate — it would have been dead config that still made the prompt
  inventory price and describe a definition the model never receives.
- Tool modules live in domain subfolders: `core/` (time, question, project
  registry, contacts, `ls`), `google/` (Calendar, Drive, Gmail, Meet, meeting
  minutes), `jira/`, `tempo/`, `slack/`, `github/`, `container/` (container
  image pulls), `tasks/` (task tools), `sessions/` (log, inspection, lookup,
  send-prompt), `workflow/` (structured Workflow Run completion), `knowledge/`
  (KB, memory, attachments, documents), `skills/` (skills-library authoring and
  history), `web/` (web, Context7), and `workshop/` (`workshopHandoffTool.ts`
  for handoff, `worktreeReviewTools.ts` for worktree review, `worktreeTools.ts`
  for managed lifecycle). Each `*Tools.ts`/`*Tool.ts` module owns one
  integration/domain family's tools plus that family's non-tool helper exports
  (stores, accept-mutation helpers, display converters).
- Matching `*Settings.ts` files at `src/` root own integration configuration.
- `google/googleDriveTools.ts` keeps browsing, text retrieval, and user
  downloads separate. `google_drive_search_files` doubles as the folder browser:
  `folderId` (an id or a Drive URL) adds an `in parents` clause, which alone
  enumerates a folder's direct children in natural name order, and `foldersOnly`
  locates the folder by name first. Drive's `folder` sort key orders by parent
  id, not by kind, so a listing cannot be folders-first: subfolders come back
  interleaved, as ordinary entries to descend into. One call returns one page
  bounded by `maxResults`, with `nextPageToken` to continue.
  `google_drive_get_file` refuses a folder id with a pointer to that listing,
  and exports bounded readable text into assistant context;
  `google_drive_download` streams raw files to the authenticated
  session-artifact store without buffering them in memory, and returns a
  Markdown download link plus the file's `localPath`. The download goes to a
  `.partial` file that becomes the artifact only once complete. Before it
  streams, the tool refuses a declared size that would leave less than 2 GiB
  free on disk. Google Workspace files use an available editable export by
  default, while callers can choose a supported MIME type for one file. Folder
  downloads recurse through Drive parents and write a bounded ZIP entry by
  entry, preserving nested paths and empty directories. The limits cover source
  bytes (1 GiB by default, 20 GiB at most) and file count, with a fixed
  1,000-folder guard. The ZIP is stored without compression or ZIP64, so a
  folder holds at most 3.75 GiB, and archive bytes are source bytes plus ZIP
  headers. The artifact route permits only raster images inline; it sends
  `nosniff` for every artifact and forces other types to download under a
  sandbox policy. When the 80-entry artifact drawer drops an old record, its
  backing file is deleted too.
- `google/googleGmailTools.ts` owns Gmail search and body reads.
  `google/googleGmailArchiveTools.ts` adds `google_gmail_archive`: it resolves
  thread ids from the read tool into the exact messages that currently carry
  `INBOX`, freezes up to 200 message ids with their senders and subjects in one
  `gmailArchive` approval, and terminates the turn. Approval sends those ids in
  one Gmail `messages.batchModify` request that removes only `INBOX`. New mail
  in the same threads is outside the frozen batch. The Google OAuth request uses
  `gmail.modify`, which retains read access and permits archive without granting
  permanent deletion. The settings file records the scopes returned by Google;
  an old connection without a recorded `gmail.modify` grant fails before a card
  is created, and Settings shows the Reauthorize action that grants it.
- `slack/slackTools.ts` owns five documented Web API capabilities—search,
  one-conversation reading, one-thread reading, bounded personal unread
  aggregation, and bounded authenticated file reading—using only the personal
  user OAuth projection. It also owns workspace-scoped, expiring Slack
  user/conversation/user-group metadata resolution: names fail safely on
  ambiguity/deletion, person names can resolve DMs, MPIMs have human participant
  labels, and normalized messages preserve bounded Block Kit/legacy
  attachment/file metadata while resolving authors/mentions/channel/user-group
  references. File reads retain optional originating message/thread context and
  expose no private URLs: allow-listed text-like MIME types return bounded
  inline content, binary files (PDF/doc/image) are downloaded and staged into
  the `sessionAttachments` store (status `saved_attachment` + an attachment id,
  bytes off-context), and external/deleted/inaccessible content degrades to
  metadata-only. Unread aggregation preserves missing-marker uncertainty and
  treats thread coverage as explicitly best-effort. Experimental browser-backed
  Huddles and private Slack web-client APIs do not belong in this module.
- `web/webTools.ts` owns the two public-web tools shared by every persona:
  `web_search` (Brave Search API) and `web_fetch` (in-house http(s) fetch →
  Readability/Turndown Markdown or raw text). `web_search` reads its key and
  enable flag through `getBraveToolConfig()` in `../braveSettings.ts` (runtime
  user setting, no static/env fallback), which throws a user-actionable error
  when disabled or unconfigured. `web_fetch` needs no key and enforces its own
  SSRF boundary — only http/https, per-hop redirect revalidation, and a hard
  refusal of any non-public address (loopback, private, link-local, and CGNAT
  `100.64/10`, the range Tailscale assigns) — plus byte/time/char caps; JSDOM
  runs no scripts and loads no subresources. Keep any new web capability here
  rather than enabling a harness's native web tools (the single-tool-path
  contract).
- `web/context7Tools.ts` owns the two Context7 docs-search tools shared by every
  persona: `context7_resolve_library` (name → candidate library ids) and
  `context7_get_docs` (library id + query → up-to-date docs). Both read their
  key and enable flag through `getContext7ToolConfig()` in
  `../context7Settings.ts` (runtime user setting, no static/env fallback; throws
  a user-actionable error when disabled or unconfigured) and call the Context7
  v2 REST API (`CONTEXT7_API_BASE`); `context7_get_docs` bounds output to
  `maxChars` and tolerates either the JSON `{codeSnippets, infoSnippets}` shape
  or a plain-text response.
- `jira/jiraTools.ts` owns the Jira family (token/Basic auth via
  `jiraSettings.getJiraToolConfig`, gate `jira`): `jira_get_issue`,
  `jira_search_issues`, the consolidated read-only `jira_lookup`
  (kind=fields|projects|users|issueLinkTypes; replaced the former
  `jira_list_fields`/`jira_list_projects`/`jira_search_users`), and
  `jira_mutate_issue` — which stages a PENDING `ApprovalCard` via the shared
  `../../pendingApprovals.ts` subsystem (kind `jiraIssue`) and registers the
  `jiraIssue` executor that applies the change on approval. Each item carries an
  `operation`: `edit` (default — first-class summary/Markdown-description edits,
  transitions, fields, links), `create` (projectKey + issueType + summary +
  optional Markdown description/parent/known or advanced fields/linkChanges →
  `resultIssueKey`; we never set the cost center, Jira automation does), or
  `comment` (issue + Markdown commentBody). `jira/jiraMarkdown.ts` converts
  CommonMark/GFM to native ADF blocks/marks; raw HTML is preserved as code,
  images as linked alt text, and nested Markdown quotes are flattened into the
  nearest outer quote because Jira rejects nested `blockquote` ADF. Before
  approval, optional create fields are checked through expanded `createmeta`,
  comments/native links through Jira's issue-scoped `mypermissions` using the
  Jira permission keys `ADD_COMMENTS`/`LINK_ISSUES`, and first-class
  summary/description edits through `editmeta`, so known permission/screen
  failures are rejected before the user approves. Creates apply native links
  after Jira returns the new key; if only that post-create link step fails, the
  card is successful-with-warning and retains the created key instead of falsely
  saying the whole create failed. The approval flow is harness-neutral,
  persistent, and attention-surfaced (see the `pendingApprovals.ts` bullet in
  `../CLAUDE.md`); it no longer uses pi custom entries or a pi-only accept path.
  Read payloads are compact JSON with null/empty keys dropped and no static
  `presentationGuidance`; the projects/users kinds and `jira_search_issues`
  render web tables (`JiraToolCard`) when `render=true`. Issue links:
  `jira_get_issue` always returns normalized `issueLinks`
  (id/type/direction/relationship/other issue);
  `jira_lookup kind=issueLinkTypes` lists the site-global link types (cached
  per-host in `../jiraIssueLinkTypeCache.ts`, mirroring `../jiraFieldCache.ts`;
  link types are NOT per-project); and each `jira_mutate_issue` create/edit item
  accepts `linkChanges` (add/remove, executed via
  `POST`/`DELETE /rest/api/3/issueLink`).
- `github/githubTools.ts` owns the GitHub family (classic-PAT Bearer auth via
  `githubSettings.getGithubToolConfig`, gate `github`), read-only and split into
  four intent-based catalog groups that all share the `github` gate so a
  repository lookup does not load code/collaboration/activity schemas:
  - `github-repositories`: `github_list_repositories` (enumerate accessible
    repos — `GET /user/repos` with the private-inclusive
    `affiliation=owner,collaborator,organization_member` default, or
    `GET /orgs/{org}/repos` when `org` is set — bounded pagination surfacing
    `returned`/`pagesFetched`/`exhausted`, compact normalized metadata incl.
    SSH/HTTPS clone URLs and the token's highest permission) and
    `github_search_repositories` (`GET /search/repositories`, native repo query
    syntax, `totalCount`/`incompleteResults`; only reveals repos the PAT can
    access). Repository-to-Project matching stays orchestration (compare
    clone/web URLs with the project-registry tools), not GitHub-tool behavior.
  - `github-code`: `github_search_code` (`GET /search/code` with text-match
    metadata, bounded fragments, and REST caveats surfaced in `notes` — default
    branch only, files <384 KB, ~10 req/min, possibly incomplete) and
    `github_get_content` (Contents API by `repo`/`path`/optional `ref`: bounded
    directory listing; bounded UTF-8 text with a `contentTruncated` flag; binary
    files staged into `sessionAttachments` BY REFERENCE — status
    `saved_attachment`, bytes off-context, matching `slack_file_read`;
    symlink/submodule metadata; an oversized-file `too_large` guard that never
    downloads past `maxDownloadBytes`).
  - `github-collaboration`: `github_list_notifications` (the user's notification
    inbox), `github_search_issues` (GitHub issue/PR search syntax),
    `github_get_issue` (one issue/PR by `owner/repo` + number, with opt-in
    comments and — for PRs — an opt-in bounded diff), and
    `github_get_pull_request` (rich PR read model: head/base refs+SHAs,
    requested reviewers, and opt-in bounded commits/files/patches/timeline
    comments/submitted reviews/inline review-comment threads grouped by
    file+reply chain).
  - `github-activity`: `github_org_activity` (per-repo day digest for "what
    happened today in <org>" —
    pushes/PRs/issues/reviews/comments/releases/branches — with a DST-correct
    user-local day window, newest-first scan that stops past the window, and
    Events-API caveats surfaced in `notes`/`exhausted`/`source`). It reads the
    authenticated user's org dashboard `GET /users/{login}/events/orgs/{org}`
    (login resolved+cached from `/user`), which includes PRIVATE activity the
    user can see and is near-real-time; the public `GET /orgs/{org}/events` feed
    (no pushes, public-only, stale) is used only as a fallback for orgs the user
    is not a member of, flagged as `source:"public-org"`.
  - `github-ci`: `github_watch_pull_request_checks` (one current PR-head check
    snapshot or a bounded wait for checks to appear and settle, with failed-job
    log-reader arguments, the repository's reported default branch and supported
    merge methods, and conservative merge blockers), `github_get_ref_checks`
    (aggregate Checks API check-runs + legacy commit statuses for a
    branch/tag/SHA into one success/failure/pending state — via the shared
    `githubClient.githubRefChecks` core that `gitHosting.ts`'s GitHub `ciStatus`
    reuses), `github_list_actions_runs` (Actions workflow runs filterable by
    branch/head SHA/event/status/date), `github_get_actions_run` (run +
    jobs/steps, opt-in bounded failed-job annotations), and
    `github_get_actions_job_log` (one job's log as bounded text — follows
    GitHub's redirect to signed storage, dropping auth cross-origin, capped at a
    5 MB ceiling, tail-by-default; never a whole run ZIP). Bare `owner`-less
    repos/orgs resolve against the configured default owner. Payloads are
    compact JSON with null/empty keys dropped and conservative bounded limits;
    no render tables yet.
- `github/githubPrWriteTools.ts` owns the approval-gated, coding-persona-only PR
  write tools (catalog group `github-pr-writes`, gate `github`):
  `github_create_pull_request`, `github_review_pull_request` (verdict +
  summary + inline comments; a `suggestion` renders GitHub's fenced
  ```suggestion block), `github_comment_pull_request` (timeline comment or a
  reply to a review comment), and `github_assign_pull_request` (review requests
  and assignees — two independent lists, each with an add and a remove arm, plus
  org team review requests by slug; the `@`-prefixed `@me` — and only that form,
  since `me` is a real account — resolves to the token's own login when the
  proposal is staged, so the card names a real user). These NEVER write during
  the model turn — each stages a PENDING `ApprovalCard` via the shared
  `../../pendingApprovals.ts` subsystem (`createApproval`, kind
  `githubPullRequest`) and returns a bounded summary + `terminate`. The module
  also registers the `githubPullRequest` executor (`registerApprovalExecutor`)
  that performs the API write on approval; the `assign` arm calls only the
  endpoints its proposal actually populates (POST/DELETE
  `pulls/{n}/requested_reviewers`, POST/DELETE `issues/{n}/assignees`). Reuses
  `resolveRepo` from `githubTools.ts`.
- `github/githubIssueWriteTools.ts` owns `github_mutate_issue` (catalog group
  `github-issue-writes`, every persona, gate `github`): approval-gated issue
  create, edit (title, description, close/reopen with a reason, assignees,
  labels), comment, and label-only changes, on issues and on the issue behind a
  pull request. Staging resolves `@me`, maps requested labels onto the
  repository's spelling and records the ones GitHub would create (`newLabels`);
  the `githubIssue` executor runs each change as its own request, checks each
  response for a change GitHub silently ignored, and names the ones that landed
  when a later one fails. Dot-only labels are refused for removal (URL parsing
  collapses the segment).
- `github/githubRepoWriteTools.ts` owns the coding-persona group
  `github-repo-writes`: `github_rerun_actions_run` (immediate, no card: failed
  jobs by default, every job, or one `jobId` that must belong to that run; an
  unfinished run or job is refused) and `github_delete_branch` (approval card
  `githubBranchDelete`, up to 20 branches; default and protected branches
  refused when staging and again when executing, open head/base pull requests
  listed on the card, and each delete bound to the staged commit through GraphQL
  `updateRefs` `beforeOid`).
- `forgejo/forgejoTools.ts` owns the Forgejo READ family (Gitea-compatible API
  v1 via `forgejoSettings.getForgejoToolConfig`, gate `forgejo`), the read-side
  twin of `githubTools.ts` in three deferred catalog groups:
  - `forgejo-repositories`: `forgejo_list_repositories` (three separate
    endpoints, because Gitea's org routes run under `orgAssignment` and 404 for
    a personal account: `GET /user/repos` for the token's own inventory —
    `source: "token"`, the one arm that refuses to run without a token —
    `GET /orgs/{org}/repos` for `org`, and `GET /users/{username}/repos` for
    `user`, which are mutually exclusive; bounded pagination surfacing
    `totalCount` from `X-Total-Count`/`returned`/`exhausted`, compact normalized
    metadata incl. topics, SSH/HTTPS clone URLs and the token's highest
    permission — Gitea grants only admin/push/pull) and
    `forgejo_search_repositories` (`GET /repos/search` with Gitea's own
    parameter names `q`/`topic`/`includeDesc`/`private`/`archived`/`mode`/
    `sort`/`order`; the keyword is plain text, NOT a query language). Search
    pages through its own loop rather than `forgejoPaginate` — the endpoint
    answers with a `{ok,data}` envelope instead of a bare array — and reports
    `exhausted`, so a result set cut off at the cap is never mistaken for the
    whole of it; `totalCount` is OMITTED when the instance sends no header
    rather than fabricated from the page size.
  - `forgejo-collaboration`: `forgejo_list_notifications` (`GET /notifications`
    with `all`/`status-types`/`subject-type`/`since`/`before`; the array filters
    are REPEATED query keys, which the client's flat query map cannot express,
    so they ride on the path; token-only, checked before the request),
    `forgejo_search_issues`, `forgejo_get_issue` (`/issues/{index}` + opt-in
    `/comments` and `/timeline`), and `forgejo_get_pull_request` (rich PR read
    model: head/base refs+SHAs, requested reviewers, opt-in bounded
    commits/files/timeline comments plus the whole-PR `.diff`/`.patch` and
    submitted reviews with their inline comments — whose `line` (`position`,
    post-change) and `originalLine` (`original_position`, pre-change) stay
    SEPARATE keys, since a comment on a removed line has `position: 0` and
    collapsing the two would quote a deleted line as a current one).
  - `forgejo-content`: `forgejo_get_content` (Contents API by
    `repo`/`path`/optional `ref`, the same result contract as
    `github_get_content`: bounded directory listing; bounded UTF-8 text with
    `contentTruncated`; binary files staged into `sessionAttachments` BY
    REFERENCE as `saved_attachment`; symlink/submodule metadata; a `too_large`
    guard that never downloads past `maxDownloadBytes`). Unlike GitHub's
    pre-signed download URLs, Forgejo's `download_url` points back at the
    instance and needs the token for a private repo, so the bounded raw download
    sends `Authorization` only when the URL really is on the configured
    instance.

  Four deliberate divergences from the GitHub twin, because a schema promising
  behaviour the instance cannot deliver is worse than no tool: Forgejo has NO
  code-search API, so there is no `forgejo_search_code` (discovery is repository
  search + `forgejo_get_content`); `forgejo_search_issues` takes STRUCTURED
  parameters (`state`/`type`/`labels`/`milestones`/`owner`/`team`/
  `since`/`before`/involvement booleans) instead of GitHub's query syntax, and
  `repo` switches it to the better-targeted `GET /repos/{o}/{r}/issues`, where
  the involvement filters name a USER (`assigned_by=<login>`, resolved through
  `resolveForgejoLogin`) and `owner`/`team`/`reviewRequested`/`reviewed` do not
  exist at all — every one of them an explicit error naming the unsupported
  parameters, never a silently dropped filter; `/pulls/{index}/files` carries no
  per-file patch, so files are counts only and hunks come from `includeDiff`;
  and inline review comments hang off the review that owns them
  (`/pulls/{index}/reviews/{id}/comments`, bounded to 20 review fetches per
  read), so the review grouping IS the thread structure. `resolveForgejoRepo`
  lives here and the write module imports it, as `githubPrWriteTools.ts` takes
  `resolveRepo` from `githubTools.ts`.

- `forgejo/forgejoCiTools.ts` owns the Forgejo CI reads (catalog group
  `forgejo-ci`, deferred, gate `forgejo`), the twin of `github-ci`:
  `forgejo_watch_pull_request_checks` (the same current/wait and merge preflight
  contract as the GitHub twin, with status target/run web links as the only
  authenticated-log handoff Forgejo supports), `forgejo_get_ref_checks`
  (aggregate CI for a branch/tag/SHA via the shared
  `forgejoClient.forgejoRefChecks` core that `gitHosting.ts`'s Forgejo
  `ciStatus` reuses, plus opt-in `includeHistory` superseded status rows from
  `/commits/{ref}/statuses`), `forgejo_list_actions_runs` (`/actions/runs`
  filterable by `ref`/`head_sha`/`event`/`status`/`workflow_id`/`run_number`,
  sliced client-side as well as asked for because instances differ on whether
  `limit` is honoured), and `forgejo_get_actions_run` (one run plus its jobs).
  Three deliberate divergences from the GitHub twin, all forced by API v1:
  Forgejo has NO check-runs, so ref checks are one endpoint and one rollup where
  the worst context wins (Gitea's own `CalcCommitStatus` order); there is no
  per-run jobs/steps route, so jobs are RECONSTRUCTED from the repo-wide
  `/actions/tasks` feed by run number — scanned newest-first under a 4×50-task
  budget, stopping only once a whole page sits below the run because adjacent
  runs INTERLEAVE in that feed. Both ways of running out of budget are stated
  rather than smoothed over: a run further back than the scan reaches answers
  `jobsNote: "Jobs unavailable…"` rather than an empty `jobs` list that would
  read as "nothing ran", and a run the budget ends INSIDE answers its matches
  with a "may be incomplete" note, since the same interleaving means the page
  never fetched could still hold jobs of that run. Matching is by run number
  alone — it is repo-wide, and a second guard on the workflow could only ever
  match nothing if the two endpoints spelled it differently. Tasks carry no
  per-step breakdown, so `steps` has no equivalent; and there is NO
  `forgejo_get_actions_job_log`, because logs live only on Forgejo's WEB routes
  and a probe against Forgejo 15.0.6 established that an API token does not
  authenticate there in any form (`token`, `Bearer`, basic, `?token=`) — those
  routes answer for a PUBLIC repo only because they permit anonymous reads, so a
  log tool built on them would work until pointed at a private repo. A run's
  `url` is the way to its log. Note also that a run's `id` and its per-repo
  `runNumber` (`index_in_repo`, the number in the web URL) are different
  numbers, and both are returned.

- `forgejo/forgejoPrWriteTools.ts` is the GitHub PR-write family against a
  self-hosted Gitea-compatible instance (catalog group `forgejo-pr-writes`,
  coding personas only, deferred, gate `forgejo` = `isForgejoConfigured()`):
  `forgejo_create_pull_request`, `forgejo_review_pull_request`, and
  `forgejo_comment_pull_request`, staging kind `forgejoPullRequest` and
  registering its executor. Uses the read family's `resolveForgejoRepo` rather
  than the github.com-specific `resolveRepo`: the instance host is user config,
  so an absolute URL resolves only when its host matches `getForgejoBaseUrl()`
  and a foreign host is an ERROR — reading any host's first two path segments
  would silently retarget a pasted `https://github.com/owner/repo` at the
  same-named repo on this instance, plausibly a different repository. Three API
  translations live in the executor and are the reason this is not a shared
  module with the GitHub twin: `CreatePullRequestOption` has no `draft` field,
  so a draft is the `WIP: ` title prefix (not re-applied when the title already
  carries a WIP marker); `CreatePullReviewComment` anchors with
  `new_position`/`old_position`, so `side: RIGHT`/`LEFT` is mapped at execution
  rather than sent; and a review `event` is a `ReviewStateType`
  (`APPROVED`/`COMMENT`/`REQUEST_CHANGES`), not GitHub's
  `APPROVE`/`CHANGES_REQUESTED`. Forgejo has no reply-to-comment endpoint, so
  the reply arm posts to `POST /pulls/{index}/reviews/{id}/comments` — a comment
  on the REVIEW that owns the thread — and therefore requires its own
  `replyPath` + `replyLine` anchor.
- `forgejo/forgejoReleaseTools.ts` owns `forgejo_create_release` (catalog group
  `forgejo-releases`, coding personas only, deferred, gate `forgejo`), staging
  kind `forgejoRelease` and registering its executor. A repository can deploy
  from the release event, and Forgejo suppresses events raised by the Actions
  user, so a release published with the USER's token is what starts such a
  deploy. Three decisions carry the safety: the target is resolved to a commit
  while PROPOSING (`GET /git/commits/{ref}`, or the repository's
  `default_branch` when no target is given) and the executor tags that sha, so a
  branch moving between proposal and approval cannot redirect the release; the
  annotated tag is created through `POST /tags` BEFORE `POST /releases`, since
  the release endpoint would otherwise leave a lightweight tag it cannot
  upgrade; and both the release check and the tag check run again inside the
  executor, where an existing release always fails and an existing tag is reused
  only when it already resolves to the approved commit (the retry case after a
  partial failure). Tag names are validated as git tag names before any request,
  and the card renders tag, short sha, target subject and notes.
- `container/containerImageTools.ts` owns the single-tool container family
  (catalog group `container-images`, coding personas only, deferred, gate
  `github` because the credential is the GitHub integration token):
  `container_image_pull` makes an image available in the host's local Docker
  store so a worktree build can use it. The tool only validates the reference,
  checks `containerRuntimeStatus()`, and delegates to `../../containerImages.ts`
  with `getGithubRegistryCredential` as the credential provider — credentials
  never enter the tool result, the agent shell, or the transcript, and plain
  `docker pull` in an agent shell stays unauthenticated by design (the prompt
  guidance says so explicitly). Output is compact JSON safe metadata (normalized
  ref, registry, status pulled/already-present, digest, image id, size,
  `authenticated`, duration); `ContainerPullError` messages are already bounded
  and redacted. Deliberately no allowlist, digest pinning, or approval card —
  the boundary is the credential, not the image list (contract:
  `docs/container-images.md`).
- `tempo/tempoTools.ts` owns the Tempo family (OAuth bearer via
  `tempoSettings.getTempoToolConfig`, gate `tempo`): `tempo_list_worklogs` and
  `tempo_mutate_worklogs` — which stages a PENDING `ApprovalCard` via the shared
  `../../pendingApprovals.ts` subsystem (kind `tempoWorklog`) and registers the
  `tempoWorklog` executor. UNIFIED ENGINE (time-logging-routing plan): a CREATE
  row is given a unique day-plan row id at staging (`tempo:<date>:chat-<uuid>`,
  travels as the Tempo `clientId`) and, on approval, is routed through the SAME
  day-plan engine as the calendar "Log my time" (`logCreateThroughDayPlan`:
  `upsertProposal` → serialized CAS → `submitDayTempoRow` → profile learning via
  `dayScan/tempoProfile`), so a chat-logged entry appears on the calendar day
  plan, reconciles on the next scan, and teaches the routing profile. An
  `update` (existing worklog) row is not a day-plan proposal and writes
  directly. Tempo reuses the Jira integration's creds for enrichment/author
  resolution and degrades when Jira is off — `tempo_list_worklogs` returns raw
  issue ids only (no key/summary/url), and `tempo_mutate_worklogs` hard-requires
  Jira. It also exports `fetchWorklogs` (the day-scan Tempo collector's fetch
  core), `submitDayTempoRow` (the day-scan Tempo assistant's single-row write,
  reusing the same issue-key/activity validation + write path; the row id
  travels as `clientId`), and `getCalendarWorklogs({from,to})` (the calendar
  Tempo overlay's own-worklog projection → `CalendarWorklogsResponse`, reusing
  the same fetch + author filter + Jira issue enrichment; degrades to
  `enabled:false` instead of throwing when Tempo is off, backing the
  `GET /api/calendar/worklogs` endpoint).
- `knowledge/memoryTools.ts` owns the memory tool surface shared by every
  persona: `memory_search` (deterministic lexical/metadata recall, results carry
  stable `id` + current `revision`) and the batch `memory_manage`
  (create/reinforce/correct/edit/archive/restore/pin/unpin). All operations
  route through the `../memory/memoryService.ts` lifecycle service so
  validation, optimistic concurrency (`expectedRevision`; stale ops return the
  current card without mutating), provenance (derived from the calling session —
  `clientId`/strength/state are NOT exposed), and content-dedup idempotency
  match automatic processing. Coding personas load/search but write only on
  explicit user authorization (prompt guidance, not tool enforcement).
- `knowledge/attachmentTools.ts` owns the session attachment tools shared by
  every persona: `list_attachments` (metadata-only listing of the current
  session's `sessionAttachments` store) and `read_attachment` (bounded UTF-8
  text for text-like files; binary files return metadata + a pointer to
  `kb_add_asset` `sourceAttachmentId`). It never returns raw binary bytes
  inline.
- `sessions/sessionLogTools.ts` owns read-only cross-session inspection:
  `session_read` (bounded transcript window from a copied id,
  `at`=latest/start/entryId) and `session_search` (bounded literal-substring
  excerpts in one known log). Both read only the canonical app-owned normalized
  log at `DATA_DIR/sessions/<sessionId>/log.jsonl` through
  `sessionInspection.ts`, so a copied session id works regardless of pi/Claude
  harness. `query`/`at` are length-bounded and EXPLICITLY REJECTED when
  over-limit (never silently sliced) so the aggregate caps hold regardless of
  input. `sessionInspection.ts` owns the shared plumbing: sessionId validation,
  deleted/internal/archived classification against `session_index`
  (metadata-only; content is never read at this step), a byte-safe streaming
  line reader (`forEachLine`, never decodes mid-UTF8-character, so a single
  oversized JSONL record is always read in full rather than dropped), the
  sanitized `peerPrompt` card surfaced for delivered peer-prompt rows (never the
  raw envelope), and the aggregate response-budget allocators.
  `readSessionWindow` dispatches per anchor: `start` streams forward with an
  early-exit peek past the limit; `latest` tries a heuristic tail byte-position
  first and falls back to a full streaming pass only when ambiguous (never drops
  an oversized final record); an explicit entry id does a balanced two-pass
  streaming scan (a redistribution pass only when one side has spare capacity
  near an edge), always retaining the anchor and real
  `previousEntryId`/`nextEntryId` continuation hints. `searchSessionLog` streams
  the whole log with bounded memory (never holds the full record set or raw text
  at once). All three report a real malformed-line count as an actionable
  warning.
- `sessions/sessionLookupTools.ts` owns `session_lookup`: indexed discovery of
  another session by exact id or title/linked-object match. It reads only SQLite
  session metadata and existing relation indexes (never a transcript, provider
  file, Task body, or project body) and overlays live/running state from the
  hub. Deterministic ranking (exact id → exact title → title prefix →
  all-title-tokens → exact linked object id → linked-object-title token
  overlap); output is bounded (≤25 compact candidates) and excludes the current,
  deleted, and internal sessions; archived sessions require `includeArchived`.
- `sessions/sessionAuditTool.ts` owns `session_audit`: the bounded agent-facing
  projection of the Task-254 session usage and context-contributor report
  (`../../sessionAudit.ts`, shared with `pnpm run measure:session`). The summary
  — provider calls, tool calls, per-token totals, occupancy, failures,
  compactions, agreement with the persisted session stats — is always returned;
  `turns`, `contributors`, `tools`, `toolResults`, `contextJumps` and `events`
  are opt-in sections, because each costs output. Everything is sizes and
  counts: the largest tool results are bytes, the drill-down (`entryId` or
  `providerRun`) is block structure, and no message body is ever returned —
  `session_read` remains the only way to content. The serialized payload is
  capped at `SESSION_AUDIT_MAX_CHARS` by shedding the bounded list sections from
  their cheap end (events, then oldest turns, then ranked tails) and naming what
  was shed in `responseTruncated`; the summary is never sacrificed. Data access
  is server-side only — no shell, no `DATA_DIR` reads by the agent, no external
  CLI — and deleted/internal sessions are refused by the same
  `resolveInspectableSession` gate as the other session tools.
- `sessions/sessionSendPromptTool.ts` owns `session_send_prompt` (exposed to all
  three personas): one open, safe API to prompt another session by copied id. It
  validates the target (rejecting
  self/deleted/internal/archived/non-promptable), bounds the prompt to 8000
  chars, and delegates to `../peerPrompt.ts` — the server-owned engine that
  resolves the conversation/causal chain (with automatic reply correlation via
  active delivery context or a unique unreplied request), persists through
  `db/peerPromptStore.ts`, and delivers a concise agent-provenance envelope
  without interrupting a running target. Because delivery only happens while the
  recipient is idle, the description owns the async reply contract — a reply
  arrives later as a new incoming peer message, so the sender ends its turn
  rather than waiting or polling — and the envelope's conditional reply cue
  names the sender's session id so a reply needs no `session_lookup` round trip
  (model-facing only; the transcript renders the sanitized card). No target
  kind, role, interrupt, or thread/correlation parameter is exposed. The retired
  `send_agent_relay`/`send_session_relay`/`list_agent_sessions` relay tools are
  gone.
- `sessions/sessionSpawnTool.ts` owns `session_spawn`, one tool with three
  operations because the AUTHORITY differs and nothing else does.
  `operation: "propose"` ([Task-553](pa://task/553)) proposes up to 8 NEW peer
  sessions, each with a title, persona (`developer`/`assistant`), opening prompt
  and optional worktree/project/Task, as ONE approval card: it creates nothing
  and returns `terminate: true`. Its provider/model/thinking parameters are
  HINTS — an un-hinted row inherits the proposing session's runtime and the user
  picks in the card either way — so an unavailable one becomes a note on the row
  rather than a tool error. `operation: "profiles"` ([Task-595](pa://task/595))
  is a read: the approved roster in the user's order with availability, inferred
  family, user-set relative cost and the user's optional selection description
  per row. This is how a coordinator answers "prefer cross-family review" from a
  fact and applies the user's hint about when to choose each option rather than
  guessing from a model name. `operation: "spawn"` creates sessions immediately,
  every row naming a `profileId` from that roster;
  provider/modelId/thinkingLevel are REFUSED there and a `profileId` on a
  proposal row is refused too, so neither path can be used to widen the other.
  An unknown id is refused rather than degraded into a proposal. Because raw
  tool arguments never pass a JSON-schema check, the tool enforces the whole
  schema at the execution boundary, on the RAW row (`checkRawRow`): an unknown
  top-level parameter or row property is an ERROR, the operation's forbidden
  fields are refused by PRESENCE, and a known field whose stated value is not a
  non-empty string (or, for `responseRequested`, a boolean) is refused rather
  than dropped. Only `undefined` reads as absent, since JSON cannot express it.
  All three rules exist for one reason: a value the tool discards is
  indistinguishable from a field nobody sent, so `credentialProfileId: "acct"`,
  `provider: 7` or `thinkingLevel: ""` would otherwise spawn SUCCESSFULLY on the
  roster's runtime while the request the caller actually made left no trace. The
  per-operation decision therefore happens before parsing, not after it.
  `../sessionSpawn.ts` owns both executions, `../peerSpawnRuntimes.ts` the
  roster, resolution and concurrency policy. The tool is classified `local`, but
  Plan mode deliberately exposes its read-only `profiles` operation while
  `spawn` and `propose` remain Build-only. Its `searchHint` and description
  deliberately avoid the inspection vocabulary (`transcript`, `worktree`,
  `outcomes`, `list`, `prompt`): scoring reads name + description + hint only,
  and a spawn tool ranking on "inspect recent sessions" would push
  `session_read` out of that query's default load.
- `sessions/sessionControlTool.ts` owns `session_control`, a Build-mode local
  mutation with `cancel_queued_prompts` and `stop` operations. Cancellation is
  sender-scoped and changes only `queued`/`retryable_failed` rows to the durable
  `cancelled` state; `dispatching` is already past the safe retraction boundary.
  Stop requires the target's durable spawn edge to name the caller and remain
  `coordinator`-owned. Its optional `clearQueue` cancels every waiting row for
  that owned child before the runtime abort, so the idle hook sees an empty
  queue. The user's explicit Take over revokes stop authority (Hand back
  restores it), and neither operation archives or deletes a session.
- `workflow/sessionSubmitResultTool.ts` owns `session_submit_result` (coding
  personas, catalog group `workflow`, shared and deferred; assignment prompts
  explicitly direct discovery through tool search). It resolves the caller's one
  open session assignment from `db/workflowStore.ts`, infers the expected
  registered contract from the step payload, and refuses malformed completed
  evidence without ending the step so the agent can resubmit. `blocked`/`failed`
  forbid payloads. Accepted results atomically make the step terminal with the
  caller session as actor, broadcast the immutable result, and fire-and-forget
  `advanceRun`; its compact JSON confirmation is a byte-stable tool result.
- `knowledge/documentTools.ts` owns `convert_pdf` (shared by every persona):
  converts a PDF from a session attachment OR a KB asset to Markdown, resolving
  bytes server-side (raw binary never enters model context). Conversion logic
  lives in `../documentConversion.ts`; the tool only resolves the source,
  enforces exactly-one-source and PDF-only, bounds the returned Markdown to
  `maxChars`, and optionally persists the result into the KB asset's text
  extract (`persistToExtract`, KB source only, via
  `writeKnowledgeAssetExtract`). Has a test-only store seam
  (`setDocumentToolsStoreFactoryForTests`). The scanned-PDF Claude fallback
  (model/thinking/enable) is configured by the `pdfConversion` app settings and
  wired in `../pdfClaudeFallback.ts`.
- `knowledge/spreadsheetTools.ts` owns `convert_xlsx` (same `documents` group):
  reads an .xlsx from a session attachment, an absolute host path or a KB asset
  through the dependency-free `../xlsxConversion.ts` (ZIP central directory +
  SpreadsheetML: shared strings, date-styled serials → ISO, booleans, cached
  formula values), stages one CSV session artifact per sheet under
  `spreadsheets/` and returns a bounded preview (rows + Markdown table) of the
  selected sheet.
- `tempo/tempoExportTools.ts` owns `tempo_export_worklogs` and
  `tempo_export_report` (`docs/jira-tempo.md#reading-worklogs-at-scale`):
  windowed, checkpointed full-range extraction into
  `DATA_DIR/tempo-exports/<exportId>/` (`tempoExportStore.ts`), the cached Jira
  metadata/user join (`tempoJiraJoin.ts`), CSV/JSON/manifest outputs, and
  aggregation by dimension over the persisted rows (`tempoReportRows.ts`).
- `skills/skillTools.ts` owns the ten skills-library tools registered as the
  deferred, ungated, shared `skills` catalog group for `assistant`,
  `personal-assistant`, `developer` and `workshop` ([Task-633](pa://task/633),
  `docs/skills.md`): `skill_list`, `skill_get`, `skill_read_file`,
  `skill_history` and `skill_diff` are `none`; `skill_create`, `skill_edit`,
  `skill_manage_files`, `skill_rename` and `skill_delete` are `local`, so Plan
  keeps only the reads. The module stays thin — it validates and shapes tool
  input, resolves an `import_attachment` operation for THIS session through
  `resolveSessionAttachment` so binary bytes never enter model context, and
  hands the planner the recorded SIZE plus a bounded read rather than the bytes:
  the per-file and whole-batch budgets are spent before a byte is read, so
  twenty individually valid imports cannot allocate their way past a refusal;
  the read loops to EOF (one `read` is not a whole file) and the planner refuses
  an import that does not deliver the size its budget was spent on, rather than
  committing a silent prefix. `skill_list` bounds both of its lists and reports
  the true `skillCount`/`diagnosticCount` with an explicit `truncated`, so the
  library's size cannot decide the size of a model's context. `skill_read_file`
  hands `readSkillTextWindow` the caller's line window and reports the file's
  size beside the window's own bounds, so a reference too large to carry is
  paged rather than refused, and a `skill_manage_files` `edit` operation carries
  its replacements to the authoring layer unchanged — the planner cannot know an
  edit's bytes before the file is read, so it spends no byte budget on one. It
  builds commit provenance from `ToolCallContext.session` (refusing a multiline
  or oversized `reason`/`taskId` before anything is written, since a trailer
  block is line-structured), passes `ctx.signal` into the streaming history/diff
  reads AND into all five mutations (where the authoring layer honours it at its
  own checkpoints only, so a stop is always "nothing happened"), and bounds
  every result — while `../../skills/skillAuthoring.ts` owns resolution,
  filesystem work, validation and committing. Failures throw the domain message
  (dirty repository, invalid manifest, unsafe path, ambiguous edit). Has a
  test-only library seam (`setSkillToolLibraryForTests`).
- `slack/slackHuddleTools.ts` exclusively owns `slack_huddle_history`. It is the
  only tool allowed to request the browser-session projection, returns no raw
  Slack objects or secrets, bounds history/output/metadata calls, and may use
  personal OAuth only for participant/conversation/thread enrichment. It also
  exports the day-scan core `collectOwnHuddleAttendanceForDay` (Task 171): an
  OWN-attendance projection (channel id, timing, my duration, self status) that
  ALSO resolves WHO ELSE was in each huddle — participant display names via
  bounded personal-OAuth `users.info` + status (the context for what the huddle
  was about; names + status only, never content) — reused by the `slack-huddles`
  day-scan collector.
- `google/googleMeetingMinutesDiscoveryTools.ts` and
  `google/meetingMinutesScannerTools.ts` own the
  `meeting_minutes_discovery`/`meeting_minutes_scan_source` tools AND export
  reusable cores consumed by the day-scan minutes pipeline
  (`../../dayScan/minutesPipeline.ts`): `gatherMeetingMinutesCandidates`
  (dedup/score-sorted discovery, no processed-ledger filtering),
  `loadMinutesSource` (Drive/Gmail content fetch), and `extractMinutesActions`
  (the metered scanner sub-agent that reads the FULL fetched minutes/transcript
  — bounded by `maxSourceChars`, not keyword snippets — and returns a faithful
  summary + owner action candidates). Keep the tool `execute` paths and these
  cores behaviourally aligned.

## Contract notes and rationale

- No `@earendil-works/*` or `@anthropic-ai/claude-agent-sdk` imports (guarded by
  `architecture.test.ts`). Pi/Claude specifics reach tools only through the
  typed `ToolCallContext`.
- Session identity comes from
  `ctx.session.{sessionId, harness, agentType, sessionFile, title, cwd, sessionManager}`
  — always populated; never duck-type or default it.
- The deferred shared `worktrees` group gives coding personas registered
  cross-project lifecycle operations: create returns the path to `cd` without
  relinking the session, list is bounded and avoids per-worktree git scans,
  detail computes live status, and removal uses the shared
  session-settlement/concurrency guards while force only overrides data-loss
  guards. A branch-cleanup failure after checkout removal is returned as partial
  success with its snapshotted force-loss details, `branchDeleted: null` when
  the branch cannot be inspected, and a pending cleanup error.
- The eager tier is deliberately small, and each group in it earns its place
  ([Task-286](pa://task/286)). `time`, `questions`, `tasks`, `attachments`, the
  coding `worktree-review`, `listing`, and `post-reload` stay eager because they
  are used across ordinary sessions or (post-reload) must be callable before a
  reload cuts the turn short; attachment relevance is handled by session-start
  conditioning, not by deferral. `listing` (`ls`, 561 chars) is eager because a
  deferred listing tool costs a discovery round trip before it can list a
  directory, which is strictly worse than the `bash ls` it exists to replace
  ([Task-319](pa://task/319)); on pi it also replaces the `ls` builtin, whose
  definition cost 399 chars in the harness block, so it is close to a wash
  there. That raise is the one argued exception to the `catalog.test.ts`
  ratchet, whose coding ceilings now sit just above the measured 12,288
  (workshop) and 11,759 (developer) chars. `memory` (`memory_search` +
  `memory_manage`, ~3.6k chars) stays eager on purpose: the `<memory>` snapshot
  already arrives in the prompt, so reinforcing, correcting, or archiving
  `[id@revision]` must not need a discovery hop first. `knowledge-core`
  (`kb_search`, `kb_get_entry`) was moved to the deferred tier: most sessions
  never consult the KB, and the eager KB prompt pointer keeps it discoverable
  for the ones that do. Measured with `pnpm run measure:prompts` when it landed,
  that cut ~1.3k chars (~335 tokens) off the first request of EVERY persona on
  both harnesses, against a 21-char growth of the KB pointer; re-run the script
  for current numbers rather than trusting a figure quoted here. What a KB-using
  session pays back is one `find_tools`/ToolSearch call, which at the default
  limit of 5 loads the matching KB tools (a few thousand chars of definitions) —
  a bounded per-session cost in place of a cost every session used to pay. The
  two search paths are pinned to DIFFERENT depths, because only one of them is
  ours: `piSdk/toolActivation.test.ts` drives our real `find_tools` scorer and
  asserts realistic durable-knowledge queries reach `kb_search`/`kb_get_entry`
  in ONE call, while `mcp/sessionToolServer.test.ts` can only assert the list
  metadata the vendor ToolSearch consumes (memory marked `anthropic/alwaysLoad`,
  the KB reads carrying the `anthropic/searchHint` it ranks on) — the ranking
  itself runs inside the Claude CLI and is not reproducible in-process. Keep KB
  `searchHint`s to domain nouns: the pi scorer is substring-based, so
  conversational filler in a hint drags the tool into unrelated top-5s and
  displaces real matches at the default limit.
- CONTENT and NAME search is NOT an app tool and must not become one: each
  harness uses its own native, self-bounding search ([Task-316](pa://task/316))
  — Claude `Grep`/`Glob` (`claudeSdk/options.ts` `CLAUDE_SDK_NATIVE_TOOLS`), pi
  `grep`/`find` (`piSdk/options.ts` `PI_SEARCH_BUILTIN_TOOLS`). They are free of
  catalog upkeep, they truncate their own output, and they do not depend on the
  session shell, where a bare `grep` is wrapped and fails
  ([Task-315](pa://task/315) — `rg` still works there). The cost is an eager
  definition per harness — re-measured with `pnpm run measure:prompts` after
  [Task-319](pa://task/319) at 1,612 chars (~450 tokens) for pi's two: their
  per-tool contributions to `tools:eager:harness-builtin` (1,509 = grep 966 +
  find 543, name + description + schema; the whole six-builtin row is 4,052) and
  to `pi-tool-list:builtin` (103: their one-line prompt snippets) — against the
  shell round trips and 50KB `bash` outputs they replace. Assistant personas get
  none of them, on either harness. Directory LISTING is the one deliberate
  exception: Claude has no native listing tool (`Glob "*"` returns files
  recursively, never directory entries), so `ls` is an app tool in
  `core/lsTool.ts`, and pi's builtin — which that tool shadows — is dropped from
  `PI_SEARCH_BUILTIN_TOOLS` in favour of it.
- An `AgentTool` has exactly two model-visible guidance surfaces, `description`
  and the `parameters` prose, and both harnesses render both for eager and
  deferred tools alike. `promptSnippet`/`promptGuidelines` were deleted by
  [Task-282](pa://task/282): they reached only pi developer/workshop sessions
  and rode in `_meta` the Claude CLI ignores, so a rule written there was
  invisible to most sessions. The triage that removed the 400 surviving bullets
  applied three outcomes — inline into the description (it prevents a real
  argument or behaviour error), leave it to the layer that already states it
  (another prompt section, the schema, or the tool's own result/error text), or
  delete it. `tools/toolGuidanceSurface.test.ts` guards the channel, including
  hand-folded `Guidelines:` blocks glued onto a description. Note the size
  asymmetry when authoring: an EAGER tool's description is paid for by every
  session on both harnesses, while a DEFERRED tool's arrives only on activation.
- `parameters` are plain JSON Schema object literals; `defineAgentTool<Params>`
  types the execute params.
- [Task-285](pa://task/285) trimmed the eager tools against a sharper test than
  the Task-282 triage: an EAGER property description survives only when the call
  would otherwise SUCCEED with the wrong argument. Three shapes of that: a
  meaning the schema cannot express (`dueDate` vs `scheduledFor`, `task_read.id`
  vs `query`, `memory_manage.expectedRevision`,
  `ask_questions .allowTypedAnswer`); a value both branches of an enum accept
  while something downstream keys on it (`externalLinks[].type`, which Slack
  intake and minutes processing deduplicate on); and a field an operation
  IGNORES rather than refuses (`memory_manage`'s `text`/`kind`/`pin` outside
  create/correct/edit — the write reports success and changes nothing). Anything
  a precise throw or per-operation error already says — which operation needs an
  `id`, that a whole description is never replaced on update, that an `oldText`
  was ambiguous — was deleted, because that text costs every first request but
  is only useful in the one call that failed. Defaults are stated as JSON Schema
  `default`, not prose, and a bound the runtime CLAMPS (`memory_search.limit`,
  `read_attachment .maxCharacters`) deliberately has no `minimum`/`maximum`: a
  schema bound would turn an over-ask into a validation failure instead of a
  clamp. `tools/eagerToolGuidance.test.ts` pins the surviving disambiguation and
  the throws that carry what was dropped; `catalog.test.ts` ratchets the block
  size in characters. Measured with `pnpm run measure:prompts`: the developer
  eager block went 15,530 → 10,824 chars on Claude (16,274 → 11,526 on pi), of
  which ~5,600 is JSON Schema structure and ~2,000 is the description layer that
  Tasks 282/284/298 moved out of the persona prompts. Those two floors are why
  Task-285's target was amended from 9,000 to 10,900 chars rather than met: the
  difference was reachable only by deferring `memory_manage` and/or
  `worktree-review`, which reverses [Task-286](pa://task/286)'s eager-tier
  decision, or by dropping schema capability.
- Rich web UI tool cards parse a JSON payload (`renderKind`, …) from the tool's
  TEXT output — keep result text byte-stable unless the web renderer changes
  with it.
- The Task tools implement the product contract in `docs/tasks.md` — what a Task
  is, who owns status, when an agent may create one, and what a comment is for.
  Read it before changing their surface; the notes here only describe the code.
  `taskTools.test.ts` pins the rules that exist on no other surface.
- `task_read` resolves durable ids through `id` (never text `query`), can return
  an epic plus ordered descendants through `includeSubtasks`, and bounds
  list/search output to 50 Tasks by default. Task tool text is compact JSON and
  omits internal bookkeeping from ordinary list results.
- A `task_read` result is bounded by BYTES as well as by item count, because an
  epic with descendants, full descriptions and a long trace used to overflow the
  harness tool-output limit outright — which costs more round trips than the
  one-call read saved. The whole payload fits a 24 KB budget: comments are
  bounded first (12 KB of it) and the Tasks get what is left, so a long trace
  cannot starve the read of the Tasks that were asked for. The Task side then
  degrades in a fixed order and names what it did — clip each description to 2
  000 chars (`descriptionsTruncated`, per item `descriptionTruncated` and
  `descriptionChars`), drop descriptions so the short previews survive
  (`descriptionsOmitted`), then drop trailing Tasks (`omittedForBudget`, with
  `truncated` and `totalCount`). Losing bodies beats losing Tasks: a caller that
  asked for an epic wants its whole shape first.
- `comments` (with `id`, an object rather than a flag so the bound is explicit)
  returns the Task's activity trace: the most recent `limit` comments (default
  10, max 100) rendered oldest-first so the trace reads chronologically, each
  body clipped to 1 500 chars (`bodyTruncated`, `bodyChars`) so one 20 k-char
  comment cannot decide how many comments fit. The block carries `count`,
  `totalCount`, `olderCount` and a `nextCursor` that pages BACKWARDS in time
  through `comments.before` — the rare deep-history read walks it, the common
  read never pays for it. An unknown cursor throws, and so does `comments`
  without `id` — a trace belongs to one Task, so a list read that asked for one
  meant something else. Omitting `comments` returns no trace at all.
- Clipped bodies here use the shared marker in `textBudget.ts`, not a local one:
  the Task-context attachment clips text too, and one vocabulary means an agent
  learns the "there was more here" signal once.
- `tasks/taskTools.ts`'s `task_manage` carries BOTH Task dates, and their
  descriptions keep them apart because an agent choosing wrongly is the failure
  mode: `dueDate` is the external DEADLINE, `scheduledFor` is the day the user
  plans to WORK on it — the field to set when asked to plan a day or pick what
  to work on. `task_read`'s `scheduled` filter
  (past/today/tomorrow/upcoming/unplanned) is the read side of that, with `past`
  meaning planned work that was not finished. Neither is a today/tomorrow flag:
  both are real dates, so a plan that has come and gone reports itself instead
  of going stale.
- `task_manage`'s result is a fixed payload — `renderKind: "taskManage"`,
  `version`, `changedCount` (mutated + deleted Tasks), `changed[]`, optional
  `deletedIds`, `comments` and `warnings` — carried identically in the TEXT and
  `details` through `compactJsonResult`. `changed` follows input op order and
  each entry's `status` is the status AFTER the write, with `statusSuggestion`
  stating what is still waiting for the user, `statusSetByRequest` marking a
  status `userRequestedStatus` applied, `descriptionEditsApplied` counting the
  targeted body edits that landed, and `deduplicated` marking an entry a
  `create` op resolved onto an EXISTING Task (the Slack source-link dedupe) —
  flagged on the entry and not only in `warnings`, since a renderer taking the
  verb from the op would otherwise call an existing Task "created". `comments`
  lists every trace append in op order, each carrying its own `taskId` because
  one batch may comment on several Tasks. A suggestion is never phrased as a
  warning: the server did exactly what an agent's status write means, and
  `warnings` keeps its existing users (project-link resolution, Slack dedupe).
  Failure still throws, so the payload has no error field; ops before a throw
  stay applied, including their comments. Within ONE op the mutation lands
  before its comment is appended, so a throw from the append itself (only
  reachable through a concurrent delete) leaves that mutation applied and the
  comment missing. `task_read` stays a plain body with no `renderKind`. The web
  card that renders this (`components/TaskManageToolCard.tsx`) also reads the
  CALL's `operations` for the verb per changed Task, since the payload states
  the outcome and not the operation — so op order in `changed` is part of the
  contract, and both the result and the call's input stay whole in a reloaded
  snapshot (`session/log/timelinePayloadPolicy.ts`).
- Comment writing lives INSIDE `task_manage` (there is no `task_comment` tool):
  any operation may carry a `comment`, and `{operation: "comment", id, comment}`
  appends without mutating the Task — so a status change, a description edit and
  a comment are one provider round trip. A create's comment lands on the id the
  create resolved to, including the Slack-dedupe target; `delete` refuses one.
  It routes through `../taskComments.ts` `addTaskComment`, which broadcasts the
  authoritative `taskComments` list and refreshes `commentCount`; comments
  cannot be edited or deleted. A bare comment mutates nothing, so it stays out
  of `changed`/`changedCount` — and it may carry NO change field
  (`MANAGE_MUTATION_FIELDS`): meaning "update and comment" while writing
  `comment` is the likeliest slip, so it throws and names the offending fields
  rather than dropping a status suggestion on the floor.
- An agent cannot replace a whole Task description: `description` on an `update`
  operation THROWS, and the body changes only through `descriptionEdits`
  (`{oldText, newText}`, mirroring `kb_edit_entry` — each `oldText` must occur
  exactly once and the edits must not overlap). `create` still writes a whole
  body, since there is nothing there to clobber, and the user's own web edit
  path is untouched.
- Long-running tools stream partials via `ctx.progress?.(...)`; honor
  `ctx.signal`; throw on failure (never encode errors in content);
  `terminate: true` asks the agent to stop after the current tool batch.
- Read/search integrations default to compact, bounded results. Keep verbose
  metadata, bodies, participant/session expansion, and rich render payloads
  opt-in; expose explicit limits with conservative defaults.
- Helper runs go through `runOneShot` (`harnesses/oneShot.ts`), never an engine
  runner or provider SDK directly. They are no-tool by default; a research
  helper may receive only an explicit, bounded `AgentTool` allowlist. Never
  expose a persona's complete toolset implicitly.

## Working notes

- When adding a tool: put the module in its domain subfolder, register it in a
  `catalog.ts` group (choose `loading` deliberately — new integration families
  default to "deferred"); a tool needing an external subprocess connection or
  artifact capture belongs in `mcp/toolGroups/`. Update shared display/protocol
  types plus web renderers if the output is user-visible.
- When adding a setting: include defaults, validation/test helpers, protocol
  shape, and Settings page UI as needed.

## Verification commands

- Run `pnpm --filter @assistant/server test` (tool tests live beside their
  modules).
- Run `pnpm --filter @assistant/server typecheck`.
