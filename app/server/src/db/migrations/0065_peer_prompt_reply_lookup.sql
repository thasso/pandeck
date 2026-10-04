-- Indexes for "has this request been answered?" in the session list.
--
-- Each rebuild asks, for every request still owed a reply, whether a later
-- prompt reached its sender from the owed peer, or on the request's chain.
-- The existing recipient index puts `status` between the recipient and
-- `queue_seq`, so neither question could seek: each scanned every prompt the
-- sender ever received. These answer both with a range seek.
CREATE INDEX peer_prompts_recipient_sender_seq_idx
  ON peer_prompts(recipient_session_id, sender_session_id, queue_seq);
CREATE INDEX peer_prompts_recipient_chain_seq_idx
  ON peer_prompts(recipient_session_id, chain_id, queue_seq);
