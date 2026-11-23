# Session runtime switching

A started session can change the model, effort (thinking level) and account its
next turn starts on. This document is the contract for those changes. It grows
with Task-1485: switching between harnesses is planned; until it lands, every
change stays within the session's current engine. Failover and the other moves
the app makes itself are `docs/account-routing.md` "Live account switching".

## Pending selection

A started session's change is a **pending selection**: one complete target
(model, effort, account) stored on the session row
(`session_index.pending_runtime`, migration 0101) and carried as
`pendingRuntime` on `SessionState` and `SessionListItem`. Nothing about the
engine changes until the next turn is admitted. Setting it or resetting it
leaves no trace in the transcript or the native session, survives a restart, and
has no expiry. A fork does not inherit it.

`app/server/src/sessionPendingRuntime.ts` owns both halves.

- **Setting** (`setPendingRuntime`, or `session_control` `move_account`) is
  accepted at any time, during a turn too. A change names any of the three
  parts; the server completes it from the current pending selection, else the
  session's current runtime, and clamps the effort to the target model. A target
  equal to what the session runs now clears the selection. Only static rules
  refuse at set time: a model of another harness ("Another harness: not
  available yet"), one the bound account's kind cannot run, an unknown model,
  and for a chosen account another kind, a disabled one, one that is not
  enterprise when the session requires it, or one that does not offer the model
  at that effort. Health and benches are judged when the turn starts. `setBy`
  records the user or the coordinator.
- **Reset** (`clearPendingRuntime`) drops it. Both answer with
  `pendingRuntimeAnswer`; a refusal carries `error` and becomes the session's
  failure (`docs/messaging.md`).
- **Account.** "Automatic" keeps the bound account when it can run the target
  and asks the router otherwise, within the bound account's kind and enterprise
  requirement. A chosen account must still pass every move rule (below). Only a
  subscription login moves; any other account alone serves its models.

### Applying it

`runtimePrompt.ts` applies the selection when it admits a new turn of any origin
(a user prompt, a queued prompt, a peer prompt, a background wake, a scheduled
run, an automatic continuation). It does not apply to a steer into a running
turn, a steer-only message, the account-recovery (failover) continuation, or a
turn the provider already started (`beginRuntimeProviderTurn`). Order: recheck
the target, move the account (`switchIdleSessionAccount`, the same engine switch
as failover), then set model and effort through the runtime adapter, then clear
the selection in the same step. A changed account appends the display-only
marker `Switched from A to B — chosen by you.` (or
`— chosen by its coordinating session.`); a model or effort change appends
nothing.

### When it cannot apply

The turn is **held**, never failed and never run on the old engine
(`PendingRuntimeHeldError`, a Stop-class hold):

- The selection stays pending. The reason is the session's failure and its run
  failure, for example "Couldn't switch to Opus · High · Work: Work needs login.
  The change is still pending; change or reset it to continue."
- When the only obstacle is background work keeping the source engine open, the
  reason is "Waiting for background work on Claude; stop it to switch now."
- A user prompt is refused before anything is appended. It goes to the user's
  queue, and the error adds "Your message is waiting in your queue." A skill
  invocation cannot be queued (Task-1023); its error says to send it again.
- Queued prompts, peer prompts and background wakes stay where they were, with
  no attempt spent.
- Changing or resetting the selection wakes delivery, so held work is offered
  again; so does the end of the background work.

## Web

The inspector's **Runtime** section (`SessionRuntimeSection.tsx`, shown for a
started session) has Model, Effort and Account rows for the next turn. Models of
another harness or account kind are listed disabled with their reason
(`lib/sessionRuntimeControl.ts`). The Account row offers Automatic and the
accounts the server lists for the pending model
(`listSessionAccountMoveTargets`, asked on every open); an account that cannot
move shows as text. While a change is pending, a "Next turn" row states the
target and what runs now, names a coordinator's choice, and offers Reset.

While a change is pending, the composer shows a chip "Next turn: <model · effort
· account>". Tapping it opens the inspector at the Runtime section, as the
object dock on a phone.

`/model`, `/effort` and `/account` are client slash commands
(`lib/runtimeSlashCommand.ts`). Without an argument they open the Runtime
section. With one they set the pending selection at once, even mid-turn, and are
never queued. Their argument completes from the session's models, the target
model's levels, or Automatic and the accounts of the bound kind that can serve
the target model; `/account` is offered only when there is more than one such
account. They are offered only for a started session.

A started session refuses `setModel` and `setThinkingLevel` with "This session
has started: change its model or effort in the Runtime section, from its next
turn." Those two messages serve only a session that has not started (a draft on
the server), whose change applies at once.

## Engine changes

Applying a pending selection, or changing an unstarted draft, goes through each
engine's own model and effort controls. The change stays on the session's
harness and bound account; moving to another harness is refused.

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
