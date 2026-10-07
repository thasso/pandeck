# UI Shell Concept

Binding concept for the app shell: layout, navigation, and object linking in
`app/web`. Changes to the shell, sidebar, routing, or page composition must
follow it. Wider exploration material lives in `docs/` on the `app-shell`
branch; where it conflicts, this document wins.

## Core Question

> What am I working on, in what context, with which agent, using which
> resources?

The app is one connected work graph, not a bundle of mini-apps. Sessions, tasks,
projects, and future object types are different views into the same graph. A
user may start from any object; the UI makes the current object clear, shows
what it is connected to, and makes it easy to continue from there.

## Objects

The shell is built around first-class object types (e.g. session, task, project,
worktree, Knowledge Base file). Objects reference each other; each object type
defines which references it carries (e.g. a session may reference a task, a
project, and the worktree it executes in).

Every object type has exactly one **canonical sidebar location**. Adding an
object type means a new primary section, a browser shape, a main-pane view, and
related-object rows — never a shell rewrite.

## Shell Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ App header (wide layouts only): history arrows, panel toggles│
├───────────────┬───────────────────────────┬──────────────────┤
│ Left sidebar  │ Main pane                 │ Right sidebar    │
│               │                           │                  │
│ Object browser│ Current object/view       │ Inspector        │
│ Primary nav   │                           │ Context/actions  │
└───────────────┴───────────────────────────┴──────────────────┘

Left sidebar:  Where am I browsing?
Main pane:     What am I looking at?
Right sidebar: What is this connected to, and what can I do next?
```

Shell layout state is scoped to the browser tab through `sessionStorage`: left
and right panel openness, the selected left-sidebar section, and desktop
right-panel tabs survive reloads without leaking into another tab.

The main pane renders exactly one current object or view. The right sidebar is
the **object panel** for the main-pane object, never a second navigation tree.
It is a single **Details** inspector — summary, related objects, and
object-aware actions — with no embedded chat: agent work always happens in a
real session. The panel's open/closed state is pure user state at every size —
unlike the left sidebar, whose visibility becomes route-driven on small screens
(see Small Screens): navigation never opens or closes the object panel, and it
is never disabled — for a surface with nothing to inspect it is at most empty.
On small screens it presents as the bottom object dock rather than a side pane,
and its **Actions** are the object's single action home there: what a wide
layout shows in the main pane's header row belongs in the dock on a phone.

## Layers

Anything portaled to `document.body` — modal surfaces, toasts, popovers — lands
in the root stacking context as a SIBLING of every other portaled thing, so its
z-index is the whole of its ordering: being opened FROM a modal buys a panel
nothing. The scale is therefore fixed, and a new floating surface picks the band
it belongs to rather than a number that looks free:

| Band  | What sits there                                                                      |
| ----- | ------------------------------------------------------------------------------------ |
| ≤ 40  | In-page chrome inside the shell's own stacking contexts (dock, rows)                 |
| 50    | Shell panel overlays, in-flow tooltips and non-portaled panels                       |
| 60    | Toasts (`ToastViewport`)                                                             |
| 66–70 | Modal surfaces: the bottom card in overlay position, sheets, dialogs                 |
| 80    | Portaled `Popover` panels — above the modal layer, on purpose                        |
| 90    | A confirmation raised OVER any of them (`ui/dialog.tsx`, `raised`)                   |
| 100   | Full-screen takeovers and dev overlays (login terminal, shortcuts, the image viewer) |

Comment actuation is shell furniture, never a floating bar over content. A
commentable surface publishes its affordances without giving the shell its
anchors, threads, or transport: wide layouts render **Add comment** and any
pending **Submit review** in the page header; small layouts render them in the
object dock's action row and the sheet's **Actions** list. Add comment stays
visible but disabled until the surface owns a selection or named structural
target, with “Select text to comment” naming the enabling gesture.

Until every bottom-edge surface has migrated into shell furniture, the shell
keeps `--app-bottom-chrome-inset` equal to the resting bottom card plus the safe
area inset, or only the safe area when there is no card. The chat and Knowledge
portal composers position themselves against that inset so they do not cover
existing bottom chrome.

The 80 band is the load-bearing one: a picker inside a dialog would otherwise
open behind the dialog's own backdrop, where it is invisible and swallows the
click that should have chosen an option. That failure is silent — the popover
state opens and closes exactly as designed — so keep panels at 80 and keep
modals at 70 rather than raising a single surface past its neighbours. The 90
band is the exception the rule needs: a confirmation is asked FROM a menu, sheet
or dialog and has to be answerable over it. It is reserved for `ConfirmDialog`
with `raised`, which hosts no picker of its own.

## Asking the user

Confirmations, destructive guards and rename prompts are the app's own DOM, from
`components/ui/dialog.tsx` — never `window.confirm`/`alert`/`prompt`, which the
Tauri shell's WKWebView silently drops, turning the guarded action into a dead
control (`nativeDialogAudit.test.ts` enforces this). A handler that asks and
then acts awaits `useDialogs().confirm` / `.promptText`; a flow that owns its
own open/busy/error state (the worktree clean and removal guards) renders
`ConfirmDialog` directly. Both are the same surface, so a confirmation looks and
behaves the same wherever it is raised: Escape, the backdrop and Cancel all
answer no, Enter answers yes, and the keys it consumes never reach the app-wide
shortcut dispatcher behind it.

## App Header Bar

Wide layouts only, and window chrome rather than page content: the history
arrows lead it, the theme switch and the two panel toggles trail it, and nothing
route-, session- or workflow-specific belongs in it (that is what the local page
header, session header, composer and dock are for). It survives on wide layouts
because a closed sidebar cannot host the control that reopens it.

The history arrows are the one navigation control in the app that retraces steps
rather than addressing a place, which is why they are here and not among the nav
bar's slots — and why they are the only thing that may call `history.back()`,
unlike the surfaces' own Back, which targets the selected section's index route.
They disable at the ends of the app's own history: the app counts the entries it
created (`lib/historyNav.ts`), because the platform answers no question about
history's shape, and back must stop at the app's first entry rather than walking
out of it.

In the native shell this bar IS the window's title bar rather than a row under
one, which is why the shell costs no extra chrome height. That makes it drag the
window, and makes its leading edge reserve the window controls' width.

## Left Sidebar: Object Browser + Primary Navigation

The left sidebar has two zones:

- **Object browser** (top, taking all remaining height) answers "which object in
  that space?" — it shows the selected section's content in a shape that section
  defines (flat list, grouped list, tree, settings list, …). It is never a
  global mega-tree. A section's browser may include bounded, directly-related
  child rows when that relationship is part of the section's canonical browse
  shape (for example Project → Worktree → recent Sessions), but it should not
  become a cross-object catch-all tree.
- **Primary navigation** (a compact icon bar pinned to the bottom) answers
  "which kind of space am I in?" — one slot per section, work sections and the
  Settings system area in one flat user-defined order, plus the app-level
  **actions** (below). The browser is what the user reads and scrolls, so it
  gets the height; the bar sits at the bottom where it is thumb-reachable on a
  phone.

The nav bar carries **no counts, badges, or dots**: they add no decision value
here, and uniform slot widths are what make the overflow fold exact. The active
section renders as an icon + label pill, every other slot is icon-only, and
whatever does not fit at the bar's current width folds away. The bar measures
itself, so a resizable desktop panel and a full-width mobile browser screen
share one presentation; the active section is never folded away. Slot order is a
browser-local user preference edited in Settings → Appearance.

Where the folded slots live differs by viewport, and only there. A wide layout
puts them behind a trailing **More** popover. A phone has no More control at
all: the bar is the header of the same bottom card the object dock uses, so
dragging it up (or tapping its grabber) reveals them with full labels. One card,
one gesture, one set of chrome at the bottom edge of every phone screen — a
modal sheet with a title row and a close button for "the rest of the navigation"
was the odd one out.

App-level actions (New Session, Personal Assistant, Usage, Background) are NOT
sections, but they ARE navigation, so they share the nav bar as ordinary slots:
same width, same treatment, one user-defined order over both kinds. A surface
qualifies as an action, not a section, when it opens exactly one page with
nothing to browse alongside it — Usage is one page stacking every provider, so
it needs no browser. An action just navigates and leaves the selected section
alone; on small screens the object screen it opens replaces the browser.

They used to sit in the app header instead, to stay reachable without opening
the sidebar. That cost the whole header, and a header is the worst real estate
on a phone: one tap is now sometimes two (from an object screen, back first),
which is the price of having no app chrome at the top at all. Because the bar
folds what folds, which actions stay one tap away is a user decision rather than
a design one — and a slot the user has never seen lands at its default position
rather than at the end, so a new action is not born behind More.

Settings as a primary section shows its configuration pages in labeled groups in
the object browser, with the most frequently oriented surfaces first. Model
configuration and provider account setup share a Models & providers group, but
each provider keeps its own page rather than mixing account types in one form. A
section whose mapping is still unclear may ship with a minimal or empty browser
until the shape is decided. A section only one client can act on (Port
forwarding, the macOS shell) stays routable everywhere and renders a page that
says what it needs, but is listed only where it works (`shownWhen`). A settings
section that reads a domain list subscribes only while the main pane RENDERS it
— the browser listing its entry reads nothing — because for the skills library a
subscribe is what makes the server rescan the user's working tree.

Tasks use one server-authoritative Backlog projection across the sidebar and
full-page browser. A `tasks` topic subscription replaces browser-local cached
Task data, and mutation broadcasts update every subscribed tab/PWA instance. The
staged-session routes (`/sessions/create` and the `/sessions` empty draft) do
not subscribe merely because they exist: the create route's visible quick start
needs projects and worktrees, while either route subscribes to Tasks only for
the interval in which the staged-context Task field is expanded. A visible Tasks
sidebar still subscribes independently.

Every Backlog surface states its own row DENSITY, and it is the host's decision
rather than a breakpoint: the desktop sidebar rail and the composer's task
picker are `tight` (one line, hover for what the row cannot hold), while the
Backlog and Project pages — and the same sidebar when it is a phone SCREEN — are
`comfortable` (two lines, thumb-sized secondary controls). Width and pointer
coarseness are independent, and the mobile browser is where they disagree.

The Sessions browser takes the same decision from the same host
(`lib/rowDensity.ts`, one type for both browsers): its cards and shelf rows are
`tight` on the desktop rail and `comfortable` when the sidebar is a phone
SCREEN. The phone grows the card's inline controls to 32px and keeps
thumb-height shelf rows. Expanded peer rows are the deliberate exception: they
remain compact one-line rows at 32px because the parent card owns the fold and
stacking another set of card-sized rows obscures that hierarchy. Density is a
prop the host passes down, never a breakpoint a row reads for itself.

The Sessions browser is headed by a STABLE bar, and stability is its whole
contract: three counts — waiting on you, running a turn, background processes —
always rendered, at a constant size, dimming to zero rather than unmounting. It
is sticky, so the sidebar's shared scroll cannot carry it away, and it owns the
panel's top EDGE: the sidebar drops its top inset for a section whose browser
draws a header bar, because a sticky box cannot claim an edge that padding has
taken (Chromium clamps `top: 0` to the scroll container's content box), and the
inset would otherwise be a strip for rows to scroll through above a pinned bar.
Nothing else above the cards may come and go: the background-work line that used
to live there appeared and vanished with work no user action started, which
shoved the whole list — and, in a scrolling container, the reading position with
it. The counts are not announcements (`docs/messaging.md`) and carry no live
region; they state what this browser already holds. Each is a GLYPH plus a
number, with the words as the accessible name, because the sidebar is a rail
resizable down to 220px and the type scale is a user preference — a phone, where
the browser is a full-width screen, has more room than the desktop rail, not
less. A count with a destination is a button: waiting-on-you moves to the first
such row, and background opens `/background-tasks`. The **Needs you** block
keeps its label and gives up its count to the bar, which states it whether or
not the block exists. The **Settled** and **Archived** shelves carry no count
either: the size of the history is not a decision, and the open shelf's own
paging says how much more there is. There is no session search: finding a
session by title is the shelves' job, and the field cost a permanent row of
chrome for it.

Sessions **Settle** is an ACKNOWLEDGEMENT of an outcome, not a visibility flag
that activity resets. A user-facing run on a directly owned session raises a
durable attention revision when it COMPLETES or FAILS, and at nothing else: not
when a turn starts or streams, not on tool activity, and not when the transcript
is read or routed to. A successful coordinator turn driven by a peer report is
intermediate while another explicitly requested peer reply remains outstanding.
It raises no revision and clears only the unread state that turn introduced; an
older unread item remains unread. The final expected report, a direct human turn
and a coordinator failure are user-facing outcomes. The cursor and the visible
badge have different jobs. An unread successful response is in the attention
tier with **Done**. Once the session has been open for the three-second read
dwell, it becomes a quiet **Idle** card in the active tier. Every card keeps
three stable rows. The first holds the objects it hangs off, with the time at
its right edge (a running session's time is how long the run has taken). The
second is the title, led by one fixed slot: the session's type icon while it is
Idle, otherwise the state's badge as an icon. The third holds what the work
produced and what is moving — the pull request with its number, else the
worktree's uncommitted lines and commits ahead of base; background work; a
cluster's peers — with the actions flip and Settle at its right edge. A row
shows each item whole or drops it; only the branch shortens, into the width the
others leave. The state's sentence — a failure message, "Unread response" — is
part of the card's spoken label, not a visible line: the badge already says it.
So is everything a row drops for lack of room; a control on a row's hidden
overflow line is made `inert`, so keyboard focus never lands on what is not
shown. Queued work is the one sentence still shown, beside an Idle card's empty
slot. The expanded peer rows show type icon, state icon, title, its running
background jobs, its own peers' count when it coordinates any, and time, with
Idle as a neutral badge. The card's first and third rows are as tall as the
inline actions take in that density (20px on the rail, 28px on a phone), so the
title sits centred between them and no action's touch target reaches into the
title row (`CARD_OUTER_ROW`). The card stays in the working set until Settle
acknowledges the cursor; its presence there already states that it is unsettled.
Every object is opened from exactly one target: Project from its front text
item, Worktree and Task from the back action face. Their front metadata remains
context, not a duplicate target. A latest failed outcome stays visibly
**Failed** after reading, even if a later run start cleared its error record.

A settled session runs its next turn from the Settled shelf and comes back when
that turn produces a user-facing result. Reading it here or in another tab
changes only its unread presentation and acknowledges no outcome. Settle
acknowledges the revision the CLICKED row carried, so an outcome that landed
between the render and the click stays visible instead of being hidden by a
stale click. Only a human-decision blocker overrides the shelf, a question, an
approval, or a pull request waiting for a Task choice, because work that cannot
proceed without an answer must never be collapsed away. A coordinator-owned
spawned child raises no top-level attention of its own: its result belongs to
the run above it.

A coordinator and the peers it still owns are ONE Sessions inbox item
([Task-675](pa://task/675)). Grouping reads the durable spawn edge and its
ownership, and nothing else — never a title or a role word: a peer folds while
its ownership is `coordinator` and its spawner is present, unarchived and
matched by the current filter, so a `taken-over` peer, an `unknown` one, and one
whose spawner is gone each stay a card of their own. Depth is unbounded: the top
level is for the sessions the user drives, so every peer a coordinator still
owns folds under it however deep the chain runs. A cycle guard breaks a looping
chain at a deterministic root, so every session still belongs to exactly one
item. The card states the coordinator's own status plus a compact session count
over every depth and renders no peer as a card of its own; this is not
`delegation`, which counts subagent runs and is untouched. The disclosure itself
states what the tree is doing right now — agents running a turn and background
jobs, each an icon and a number counted over every peer — because a coordinator
that has gone quiet under its peers has no provider state of its own, and "an
agent is busy" and "a job is still going" are different answers to whether to
wait. Jobs count only work somebody waits on: an item its agent declared a
service (a dev server, a watcher; `background_tasks` `set_intent`) is said
apart, as services, in the aggregate, and neither spins the fold nor puts its
session in the working tier — it is running, but no reason to wait. They sit
inside the disclosure because it is the line's first item and never wraps out of
sight; on a narrow card its word "sessions" drops like every label on the line.
A spinner replaces the peer glyph while any peer is working, and a named
Answer/Approve/Pick task/Failed badge, capped so a long title truncates inside
it, carries the peer that needs the user. The complete
running/jobs/waiting/failed aggregate stays in the card's accessible name and
the disclosure's tooltip.

A quiet card answers the last question too — finished, or waiting for a poke.
Every session row lists the peers that still owe it a reply
(`awaitingRepliesFrom`): it asked (`responseRequested`), their turn ended
without the answer, and nothing from them — nor from a peer they handed the work
to since, on that handoff's chain — has reached it since. A request still being
delivered or retried is not owed yet; one whose reply was cancelled or failed
before it arrived still is. When a card's tree — the session and every peer
folded under it — is owed a reply but nothing in it, nor any peer owing one, is
moving (no turn, queued work — a reply still being delivered or retried counts —
working subagent run, background job it waits on, or a retained host not kept up
by services alone) or waiting on the user, the tree is STALLED: the card carries
a warning chip, **No reply from «peer»** (`+N` when several owe, kept apart from
the title so it never truncates), that opens that peer, says so in the card's
spoken label, and rises to the attention tier. When the one owed the reply is
the card's own session — a peer asked its coordinator, which went quiet — the
chip names the peer that waits instead, **«peer» awaits a reply**, and opens it.
It is judged over the whole tree, not request by request, because a coordinator
often routes an implementer's report to a reviewer instead of to itself; while
anything in the tree works, an open request is work in progress, not a stall. A
peer that is archived, settled or gone owes nothing here — the user put it down;
a peer the user took over still owes until it answers or is settled. A forwarded
report on another chain than its handoff (the user prompted the forwarding peer
in between, closing its chains), a forward of two or more hops, or a peer
released with a plain message stays owed until that peer is settled or the
request expires (30 days). The other way round, a peer that asked a sibling
something on their shared chain is cleared by that sibling's own report, as if
it had handed the work on. The composer ledge says the same for the chat on
screen, judged over the tree that chat's card would fold — for a chat deep in a
tree, its own subtree, so a coordinator still working above it does not hide its
line though the top card shows no chip — a peer the user took over or a run's
role is not this chat's work — and a chat that spawned no one but asked an
existing session for a reply shows that line alone. A settled tree is on the
shelf and raises nothing; one kept up by an unsettled peer still shows its chip.
Workflow Run role sessions are the run's item and raise no chip of their own. A
card with no chip and nothing moving is done.

What the fold may never hide is the work that needs a human. A folded peer
asking, awaiting approval, waiting on a Task choice or holding an unresolved
failure LIFTS the whole cluster to that tier, is named on the card, and opens
from it in one action — and it keeps the cluster in the working set even when
the coordinator itself is settled, so a settled coordinator can never bury a
peer's question or failure. A failure here is the FAILED BADGE. A later run
start may clear the failure's message, but the unacknowledged failed outcome
keeps the session classified as `failed`, so the cluster still counts and
bubbles it. More generally, a settled coordinator with an UNSETTLED peer folded
anywhere under it stays a card in the working set, because work the user has not
put down may never be folded into a row that is; otherwise it and every session
folded under it take the shelf, each as its own shelf row, so none of them
leaves the shelf while a peer runs. A settled peer merely running again does not
bring it back: it runs from the shelf raising no outcome, exactly as the
coordinator's own next turn does, so the card does not come and go with every
peer turn. The coordinator's composer ledge still shows that run. The same rule
holds inside the tree: a settled peer folds only while live work hangs below it,
so a live peer it spawned stays under the coordinator above instead of surfacing
as a card of its own. A settled peer its coordinator sets going again — a turn,
or background jobs — is live work itself: it runs from the shelf raising no
outcome, so it folds, counts under running (a turn), jobs (background work it
waits on) or services, refuses the coordinator's Settle in its own wording like
any busy peer, and returns to history when it goes quiet
(`isDormantInSpawnTree`). A settled session kept up that way shows no failure:
the server withholds `settledAt` from a row whose latest outcome is open, so a
shelved row's stored error is one the user already acknowledged, and it neither
counts nor bubbles. Settled peers are otherwise history: out of the counts, the
Settle cascade and the tree.

Settle on a session settles it AND the peers it still coordinates, in one
command: its own `session:<id>` outcome revision is acknowledged through the
revision the clicked row carried, and the server settles every folded peer
through its current outcome revision, the server-side privilege the user's
acknowledgement of the coordinator grants. Membership is the shared spawn forest
(`spawnClusterForest` over `spawnClusterMembers`: the unarchived rows no
working-set Workflow Run owns, folded along `coordinator`-owned edges with the
same cycle break the browser draws), so what a card shows folded is exactly what
its Settle shelves — on the card, on a folded peer's own row in the disclosure,
and in the Session inspector, which all read the same `sessionSettleCascade`.
The browser shelves those peers optimistically with it, so none of them surfaces
as a card of its own in the gap before the authoritative list lands. The
mutation is all-or-nothing, in one store transaction: a peer the shared session
predicate still blocks — waiting on a human, still running, queued — blocks the
Settle in that peer's own wording, read in forest order so the disabled button
and the server's refusal name the same peer, because a coordinator put down
while a peer stayed up would have that peer resurface as a card of its own. A
peer's FAILURE never blocks it: acknowledging that is what the Settle is for.
Unsettling brings back the one session alone.

A shelved coordinator-owned peer raises no outcome attention of its own, so it
comes back in exactly one way: a later FAILURE unsettles it (server-side, with
no revision), and the fold bubbles it under its coordinator again — a settled
coordinator included — so a failure can never stay buried on the shelf. A later
completion leaves it there: that result is the coordinator's to act on, and the
coordinator's own outcome is what brings the cluster back. The settled
coordinator rule above is therefore for a peer that came back on its own, or was
spawned after the coordinator was put down.

A bubbled FAILURE is also dismissible from the card itself, which is where the
user meets it: dismissing sends that peer's own Settle alone, so the peer lands
on the Settled shelf and the bubble goes with it while the coordinator stays in
the working set — nothing is archived and nothing is deleted. It is offered
exactly while that peer's own settle would succeed, on the shared predicate
every settle surface answers. A peer waiting on a HUMAN is never dismissible:
settling it is refused by the same rule, because the work cannot proceed without
the answer, so that bubble is dealt with by opening it.

The card's DISCLOSURE is the one way a folded peer is listed, and it lists every
one of them as a TREE: each peer directly under the session that spawned it,
indented by its depth, siblings in inbox order. A peer that coordinates peers of
its own shows their count, and any peer running background jobs shows how many.
The button states what the click will do, and closing it returns to the
cluster's single row. Listed that way, folded peers are ordinary rows of the
browser: focusable, swipeable, and openable. When the coordinator's tree also
holds settled peers, the open fold ends in a "Show N settled" row that puts them
back in the tree where they were spawned, after their live siblings; they stay
on the Settled shelf (listed here under a prefixed row id, so the two rows never
share one), offer no Settle, and count for nothing on the card. No other settled
session listed in the tree offers a Settle either — a bridge kept by live work
below it, a settled peer running again, or a settled role of a Workflow Run: it
is already down, and the coordinator's (or the run's) own Settle is the one that
reaches it. Those live rows still count on the card, though: in its total, and
under running or jobs while they are busy. A session whose peers are ALL settled
has no fold at all: the card is about live work, and that history is on the
Settled shelf and in the session's own composer ledge.

A formal **Workflow Run** is one Sessions inbox item too
([Task-676](pa://task/676)). Every live run — active or paused — is a card of
its own, and its role sessions are not: a paused run appears under **Needs you**
with the actionable reason it stopped for, an active run sits in the working
list with its phase and next action, and both state their own sessions in one
disclosure ("3 sessions") instead of spending a card on the coordinator, the
implementer, each review pass, the fixer and the verdict. The card has the
session card's three rows and rules: Project, branch and Task with the time; the
Task title led by the Workflow icon while the run is simply moving, else by the
run's state badge; then the disclosure, a role that needs you, the pull request
(from the role session that owns its card) and the phase, with Settle at the
right edge. The pause reason and next action are the card's spoken label. The
item is named by the TASK the run works on, since a run has no title of its own;
the Task's title is a best-effort join on the Backlog rows this tab already
holds, so a browser that has none shows the id and the run is still complete. A
visible Sessions browser therefore holds the `workflow` topic — and only that
one.

Membership is STRUCTURAL: the ids on the run's recipe card projection, and
nothing else. No rule here parses a session's title or looks for a role-like
word, so a run cannot suppress a session it does not own. The corollary is the
safety property: a run whose projection is absent or unsupported folds nothing —
it is still shown from its summary, and every one of its sessions keeps the card
it always had.

The run's ENDING is the thing the user acknowledges ([Task-677](pa://task/677)),
so the item crosses the terminal boundary instead of vanishing at exactly the
moment its outcome matters. A run carries a durable attention cursor with the
same shape and rules as a session's: a revision raised only by a MEANINGFUL
event — reaching a pause or gate (a failure pauses the run with its reason),
completing, or being cancelled — and never by a run or step starting, by tool or
agent progress, or by viewing the run or any of its sessions in any tab. A run
that completed, failed or was cancelled stays ONE item under **Needs you** while
that revision is unacknowledged, stating its outcome (Merged, Completed or
Cancelled), its reason where it has one, and its Task, and opening the same
`/tasks/:taskId#workflow-run-:runId`; its role sessions stay folded under it,
whatever pending outcomes of their own they hold, because the server keeps
shipping the card projection for a terminal run until it is settled. A
historical terminal run from before the cursor existed carries none and is never
resurrected.

Settle is the ONE verb the run item carries, and it is offered exactly while
there is an event to acknowledge. It sends the revision the CLICKED item
rendered, captured at the click rather than read when the command is finally
sent after the exit animation, so a stale click cannot acknowledge an outcome
that arrived after the render — the item stays awake, optimistically and
authoritatively alike. Settling the run also settles the role sessions it
structurally owns, server-side and through their current outcome revisions, in
the same mutation: the run is the attention owner, its roles are evidence, and
no per-session Settle is required afterwards. The mutation is all-or-nothing. A
run whose current gate is an unresolved user decision — a ceiling decision, a
merge decision — cannot be settled, and neither can one whose cancellation is
still in flight; the item's Settle is disabled with the shared refusal wording,
the same fragment the server refuses the command with. A role session the shared
session predicate still blocks — waiting on a human, still running, queued —
blocks it too, in that session's own wording, because a run acknowledged while
one of its roles stayed up would clear the item and have that role resurface as
a card of its own. A role's failure never blocks it: acknowledging that is what
the Settle is for. Settlement is broadcast to every subscribed client, so a
Settle on the phone clears the item on the laptop, and the session list is
flushed BEFORE the run list so no tab sees the settled run while its roles are
still unsettled.

Settle is not the only way a run leaves the item list. Cleaning up a completed
run's checkout — the control on its Workflow card — retires the worktree,
settles every session on it, and then settles the RUN, because that click is the
last step of the delivery the item is waiting on: leaving it to be acknowledged
separately would send the user to the inbox for a click with nothing behind it.
Nothing else settles a run on its own: a cleanup run from the live PR card
retires the checkout only, and so does one run by a role session of the run
itself — that session is mid-turn and cannot acknowledge the run it belongs to.
In both cases the item stays for its own Settle.

Once settled, the run and its sessions are released to what they would be on
their own: the sessions become ordinary rows (settled, on the shelf, until their
own next outcome), and the run leaves the working set until a newer event raises
its revision — for a terminal run, never. A paused run behaves the same way:
settling a failure pause parks the run on its Task, where Retry and Resume are,
and resuming it makes it a live item again without waking it. An active run is
always an item while it works, and offers no Settle unless it still carries an
unacknowledged event.

What the run may never hide is the work that needs a human, so the two rules the
clusters have hold here too: a role session asking, awaiting approval, waiting
on a Task choice or holding an unresolved failure LIFTS the run's item to that
tier and is named on it as a target of its own, and a query that matches a
folded role session lists that session's row under the run — as does the item's
own disclosure, which lists all of them. Those rows are ordinary rows of the
browser: focusable, swipeable, and openable. Beyond Settle, a run carries no
archive, delete or run control of its own: those are on the Workflow card on its
Task, which is where its evidence is, and where selecting the item lands.

The two kinds of item are ordered in ONE list by the same rule — attention tier,
then when each last moved — because a run is the coarser unit of the same
attention, not a more important one. A run's own sessions are folded out of the
Settled shelf as well, since a session put down inside a live run belongs to the
run rather than to a shelf the user cannot see it from.

One Workflow Run is addressed as `/tasks/:taskId#workflow-run-:runId`: it
belongs to its Task, so it is a FRAGMENT, exactly as one message of a session is
(`/sessions/:id#m-<entryId>`). The Task page gives each Workflow card that
fragment as its id, and jumps to it once the run has actually arrived — both the
Task row and the run list load asynchronously, and native fragment scrolling
resolves once against a page that does not have the element yet. The jump
scrolls the card into view and focuses it, once per address, honouring reduced
motion.

## Pull Requests

The **Pull Requests** section replaced **Worktrees** in the navigation bar, and
the replacement is the point: a branch on disk was never the unit of work
waiting on a human. The pull request is, and the checkout is one of the things
it is joined to. Worktrees did not lose a home — they are browsed on their
Project page, which is where a project is the subject, and `/worktrees/:id` is
unchanged. There is no `/worktrees` index any more, and a stored `worktrees` nav
slot MIGRATES to `pull-requests` in place, so a user who arranged their bar
keeps the position rather than finding the replacement at its default one.

The browser lists what wants something from you, never a repository's whole open
list (that is the Project page), in three groups in this order:

1. **Needs your review** — your review was requested. It leads because somebody
   else is blocked on it, and a review request outranks your own authorship on
   the same pull request.
2. **Yours** — the ones you opened, with drafts marked rather than hidden.
3. **Needs cleanup** — merged or closed, with a local worktree still holding the
   head branch. The checkout is what is left to deal with, and it is what keeps
   a finished pull request visible until it is gone.

Within a group the most recently updated is first, an unknown `updatedAt` sorts
LAST rather than first, and the tie-break is the row's identity — project,
provider, repository and number — which makes the order total, so a poll that
changed nothing cannot reshuffle the list. That identity is the row id, the
selection comparison and the ROUTE alike: a number alone names nothing, since
every repository has a #1 and one project can hold two repositories (a spawned
worktree publishing to a `pushurl` fork). Addressing on project and number would
give two rows one URL, highlight both, and open whichever came first.

A row states `#number`, the title, the project chip, the head branch, a draft
marker, a marker when a local worktree holds the branch, and two glyphs for CI
and review. The whole vocabulary distinguishes UNKNOWN from a negative answer,
because absence on the wire means the provider was not reached: an unread CI
reads as unknown, never as passing, and an unread review as unknown, never as
agreement. Threads are only counted when the provider actually counted them.

One pull request opens at
`/pull-requests/:projectId/:provider/:repositoryKey/:number` — the detail page.
The repository key (`owner/repo`) is ONE percent-encoded segment, because it is
a single opaque identifier rather than two path components, and a provider this
build does not have is rejected rather than parsed. It states the provider's
answer (checks, review, mergeability, the exact head) and the local objects the
pull request is joined to: the worktree with its dirt and drift and a link into
its changes, the sessions, the linked Tasks. A `mergeable: null` is the provider
still computing and says so; it is never rendered as a conflict.

The joins keep four answers apart, because the ids are authoritative and the
lists that resolve them are not. No ids is the only "none" the page may claim —
the inventory said so. A resolved id renders even from a stale list. An
unresolved id whose list is cold, stale or failed reserves its row. Only against
a FRESH list is one stated as absent (an archived session or Task), since
nothing is still coming for it.

The section polls ONE inventory while it is visible (`GET /api/pull-requests`,
~60s), and the detail page reads that same projection rather than fetching for
itself: two reads would double the provider traffic and let the list and the
page disagree about the same pull request.

The pull request's ACTS are the object panel's, in the one Actions list every
object type has (Object panel below; `docs/pull-requests.md` owns each contract,
including the endpoints and the shared seams): on a wide layout the page
header's `…` menu, on a phone the object dock. In order: **Start session in
worktree**, **Review in a session**, **Create worktree** (**Update worktree**
once one exists), **Merge & clean up…** (**Clean up…** for a terminal pull
request), and **Open on GitHub/Forgejo**. The page itself draws no action bar
and no link out: it states what the provider says and what the pull request is
joined to, and stays the surface those acts change.

Start session in worktree is the primary action — the one the wide header and
the dock's action row draw in the primary slot — but only once a local worktree
holds the head branch. Without one the slot is empty and the panel lists the
action DISABLED, with creating the worktree as its reason: the session is the
reason to create the worktree, and hiding it would hide the reason. Create
worktree is that checkout alone (`POST /api/pull-requests/checkout`, the same
convergent create-or-update Review performs); the inventory is refetched so the
page's local join shows the checkout, and the toast that reports what the
checkout did carries **Start session** as its action.

Nothing that cannot do what it says is offered: a terminal pull request whose
checkout is gone has neither a merge nor a cleanup, and Review and Create
worktree exist only while the pull request is OPEN, since a merged one has
normally had its head branch deleted and the only possible answer would be that
it is gone. A merge the pull request itself blocks (draft, a KNOWN conflict,
unreadable capabilities) is disabled with its reason, and because a disabled
row's tooltip reaches neither a keyboard nor a phone the page's Status block
states the same sentence as TEXT. The merge confirmation is one
`components/ui/dialog.tsx` dialog listing every consequence with a per-item
opt-out and the sentence under each control describing what THIS click will do;
it is owned by the panel, which the app keys by the pull request so no
consent-bearing refusal survives into another one. Each action busies only its
own row (R5). A failure from the merge dialog stays in the dialog, which holds
the retry; a checkout's refusal — dirty, diverged, a head on a fork — has no
durable inline home, because the row that asked is a menu entry (closed on a
wide layout the moment it was chosen; a button, not a failure surface, in the
dock), so it travels as a toast NAMING the pull request (the same rule the
worktree panel's delivery rows follow). Success is silent unless the pull
request left the inventory with its checkout — then the sanctioned toast names
it. Every attempt refetches the inventory rather than patching the list in
place.

**Review** is one row for the whole start of a review: the server creates or
updates the local checkout of the pull request's head branch, and the app then
NAVIGATES to the staged new-session composer with the project, that worktree and
the linked Task attached and a review prompt PREFILLED — never sent. It is the
same staging path as the worktree comment review and the `/review` handoff
(staged context plus an editable composer draft), not a second one, so runtime,
persona and the text itself stay the user's. Success is silent because the
navigation IS the confirmation; a refusal is the toast above and the row stays
the retry, since the act converges (a checkout that was created is found by the
next attempt and merely brought up to date). An answer that lands after its
panel is gone neither navigates nor vanishes: it becomes the sanctioned toast
naming the pull request, with the hand-off as its action.

## Navigation Rules

The left sidebar and main pane are decoupled: the selected section is UI state,
not a function of the route.

1. Clicking a browser item updates both sidebar selection and main pane.
2. Clicking a link in content or inspector updates the main pane and
   **preserves** sidebar section and scroll state.
3. Opening a deep link with no prior sidebar state shows the object's canonical
   sidebar location.

Scroll state in rule 2 is a promise about the READER, not about the DOM: a
browser is remembered per section and restored when it comes back, wherever it
went in between. It has to be, because a phone unmounts the whole browser the
moment an object screen opens (see Small Screens) and the section's own list
also arrives after its container does. What is restored is the row the reader
left at the top edge, not a pixel offset — these lists re-sort under them.

Routes identify objects, not sidebar state: one canonical route shape per object
type (`/sessions/:id`, `/tasks/:id`, `/worktrees/:id`, …) plus section index
routes such as `/knowledge`. The singleton Personal Assistant has the dedicated
`/assistant` route so its empty first-use state is not mistaken for the ordinary
`/sessions/create` draft surface. No legacy aliases.

Document routes share one navigation shell around source-specific renderers
(`docs/document-presentation.md`). `/files/<absolute path>` addresses a live
host file and `/artifacts/<session>/<path>` addresses captured session output.
Knowledge Base and worktree files keep their canonical `/knowledge/files` and
`/worktrees/:id/files` routes. A host-file route has no sidebar location or
index because there is no useful list of every file on the host. Worktree routes
carry the worktree id; an absolute filesystem path never supplies it.

`/background-tasks` is the canonical registry of session-owned background work,
an ACTION surface with no sidebar location; `?task=<id>` anchors one item by its
PA id, which is what an agent's link hands back to you. An anchored row is
PINNED past the page cutoff and scrolled to once the data arrives, and it
overrides the list's remembered reading position: a deep link is a promise that
the row it names is on the page it opens, and a target that is merely not
rendered is a harder break than one that is not scrolled to. Background work is
not a provider turn, so it is never merged into `/subagents` and never sets a
session's run state: a session card shows it as its own chip, and the owning
session's inspector shows it as its own section. Both, and the registry route,
are the only surfaces that hold the `background` topic — the session list states
the global count in its bar and per-session activity on the row, both derived
from the session summaries it already has.

A part of an object is addressed by a URL FRAGMENT, never by another route
shape: `/sessions/:id#m-<entryId>` names one message of a session, by our own
durable log entry id. The fragment is the address — it survives a reload and a
share, and back/forward pass through it — but never the mechanism: the
transcript is a windowed suffix that owns its own scroll position, so arriving
at one asks the server where the entry sits (`resolveTimelineAnchor`), loads
back to it, and only then scrolls. Landing in the right session at the wrong
place is a broken link, so a jump that cannot load its target says so instead of
quietly stopping at the tail.

## Object panel: Details

**Details** is the whole object panel — the inspector. On wide layouts it opens
as the **Inspector** tab in the right-panel tab bar, whose `+` opens the panel
home and whose tabs are closeable. A tab's surface is built when it is first
SEEN — the active tab of an OPEN panel — not when it is merely open: a panel
draws an object, so it fetches and subscribes on mount, and tabs are restored
from `sessionStorage`, including with the right panel shut. Once shown it stays
mounted behind whatever is in front of it and while the panel is closed, which
is what makes a tab switch free. The Inspector is the one exception in both
directions: it publishes the page header's overflow actions rather than only
drawing, so it is mounted whenever its tab is open. Closing every tab leaves the
panel open on a centered list of available panels; **Personal Assistant** is the
second panel and opens an independent view of the server-owned permanent
conversation, so it can remain beside the routed main-session chat.
**Knowledge** is the third (offered only while the Knowledge Base is on in
Settings, as is the sidebar section): the Knowledge Base folder as the SAME
Files and Review page the `/knowledge` route draws — file tree,
File/Preview/History, uncommitted changes — in a narrow column. Moving inside it
is panel state, like the Worktree panel below, and its one action hands the file
or view it is on to the main pane. A panel surface is opened from elsewhere by
request: `kb_show`'s transcript card opens its file here. **Worktree** is the
fourth, and it is the only panel that addresses no object of its own: it follows
the OPEN SESSION to the worktree that session executes in, drawing the same
Review and Files page the `/worktrees/:id` route draws — diffs, file tree,
commenting and review submission included — so the changes can be read beside
the chat producing them. It is a narrow column, so it takes the list→detail
layout and the unified diffs a phone takes — but only the LAYOUT: its scope
picker and jump list open as anchored popovers, since a viewport-wide sheet
dropped over the app is a phone affordance, and this panel exists to sit beside
what the reader is comparing against. Moving inside it (a view, a file, a diff
scope) is panel state and never touches the address bar, which keeps naming the
main pane's object; its one action hands the worktree, at the view it is on, to
the main pane. A session with no worktree, and one whose worktree is gone, each
say so rather than drawing an empty page. The tab bar is panel chrome, not a
second object-title row. On small layouts none of this tab state exists: the
right panel remains the direct flip-up Inspector dock, and a Knowledge card
there offers its route alone. Top to bottom, for the current main-pane object:

1. **Summary** — type, title, key status.
2. **Related objects** — the object's references resolved and rendered as links
   (rule 2), as defined per object type (e.g. session → task, project,
   fork/draft lineage). New peer sessions created by `session_spawn` retain
   durable parentage here: the child shows **Spawned by** and its coordinator
   shows **Spawned sessions**, with each row opening the related Session. A
   child the user has explicitly taken over is marked **Taken over** on that
   row, ahead of its running/model/thinking detail and read from
   `spawnOwnership`, never from a title or a role word; a coordinator-owned or
   untracked child carries no marker. A spawned session's own panel offers
   **Take over** — the ONE way ownership moves, since messaging a peer is a poke
   that leaves its coordinator in charge — and, once taken, **Hand back**,
   naming the coordinator it returns to. The inspector LISTS this relation; the
   Sessions inbox is what folds it into one card (above). A group may bound its
   first page (a session's Tasks shows five) and reveal the rest on demand.

On wide layouts, object-aware secondary actions (archive, delete, rename, and
similar) live in the `…` menu on every main-page header; the primary action
remains visible in that header beside the comment controls. The inspector does
not repeat an **Actions** section there. On small layouts there is no header
`…`, so the object dock's inspector retains the full **Actions** section.

There is no embedded agent panel. The **Start a new session** action navigates
to the new-session page (`/sessions/create`) with the inspected object (and any
derivable context) already staged as removable chips, so the user only fills in
what is missing, types a prompt, and sends. Every agent-enabled object type
(Task, Project, Worktree, any document) exposes this one action rather than a
nested main-pane split. A worktree review handoff is the same editable draft: it
stages the worktree plus the selected comment bundle and prefills a review
prompt; sending to an existing session stays an immediate send that jumps to
that session. A document's comment tray (a host file) is not a handoff: sending
it moves the comments into the chosen session's composer and goes there
(`docs/comments.md`).

## Structured Context

A session does not belong to exactly one thing; it has a **context envelope** of
structured object references, carried as references on the wire — never pasted
text. Mentions and attachments that name an object resolve to references. The
inspector shows the envelope as object references.

## Draft Sessions

Creating a session is instant — no modal setup flow. A draft session opens as a
main-pane view with the composer focused; starting from another object stages
that object as initial context. While drafting, the inspector is in **context
staging** mode: staged references are visible and removable. The first send
commits the initial context envelope; later attachments are recorded as
turn-level context events, not merged into the initial envelope.

The draft header says **New Session** only until that first send. From
acceptance until the dedicated naming agent settles, every surface uses the
stable **Unlabeled Session** placeholder; it never derives an interim title from
the prompt or a provider default. While generation is actually running, the
title uses the shared reduced-motion-safe working-text treatment. A successful
answer replaces it directly with the final title. A failed naming run settles on
an informative deterministic first-prompt fallback only AFTER the working state
ends, so it does not reintroduce an interim-title flicker; disabled naming skips
the working treatment and uses that fallback as soon as the session row lands.

## Small Screens

On small screens the shell does not collapse to overlays; it collapses to
**screens**. There is no app header at all: one pane fills the viewport and
which one is a function of the route. The header's actions are nav-bar slots and
its panel toggles never existed here, so nothing was left to hold — and the top
of a phone screen is the worst place to spend on chrome. The shell owns the top
safe-area inset in its place, so an installed PWA still clears the notch.

- A **browser screen** is a section index route (`/sessions`, `/tasks`,
  `/projects`, `/pull-requests`, `/knowledge`, `/calendar`, `/settings`): the
  left sidebar fills the viewport — object browser above, and the nav bar at the
  bottom as the resting header of the same bottom card every other screen has,
  its folded slots one drag up. Nothing competes with it there, since the
  composer only exists on session routes.
- An **object screen** is any other route: the main pane fills the viewport and
  carries a **back** control. Its own header is not automatic: on a phone a
  surface earns one only if it says something the content does not. Identity
  that the screen already makes obvious, and metadata about an object that does
  not exist yet, cost a row that a phone would rather spend on content — the
  new-session screen therefore has no header at all, since it is visibly a new
  session and back sits in the dock's row. It earns one the moment the first
  prompt is sent: the screen is then a session being created, and the row states
  the identity that prompt is going to (see `loading-states.md`, the optimistic
  session shell) rather than metadata about nothing. Where a header earns its
  place it is ONE compact row of identity: a session keeps its title, because a
  transcript never states it, and drops the subtitle (those counts are in the
  dock sheet's own sections, with the lists). A control that belongs to the
  identity itself rather than beside it can ride ON the glyph — copying the
  IDENTIFIER, which is what names the object to a human: the session id, a
  Task's `Task-123`, a Project's key. That row states the identifier rather than
  restating the body, and which one that is decides where editing lives: a
  Task's long title moved out of the row into the page (with the rename pencil
  beside it), while a Project's short name stays in the row behind its key
  (`PD - Pandeck`), appears nowhere else, and is renamed from the row itself.
  Wide layouts keep their taller headers; there is room, and that row also
  carries the controls the dock takes over on a phone.
- The session page header uses that same compact identity row on every viewport:
  its glyph copies the session id, its title names the transcript, and
  Tasks/Tools metadata stays in the right panel where it has room. Wide layouts
  retain only the right-aligned session actions in the row; phones place those
  actions in the object dock.
- **Back** on an object screen navigates to the index route of the currently
  selected section, never `history.back()`. A deep link with no history then
  behaves like a tap from the browser. It lives in the object dock's action row
  where the screen has a dock, and in the leading position of the screen's own
  header where it does not (Settings, Usage). Document screens are the explicit
  exception: their Back and Forward retrace app-owned history, while Close
  returns to the exact opening entry or the source fallback. All three live in
  the same dock row on a phone with typed source actions, composed rather than
  replacing worktree comment/review/session actions, and their POSITIONS are
  fixed: Back and Forward are the leading pair, Close is pinned at the far right
  end, and only the source's and object's actions occupy the scrolling middle. A
  wide header uses that same order. The shared document shell registers them; no
  document renderer adds a fixed mobile toolbar.
- Section selection stays UI state, so navigation rule 2 still holds: only the
  browser's _visibility_ is route-driven. A nav-bar tap selects the section and
  navigates to its index route; opening an object from the browser navigates to
  the object screen, and that is what hides the browser.
- Navigation on a phone is therefore: the nav bar on the browser screen, back
  and the object's actions in the dock's row on an object screen. Nothing lives
  in a top corner, which is what let the header go.
- The right object panel becomes the **object dock** at the bottom edge: ONE
  card in two positions, resting with only its **header** showing (non-modal —
  the page scrolls and clicks through behind it) and sliding up into a **sheet**
  over the screen. Open/closed stays pure user state — the header is the
  trigger, so the app header carries no panel toggles at all on small screens:
  both panels have a thumb-reachable way in, and the top-right corner is the
  worst place to put one. Screens with no object to inspect (a browser screen,
  Settings, Usage) get no dock. The sheet carries **no identity header** — it
  sits over the object you are already looking at, and the screen's own header
  says which one that is.
- The dock's header is a grabber strip above the object's action row, and it is
  the card's top edge in both positions, so nothing in it moves as the card
  grows. All of it drags, both directions, tracking the finger continuously
  between the two rest positions — the card is one element, so there is no
  hand-over and no separately animated entrance to get wrong. A release lands at
  whichever end the position and the throw imply. Tapping the grabber toggles (a
  gesture is never the only way), and the backdrop and Escape also close. No
  labelled or close button on top of that: the row's width belongs to the
  object's actions.
- The action row stays visible in both positions, so the sheet's **Actions**
  section does not repeat the object's primary action while the row is showing
  it: the panel lists it again exactly when no chrome outside the panel does
  (`shell/RoutePrimaryAction.tsx` publishes it once; the panel hoists on that,
  never on "the row has some actions"). Add comment is the deliberate exception
  — it stays in both the thumb-reachable row and the sheet's complete Actions
  list. Back leads the row, the object's actions trail it, and the gap between
  them is drag target. Those trailing actions SCROLL horizontally when they
  overflow, so the row has one more slot beyond them, fixed at the far right for
  the one control that may never scroll away (a document's Close). Both ends —
  the leading `back` slot and that trailing one — sit outside the scroller;
  everything else belongs in the middle.
- That row ENDS in one slot, and the slot holds the thing to do right now: the
  object's primary action, or **Submit review** while comments are waiting to
  go. One slot rather than two controls, because the row's last position is the
  thumb's and both want it; swapping the interior rather than re-flowing the row
  is the same rule the session row follows for Send/Stop/Comment. Nothing is
  lost by the swap: the sheet the review opens offers to start a session without
  the comments, and the object panel lists the primary again while the slot is
  not showing it. **Submit review appears only while something is pending** —
  the batch is derived from the comments no session has been handed, so an empty
  one would send nothing at all, and a count of zero is not news.
- The WIDE page header carries that same pair, in the same order, for the same
  reason: it is the always-visible chrome there, and an object's primary action
  reachable only through a panel the reader may have closed is not reachable.
  Whichever of the two is on screen, the panel hoists the primary.
- Everything in that row is an icon-only ghost control, the app's chrome-row
  icon button. A labelled accent pill was both the widest thing in the row and a
  claim the action does not earn — "Start session" is not the call to action of
  a task you are reading — and the row is where the screen's back control now
  lives, so one control shape has to serve navigation and object actions alike.
  The session row's Send/Stop is the single exception, and it earns the filled
  treatment by not being an object action at all: it is the composer's primary
  action, wearing the composer's own tone in the composer's own place.
- Screen edges belong to whoever owns the back gesture there, and in a browser
  that is never us: iOS drives back/forward from both edges even in a Home
  Screen app. In the native shell it is us — WKWebView's own back/forward
  gestures are off, and unsupported on iOS anyway — so exactly one app gesture
  lives on the leading edge there, and it is BACK (below). The trailing edge
  stays untouched, and away from the edges the main pane keeps no global pan of
  its own (horizontally scrolling regions, diff gutters and the touch
  text-selection flow already own touch there).
- **Edge-swipe back** is another rendering of the screen's Back action, not a
  separate navigation rule. Object screens go to the selected section index.
  Document screens traverse one app-owned history entry and keep the leaving
  screen off-canvas until `popstate` lands; a deep-linked document invokes its
  Close fallback. It arms only where the app owns the edge
  (`lib/nativeShell.ts`), only in mobile layout, and only where Back or a
  document Close fallback is available.
- Nothing stacked over the screen may be dragged out from under: a modal sheet,
  dialog or popover owns the finger that touches it, and its own dismissal is
  what a gesture there would have to mean. That is settled STRUCTURALLY, not by
  a register each new surface has to join — a list of exceptions fails silently,
  and the failure is a dialog navigating away under the hand. A layer over the
  screen is either portaled to `document.body`, and so outside the DOM subtree
  the gesture listens on (which is why it listens on the DOM and not on React's
  event tree — portals travel up THAT one), or it is `position: fixed`, which is
  what makes it a layer rather than page content; a touch under either never
  starts the gesture.
- The gesture drags the whole shell aside and reveals the destination beneath
  it, parallaxed in from the left: the browser is the left panel's own content,
  mounted for the gesture and drawn under the leaving screen, so the pull is a
  stack being popped rather than a screen sliding over a blank background. It
  follows the finger 1:1, resists near the far edge, and a release either
  commits (a third of the width crossed, or a flick that says the direction) or
  springs home — TOUCH only, and the navigation fires when the screen has
  FINISHED leaving, in the same batch that drops the transform, so the
  destination is never seen sliding out. The pull is aimed ONCE: a touch in the
  strip that leans rightward is taken from the scroller under it — the page
  stops scrolling for that finger — and from then on the gesture is judged on
  the horizontal alone, however far the thumb arcs. Asking a thumb to hold a
  direction for the length of a screen is what makes an edge gesture feel
  unhittable, and the yield cone is there for the touch that has not been taken
  yet, not for the one already following. The math is
  `components/shell/edgeSwipe.ts`, on the same rule as the row swipe below:
  thresholds belong in a tested module, not in a component tuned by feel.
- A LIST ROW may carry one swipe action PER SIDE (`components/common/SwipeRow`),
  and it obeys the edge rule above rather than being an exception to it: a touch
  starting within `SWIPE_EDGE_GUARD_PX` of either edge belongs to the edge's
  owner — the browser's gesture, or the shell's back — and never becomes a row
  swipe. That guard is load-bearing now rather than courteous: a row's rightward
  swipe is the edge gesture's own direction, so it is the only thing keeping one
  finger from arming both, and it is therefore WIDER than `EDGE_SWIPE_ZONE_PX`
  (asserted in `swipeGesture.test.ts`, since the two are separate modules and
  neither would notice the other moving). The rest of the shape is fixed so rows
  cannot each invent one — TOUCH only (a mouse keeps the row's click and its
  drag-to-reorder), only a MOSTLY vertical drag that the row has not claimed
  goes back to the scroller, and the row springs back below the commit
  threshold. The math is `lib/swipeGesture.ts` — thresholds belong in a tested
  module, not in a component tuned by feel.
- A row with two actions settles its DIRECTION once, at the engage, and the
  travel is clamped to it: dragging back through the start point springs the row
  home rather than opening the other side. One gesture means one thing, and the
  two sides of a row are not neighbours in consequence — on the Backlog they are
  archive and delete. For the same reason the panel's COLOUR says which action
  is opening from the first px rather than at the threshold (a destructive one
  is `danger`, not the accent): arming says "release now", but only colour says
  WHAT, and a thumb needs that while it can still pull back. A row may carry one
  side and not the other, and where neither applies it has no swipe at all, so
  it does not take touches away from the list's scrolling for nothing.
- Which side is which is a product decision, but not a free one: RIGHTWARD is
  the light, frequent "I am done looking at this" and LEFTWARD is the heavier
  removal behind it. The Backlog reads archive/delete and the Sessions inbox
  reads settle/archive, so the same word lands on different sides of the two
  surfaces — which is the point rather than an oversight. What a thumb learns is
  the WEIGHT of a direction, not a vocabulary, and archive is the lighter of the
  two acts on one surface and the heavier on the other. A new surface picks its
  pair on that axis.
- A row swipe is aimed ONCE, exactly as the edge gesture above is: a touch that
  leans toward a side this row HAS an action on (`SWIPE_CLAIM_PX`, horizontal at
  least matching vertical) is TAKEN from the scroller it started in — a
  non-passive `touchmove` `preventDefault`, said before the row engages and
  while the UA can still be told not to pan — and from then on the gesture is
  judged on the horizontal alone, however far the thumb arcs.
  `touch-action: pan-y` is the resting state, not the arbitration: it does not
  preempt this code, and on its own it left every swipe at the mercy of a pan
  starting underneath it, which takes the pointer with it (`pointercancel`).
  That ending is bounded — a cancelled gesture can never commit, because a
  commit needs a release — but it is a failure the hand can neither see nor
  correct, and it is what made the row swipe unreliable in the field while the
  edge swipe, which claims, was not.
- The yield cone is therefore for the touch that has NOT been claimed yet:
  vertical takes such a gesture only when it is unmistakable in its own right
  AND clearly the larger motion (`SWIPE_VERTICAL_YIELD_PX`,
  `SWIPE_VERTICAL_DOMINANCE`), and a tie goes to the swipe. A thumb does not
  swipe along a ruler, and a cone tight enough to reject drift rejects the
  gesture people actually make. The claim's own cost is the mirror of that, and
  is paid on a row rather than in a reserved edge strip: a touch claimed in
  error does nothing at all, because scrolling cannot be handed back. Two things
  bound it: the lean rule — 6px of travel out-running the vertical is not how a
  list scroll begins — and the requirement that the lean point at a side this
  row actually has, so a one-sided row never pays the cost for the empty half.
- The commit threshold is VISIBLE, because a gesture that hides where it commits
  is a gesture you can only learn by getting it wrong: the revealed panel flips
  to an armed treatment the moment releasing would run the action, and back if
  the finger returns below it. The flip is instant, because a threshold is a
  line and a state fading across it is one you can misjudge mid-gesture. The
  panel's WORDING is not part of the flip: it names the action for the whole
  gesture, because a label that rewrites itself at the threshold asks the reader
  to re-read it only to find the action unchanged. The distinction never rests
  on colour alone — filled accent, bolder text and a larger icon carry it
  without wording — and it holds through the spring-back, so a committed swipe
  confirms itself rather than going neutral as the action fires. Where there is
  no spring-back there is no hold: under `prefers-reduced-motion` the panel
  leaves with the travel, its position being the travel.
- The panel is the row's FAR SIDE, not a box laid over it: square and borderless
  like the row, parked past the edge the row uncovers, and moved by the row's
  own transform, so it slides in from that side glued to the row's edge, its
  icon and label riding in at the leading edge as it is uncovered.
- That threshold is a PROMISE, not the whole rule. A flick commits below it on
  direction alone (`SWIPE_FLICK_VELOCITY`, as at the edge): a finger that leaves
  the glass at speed has said which way it meant, and asking it for distance as
  well is what makes a gesture feel unresponsive. The asymmetry only ever errs
  outward — everything the armed panel promises still commits, and the panel
  arms at the release of a flick that never reached it, because the confirmation
  is the only thing that says the action is running. The same speed decides the
  other way: a row thrown back rightward is a swipe RETRACTED, whatever the
  panel promised a moment earlier. A finger that stops is judged by where it is
  rather than how it arrived, or holding the row open and lifting would be read
  as the flick it no longer is.
- A swipe that REMOVES its row finishes the removal: the row carries on in the
  swipe direction and the gap it leaves closes, drawing the list up behind it,
  because a row that springs home and is then deleted shows the gesture being
  undone and the row disappearing for no visible reason. The action says whether
  it took the row (`onCommit` returning true) — the removal is what is animated,
  never the request — and the list must hold the row until the exit reports it
  is done: a Task list comes back without an archived row within a frame or two,
  long before a hand can see it leave. A row still there long after its exit
  comes BACK, because a hole in the list is worse than a row that returns.
  Nothing else in the list moves sideways: a row that changes depth (archiving
  promotes a parent's finished subtasks to the root) animates to its new indent
  rather than appearing at it, and a subtree that was collapsed is opened BEFORE
  the row leaves, so what it held arrives in place instead of popping into a gap
  that has already closed.
- A swipe cannot ask a question BY ITSELF, so what it commits to must be
  recoverable one way or the other: either the action is REVERSIBLE and paired
  with an Undo receipt (archive), or the swipe commits to the CONFIRMATION and
  not to the act (delete — the row springs home, the dialog decides, and nothing
  is animated out until the answer is yes). What may never sit under a thumb is
  an unrecoverable act with neither. Both are offered only on rows where they
  will succeed: a row whose action would be refused must not slide, because the
  refusal has nowhere to appear mid-gesture.
- Acting from the sheet **collapses** it: following a related object, running an
  action, or opening a linked surface changes the screen the sheet is covering,
  so it gets out of the way rather than hiding the result. Only actions with no
  visible effect there (copying a link) and the view toggles, which are flipped
  in bursts, leave it open.
- The bottom edge is ONE slot, and the dock's card is what rests in it — on a
  session screen too. There is no collapsed composer on a phone: the dock's
  action row carries what that bar used to, and on a chat screen it LOOKS like
  what it carries: the row is the resting composer, drawn as the composer's own
  bordered box showing the placeholder or the unsent draft. Tapping it replaces
  the whole card with the expanded composer, and closing that — sending, or a
  tap outside — brings the card back. So the phone shows either the card or the
  composer, never both, and every screen rests on the same card with the same
  grabber and the same back control. An icon-only row was the same controls
  without the one thing a chat screen has to state, and it left the new-session
  screen with nothing input-shaped on it at all.
- Writing a COMMENT takes that slot the same way, on any screen that offers it:
  the surface's composer replaces the dock's card (it says so with
  `composerOpen` on the comment-actuation channel) rather than stacking a second
  row under it, and it is the chat composer's card — same width, same field,
  same action row — because a phone that shows two different input boxes at the
  same edge has two inputs, not one. It states no quote: the passage it
  annotates is selected on the screen right above it. Its trailing corner
  carries what the surface can answer — cancel, delete when it holds an existing
  comment, and submit — and the field is FOCUSED by the tap that opened it,
  since asking to comment and then having to tap again is the same wasted
  gesture that rule exists to end.
- That row is BOOKENDED, two controls a side, and the symmetry is structural
  rather than decorative: the field sits between equal clusters so it lands on
  the same axis as the grabber above it. Inset 44px on one side and 4px on the
  other, it read as shoved sideways with its corner against the card's own. The
  clusters are held 16px off the screen — the card's own 8px gutter doubled by
  the row's padding — because the outermost control is now the one that sends,
  and a filled button hard against the edge reads as cropped rather than placed.
  - The sides are split by what they act on. The left pair LEAVES this
    conversation: back, then the session's context jump — its worktree when it
    has one (with the uncommitted-changes dot, the one indicator worth seeing
    without opening the sheet), else the object it hangs off, else the
    composer's paperclip. That order is one rule in
    `src/lib/sessionDockContext.ts`, not per-caller guesswork. Before the first
    send there is no such object yet, so on the new-session screen that slot
    carries the staged-context picker: the same "where does this go", asked
    ahead of time. A worktree is not one of that screen's answers to reach for —
    it is one of the things the picker stages.
  - The right pair belongs to the MESSAGE, in the order the composer's own
    toolbar has them: the mic, then Send. The draft resting in the field can
    therefore leave from the row itself, rather than only after opening the
    composer to press the same button again; Send is enabled exactly while there
    is a prompt to send, and a send the composer is refusing opens it on the
    hint that says why instead of doing nothing.
  - Both right slots keep their place in every state: a captured transcript
    selection is the fourth interior — its quote takes the field and Comment
    takes Send's slot; deselecting restores the draft and Send. A turn puts Stop
    in Send's slot (the same primary action the composer swaps in place, drawn
    as the composer draws it — a filled box, not one more ghost glyph), greys
    the mic beside it and makes the face state that turn, inert, because the
    composer can neither steer nor queue yet; a recording puts the live trace in
    the field with its discard and Stop in the mic's slot, leaving Send inert
    until the sentence lands. Recording wins a collision with a selection: it
    never displaces Stop, and the selection remains once recording ends. One
    row, one geometry, four interiors.
  - A phone session screen has no nav bar, so New Session is reached from the
    browser screen's nav bar rather than from this row: the bottom edge of a
    chat is worth more to the chat than to the next one.
- Dictation happens in that field: it is the one state with no textarea
  involved, so it is the one state that never raises the keyboard. The row keeps
  its controls through it — the field is wide enough to hold a trace without the
  rest stepping aside — but the sheet still cannot be opened over a recording,
  because the only thing worth hitting mid-sentence is Stop and nothing may
  cover it. Starting from the expanded composer's mic hands over to that field
  rather than recording in place, so there is one recorder and one recording UI
  either way, and the finished text lands back in the composer at the caret it
  remembered.
- The dock stays inside the app's own viewport box rather than being pinned to
  the browser's: it is chrome you must be able to hit, and on iOS Safari a
  viewport-fixed element extends behind the floating address bar. Modal sheets
  are fixed and deliberately DO bleed down there — a background should not leave
  a sliver of page under the browser's bar — but a resting header cannot afford
  it.

Everything above is gated on the shell's single mobile breakpoint; the
three-pane layout is untouched.
