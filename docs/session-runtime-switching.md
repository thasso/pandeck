# Session runtime switching

A started session can change the model, effort (thinking level) and account its
next turn starts on, including a model of another harness or account kind
(Task-1485). This document is the contract for those changes. A switch is never
automatic: the user chooses it, or a coordinating session for its child.
Failover and the other moves the app makes itself stay within one account kind
(`docs/account-routing.md` "Live account switching").

## Pending selection

A started session's change is a **pending selection**: one complete target
(model, effort, account) stored on the session row
(`session_index.pending_runtime`, migration 0101) and carried as
`pendingRuntime` on `SessionState` and `SessionListItem`. Nothing about the
engine changes until the next turn is admitted. Setting it or resetting it
leaves no trace in the transcript or the native session, survives a restart, and
has no expiry. A fork does not inherit it.

`app/server/src/sessionPendingRuntime.ts` owns both halves.

- **Setting** (`setPendingRuntime`, or `session_control` `set_runtime`) is
  accepted at any time, during a turn too. A change names any of the three
  parts; the server completes it from the current pending selection, else the
  session's current runtime, and clamps the effort to the target model. A target
  equal to what the session runs now clears the selection. Only static rules
  refuse at set time: an unknown model, and for a chosen account another kind, a
  disabled one, one that is not enterprise when the session requires it, or one
  that does not offer the model at that effort. Health and benches are judged
  when the turn starts. `setBy` records the user or the coordinator.
- **Another engine.** A model whose kind the bound account does not serve (pi ↔
  Claude, or Codex ↔ an OpenAI-compatible endpoint within pi) is an engine
  switch. It is refused only when no enabled account of its kind, within the
  session's enterprise requirement, offers it at that effort ("No enabled Claude
  account offers Opus."). A chosen account must be of the model's kind ("Work
  cannot run GPT-6."). Picking only a model of another kind turns a chosen
  account of the old kind into Automatic.
- **Order.** Sets and resets of one session run one at a time, in request order,
  each from the selection the previous one left: two partial changes both land,
  and a reset is never undone by a set asked for before it. A set recomputes
  when a turn's admission spent the selection while it read the session.
  `set_runtime` asks its ownership again with the write, so a coordinator the
  user took the child over from changes nothing.
- **Reset** (`clearPendingRuntime`) drops it. Both answer with
  `pendingRuntimeAnswer`; a refusal carries `error` and becomes the session's
  failure (`docs/messaging.md`).
- **Account.** "Automatic" keeps the bound account when it can run the target
  and asks the router otherwise, within the target model's kind and the
  enterprise requirement. A chosen account must still pass every move rule
  (below). Only a subscription login moves; any other account alone serves its
  models.

### Applying it

`runtimePrompt.ts` applies the selection when it admits a new turn of any origin
(a user prompt, a queued prompt, a peer prompt, a background wake, a scheduled
run, an automatic continuation). It does not apply to a steer into a running
turn, a steer-only message, the account-recovery (failover) continuation, or a
turn the provider already started (`beginRuntimeProviderTurn`). The "Continue
on" continuation (below) is not account recovery: it applies the selection its
click set. Order: recheck the target, move the account
(`switchIdleSessionAccount`, the same engine switch as failover), then set model
and effort through the runtime adapter, then recheck the whole target (enabled,
enterprise, login, bench, offers the model at that effort). The final admission
boundary checks it once more synchronously (binding, model, effort and the
account rules) and the selection is cleared only once the turn is admitted
there; a refusal anywhere before keeps it. While a selection applies, the
disabled-account move does not run: it would replace the chosen account. A
changed account appends the display-only marker
`Switched from A to B — chosen by you.` (or
`— chosen by its coordinating session.`); a model or effort change appends
nothing. A selection on another engine moves the session there instead ("Moving
to another harness").

### When it cannot apply

The turn is **held**, never failed and never run on the old engine
(`PendingRuntimeHeldError`, a Stop-class hold):

- The selection stays pending. The reason is the session's failure and its run
  failure, for example "Couldn't switch to Opus · High · Work: Work needs login.
  The change is still pending; change or reset it to continue."
- When the only obstacle is background work keeping the source engine open, the
  reason is "Waiting for background work on Claude; stop it to switch now."
- A cross-engine switch's refusals (the naming wait, an unreadable pi
  transcript, a failed open or a late account refusal) are this same hold, so
  everything below applies to them too.
- A user prompt is refused before anything is appended. It goes to the user's
  queue, and the error adds "Your message is waiting in your queue."
- A skill invocation cannot be queued (Task-1023), so the server keeps it as a
  **held input** of the session: the exact submitted text, stored in
  `session_prompt_queue` with `kind = 'held'` (migration 0101), in order. It
  rides `PromptQueueState.held`, so every device sees it, after a reload and a
  restart too. The error adds "/X did not run; it is waiting above your message
  box to put back once the change applies or is reset."
  - The composer's queue strip (`PromptQueueLedge`) lists each with **Put back**
    and **Discard**. Put back puts the text into the composer: as is into an
    empty field, else first and on its own line above what is typed, never
    replacing it. The client sends `removeHeldInput` only once the field holds
    the text and this browser's draft has stored it. Discard sends
    `removeHeldInput` at once.
  - Each `removeHeldInput` carries a `requestId`, and the server answers that
    request alone with `heldInputAnswer` (`error` when refused). The row's
    answer stays busy until its OWN answer arrives (or the id leaves the queue);
    a disconnect releases it as unknown. A refusal shows on the row and nowhere
    else, never as the session's failure above the composer; no other failure of
    the session settles or marks the row (`docs/messaging.md`).
  - A held input is never sent on its own: not when the selection applies or is
    reset, not by the boot drain. Queue commands (Remove, Clear, Send next)
    never touch it. It stays until Put back or Discard; a fork does not copy it,
    and deleting the session removes it.
- Queued prompts, peer prompts and background wakes stay where they were, with
  no attempt spent.
- Held work is offered again (a delivery wake) when the selection is changed or
  reset, when background work of the session ends in any way (a Stop from the
  background UI included: its fact defers but still wakes), and when any account
  changes (enabled, enterprise, login, bench) for every session with a
  selection. The scheduler starts nothing when nothing waits.

## Coordinator switching

An owning coordinator sets its still-owned direct child's pending model, effort
or account with `session_control` `set_runtime` (`sessionControlTool.ts`). The
selection is the same pending selection the user sets, with `setBy`
`coordinator`, so its marker reads `— chosen by its coordinating session.`

- A child spawned from an agent definition: a model its frozen definition lists
  (`listedModels`, frozen at spawn from the definition's model choices; a row
  frozen before reads as listing its own model only;
  `docs/agent-definitions.md`) and any effort are set at once. Any other model
  asks the user.
- A child without a definition: any model or effort change asks the user. A
  change is measured against the next turn's target: the pending selection, else
  what it runs now. So a value equal to the pending one is left out of the write
  (only an account is ever set for it without a card), while one equal to what
  it runs now with another pending is a change, and asks.
- An account alone keeps the same-kind move rule and is set at once for any
  owned child.
- Asking is a `sessionRuntime` approval card (`docs/approvals.md`) naming the
  child, what it runs now and its next turn. Nothing changes until it is
  approved; the card is never granted, and a newer request for the same child
  supersedes it.
- Ownership is asked again at the write, also when the card is approved: a child
  the user took over, or a coordinator no longer its owner, changes nothing and
  the card fails.

## Continue on another model

A turn whose quota or rate-limit failure same-kind failover could not recover
(`docs/account-routing.md` "Live account switching") offers "Continue on
<model>" on its failure (`sessionContinueOffer.ts`). It is never automatic: only
the user's click continues anything.

- **Offer.** Once the failure is stored, the server lists the models another
  engine could continue on now: the picker's visible models in the user's order,
  each crossing engines from the session's account, whose Automatic account (the
  router's non-degraded pick within the enterprise requirement) offers it at the
  session's effort, clamped. The default comes first: the model at the failed
  one's position among its own kind's. At most four. They are stored with the
  failure (`session_index.last_error_continue_json`, migration 0105) and carried
  as `continueOn` on its `SessionRunFailure`; a new failure, a run start, or
  Dismiss clears them. The offer is bound to the failure by run identity, not
  timing: the row records which run its failure ended
  (`session_index.last_error_run_id`, migration 0106, from that run's error
  status), the terminal report names the same run (for a turn recovery ran on,
  its last attempt: `attemptRunId`), and the offer is written only while the
  row's failure is that run's. A late or retried report of an older run's
  failure, a newer run's failure, or one no run owns (a pending selection's
  hold) never receives it. User sessions only, never the permanent assistant.
- **Click** (`continueOnModel`). The offer must still belong to the failure the
  user saw (`failureAt`) and list the model, and the session must be idle;
  otherwise nothing changes and the answer carries the error. It sets the
  pending selection (model, clamped effort, Automatic account, `setBy` user)
  without waking held work. All three conditions are asked again with the write
  itself (the setter's `authorize`), so an offer a run start, Dismiss or newer
  failure retired while the target resolved writes nothing. In the same
  synchronous step as the write it starts the continuation of the failed turn
  through `runtimePrompt.ts`, which claims the session's admission at once: no
  user row, the continue context as model-only text, the switch's handoff as for
  any turn. Admission applies the selection as above, so a refusal holds it
  pending like any other.
- **Authority and order.** The click is the user's resume authority, captured
  when it arrived: it passes a Stop's hold and spends it once the provider is
  called. It is admitted ahead of queued work, which follows on the new engine;
  a Stop-paused queue resumes with it.
- **Web.** The chat's failure note becomes `ContinueOnNote`: "Continue on
  <default>" as its action, the other models in a menu, and Dismiss. The pressed
  action is busy until `continueOnModelAnswer`; a refusal is the session's
  failure (`docs/messaging.md`). The inbox card keeps the plain failure.

## Web

The inspector's **Runtime** section (`SessionRuntimeSection.tsx`, shown for a
started session) has Model, Effort and Account rows for the next turn. It lists
every model, this engine's first (`lib/sessionRuntimeControl.ts`). The Account
row follows the target model's kind: Automatic ("chooses among Claude accounts")
and the accounts the server lists for the pending model
(`listSessionAccountMoveTargets`), asked again whenever anything that list
judges changes: the session and its bound account, its next-turn model or
effort, its enterprise requirement, and any account's kind, enabled, enterprise
or health projection (including `benchRevision`, so a new bench scope refreshes
it even when the health state stays the same), and any account's model listing
(the `models` push reloads the account projection, so a listing that gains or
drops the next turn's model refreshes it too; `accountTargetsRefreshKey`). A
refresh keeps the last list shown. The answer also says whether the bound
account itself can run the next turn (`boundEligible`: enabled, enterprise
requirement, offers the model at that effort, login, bench), judged by the rules
a selection naming it is applied with. For a model of another kind the server
lists that kind's accounts and `boundEligible` is false. An account that cannot
move, and an endpoint model's one account, show as text. While a change is
pending, a "Next turn" row states the target and what runs now, names a
coordinator's choice, and offers Reset.

A pending change on another engine adds a **Handoff** row: "Hands over ~12k
tokens", or "Hands over nothing: it keeps its own history" when the engine would
resume a native session that missed nothing. The server computes it
(`estimateSessionHandoff` → `sessionHandoffEstimate`,
`pendingSwitchHandoffTokens`) by the same selection and cap the switch delivers,
predicting the resume without touching native data and resolving Automatic to
the router's pick now. The client asks again when the session, its pending
target, its message count or an account changes (`handoffEstimateRefreshKey`);
only the latest request's answer lands. Loading, refreshing and failure follow
`app/web/docs/loading-states.md`, with Retry on a failure.

While a change is pending, the composer shows a chip "Next turn: <model · effort
· account>", followed by the handoff estimate for another engine. Tapping it
opens the inspector at the Runtime section, as the object dock on a phone.

`/model`, `/effort` and `/account` are client slash commands
(`lib/runtimeSlashCommand.ts`). Without an argument they open the Runtime
section. With one they set the pending selection at once, even mid-turn, and are
never queued. Their argument completes from every model, the target model's
levels, or Automatic and that same server answer, so `/account` lists the target
kind's accounts: the bound account only when it serves the target and
`boundEligible`, then the listed accounts. `/account` is offered only when that
gives more than one account, and not before the list has answered; the client
never judges an account itself. They are offered only for a started session.
`/model` reads its argument as a model's `provider/id` and as a bare id at once
(an endpoint's id may itself hold a slash, `openai/gpt-5.5`), then as a display
name. The completion inserts the bare id when that names only this model in both
readings, else `provider/id` (two OpenAI-compatible endpoints may both offer
`llama3`), and completes it from the text after any slash. A model that neither
names alone is listed disabled: choose it in the Runtime section. Text that
names more than one model is refused with the `provider/id` choices, never
resolved to the first.

A started session refuses `setModel` and `setThinkingLevel` with "This session
has started: change its model or effort in the Runtime section, from its next
turn." Those two messages serve only a session that has not started (a draft on
the server), whose change applies at once.

## Engine changes

Applying a pending selection, or changing an unstarted draft, goes through each
engine's own model and effort controls when it stays on the session's harness
and account kind. Any other change is an engine switch ("Moving to another
harness").

| Change              | pi                                          | Claude                                     |
| ------------------- | ------------------------------------------- | ------------------------------------------ |
| Model               | Any model the bound account serves          | Any curated Claude model the account lists |
| Effort              | Any level the model supports                | Clamped to the model                       |
| While a turn runs   | Accepted; used from pi's next model request | Refused                                    |
| A non-harness model | Refused                                     | Refused                                    |

### Claude

`ClaudeSdkSession.setModel` and `setThinkingLevel` are the only writers.

- **Between turns only.** While a turn runs, both refuse with "This session is
  running; change its model once the turn ends." (or "its effort"). The running
  turn keeps the model its assistant entry, context window and native controls
  started with. The connection sends the refusal as an error targeted at the
  session.
- **Which model.** Only a curated Claude model id is accepted
  (`knownClaudeSdkModelAlias`); a model from another harness is refused before
  it reaches the session. The bound account must be able to run it: an account
  whose known model listing lacks the model is refused with "<account> can't run
  <model>." (`assertAccountCanRunModel`, the gate pins and the first send use).
  An account with no listing yet offers every curated model.
- **Effort** is clamped to the model (`clampThinkingLevelForModel`): picking a
  model clamps the current effort, and picking an effort clamps it to the
  current model. Fable has no `off`, so a switch to Fable lifts `off` to `low`.
- **Admission queue.** Model and effort changes, a prompt admitted behind them,
  provider-started turns and account switches take places in one first-in,
  first-out queue (`claudeSdk/admissionQueue.ts`). Joining is synchronous, and a
  place is ready only after every earlier place released. So changes apply in
  request order and the latest one is what is stored. A change holds its place
  until it settles, native controls included. A prompt queued behind changes
  holds its place until its turn is open, so it runs on their result and no
  change ever runs under it. A provider-started turn holds its place until it
  opens or is denied. An account switch waits for earlier changes. Until it
  ends, the session refuses model and effort changes, prompts, host-command
  turns and provider-started turns; its callers also hold the runtime's
  admission. It does not keep its place for the whole switch, because a provider
  turn waiting for that place would stall the query loop the switch waits to
  close. A host-command turn (`/compact`, `/commit`) cannot wait and is refused
  as busy while anything is queued. A failed change releases its place. Disposal
  makes every place ready, and each waiter then finds the session gone. Pending
  selections (Task-1485) are to apply inside this queue.
- **Stop while waiting.** Stop cancels a prompt still waiting for admission. It
  leaves the queue, never reaches the process, and its run ends `aborted`, the
  ordinary stopped outcome; its request id may be sent again. The runtime's Stop
  reaches it through the adapter's abort, and a prompt that finished waiting
  rechecks whether a Stop arrived meanwhile before it opens.
- **Where it applies.** With no process running, the next query epoch opens on
  the new selection, resuming the native transcript as usual. A process that
  background work keeps open switches through its native controls (`setModel`,
  `setMaxThinkingTokens`, `applyFlagSettings`); one without a model control
  refuses the change.
- **A failed control.** A refused model control changes nothing. Once the model
  control succeeds, the model and its clamped effort are stored together, so a
  stored effort the model cannot run never exists. If an effort control then
  fails, or fails on an effort change, the change reports the failure. The
  process may then run another effort than the stored one, so it restarts as
  soon as its background work allows, like a changed start-time setting.
- **Persistence.** A started session writes the selection to its record and its
  `session_index` row at once; before the first prompt it stays local, as the
  first send creates the session with it.
- **Agent pins.** `claudeQueryModel` decides the native model on every query and
  retained switch: a session on its definition's alias runs the pinned version,
  any other model runs as usual (`docs/agent-definitions.md`).
- **Context window.** The window a previous model reported is dropped and
  learned again from the new model's results. A `result`'s `modelUsage` is the
  epoch's running total and still lists the previous model, so the window is
  read only from the selected model's entry (`mapResultMeta`). A retained
  process's reported compaction threshold is dropped too, so the agent's
  lowering reads it again. The stored compaction window is kept; a query clamps
  it to the new model at start, and a retained process whose clamped value
  changed restarts once its background work allows
  (`docs/compaction-window.md`).

### Draft pickers

`startedModelDisabled` (`app/web/src/lib/sessionCapabilities.ts`) disables what
the server would refuse for a Claude session's models: the Claude models its
bound account offers, all of them while that list is unknown, and never another
harness's.

## Engine bindings

A session's **engine binding** names what runs it: harness, account, provider,
model, effort and the engine's own id for the session (its **native id**).
Bindings live in `session_engine_binding` (migration 0102,
`db/sessionEngineBinding.ts`), numbered from 1 per session; exactly one per
session is active (no `ended_at_ms`). Each records the session-log cursor and
the run it began at; the first binding has cursor 0 and no run. The migration
gave every existing row, tombstones included, its first binding. A binding a
switch started also records `resumed_seq` (migration 0103): the earlier binding
whose native session its open actually reopened, absent when the open started a
fresh one. A binding a switch started on Claude also records its usage base
(`usage_base`, migration 0104; see [Usage](#usage)).

- **Projection.** `session_index`'s `harness`, `provider`,
  `provider_session_id`, `model`, `thinking_level` and `credential_profile_id`
  are the active binding's projection. Only `sessionStore.upsert`, failover's
  `switchCredentialProfile` and the harness switch's `switchEngineBinding` write
  them, and each writes the binding in the same transaction, so the row always
  equals the active binding. Nothing else writes either
  (`engineBindingBoundary.test.ts`).
- **Native id.** Claude's is the SDK session id (`provider_session_id`, absent
  until the first query). pi's is the app id for every pi binding, a session's
  first or a later one: a later pi binding reopens the transcript the app id
  names, or starts one under it. Only the binding is stored, never a path. A
  stored pi session's transcript resolves through its binding (`piSessionFile`);
  `canonicalPiSessionPath` derives it from the app id only where no row exists
  yet (a fresh session, rowless recovery). A pi binding whose native id differs
  from the app id is refused.
- **One accessor.** Capability readers ask `activeEngine(...)`
  (`harnesses/activeEngine.ts`) what a session runs on, and native-ref readers
  `activeNativeRef(...)`; readers holding only an id use
  `harnessRegistry.engineOf`. Remaining direct `.harness` reads are pinned per
  module and only shrink.
- **Per-run attribution.** A run's `run.started` marker (server-only) records
  the engine it starts on: harness, account, provider, model and effort as the
  adapter reports them. Run-completion listeners receive that stamp, so usage is
  marked against the account the run actually used; a marker without one (an
  older log) falls back to the session's active binding. After an account move
  the one logical completion carries the stamp of the attempt that finished it,
  not the first attempt's, and each attempt keeps its own marker.
- **Offline readers** (`measure:session`, `measure:tasks`) never ask the
  binding: it lives behind `getDb()`, which migrates, even when the directory is
  this process's own `DATA_DIR`. They read the `session_index` projection over a
  read-only connection and derive a pi file from the app id, which every pi
  binding's native id equals.

Only the harness switch ends a binding and starts the next:
`sessionStore.switchEngineBinding` is its commit, one transaction that ends the
active binding (refusing unless it is still the one the switch started from),
inserts the next with the session log's cursor, projects it onto the row and
clears the pending selection the switch applied when that is still the stored
one. The first run the new binding starts stamps it (`started_run_id`).

Only the engine instance that holds the active binding writes the projection.
Each engine instance names the binding it runs (`bindingSeq`) on every row
write: the active binding when it opens, a session's first (1) when there is no
row yet, and for a switch's target the binding the commit starts. An `upsert`
that names another harness, or another binding than the active one, whatever its
harness, leaves the six binding columns and the binding as they are, and its
title, activity time and message count too: those describe only its own native
stretch. So the target writes nothing before its commit, a late write from an
instance of the binding a switch left never lands after it, and a kind change
within pi leaves the binding it left exactly as it was; an abandoned one changes
nothing. Claude's usage writes follow the same rule. A released instance also
writes nothing at all: pi's late naming run neither renames nor appends to a
transcript the next binding reopens, and Claude's store persists only the
instance it holds. After a switch the active engine counts only what it ran, so
its message count may raise the row's but never lower it (0 would hide a started
session from the list).

### Usage

A session's usage totals (`session_usage_totals`: tokens, cost, usage and
assistant turns) are the sum over all its bindings. Every reader reads that one
row: the session audit, the Status digest, a workflow run's spend evidence and
the offline `measure:session` snapshot.

The two engines count differently. pi adds each run's own usage as the session
log records its assistant entry (`recordUsageTurn`). Claude reports its record's
RUNNING native total, and a return's record still holds what that record counted
under its earlier binding. So the switch's commit stores a **usage base** on a
Claude binding: the session's totals at the commit less what the record it
opened already holds (zero for a fresh record; a field never goes below zero).
Claude then writes its record's total over that base
(`sessionStore.replaceEngineUsage`). A pi binding and every first binding have
no base, and a session that never switched counts exactly as before. A return
counts its record's earlier stretch once, because the base leaves it out. The
base is durable, so a restart writes the same sum. Only the active binding's
instance writes (see above).

Turn counts follow the same sum. Context tokens and window are the active
engine's latest. The audit reconciles a switched session's cost under its own
`per-engine` accumulation: pi's runs rounded per entry, plus Claude's runs
(attributed by each run's `run.started` engine) rounded once.

## Moving to another harness

A session can move to a model of another harness (pi ↔ Claude) under the same
app id. The switch closes the session in its current engine and opens it in the
other with a new binding. Applying a pending selection that names another
harness performs the switch (`applyPendingRuntime`).

A change of account kind within pi (Codex ↔ an OpenAI-compatible endpoint) is
the same move with pi on both sides: pi's account switch serves Codex logins
only, so the session closes on its pi engine and reopens on its own transcript
(D1) under a new binding that records the old one as resumed. It owes no
handoff: the transcript it reopened holds the whole session.

### Applying a switch

- **Account.** A chosen account must serve the target model, be enabled, meet
  the enterprise requirement, be logged in, not be benched, and list the model.
  Automatic takes the router's non-degraded pick of the model's kind; the bound
  account serves another kind and is never kept.
- **Move.** The store move below runs inside the turn's admission. Its refusals
  hold the turn as on one engine; background work on Claude holds it with
  "Waiting for background work on Claude; stop it to switch now." Work that ends
  by itself (the naming agent, on either engine) holds it with "Waiting for the
  session to finish its own work…", and its end wakes the session's delivery.
  Another switch of the same session holding the fence refuses the turn as busy.
- **Turn.** The turn runs on the new engine's driver (`deliverWithRuntime`),
  which rebinds the detached runtime session. A refusal after the move and
  before the commit (the final admission included) abandons it. The commit runs
  right after the turn's `admit`.
- **Marker.** Once the turn is admitted, the transcript shows the display-only
  `Switched from Claude Sonnet · Claude to GPT-6 · Work — chosen by you.` (or
  `— chosen by its coordinating session.`). No model sees it; the switch note
  below tells the new engine.
- **Viewers.** A connection showing the session on the released driver moves to
  the new one when it binds (`upgradeViewingDriver`), and a command it sends
  meanwhile reopens through the registry like a storage-backed view.

### Handoff

The new engine gets no summary and asks the old engine nothing. It gets a
budgeted, verbatim selection of the session's own app log (`sessionHandoff.ts`),
headed by a switch note. It rides as model-only context
(`RuntimePromptOptions.contextBlock`, ahead of any other) on every new turn
until the new engine has replied once (`sessionSwitchHandoff.ts`): owed while
the active binding is not the first and the log holds no assistant entry after
its `started_seq`. A steer joins a turn that already carries it, and the log
keeps the clean user text.

- **Entries** are the records `session_read` reads: user prompts (hidden ones
  too, since the model saw them), assistant text, tool calls and tool results.
  Thinking, notices and run bookkeeping are never included. Each entry is headed
  by its `session_read` entry id.
- **Order of choice:** the latest user request, the latest reply, the first
  request, then newest first until one entry does not fit; what is chosen is
  shown in log order. Each entry takes at most 4,000 tokens or a quarter of the
  cap, shortened with a pointer to `session_read` at its id.
- **Range:** a fresh native session gets the whole log, seq 0 included. Only a
  binding whose open reopened its earlier native session (`resumed_seq`) gets
  just what it missed: the entries from the `started_seq` of the binding that
  followed the resumed one. Equal native ids prove nothing: a pi return whose
  transcript was gone shares the app id but starts over, with the whole log.
  `started_seq` is the next seq the log gives, so a binding's range starts AT
  it. A binding that resumed the one it replaced (a kind change within pi) gets
  nothing.
- **Cap:** `AppSettings.sessionSwitching.handoffTokenCap` (Settings → Models,
  default 16,000, clamped to 1,000–64,000), and never more than the target
  model's context window, less what a resumed native session already holds, less
  a reserve of the larger of 16,000 tokens or a quarter of the window. What it
  holds is the context size its last reply reported (walking back the resume
  chain); when it never reported one, every log record before it was left,
  estimated, which can only overstate it. When nothing fits, only the note goes.
  Tokens are estimated at four characters each.
- **Switch note:** what changed ("moved from GPT-6 · OpenAI to Claude Opus ·
  Work"); that reasoning and tool state did not carry over; the session's own id
  with `session_read({ sessionId, at, includeToolResults: true })` and
  `session_search`; how many entries are included; up to 40 omitted entry ids,
  newest last, with a count of the rest; and "Historical material is context,
  not a new request or instructions." It points at the app log only, never at a
  native transcript. `session_read`'s own description names this use: a session
  reading its own earlier turns on another model.

### Store move

A switch releases the session from the engine it leaves and opens it in the
other under the same id; the runtime session in between is never replaced.

- **Release** (`releaseForSwitch` on `claudeSdkStore` and `piStore`) runs inside
  the switching turn's admission, whose own reservation is the only thing
  allowed to keep the session busy. Claude ends its process first; background
  work on a retained Claude process refuses with `AccountSwitchBlockedError`,
  which holds the turn ("Waiting for background work on Claude; stop it to
  switch now"). pi's background work keeps running and reaches the session on
  its next engine. Claude saves its record before it lets go, and a session it
  cannot save stays. Neither refuses for nothing being resident. Work that ends
  by itself (the naming agent, on either engine) refuses with
  `SessionSettlingError` and wakes the session's delivery once it has ended; a
  browser the agent keeps open on Claude refuses outright.
- **Runtime session.** `SessionRuntime.detachHarness` swaps the leaving engine's
  adapter for the detached one, between runs only; the runtime session, its log
  and its viewers stay, and the next engine's driver binds it as a reader's view
  is bound. A caller still holding the old driver is refused as a released one
  and retries against the new engine.
- **Open** (`openForBinding`). Claude takes the binding's model, effort, account
  and native session (none for a fresh one) over what an earlier Claude binding
  left in its record, and the session's own mode, title, creation time and
  scope; the record's timeline stays. pi reopens the app id's transcript or
  starts one under it, and reports which it did: that, not the plan, is what the
  commit records as `resumed_seq`. It reads the session's frozen prompt
  conditions, skills and agent definition. A pi transcript that is there but is
  not this session's (an unreadable or foreign header) refuses with
  `PiSwitchTranscriptError`, and the switch holds with "choose another model, or
  reset the change"; nothing is started over it. Both engines read the one
  insert-only prompt-conditions record the session froze at its start and render
  it their own way: pi its persona layer and bare tool names, Claude the
  `claude_code` preset's append and its mounted server's `mcp__pa__` names
  (`claudeSdk/claudeSdkSwitchSurface.test.ts`).

- **Order** (`prepareEngineSwitch`, `harnesses/engineSwitch.ts`). The fence goes
  up first, before any side effect, so a second switch of the same session
  refuses before it can stage or roll back native data the first one owns. Under
  it the switch reads the row and finds the target engine's newest earlier
  binding: Claude resumes the earlier native session when its account still
  holds the transcript, or copies it to a new account with the failover copier,
  and otherwise starts fresh; pi decides at its open. Then it releases, opens,
  and hands back the session on its new engine with `usable`, `commit` and
  `abandon`. `usable` also refuses when the engine it left holds the session
  again. A throw anywhere before the commit, or an abandon, lets the new engine
  go, rolls a copy back and lifts the fence: the row still names the old
  binding, the old engine reopens the session on its next use, and the selection
  stays pending. The commit checks `usable` again, writes the binding and lifts
  the fence; nothing awaits between the turn's final check and it.

### Switching fence

From the release until the commit or the abandon, the session belongs to no
engine for anyone else (`harnesses/engineSwitchFence.ts`): neither shows it
resident, and `harnessRegistry.acquireById` refuses with
`SessionSwitchingEnginesError`, a `SessionBusyError`. A viewer's command, a peer
delivery or a background completion is refused as busy and tries again. A commit
wakes the session's delivery, so that work is offered at once on the new engine.
A rollback wakes it only when the fence refused someone meanwhile: the switching
turn's own work is held, and waking it would only retry the failed switch.

The fence holds at registration too, not only at the registry's entry: an
acquisition that checked before an await could otherwise reopen the engine the
session is leaving. Each store asks `harnessRegistry` after its open's last
await (`setRegistrationCheck`). It refuses an id the other engine holds resident
and one whose row is tombstoned, whoever opens it; outside the switch's own open
it also refuses an id a switch is moving (busy) and one whose active binding
names the other engine.

- **Reopen after a commit.** The committed binding is what reopens. Claude takes
  the active binding's model and effort over its record, and for a binding a
  switch started its native session too (none until its first query); pi passes
  a switched-to binding's model and effort over its transcript's last selection.
  A crash between the commit and the new engine's first save therefore resumes
  the committed binding, not the one before it. Because the binding wins, every
  change of the session's native identity must reach it: Claude's registry sync
  writes the native id, model and effort it holds on every save, an absent one
  as `null` (`sessionStore.upsert` clears on `null` and keeps on omission). A
  `/clear` forgets the native session in the binding too, so a reopen does not
  bring the cleared conversation back; a native session a later query learns
  replaces it there at the turn's save. pi's native id is its app id and never
  changes.

### Deleting

Deleting a session removes it from every engine, not only the active one or
those its bindings used: a switch in flight has it open on an engine no binding
names yet, and that engine tombstones it there, so the switch's abandon writes
nothing back. It also sweeps every Claude native session a binding named from
every account (`harnessRegistry.remove`). A deleted id is never opened again:
`acquireById` answers nothing for a tombstoned row, whatever an engine still has
on disk, and a store's registration check refuses one that a delete overtook.
Until the delete, old native data stays for returns and forks.

### Forking

A fork of a switched session cuts the native session of the binding that wrote
the chosen entry (`prepareFork` in `harnesses/fork.ts`). That binding owns the
log from its `startedSeq` to the next binding's, and its native session also
holds what the bindings it resumed (`resumedSeq`) wrote; anchors are read only
from that chain, so an entry another engine wrote never names the cut. The fork
runs on that binding's engine, from its native session at its account, model and
effort; the child gets that binding only. An entry with no anchor in its owner's
chain is refused like any anchorless fork. A session that never switched forks
exactly as before.

### Task links

A Task's session refs (`TaskSessionRef`) name the session by id and persona
only. Which engine runs it, and its native file, come from the active binding; a
ref never stores them, and the `harness` and `sessionFile` older edges carry are
ignored.
