-- Whether the owner is WAITING on a background item (`awaited`, the default:
-- a build, a test run, a readiness wait) or merely keeps it running beside its
-- work (`service`: a dev server, a watcher). The owning agent declares it
-- through `background_tasks`; nothing infers it from the command. A service is
-- shown as running but never read as work in progress, so a quiet peer tree
-- holding only a dev server can still read as stalled or done.
ALTER TABLE background_work_items
  ADD COLUMN intent TEXT NOT NULL DEFAULT 'awaited'
  CHECK (intent IN ('awaited', 'service'));
