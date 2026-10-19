ALTER TABLE session_index ADD COLUMN peer_turn_cap INTEGER CHECK (peer_turn_cap BETWEEN 1 AND 16);
