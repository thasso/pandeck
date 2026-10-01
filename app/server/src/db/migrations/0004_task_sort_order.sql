-- Manual ordering position for tasks (root level and within a parent's children),
-- assigned by drag-reorder. Hierarchy/parentage is a `subtask` edge; this column
-- is the single manual-order signal used when listing.
ALTER TABLE tasks ADD COLUMN sort_order INTEGER;
