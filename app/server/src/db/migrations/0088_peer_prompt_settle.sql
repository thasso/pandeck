-- A recipient can close a request it handled without answering in a message
-- (`settled`, Task-942). The reason it gave is shown on the requester's card.
ALTER TABLE peer_prompts ADD COLUMN settle_reason TEXT;
