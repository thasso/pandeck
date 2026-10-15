# Changelog

All notable changes to Pandeck are recorded here. Releases use Semantic
Versioning and tags add a leading `v` to the declared version.

## [0.58.1] - 2026-10-15

### Other changes

- Normalize legacy agent approval cards on read
  ([PR #148](https://github.com/thasso/pandeck/pull/148))

## [0.58.0] - 2026-10-15

### Upgrade notes

- This release adds three SQLite migrations (`0082`–`0084`, interrupted-run
  detail and background delivery handling). Back up `DATA_DIR` before upgrading
  if you may need to roll back to 0.57.0, because an older version does not
  reverse them.
- Browser-local state moved from `localStorage` to IndexedDB
  ([PR #140](https://github.com/thasso/pandeck/pull/140)).

### Other changes

- Unify the Agent row and preserve roles across runtime picks
  ([PR #146](https://github.com/thasso/pandeck/pull/146))
- Tasks: show task links and blocked state in the UI
  ([PR #145](https://github.com/thasso/pandeck/pull/145))
- Tasks: blocks / relates links between Tasks (server + agent tools)
  ([PR #144](https://github.com/thasso/pandeck/pull/144))
- Support agent model lists and role-preserving runtime proposals
  ([PR #143](https://github.com/thasso/pandeck/pull/143))
- Move browser-local state off localStorage into an IndexedDB store
  ([PR #140](https://github.com/thasso/pandeck/pull/140))
- Rework the Pull Requests list and detail page
  ([PR #142](https://github.com/thasso/pandeck/pull/142))
- Preserve interrupted background handling for explicit recovery
  ([PR #127](https://github.com/thasso/pandeck/pull/127))
- Include linked Tasks in Claude session state
  ([PR #141](https://github.com/thasso/pandeck/pull/141))
- Prevent duplicate WebSocket errors from crashing the server
  ([PR #139](https://github.com/thasso/pandeck/pull/139))
- Default project-only drafts to main checkout
  ([PR #138](https://github.com/thasso/pandeck/pull/138))
- Move global toasts away from bottom controls
  ([PR #137](https://github.com/thasso/pandeck/pull/137))
- Restore wrapping in Markdown table cells
  ([PR #136](https://github.com/thasso/pandeck/pull/136))
- Anchor chat cards at their tool calls
  ([PR #134](https://github.com/thasso/pandeck/pull/134))

## [0.57.0] - 2026-10-14

### Other changes

- Allow Automatic accounts for peer runtimes
  ([PR #132](https://github.com/thasso/pandeck/pull/132))

## [0.56.0] - 2026-10-14

### Other changes

- Route sessions and background agents across subscription accounts
  ([PR #130](https://github.com/thasso/pandeck/pull/130))
- Persist task suggestion answers across reloads
  ([PR #129](https://github.com/thasso/pandeck/pull/129))
- Add a draggable title strip to narrow macOS layouts
  ([PR #128](https://github.com/thasso/pandeck/pull/128))
- Give Personal Assistant native tools and a configurable working directory
  ([PR #126](https://github.com/thasso/pandeck/pull/126))
- Support user-owned sessions in session_spawn
  ([PR #125](https://github.com/thasso/pandeck/pull/125))
- Add Personal Assistant unread dots and visibility-aware read handling
  ([PR #124](https://github.com/thasso/pandeck/pull/124))
- Record interrupted peer turns without replaying admitted work
  ([PR #120](https://github.com/thasso/pandeck/pull/120))
- Add user-authored agent definitions spawnable by name
  ([PR #123](https://github.com/thasso/pandeck/pull/123))
- Add user approval for blocked commit overrides
  ([PR #122](https://github.com/thasso/pandeck/pull/122))
- Show Jira user display names on mutation approval cards
  ([PR #121](https://github.com/thasso/pandeck/pull/121))
- Fix Claude prompt lifecycle, resumed usage, and Stop-all races
  ([PR #119](https://github.com/thasso/pandeck/pull/119))
- Add approval-gated Jira sprint edits
  ([PR #118](https://github.com/thasso/pandeck/pull/118))
- Render proposed approval text as Markdown
  ([PR #117](https://github.com/thasso/pandeck/pull/117))
- Add managed pull request base retargeting for GitHub and Forgejo
  ([PR #116](https://github.com/thasso/pandeck/pull/116))
- Link push cards to hosted branches and existing pull requests
  ([PR #115](https://github.com/thasso/pandeck/pull/115))
- Track worktrees and pull requests per session spawn tree, with an idle cleanup
  queue ([PR #114](https://github.com/thasso/pandeck/pull/114))
- Add refreshable session status cards with a no-tool agent
  ([PR #113](https://github.com/thasso/pandeck/pull/113))
- Measure inbox card reorders relative to the list
  ([PR #112](https://github.com/thasso/pandeck/pull/112))
- Update Sonnet and Haiku aliases to 5.5
  ([PR #111](https://github.com/thasso/pandeck/pull/111))
- Fix flipped attention card action overflow on phones
  ([PR #110](https://github.com/thasso/pandeck/pull/110))
- Notify coordinators when delegated session work fails
  ([PR #109](https://github.com/thasso/pandeck/pull/109))
- Pin the mobile workflow sheet to the viewport
  ([PR #108](https://github.com/thasso/pandeck/pull/108))
- Prevent WebKit spinner wobble and size busy icons
  ([PR #107](https://github.com/thasso/pandeck/pull/107))
- Move merge options into card footers and standardize overflow menus
  ([PR #105](https://github.com/thasso/pandeck/pull/105))
- Treat GitHub review-bot check failures as review state
  ([PR #106](https://github.com/thasso/pandeck/pull/106))
- Set sidebar surfaces apart from the main pane
  ([PR #104](https://github.com/thasso/pandeck/pull/104))
- Wake parked session owners when background jobs reach deadlines
  ([PR #103](https://github.com/thasso/pandeck/pull/103))
- Redact credentials from commit review context
  ([PR #102](https://github.com/thasso/pandeck/pull/102))
- Show observed live progress for running sessions
  ([PR #101](https://github.com/thasso/pandeck/pull/101))
- Add durable drag-to-reorder for the Sessions inbox working set
  ([PR #100](https://github.com/thasso/pandeck/pull/100))
- Add mid-turn /rename command for session title regeneration
  ([PR #99](https://github.com/thasso/pandeck/pull/99))
- Make Stop hold automatic session turns until explicit resume
  ([PR #98](https://github.com/thasso/pandeck/pull/98))

## [0.55.0] - 2026-10-12

### Other changes

- Measure worktree status against its recorded branch
  ([PR #96](https://github.com/thasso/pandeck/pull/96))
- Restore Claude SDK tool permission callback
  ([PR #95](https://github.com/thasso/pandeck/pull/95))
- Clear persisted drafts when sending prompts
  ([PR #94](https://github.com/thasso/pandeck/pull/94))
- Replace Task issue lists with a single ticket
  ([PR #93](https://github.com/thasso/pandeck/pull/93))

## [0.54.0] - 2026-10-12

### Other changes

- Port the web UI to shadcn components, with Storybook and a unified card system
  ([PR #91](https://github.com/thasso/pandeck/pull/91))
- Remove ineffective Claude session permission callback
  ([PR #90](https://github.com/thasso/pandeck/pull/90))
- Upgrade pi SDK to 1.1.0 and switch proxied MCP clients to pi-mcp
  ([PR #89](https://github.com/thasso/pandeck/pull/89))
- Update Claude Agent SDK to 0.3.296 and Anthropic SDK to 0.133.0
  ([PR #88](https://github.com/thasso/pandeck/pull/88))
- Show queued peer prompts in the composer with steer and remove actions
  ([PR #85](https://github.com/thasso/pandeck/pull/85))
- Remove Task comments across server, tools, protocol, and web
  ([PR #86](https://github.com/thasso/pandeck/pull/86))
- Restore saved chat image previews from session attachments
  ([PR #87](https://github.com/thasso/pandeck/pull/87))
- Allow Claude SDK Plan-to-Build switches during background work
  ([PR #84](https://github.com/thasso/pandeck/pull/84))
- Remove the Calendar UI while retaining agent tools
  ([PR #82](https://github.com/thasso/pandeck/pull/82))
- Remove the Slack Huddles integration
  ([PR #81](https://github.com/thasso/pandeck/pull/81))
- Port the web UI to shadcn/ui
  ([PR #80](https://github.com/thasso/pandeck/pull/80))

## [0.53.0] - 2026-10-07

The Knowledge Base is now a folder of files with path-based links, file history
and document comments. Peer-session trees show running work and stalled replies,
and the Personal Assistant can help configure settings and connect accounts.

### Upgrade notes

- Back up the database and Knowledge Base before upgrading. Migration 0068
  deletes the Day Scan synthesis journal and Tempo proposal state. Day Scan,
  automatic meeting-minutes scanning and their settings are removed; worklogs
  already submitted to Tempo remain there
  ([PR #67](https://github.com/thasso/pandeck/pull/67)). Downgrading requires
  restoring the pre-upgrade database, not just running the older version.
- Knowledge links now name file paths. On first boot with Knowledge Base
  enabled, a one-time migration preserves old ID links for history and rewrites
  editable links in KB files, Task text and active memory cards. It commits KB
  rewrites and skips files with uncommitted edits. Before rewriting database
  text, it creates `DATA_DIR/app.sqlite3.pre-knowledge-path-links.bak`; this is
  not a substitute for a pre-upgrade backup, since schema migrations run first
  ([PR #74](https://github.com/thasso/pandeck/pull/74)).
- The entry-based KB tools and APIs are replaced by file-based tools. Existing
  files and legacy frontmatter remain readable. Settings → Knowledge Base
  controls whether the KB is enabled and where its Git repository lives
  ([PR #73](https://github.com/thasso/pandeck/pull/73),
  [PR #75](https://github.com/thasso/pandeck/pull/75),
  [PR #76](https://github.com/thasso/pandeck/pull/76)).
- The native shell's version is bumped, but release CI does not build macOS or
  iOS apps. Rebuild the shell to pick up native fixes and the new About version.

### Knowledge Base and documents

- Browse the KB with the worktree file browser, including uncommitted changes
  and committing external edits
  ([PR #71](https://github.com/thasso/pandeck/pull/71),
  [PR #72](https://github.com/thasso/pandeck/pull/72)).
- Read and write KB files through path-based tools, with optional frontmatter
  and no required entry schema
  ([PR #73](https://github.com/thasso/pandeck/pull/73)).
- Add browser-local comments to KB files and send them to a session
  ([PR #77](https://github.com/thasso/pandeck/pull/77)).
- Show Markdown frontmatter as a metadata header, start sessions from documents,
  and browse per-file worktree history
  ([PR #68](https://github.com/thasso/pandeck/pull/68),
  [PR #70](https://github.com/thasso/pandeck/pull/70),
  [PR #69](https://github.com/thasso/pandeck/pull/69)).

### Sessions and background work

- Classify content refusals as non-retryable and notify waiting peers when a
  requested reply fails, including the provider's failure reason
  ([PR #78](https://github.com/thasso/pandeck/pull/78)).
- Show nested peer-session trees and stalled-reply warnings in the inbox and
  composer ([PR #40](https://github.com/thasso/pandeck/pull/40),
  [PR #49](https://github.com/thasso/pandeck/pull/49)).
- Make peer-session Take over and Hand back explicit; sending a message leaves
  the coordinator in charge
  ([PR #43](https://github.com/thasso/pandeck/pull/43)).
- Separate long-lived background services from awaited jobs, so services remain
  visible without keeping a session busy
  ([PR #51](https://github.com/thasso/pandeck/pull/51)).
- Collapse chat side activity by default and order new-session worktree choices
  ([PR #30](https://github.com/thasso/pandeck/pull/30),
  [PR #31](https://github.com/thasso/pandeck/pull/31)).
- Fix Personal Assistant rotation and concurrent day-session lookups
  ([PR #53](https://github.com/thasso/pandeck/pull/53)).

### Settings, accounts and fixes

- Let the Personal Assistant read and update settings, request secrets and
  connections through approval cards, and manage Claude and OpenAI accounts.
  Submitted secrets and login codes stay out of agent results
  ([PR #25](https://github.com/thasso/pandeck/pull/25),
  [PR #27](https://github.com/thasso/pandeck/pull/27),
  [PR #37](https://github.com/thasso/pandeck/pull/37)).
- Add Slack OAuth settings and render otherwise-unclaimed settings fields from
  the registry, with registry-derived coverage checks
  ([PR #35](https://github.com/thasso/pandeck/pull/35),
  [PR #38](https://github.com/thasso/pandeck/pull/38),
  [PR #33](https://github.com/thasso/pandeck/pull/33)).
- Clear Forgejo and OpenAI-compatible credentials, or disconnect Tempo, when
  their configured URL changes origin. Discard stale Tempo OAuth callbacks
  ([PR #41](https://github.com/thasso/pandeck/pull/41)).
- Fix Google sign-in in native iOS shells and notification-tap session routing
  ([PR #47](https://github.com/thasso/pandeck/pull/47),
  [PR #34](https://github.com/thasso/pandeck/pull/34)).
- Align the shared Claude model list with the server
  ([PR #32](https://github.com/thasso/pandeck/pull/32)).

### Internals and documentation

- Move pi and Claude SDK access behind the shared harness layer for helper runs,
  models, usage, session creation and lifecycle, viewers, host commands, tool
  exposure, review handoff and measurements
  ([PR #22](https://github.com/thasso/pandeck/pull/22),
  [PR #23](https://github.com/thasso/pandeck/pull/23),
  [PR #24](https://github.com/thasso/pandeck/pull/24),
  [PR #26](https://github.com/thasso/pandeck/pull/26),
  [PR #28](https://github.com/thasso/pandeck/pull/28),
  [PR #29](https://github.com/thasso/pandeck/pull/29),
  [PR #36](https://github.com/thasso/pandeck/pull/36),
  [PR #39](https://github.com/thasso/pandeck/pull/39),
  [PR #42](https://github.com/thasso/pandeck/pull/42),
  [PR #44](https://github.com/thasso/pandeck/pull/44),
  [PR #45](https://github.com/thasso/pandeck/pull/45),
  [PR #46](https://github.com/thasso/pandeck/pull/46),
  [PR #48](https://github.com/thasso/pandeck/pull/48),
  [PR #50](https://github.com/thasso/pandeck/pull/50),
  [PR #52](https://github.com/thasso/pandeck/pull/52),
  [PR #54](https://github.com/thasso/pandeck/pull/54),
  [PR #55](https://github.com/thasso/pandeck/pull/55),
  [PR #56](https://github.com/thasso/pandeck/pull/56),
  [PR #57](https://github.com/thasso/pandeck/pull/57),
  [PR #58](https://github.com/thasso/pandeck/pull/58)).
- Rewrite CI/CD documentation for GitHub and remove private deployment details
  ([PR #21](https://github.com/thasso/pandeck/pull/21)).

## [0.52.0] - 2026-10-02

First release from the Pandeck repository. It continues Personal Assistant
0.51.0; earlier history lives in that project.

### Upgrade notes

- Migration 0064 drops the `legacy_file_imports` and `peer_prompt_migrations`
  bookkeeping tables. Builds before 0.52.0 read them, so a downgrade needs a
  database backup taken before the upgrade.
- Databases whose migration 0005 predates the published version keep starting:
  its earlier checksum is accepted
  ([PR #15](https://github.com/thasso/pandeck/pull/15)).

### Changes

- Rename the project to Pandeck, license it under Apache 2.0, and move it to
  GitHub with GitHub Actions CI
  ([PR #1](https://github.com/thasso/pandeck/pull/1))
- Replace type-aware ESLint with oxlint
  ([PR #4](https://github.com/thasso/pandeck/pull/4))
- Retire the completed legacy card-store and relay importers
  ([PR #13](https://github.com/thasso/pandeck/pull/13))
- Remove the unused Claude SDK session listing
  ([PR #14](https://github.com/thasso/pandeck/pull/14))
- Load jsdom and the pi SDK lazily
  ([PR #8](https://github.com/thasso/pandeck/pull/8))
- Slim the Nix package's pnpm dependencies to supported Linux platforms
  ([PR #19](https://github.com/thasso/pandeck/pull/19))
- Shard CI tests and build the reproducibility check in parallel
  ([PR #16](https://github.com/thasso/pandeck/pull/16))
- Speed up and trim the test suite
  ([PR #6](https://github.com/thasso/pandeck/pull/6),
  [PR #7](https://github.com/thasso/pandeck/pull/7),
  [PR #9](https://github.com/thasso/pandeck/pull/9),
  [PR #10](https://github.com/thasso/pandeck/pull/10),
  [PR #11](https://github.com/thasso/pandeck/pull/11),
  [PR #12](https://github.com/thasso/pandeck/pull/12),
  [PR #17](https://github.com/thasso/pandeck/pull/17))
