-- Append-only follow-up (Task 91/101 review): the activeNow `recurring` keyset
-- scan (`memory/memoryApi.ts`'s `scanRecurringActive`) filters on
-- `temporal_mode = 'recurring'` and orders by `updated_at_ms DESC, id` (matching
-- `memoryStore.list`'s ORDER BY) to page via a keyset cursor. Without an index
-- covering that exact filter + order, SQLite still has to scan/sort the
-- remaining recurring rows for every chunk, defeating the point of the cursor.
CREATE INDEX memory_cards_recurring_scan_idx
  ON memory_cards(temporal_mode, updated_at_ms DESC, id ASC);
