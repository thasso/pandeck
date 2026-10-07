# Changelog

All notable changes to Pandeck are recorded here. Releases use Semantic
Versioning and tags add a leading `v` to the declared version.

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
