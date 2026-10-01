-- Shared selector bundle for immutable worktree comment anchors. Legacy
-- anchor_* columns remain readable and continue to be written; historical rows
-- derive the bundle from anchor_context_json at read time.
ALTER TABLE worktree_comments ADD COLUMN anchor_quote_exact TEXT;
ALTER TABLE worktree_comments ADD COLUMN anchor_quote_prefix TEXT;
ALTER TABLE worktree_comments ADD COLUMN anchor_quote_suffix TEXT;
ALTER TABLE worktree_comments ADD COLUMN anchor_position_start INTEGER;
ALTER TABLE worktree_comments ADD COLUMN anchor_position_end INTEGER;
ALTER TABLE worktree_comments ADD COLUMN anchor_block_id TEXT;
ALTER TABLE worktree_comments ADD COLUMN anchor_block_occurrence INTEGER;
