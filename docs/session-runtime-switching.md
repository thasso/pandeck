# Session runtime switching

A started session can change its model and its effort (thinking level). This
document is the contract for those changes. It grows with Task-1485: pending
selections, account moves made pending and switching between harnesses are
planned; until they land, what follows is all that exists. Account moves are
`docs/account-routing.md` "Moving a session by choice".

## Model and effort between turns

Both harnesses apply a change at once, to every later turn. The change stays on
the session's harness and bound account; moving to another harness is refused.

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

### Web

`startedModelDisabled` (`app/web/src/lib/sessionCapabilities.ts`) disables what
the server would refuse. A started Claude session offers the Claude models its
bound account offers, all of them while that list is unknown, and never another
harness's. No picker for a started session is reachable today: the composer's
runtime pickers are gone, and the inspector's Runtime section is planned.
