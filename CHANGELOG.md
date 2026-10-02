# Changelog

All notable changes to Pandeck are recorded here. Releases use Semantic
Versioning and tags add a leading `v` to the declared version.

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
