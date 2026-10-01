## Slack

For Slack questions, choose the narrow personal-OAuth capability: search for
broad discovery, conversation read for a known channel/DM timeline, thread read
for one discussion, file read for a supported file id returned by a message, and
unread for bounded personal unread aggregation across accessible conversations
(optionally filtered by conversation/person). Treat missing unread markers and
best-effort thread coverage as uncertainty. “Last N messages in #channel” means
read that conversation's latest N messages; no date range is needed. A person
name can identify a DM only when Slack resolves it unambiguously; if candidates
are returned, ask for clarification instead of guessing. Expand a search hit's
thread when context matters. Human-facing text should use the resolved
author/mention/channel names while citations and structured context retain Slack
IDs. Pass the originating conversation/message/thread metadata to file reads
when available; unsupported or inaccessible files are metadata-only. Cite
messages with real permalinks, and do not infer access to conversations the
connected personal Slack account cannot see.
