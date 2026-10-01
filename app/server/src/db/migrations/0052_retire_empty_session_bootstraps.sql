-- Archiving or deleting the viewed pi session used to create a replacement
-- runtime before the client-staged /sessions/create flow took over. Those
-- replacements never received a prompt, but their metadata claim survived every
-- restart as a visible "New chat" row. A pre-fix draft used the same metadata
-- shape, but its draft text was browser-only and cannot be recovered after a
-- restart either. At migration time no runtime is live yet, so every matching
-- zero-message bootstrap is stranded and safe to tombstone.
UPDATE session_index
SET deleted_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE scope = 'user'
  AND harness = 'pi'
  AND purpose = 'chat'
  AND message_count = 0
  AND title IN ('New chat', 'New session')
  AND deleted_at_ms IS NULL;
