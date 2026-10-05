# User-facing messages

How the app tells the user that something succeeded, failed, needs them, or is
about to happen. `app/web/docs/loading-states.md` owns what a region renders
while it is _waiting_; this owns what is said when the waiting ends, and the two
share one rule — a message belongs where the thing it is about lives.

Blocking dialogs (`window.confirm` and friends) are a separate, deliberate
interruption and are out of scope.

## The rule

Three questions decide the channel. The first two are ordered; the third stands
apart and can be true alongside either.

1. **Is it a condition or an event?** A condition is true until something
   resolves it — an approval waiting, a blocked composer, an unconfigured
   integration, a pane whose load failed. It lives on its object and stays
   there, whether or not that object is on screen: it is found by going to the
   object, and where it blocks an agent the inbox and its badges point at it. A
   condition never takes the ephemeral channel and never expires on a timer.
   Everything else is an event, and question 2 is about events only.
2. **Is the object the event is about on screen?** If it is, the event belongs
   there — the pane, the row, the card, the control. This is the same answer
   `loading-states.md` already gives for a failed write, generalized. If the
   surface is gone, the event has no home and the ephemeral channel is what it
   is for — the only thing it is for; it still names its object, because the
   user has to know which one it was about. Nearly every message is about some
   object, so what decides this is whether that object is in front of the user,
   not whether one exists.
3. **Is the user away?** Push is orthogonal to the two questions above and
   applies to both kinds: a condition that blocks the agent on them, and an
   event that delivers a result they were waiting for. Nothing else pushes, and
   nothing pushes while they are here.

**There is no banner channel.** A full-width tinted row that pushes the page
down is not a message surface. The one app-wide announcement that survives lives
in the app status slot below.

## Channels

| Channel                             | Carries                                                               | Lifetime             |
| ----------------------------------- | --------------------------------------------------------------------- | -------------------- |
| In place (`ErrorNote`, card, field) | Conditions, and events whose object is on screen                      | Until resolved       |
| Toast                               | Traceless receipts, actionable outcomes, events whose surface is gone | Seconds              |
| App status slot                     | App-wide, self-clearing lifecycle state                               | Until the state ends |
| Object state (inbox tier, badge)    | A blocked agent, surfaced where it can be found                       | Until answered       |
| Push                                | A blocked agent, or an awaited result                                 | The OS owns it       |

Toast lifetime has two shared values: `TOAST_BRIEF_MS` for a receipt where there
is nothing to do, and `TOAST_DWELL_MS` when the reader must finish reading or
act, such as for a failure or an action. Which one applies is a function of what
the toast asks of the reader, and nothing else.

## Failures

A failure lives on its object. It says what failed, and where the user can act
it offers the action — `ErrorNote`'s retry, the control that was refused, the
prompt that was kept. A failure that leaves the object broken until someone acts
— a pane that could not load, a session that cannot start a turn — is a
condition and stays there, on screen or not.

A one-off act that fails after its surface is gone is the event case: a
background push, a run the user navigated away from. It takes the ephemeral
channel and names its object in the message, and the retry, if there is one,
waits on the object itself.

A failure that cannot name its object must not be RAISED without one; that is
the signal it was raised in the wrong place. This is an author-facing rule
rather than a client one: the client announces an unattributed failure bare
(`messageAnnounce.ts`), because a swallowed failure is worse than an
unattributed one. The fix is at the send, not at the arrival. This is also why
the wire carries the target a message belongs to rather than a severity alone: a
client that has to match on message text to decide where an error goes is a
client that will put it nowhere useful, and the text is not a stable interface.

The same holds for what a failure UNDOES. A prompt send that never ran names
that send on the wire (`failedPromptClientRequestId`, the `clientRequestId` the
prompt arrived with), so the client retires exactly the optimistic echo whose
prompt failed and leaves any other send in flight alone. The one echo that stays
is a STAGED first send's: it is the whole content of the new-session surface,
and the failure is narrated under the kept prompt with its retry.

Unmet preconditions are not failures. "Select a credential profile", "the draft
is empty", "this session cannot be forked" are conditions on a control: the
control is disabled and says why, rather than the act being attempted so it can
be refused.

### Which object, and where it renders

Four object types name themselves on the wire, and each has one home:

| Object   | In place                                                                                | Retired by                                    |
| -------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| Session  | Above that session's composer (`sessionFailures`)                                       | Its dismiss, or that session's own next send  |
| Project  | The refused control on the project's page or panel, else a note at the top of that page | Its dismiss, or that project's own next write |
| Task     | The refused control on the open Task, else a note above the Task                        | Its dismiss, or that Task's own next write    |
| Worktree | The dialog, card or delivery flow that issued the write                                 | That flow's own next attempt                  |

A collection (a target with no member id) is the fifth case and is covered
below.

**Two things can render a failure in place, and the wire says which.** A write
the client TRACKED is refused on the control that made it — the field, the
button, the row's action — and that per-control state is where it belongs: it is
the most specific place, and it holds the retry. A write no control tracks —
archiving a Task, commenting on an entry, a review handoff — has no such place,
so it goes on the OBJECT and renders as one note above it. Which of the two a
failure is, is answered from the `requestId` it carries, at the arrival: the
client already correlates that id to the write it started. Keeping both would
print the same sentence twice on one page.

**A member that is only a ROW in a list has no home.** A row draws a title and a
status; it is not a failure surface, and a list that re-sorts is not a place a
condition can wait to be found. So a failure about a Task or an entry that is
not the one OPEN is announced naming the object — the ordinary event case — and
the claim is per object id, never per type.

**An act about many objects at once names none.** A reorder is about the
ARRANGEMENT of a list, and a bulk project assignment about a set: no one member
is the object that failed, and the collection target means something else (the
list could not be READ, which has a different repair). Those failures stay with
the surface that issued them — the drag's own note, the assignment's receipt —
and are announced when it is gone.

**A comment failure names the object the thread is ON.** A comment is not
somewhere the user can navigate; it is drawn by whatever renders the entry,
Task, diff or transcript it hangs off, so that host is the only surface that can
report it (`messageTargetForComment`, one function for every comment target
there is).

**Only an unambiguous id may be named.** The id has to be the handler's own
parameter, or a local captured before the first `await`. Reading the
connection's currently-viewed object inside a `catch` names whatever the user
navigated to while a slow write was failing, which is worse than naming nothing;
that bug has shipped here once. Where the object is DERIVED from what the client
selected, it may only be named once every part of that selection has resolved to
it: a handoff of threads that turn out to span two objects, or one thread that
cannot be resolved at all, is the many-objects case above, and naming the first
of them is the ambiguous target this rule refuses.

**Known divergence: most server `error` sends still carry no target.** Around
eighty in `connection.ts` are untargeted, and only the handlers holding an
unambiguous id have been converted — worktree merge/remove, the workflow-run
controls, the model/thinking/mode controls, the dry-run commit accept, the
question-resume, and the approval and pull-request agent handoffs. A `/pr` card
ACTION is the other resolution and the better one where it is available: the
card already renders the failure, so the send is dropped rather than targeted,
and only the case where the card itself is gone still says anything. The rest
are the gap, not the design, and each is closed by finding the id its handler
already has rather than by reading `this.viewing` in a `catch`. Until then an
untargeted error is claimed by a staged first send, which narrates it as its own
bootstrap failure: that is the concrete damage this list is ordered by.

The same correlation is required of the view half. A claim reads "which object
is open", and where that answer comes from a document the page LOADED rather
than from the route itself, it has to be matched against the current address:
state that outlives the route holds the previous entry's id while the next one
loads, and a claim made on it suppresses one object's failure and draws its note
over another's surface.

## An announcement is raised where the message ARRIVES

The client says a message out loud at the moment it lands, from the socket
handler that receives it — the same place and for the same reason as an
`appNotification`: an announcement is an event, and there is nothing about it to
reduce. What survives the arrival is only what genuinely persists — the failure
on its session or its object, the condition on its collection, the viewed chat's
last outcome. There is no global message slot.

This is the rule the whole model rests on, because every recurring bug in this
area has had one shape: **a persistent store asked to name the current event.**
A store outlives what put it there, so anything derived from it later is a guess
about whether it still means it. Deriving the announcement from state cost, in
order: an event announced on its message TEXT (so a retry, or a second session
hitting the same transport failure, said nothing); one arrival's suppression
swallowing an unrelated message that happened to land while a surface was up;
one object's live failure erased by another object's; and a suppression that
DEFERRED rather than consumed, so the failure was finally announced once the
surface that owned it — and the failure itself — were long gone. From the
arrival there is no later: the message is either said now, or owned by something
that renders it.

**Ownership has two halves, and only one of them is a wire fact.** WHICH object
a message is about is the server's to say, and it says it (`MessageTarget`,
including a target with no id, which names the COLLECTION when a list is what
failed). Whether that object is in front of the user is something only the view
layer knows, so the surfaces that render failures in place CLAIM them
(`lib/messageArrival.ts`), and the arrival is checked against those claims.

The claim registry is deliberately not the whole answer, and the wire target
deliberately is not either:

- A target alone cannot decide it. "Is this object on screen" is a routing and
  layout fact that no server can hold, and a session's failure is announced
  precisely when its chat is NOT the one being viewed.
- Matching the message's text against whatever a surface is rendering is what
  this replaced. User-facing copy is not an interface: it reroutes silently the
  moment anyone rewords a sentence, and it cannot tell two identical sentences
  about different objects apart.
- Announcing everything and letting the owning surface dismiss by toast key was
  the other option, and it is a flash of a message the user was never meant to
  see, timed by whichever renders first.

A claim is by object where there is one, and by SITUATION where there cannot be:
a staged first send is creating the session it is about, so the blockers it
narrates — the server's refusals BEFORE that session exists — name nothing.
Those are what it claims, plus its own id once it has one. What a claim may
never be is a window: suppressing every error for the length of a bootstrap
loses a background failure that names nothing to be found by later. **A claim
covers what the surface actually renders, and no more** — that is the same rule
that stops the composer's note from swallowing every notice about its session.

Claims cover errors only — the in-place note under a composer exists for a
failure, so a warning naming that same session still has nowhere to go and is
still announced. The same holds for the object notes: each exists for a failure,
so a warning naming the open Task is still announced.

What is claimed, then, is the viewed session, a staged send's situation, and the
ids whose own surface is open AND VISIBLE — the projects and Tasks
(`FailureHomes.openObjects`). One id per type, because the app opens one of each
at a time. A Knowledge Base file draws no note of its own, so a failure naming
one is announced. The claim is by id rather than by type because the alternative
suppresses every row in the list behind the one open member, and it requires the
surface to be on screen rather than merely mounted: a note behind an unselected
panel tab, or behind a collapsed panel, would suppress the announcement and then
show the user nothing at all.

A collection's load failure needs no claim: it is a condition, kept on the
collection and rendered by the pane whenever the user arrives, on screen or not,
so it is never also said in passing. Three collections keep one — projects,
Tasks and worktrees. Where the pane's note offers a RETRY, that failure also
reopens the collection's once-per-episode read gate (Tasks, worktrees), or the
retry is a no-op behind a gate that already believes the list was read.

A claim is stated from a committed render and read from the socket, so it lags
by one effect flush: a message landing in that gap is judged against the view
the user has just left. The cost is bounded to one duplicated or one missed
announcement, and never to the failure itself — it is on its object either way,
which is the whole reason a condition is kept there.

## Success

**Silence is the default. The changed UI is the receipt.** A message that
repeats what the user can already see is what teaches them to ignore the
channel.

Announce a success only when:

- **The confirmation is the only outcome** — nothing on screen changes. Copying
  to the clipboard is the archetype; saving a setting is the same shape.
- **The message carries an action** — Undo for something reversible and
  consequential, or a way to reach what was just created. The action is the
  reason, not the fact: a pull request's number earns a message because it comes
  with a way to open it, and a clone's directory earns nothing because the next
  thing the user does does not depend on knowing it.

A no-op is a design failure before it is a message. If the emptiness is knowable
in advance — nothing to commit, nothing to discard — the control is disabled and
says why. Announce a no-op only where it could not have been known without doing
it: a push against a remote that turns out to be current already.

**No success is ever persistent.** Every case above is traceless or off-screen
by construction, which is exactly the fire-and-forget shape the toast exists
for.

## Conditions and the app status slot

Conditions are not messages and do not interrupt. They render where they apply,
for as long as they apply, with the thing that resolves them: a blocked composer
carries its unblock, an unconfigured integration says so in its own section.

**The object a condition is about can be a single message.** The permanent
Assistant's queue is the case that settled it: `queued` and `working` are states
one prompt is IN until the next update replaces them, so they render on that
prompt's own row — the optimistic echo, keyed by the `clientRequestId` the send
created it under — and neither is announced. They used to be info notices, which
is a condition on the ephemeral channel.

That row is a home rather than a race because of the ORDER on the wire: the
server reports `working` before it starts the run, and the durable user entry
that retires the echo is appended from inside that run. So the echo outlives
both conditions, and it hands over rather than vanishing — from the durable row
on, the transcript's own run indicator says the same thing. The band above the
composer was the alternative and is the worse one: it is not the object, and it
already holds the missing-worktree banner, the session's in-place failure and
the bootstrap narration.

`failed` is the one thing there that speaks. It is a real failure with a session
to name, so it takes the ordinary session-failure route (`sessionFailures`) and
reaches the user exactly once — in place above that composer, or announced
naming the session when they are elsewhere. It is also retired the ordinary way,
by the dismiss or by that session's own next send, and **not** by a later
`completed`: the queue emits completed or failed per item and never both for the
same one, so a completion is always some other item's, and clearing a live
failure with it is the unrelated traffic a condition on an object exists to
survive.

One class of condition is about the whole app rather than any object, and it is
the only thing that may announce itself globally: **app-wide lifecycle or
connectivity state that the user cannot act on and that ends by itself.** Two
states qualify — a server restart, queued or under way, and a socket that has
dropped. Both are about the app rather than anything in it, neither offers the
user a move, and both clear themselves.

That slot has one component and two placements, because the app has two shells:
inline in the App Header Bar on wide layouts, where window chrome already lives
and no layout moves; floating at the top centre on narrow ones, which have no
header bar and where an overlay is also the only thing visible from the sidebar.
The two states are mutually exclusive and ranked — a restart in progress
describes the disconnect it causes, so it wins.

Anything object-shaped that reaches for this slot is in the wrong place. The
slot's name says what it is for, and the audit keeps it that way.

## The agent is blocked on the user

An agent waiting for an approval, an answer, or a Task choice is not an event to
be announced once. It is durable state on the session, and it already has its
vocabulary: the inbox's `needs-you` tier, ahead of `attention` (failed, unread),
`working`, and `active`. The card in the transcript is where it is answered; the
tier, the badge and the dot are how it is found.

Inside the session, the card itself has to be found too. It is anchored at the
tool call that proposed it, so anything the agent says afterwards pushes it up
the transcript. While an approval card is pending, the composer's ledge names it
(`PendingApprovalsLedge`), and a tap jumps to the card and flashes it. The strip
only finds the card: Approve and Reject stay on the card. Each proposing tool's
result also hands the agent a `pa://approval/<id>` link to its card, so "approve
this" in the agent's reply is a link to the card, showing the card's live
status. Both reach the card the same way, through a `resolveTimelineAnchor` with
an `approval` target. The server answers with the card's row id
(`approval-<id>`) and the index of the turn that proposed it, so a windowed
transcript loads back far enough to show the card.

This is also the one in-app state that qualifies for push, because the work has
stopped until the user acts.

## Push

Push is external and expensive: it reaches the user where they did not ask to be
reached. It is reserved for two cases — **the agent cannot continue without
them**, and **a result they were waiting for has arrived**. Anything that
neither blocks the work nor was being waited on can wait until they next look,
and is not push.

That admits an owned turn that finished or failed; CI concluding on a pull
request the agent opened; a workflow run reaching a merge decision or needing
attention; and an owned agent blocked on an approval or a question. A turn the
user stopped is not news. A coordinator-owned peer session reports to its parent
instead, and a successful agent-driven parent wake stays intermediate while
another requested peer reply is outstanding. It excludes every mutation outcome
and every condition that leaves the work running. An unconfigured integration or
a failed list is found when the user arrives, not announced to them elsewhere.

`docs/notifications.md` owns delivery: the three routes for one payload, which
runtime may raise the socket copy, and where a tap lands. A client whose app is
in front raises nothing itself; presence is the OS's judgement, not the page's.

## Alignment with loading states

`loading-states.md` is authoritative for the waiting half and nothing here
overrides it. The seam:

- Its inline-vs-toast rule for failures is the general rule above, and
  `ErrorNote` remains the one failure surface with a home.
- R2 still holds when a message accompanies a refresh: retained data stays on
  screen, a failure is added beside it and never replaces it.
- R5's per-control busy state is what makes most success messages unnecessary —
  the control that spun and stopped, next to content that changed, has already
  said it.
- `PaneLoading`, `Skeleton`, `EmptyBox` and `RefreshIndicator` are not messages
  and are not reachable from here.

## Exceptions worth keeping

- **A peer prompt delivery says nothing.** Its state is the durable card; an
  announcement would be a second, weaker copy of it.
- **A staged session's bootstrap owns its own failure.** The prompt is kept and
  the retry sits beside it, because the global channel would be the same
  sentence in the one place it cannot be acted on. This is the general rule, and
  it is named here because it predates it.
- **Provider retries and automatic compaction are session state**, not
  announcements to whoever happens to be viewing. They belong to the session's
  own surface, and each already has one: a retry is a durable `provider.notice`
  entry projected into the transcript, and an automatic compaction is the
  context meter dropping, whenever the CLI reports `post_tokens` — the meter is
  only corrected where the boundary carries the post-compaction count, and where
  it does not the next request's own reading corrects it a turn later. Neither
  raises a `notice` at all, and the broadcast is DROPPED rather than targeted.
  Targeting could not have resolved them: a claim covers errors only (a warning
  or an info has no in-place note to live in), so a targeted retry warning would
  still be toasted, merely with a name in front. The untargeted copy also only
  ever reached that session's own viewers — the people already looking at the
  row that says it.

## Enforcement

The app status slot and the toast viewport are one component each, named for the
slot rather than the visual; a second renderer of either is the drift this is
written to prevent. The other two in-app channels are vocabularies rather than
single components — `ui/load.tsx` owns the in-place one under
`loading-states.md`'s audit, and the inbox/session model owns object state — so
what is enforced there is that nothing outside them invents a third. The audit
this document adds fails on a new full-width tinted row anywhere but the app
status slot. The rule that is only written down is the rule that drifts back.
