-- Manual Sessions inbox order.
--
-- The inbox sorts its working set by one number per item, highest first: the
-- position the user dragged the item to, else its creation time. NULL is that
-- default, so every existing row keeps today's order, and a new session or run
-- (created after every placed one) still arrives at the top. A drop writes only
-- the dragged row: its position becomes the midpoint of its new neighbours'.
--
-- REAL because midpoints are fractional. Writing it never moves
-- `updated_at_ms`: where a card sits is not activity on it.
ALTER TABLE session_index ADD COLUMN inbox_position REAL;
ALTER TABLE workflow_runs ADD COLUMN inbox_position REAL;
