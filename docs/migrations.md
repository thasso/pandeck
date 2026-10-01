# SQLite migrations

How schema changes are identified, who may apply them, and what to do when a
rebase makes two branches disagree. The runner is `app/server/src/db/index.ts`;
the binding rules are in `app/server/src/db/CLAUDE.md`.

## A migration is its version number

`runMigrations` reads `app/server/src/db/migrations/`, takes the leading integer
of each file name as the **version**, and records applied versions in
`schema_migrations` (`version`, `name`, `checksum`, `applied_at_ms`). The
version is the identity. The rest of the file name is a label, and the checksum
is only how the runner notices that the file behind a version changed.

Two consequences follow, and every rule below is one of them:

- **A version number, once applied anywhere, is spoken for forever.** Some
  database out there has a row saying "version 42 = this checksum". That row is
  not going to be renamed by your rebase.
- **The version is matched, not the name.** A migration renumbered from `0042`
  to `0043` does not become "a new migration" — it becomes a _different_ file
  claiming a version that a live database already resolved to something else.

## Adding one

1. Create `NNNN_short_name.sql` with the next free number. Never edit a file
   that has shipped: add a forward migration instead, even to fix a mistake.
   That includes comments: the checksum covers the whole file. The one exception
   is `SUPERSEDED_CHECKSUMS` in `index.ts`, which accepts the checksum
   `0005_projects.sql` was applied under before two comment examples changed for
   publication; a database that recorded either checksum opens. Adding an entry
   is a reviewed decision for a statement-preserving edit that already shipped,
   never a way around this rule.
2. `pnpm --filter @assistant/server migrations:lock`, and commit
   `migrations.lock.json` with the migration.
3. Update the row mapping in the same change.

`PRAGMA foreign_keys` is on. A table rebuild that needs it off marks itself with
`-- assistant:migration:foreign_keys_off`; the runner then re-checks
`foreign_key_check` inside the transaction and refuses a migration that leaves
violations.

## Rebasing onto a migration that took your number

This is the conflict that caused a production outage, so it gets its own
section. Two branches each added `0042_*.sql`. One merged. The other rebased and
hit the collision.

**Renumber YOUR migration — the one that has never been applied anywhere — to
the next free version. Never renumber the one already on `main`.**

It is tempting to do the opposite, because renaming the other branch's file
makes the diff smaller and every check still passes. It also breaks every
database that already ran the original under its old number: the shipped build
now hashes a different file for that version, and the mismatch is fatal at
startup — a crash loop on every deploy, discovered in production because a fresh
test database has nothing to disagree with.

Concretely, when your branch's `0042_mine.sql` collides:

```
git mv app/server/src/db/migrations/0042_mine.sql \
       app/server/src/db/migrations/0046_mine.sql   # next FREE version
```

then resolve `migrations.lock.json` by taking **main's version** of the file and
re-running `migrations:lock` to append your renumbered entry. Never hand-edit
the lock, and never drop an entry from it to make a conflict go away — an entry
that disappears is the exact signature of this bug.

If the migration you would have to renumber has _already been applied_ to a real
database, renumbering is no longer enough on its own; see the repair below.

## What enforces this

| Guard                                    | Catches                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `migrationsLock.test.ts`                 | an edited, unregistered, or deleted migration — within one commit                                                    |
| `scripts/check-migrations-lock.mjs` (CI) | a locked migration renamed, rehashed, or removed **relative to the base branch**, and two files claiming one version |
| `updateMigrationsLock.ts`                | re-locking an edited migration                                                                                       |
| `migrationOwner.ts`                      | a working copy applying schema to a deployed data directory                                                          |
| `runMigrations`                          | a version whose recorded name or checksum disagrees with the shipped file                                            |

The lock test alone cannot see a renumber: after conflict resolution the lock
and the files agree perfectly, and only the base branch remembers the old name.
That is why the append-only check compares against the merge base and runs in
CI, where full history is checked out.

## Who may migrate a data directory

Opening the database runs the migrations — there is no read-only path. A
read-shaped command from a checkout
(`DATA_DIR=/home/alice/assistant-data pnpm …`) therefore used to be able to
write schema that had never shipped.

`migrationOwner.ts` records whether the build that last applied a migration was
**packaged** (a `/nix/store` path: a release or a PR preview) and refuses to
apply anything from a working copy to a data directory a packaged build owns.
Reads are untouched; a fully migrated directory has nothing pending, so nothing
is refused. Deploys are unaffected — each release is another packaged build.

Deliberate out-of-band repair sets `ASSISTANT_ALLOW_FOREIGN_MIGRATIONS=1`.

The service also scrubs its instance-owned environment
(`app/server/src/instanceEnv.ts`) once it has started listening, so a spawned
agent no longer inherits production's `DATA_DIR` by accident at all. The guard
is what covers the deliberate case; the scrub is what covers the accident.

## Repairing a database that already disagrees

Symptom: the server exits at startup with
`SQLite migration version N was applied as X, but this build ships it as Y`, and
systemd restart-loops it.

The database is not corrupt — its `schema_migrations` bookkeeping describes a
numbering that no longer exists. Repair the bookkeeping, then let the runner do
the rest:

1. Stop the unit, so the crash loop is not racing you.
2. Back the database up with the SQLite backup API (a consistent copy, not `cp`
   of a live WAL database), and verify `PRAGMA integrity_check`.
3. Work out what the recorded row actually is. If the migration recorded under
   version N is the one this build ships under version M, move the row: set its
   `version` to M and its `name` to the shipped file name. Its checksum should
   already match the shipped file — if it does not, the file was edited too and
   the two problems are separate.
4. Start the service. The runner now applies the genuinely missing versions in
   order.
5. Verify: `schema_migrations` matches the shipped set, and the columns the new
   build expects exist.

Reseed any PR preview that was seeded from the repaired directory before the
repair; it carries the same bad row.
