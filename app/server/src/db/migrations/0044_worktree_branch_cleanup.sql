-- A removed checkout may still need local-branch cleanup when `git branch -d`
-- fails after the checkout itself is gone. Persist the exact ref identity so a
-- retry can delete only the branch that belonged to this worktree; NULL means
-- there is no genuine pending cleanup and ordinary tombstones are not retryable.
ALTER TABLE worktrees ADD COLUMN branch_cleanup_oid TEXT;
