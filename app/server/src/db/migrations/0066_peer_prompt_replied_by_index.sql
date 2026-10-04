-- A request is marked replied when its correlated reply is QUEUED, so a reply
-- cancelled or failed before delivery leaves the request still owed. The
-- session list finds those requests from the lost reply, which needs the
-- back-link indexed. Partial: most rows are never replied to.
CREATE INDEX peer_prompts_replied_by_idx
  ON peer_prompts(replied_by_message_id)
  WHERE replied_by_message_id IS NOT NULL;
