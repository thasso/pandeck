-- A refused peer send is a condition until a human closes its causal chain.
-- No prompt body is stored here. Repeated refusals on one sender/chain dedupe.
CREATE TABLE peer_prompt_hop_refusals (
  chain_id TEXT NOT NULL REFERENCES peer_prompt_chains(chain_id) ON DELETE CASCADE,
  sender_session_id TEXT NOT NULL,
  max_hops INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, sender_session_id)
);
