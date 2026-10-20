-- Creation-time explanation, written atomically with the window only by
-- sessionStore.setCompactionWindow. A later window change clears it.
ALTER TABLE session_index ADD COLUMN compaction_window_note TEXT;
