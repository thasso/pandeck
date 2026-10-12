# Session status

A session's status card answers the question you have when you return to a
session after hours or days: what was this for, what happened, and what is still
open. It lives in the **Status** tab of the desktop right panel, beside the
Inspector and the worktree, and is written only when you ask for it.

## The card

The status agent writes Markdown in a fixed shape:

- the goal, with the linked Task;
- one state, from the Open list, not from Task or PR status: 🟢 Done, 🔵 In
  progress, 🟡 Waiting on you, 🟣 Waiting on agent, 🔴 Blocked, ⏸️ Parked;
- an activity line: runs, active days, provider-reported cost;
- **What happened**: the story, one row per day, oldest first;
- **Your decisions**: answers and choices you gave, merges excluded;
- **Sessions**: the sessions that did real work for this one, and their state;
- **Pull requests**: one row per PR this session opened, saying what it contains
  and what it left open;
- **Keep in mind**: caveats that are not to-dos (a check skipped "for now",
  credentials you pasted, counted and never repeated);
- **Open**: a checklist of what is still owed, each with its owner, the next
  step first.

Its length scales with the session: about 300 words for a one-day session, up to
600 for a week or 60+ runs. The panel says how old the card is and when the
session has moved on since.

## How it is written

`app/server/src/sessionStatus/` owns it.

1. `digest.ts` builds the **digest**, a Markdown read of the session:
   - a header with the CURRENT state of what the session touched: linked
     worktree and Task, its PR cards (with description and caveats), pending
     approvals, the Tasks it created with their status and the latest reply of
     the session working on each, PRs opened by those sessions and by sessions
     it spawned, and every session it spawned or messaged with who still owes a
     reply (`peerPromptStore.outstandingRepliesBySender`, the session list's own
     rule);
   - a timeline of the log: the user's prompts and question answers, peer
     messages, each run's final reply, and state-changing tool calls (commits,
     PRs, merges, spawns, peer messages, Task changes, questions).
2. `statusAgent.ts` sends the digest to the configured model through
   `runOneShot` (`harnesses/oneShot.ts`), no tools, and keeps the reply as the
   card. The model's provider picks the harness, pi or Claude; nothing here
   branches on it. The run is recorded as internal usage (`session_status`)
   under the session it describes.
3. The card is stored as `DATA_DIR/sessions/<id>/status-card.json`, beside the
   session's log: it summarizes conversation content, which never enters SQLite.
   Deleting the session deletes it (a cleanup step of the delete, whichever
   harness held the session), and a refresh that finishes after the delete
   writes nothing.

The header is there because work moves on in a Task's own session after the
session that planned it goes quiet. Without it the agent reports that session's
old plan as open.

### Fitting the digest

Recent runs are kept nearly whole (8 runs), the 30 before them clipped to a few
hundred characters, and older runs keep only the user's prompts, answers,
milestone calls and a short final reply. Old runs with no user prompt, answer or
milestone collapse into one line. The timeline then shrinks in stages to fit
50,000 characters; the header is not counted. Old runs never lose their last
short reply: "yes, do that" is not a decision without the question it answered.

Every quoted string passes `redactCredentials` (`credentialRedaction.ts`, shared
with the commit agent): private keys, known token shapes, `Authorization:` and
bare `Bearer` credentials, and the value of any `password=`/`token:`-style
assignment, however short. The card is redacted again on the way out, in case
the model repeats something the patterns missed. The log is read as untyped JSON
lines, the way `session_read` reads it, and other sessions' latest replies come
from the tail of their logs only.

## Refreshing

- `GET /api/session-status?sessionId=…` answers the last card and whether a
  refresh is running.
- `POST /api/session-status/refresh` writes a new card and answers with it. A
  refresh already running for the session is joined, not repeated, so a second
  tab gets the same card. A run that fails, or stops part-way, keeps the old
  card. A run cut off at the model's output limit counts as stopped part-way:
  `runOneShot` reports it as a failure on both harnesses (pi's `length`,
  Claude's `max_tokens`).
- With `joinOnly`, the POST only waits for a refresh already running and never
  starts one. A panel that finds a refresh running when it opens joins it this
  way: if that run ends before the join arrives, the answer is the card it
  wrote, not a new paid run nobody asked for.

The model is the **Session status** setting (`sessionStatus`, a model slot like
the PR agent's). The default is Luna with high thinking. The run never falls
back to another model (`modelFallback: "none"`): the card names the model that
wrote it, and an unavailable one is an error to fix in Settings (HTTP 409).

## Why these choices

The card's shape and the default model come from an experiment on real sessions
(October 2026): a one-day session with five PRs and a five-day, 445-run session
that handed its work to five Task sessions.

- Cheap models with low thinking were fast but invented dates and reported stale
  plans on long sessions; Haiku contradicted the digest. Luna with high thinking
  was correct for about a cent per card. Opus and Sol with low thinking wrote
  richer cards at a higher price.
- A card that only gives the current state repeats the session's last reply; the
  story and the decisions are what the owner has forgotten.
- Stating the state as a rule over the Open list fixed every model calling a
  session "Done" because its Task was.

## Not yet

- Refresh reads the whole session every time. A later refresh could send the
  previous card and only the runs since it.
- The mobile object dock has no Status tab; it shows the Inspector directly.
