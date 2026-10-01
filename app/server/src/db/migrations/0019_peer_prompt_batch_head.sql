-- Durable batch grouping (Task-82 review round 4): a batch's members are
-- delivered together as ONE recipient transcript card, but which rows were
-- delivered together was previously derivable only at delivery time, not from
-- a reconnect/history read. Persist the delivered batch's head row id on every
-- member (including the head itself) so history projection can reconstruct
-- the same grouping/aggregate state the live card broadcast used.

ALTER TABLE peer_prompts ADD COLUMN batch_head_id TEXT;
