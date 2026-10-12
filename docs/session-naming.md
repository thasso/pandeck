# Session naming

How a session gets its title: once from its first prompt, and again whenever the
user asks with `/rename`. Both go through the same dedicated no-tool naming
agent (`app/server/src/sessionNaming.ts`), configured under
`settings.sessionNaming`.

## First naming

The first prompt (plus any attached Project/Task context) is named automatically
when `sessionNaming.enabled` is on. Until the title settles, the session list
row carries `titleGenerationPending`. A run that fails or finds no model falls
back to a title derived from the prompt. A fork keeps its inherited title while
a new one is generated from the prior context and the fork's first prompt.

## `/rename [guidance]`

Retitles an existing session for where its conversation has got to, which the
first prompt often no longer describes.

- **What the agent reads.** The session's app-owned log only: the newest user
  prompts and visible agent replies, oldest first, within a record and character
  budget that keeps the latest turns. Tool calls, tool results and thinking are
  left out, and model-only `<memory>` blocks are stripped from prompts. The tail
  read never looks further back than the log's last 1 MiB, so a tool-heavy log
  gives fewer turns rather than a full parse on the server thread. The opening
  prompt is added when the recent turns no longer include it, and the current
  title as a hint that may be stale. A log with nothing visible to name is
  refused on the server, which sees the whole log; the web app only checks that
  a session exists, since its transcript window may open mid-turn.
- **Guidance wins.** Text after `/rename` is the user's own direction for the
  title and outranks the transcript.
- **Task reference.** A session started from a Task keeps the exact `Task-<id>:`
  (or Jira key) prefix, as first naming applies it.
- **Execution.** A client-execution command (`execution: "client"`) that sends
  `regenerateSessionTitle`. It needs no harness and opens no synthetic turn, so
  it runs immediately mid-turn (`runsWhileStreaming`) and is never queued.
- **Pending and races.** The row shows `titleGenerationPending` while the agent
  runs. A manual rename in the meantime cancels the run, and a newer `/rename`
  replaces an older one; an overtaken run reports nothing, failures included.
- **Explicit, so it always runs.** It runs even when automatic naming is off. A
  missing model or failed run, including one that broke off after writing part
  of a title, is reported as an error on the session, and the old title stays.
