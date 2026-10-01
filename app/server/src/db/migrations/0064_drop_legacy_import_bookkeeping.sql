-- Drop the bookkeeping of the retired one-time importers.
--
-- `legacy_file_imports` (0063) recorded which whole-file JSON stores
-- (`pull-request-cards.json`, `pending-approvals.json`) had been imported, and
-- `peer_prompt_migrations` (0017) recorded the `agent-relays.json` import. Both
-- importers are gone: every deployment had already imported its files, and a
-- leftover legacy file in a data directory is now ignored, neither read nor
-- deleted. No live code reads either table. The imported rows themselves stay
-- in their stores.

DROP TABLE IF EXISTS legacy_file_imports;
DROP TABLE IF EXISTS peer_prompt_migrations;
