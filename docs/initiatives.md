# Initiatives

An Initiative groups Tasks across Projects so the user can see the state of a
larger piece of work, follow its dependencies on a live map, and reach the Tasks
and sessions inside it. It is the user's durable object, like a Task, and it
sits above Projects rather than inside one.

This contract was agreed on 2026-10-15. The motivating case is Hosted Labs: one
goal spread over three Projects (SDC, Stardust Labs, SRS) and three epics
([Task-771](pa://task/771), [Task-802](pa://task/802),
[Task-803](pa://task/803)). An agent drew its map by hand as a static SVG, with
coordinates hard-coded per box and dependencies parsed from prose in Task
descriptions. Everything that map showed is data in this contract, so the app
draws and updates it instead.

## What an Initiative is

An Initiative has a title, a Markdown description, a state, an ordered set of
member Tasks, and its milestones.

- **Id:** an integer from `sequences('initiative')`, written `Initiative-<n>`
  and linked as `pa://initiative/<n>`.
- **State:** `active`, `paused` or `done`. The state is set explicitly and never
  derived from the Tasks. A derived state would flip an Initiative to done when
  its last open Task closes, before the user agrees it is over.
- **Members:** adding a Task adds its whole subtree. Membership is stored for
  the Task that was added; its descendants are resolved at read time, so a
  subtask created later under a member epic is a member without another write. A
  Task may belong to several Initiatives.
  - Plain memberships never nest. Adding a Task whose ancestor is already a
    member is refused with the reason. Adding a Task that holds plain members
    below it ABSORBS them: in the same write their edges go and the answer names
    the absorbed Tasks. An absorbed edge leaves no slot behind: existing members
    keep their places and the added Tasks are appended after them, in the order
    they were listed in. A Task moved under another member (a reparent or a
    Backlog drag) loses its plain edge in the move's own write the same way; it
    stays a member through its new ancestor.
  - The Tasks of one add (or create) are one request, so their order never
    decides the outcome: a listed Task under another listed Task is absorbed
    into it and reported, and the Tasks left are appended in the order they were
    listed in. With [X] stored, adding [R1, P] where P is X's parent leaves [R1,
    P]. A listed Task that an EXISTING member covers fails the whole operation,
    and nothing of it is written. A list adds plain members only; marking a
    covered Task is `setMilestone`'s alone, and an add never absorbs a marked
    edge.
  - Removing a stored member removes its edge. A Task that is a member only
    through an ancestor cannot be removed on its own, and the refusal names the
    ancestor; removing a Task that is not a member does nothing.
- **Milestones:** a milestone is an ordinary member Task marked as a milestone
  on its membership edge. Being a Task, it takes `blocks` links like any other,
  shows in the Backlog, and is done when its status is done. The mark is scoped
  to the Initiative, so the Task model does not change.
  - A milestone may be a subtask of a member epic. Marking a Task covered by a
    member stores a marked edge for it, the one kind of edge allowed under
    another member, and absorption and moves keep it. Clearing that mark deletes
    the edge, and the Task stays a member through its ancestor; clearing the
    mark of a Task nothing covers keeps it as a plain member.
  - A marked edge is a membership of its own: removing the ancestor leaves the
    milestone a member. Removing the marked edge of a covered Task leaves it a
    member through the ancestor, and the answer says which — as of the end of
    the operation, so an ancestor removed in the same operation, or by a later
    operation of the same batch, covers nothing. Marking a Task that is not a
    member is refused.

An Initiative does not touch a Task's project. A subtask still lives in its
parent's project (`docs/tasks.md`); the Initiative is the one thing that spans
them.

Archived member Tasks stay members: they stay in the tree, the graph and the
total. Deleting a Task drops its membership edges like every other edge, and
notifies the Initiatives it belonged to.

## Progress

A member's status (todo, doing, done) and whether it is blocked are separate
facts. Blocked follows `docs/tasks.md`: at least one blocker is neither done nor
archived. A done Task is never blocked; a started Task can be.

The counts are:

- **total:** every member, archived ones included;
- **done:** every done member, archived or not, so the 14-day auto-archive never
  erodes progress;
- **doing:** unarchived `doing` members, blocked or not;
- **startable:** unarchived `todo` members with no open blocker;
- **blocked:** unarchived members that are not done and have an open blocker,
  `doing` ones included.

An archived open Task is shelved work, so it counts in none of doing, startable
or blocked. `doing` and `blocked` overlap. The buckets therefore need not sum to
the total.

## Dependencies are `blocks` links

The map draws ONE kind of arrow: `blocks`, the Task link that already exists
([Task-798](pa://task/798), `docs/tasks.md`). There is no weaker dependency
type. What counts as `blocks`:

- a prerequisite without which the work cannot start;
- a Task needed to FINISH the work, even when it can be built against an agreed
  contract first. The dependent Task shows as blocked until then; being blocked
  never refuses a status change, so it can still be started;
- a simplification the team has decided to wait for.

A simplification nobody waits for gets no link; it stays a sentence in the
description. `relates` is not a dependency and the map does not draw it.

Agents write these links through `task_manage`; the UI only displays them. A
dependency written only as prose ("Depends on: L3") is invisible to the map,
blocked state and the attention list, so an agent writing dependent Tasks
records them as links.

## Agent tools

Agents create and manage Initiatives; the user does it by asking. The UI has no
create or edit form, and its only Initiative write is Settle.

- `initiative_read`: a list (state filter, search) or one Initiative by id. A
  read by id returns its members as a tree with their status and blocked state,
  the milestones, and progress counts. It never returns Task descriptions; those
  are a `task_read` away. Every answer is bounded in bytes: its lists are capped
  with the count of what was left out, and a member tree cut short says where to
  read on (`nextOffset`). Each record is also capped whole, as serialized: the
  head (19 KB), a member (4 KB) and an outside blocker (2 KB). One over its cap
  gives up optional fields in a fixed order, naming each in `omitted`: the head
  `externalBlockers`, `description`, then `milestoneIds`; a member `projectId`,
  then `blockedBy`; a blocker `projectId`. Every other field is required. If the
  record is still over, its required strings are cut in order (a member's
  `title`, `parentId`, then `id`; elsewhere `title`, then `id`), each ending in
  `…` and named in `clipped`. The caps leave every page room for its first
  member, so a read always moves on, and the whole answer is measured once more
  before it goes out. A Task's `projectId` is stored as written, so a long one
  is the usual reason a member omits it.
- `initiative_manage`: a batch of `create`, `update` (title, description,
  state), `addMembers`, `removeMembers`, `setMilestone` / `clearMilestone`,
  `archive`, `unarchive` and `delete`. Each operation is all-or-nothing, like
  `task_manage`, and runs in its own transaction, never inside a caller's.
  `delete` only when the user explicitly asks. The membership and milestone
  rules above apply as written: an add under a member is refused, an add over
  plain members absorbs them, and the answer names absorbed Tasks and removed
  ones still members through an ancestor once the batch is done. Every id it
  names is the canonical one, never the caller's spelling.

Both are deferred tools, found with a tool search for "initiative", and are
available to the developer and personal-assistant personas. Their rules live in
the tool descriptions, never in a harness-specific prompt layer.

## Storage

- An `initiatives` table holds the Initiative's own columns: title, description,
  state, the attention cursor (below), revision, and created, updated, archived
  and deleted times.
- Membership is an edge in the generic `links` table:
  `initiative —member→ task`, with `position` for the user's order and
  `metadata_json` carrying `{ "milestone": true }` on a milestone.
- Initiatives join the state-change event model (`docs/state-sync.md`) as their
  own topic, `initiatives`. A summary carries the id, title, state, attention
  cursor, progress counts (total, done, doing, startable, blocked) and the
  card's sessions (below). Because the counts move with member Tasks, the Task
  notification seam also reports the Initiatives that read a touched Task — as a
  member or descendant, or as an outside blocker of a member — in the same
  flush, and a session's liveness change reports the Initiatives listing it. A
  write is the only place that knows it changed, so no second path recomputes
  counts on a timer.
- The graph (nodes, the parent tree, `blocks` edges, milestones) is detail, read
  by id with the revision it is as of, the same way a Task body is. A newer
  Initiative event re-reads it. An archived Initiative leaves the live list, but
  a later write to it still raises an event (a `delete` with the new revision,
  as for an archived Task), so its open graph re-reads too.

## The Initiative page

The route is `/initiatives/:id`; `/initiatives` is the section index listing
every Initiative by state. An Initiative has a page of its own and no view
inside Project pages.

The page has two views:

- **Map** (the default): every member Task as a node, laid out left to right
  along `blocks` edges, one lane per member epic, grouped by Project. A blocker
  outside the Initiative is drawn as a stub node at the lane edge, because a
  dependency on outside work is exactly what the map has to show.
- **List**: the members as a tree with progress per epic, for reading and for
  small screens.

A node shows the Task's title, its short label when it has one, its status
(todo, doing or done) and, separately, a blocked marker (see Progress): a
started Task whose blocker is still open shows doing AND blocked, and a todo
Task with neither is startable. An archived member is toned back, like an
archived Task link. A node also carries a marker while a session is running on
the Task. "Startable" and the critical path are computed, never stored. The
critical path is the longest chain of open Tasks along `blocks` ending at the
next open milestone. The map can highlight it, hide done Tasks, and collapse a
member epic into one node with its progress ("7/14 done") and expand it again.

Selecting a node opens the object panel with the existing Task detail and the
Task's sessions, where a session can be started from the Task and its status
changed through the usual Task controls. The map itself writes nothing.

The map is live: it follows the `tasks` and `initiatives` topics, so a status
change recolours a node without a reload, and a link or membership change
re-reads the graph.

## The attention list

An Initiative is a Sessions inbox item, following the Workflow Run precedent
(`docs/agent-workflows.md`, `app/web/docs/ui-shell.md`).

- **While active**, it is always an item. Settle is not offered: there is no
  outcome to acknowledge, only ongoing work.
- **Once paused or done**, it stays an item with that outcome until the user
  settles it. The change of state raises the attention cursor
  (`attention_revision` / `attention_settled_revision`, the same shape and rules
  as a Workflow Run's); Settle acknowledges exactly the revision the clicked
  item rendered. A settled Initiative leaves the inbox, and setting it active
  again brings it back.
- Only the user settles. An agent changing the state never removes the item.

The card shows the title, state, progress, how many Tasks can start now and how
many are blocked, the next open milestone, and the sessions working on its
Tasks. Opening it goes to the map.

The sessions working on its Tasks are the user's sessions linked to a member
Task, archived member Tasks included, that are neither archived nor settled (a
settled session counts again once a new outcome raises it). The summary carries
at most 50 of them, newest by session creation first (ties by id), and the full
count; the query returns no more than that. When the count is larger, the card
says how many more there are ("and N more") rather than presenting the 50 as all
of them.

Those sessions are listed in a disclosure on the card but keep their own inbox
cards. Unlike a Workflow Run's role sessions they are not folded away: a Task
can belong to several Initiatives, so no single card owns a session, and a
session that needs the user must stay visible on its own. Membership is
structural: sessions linked to member Tasks, nothing parsed from titles.

## Phases

1. Storage, the `initiatives` state topic, and the agent tools. Then create the
   Hosted Labs Initiative with its three epics as members and a "First hosted
   release" milestone Task, blocked by L7 ([Task-817](pa://task/817)) and S5
   ([Task-807](pa://task/807)). Its `blocks` links are already written.
2. The Initiative page: List view, and the Map view (read only, live).
3. The Sessions inbox card and Settle.
4. Map interaction: the object panel with sessions, collapsing epics, the
   critical path and filters.

## Layout and placement

- **Layout runs on the server.** elkjs lays the graph out left to right with one
  lane per member epic. Its bundle is well over the web client's 500 KB chunk
  budget, and the layout only changes when membership or links change, which
  already happens on the server. It runs in a worker thread when a map is read,
  never from a write or an event flush. A status change recolours a node and
  never needs a new layout.
  - Each member with no member parent is a root and has a lane; every descendant
    is drawn in its root's lane. The lanes of one Project sit together, Projects
    and lanes in member order.
  - An outside blocker is a stub in the first column of each lane it blocks
    into. Milestones, a milestone under an epic included, stand in a column to
    the right of every lane, and an outside blocker of a milestone has its stub
    just left of them.
  - `getInitiative` may name collapsed epics. A member with member children is
    then one node with its descendants' progress, and the arrows into and out of
    its subtree end at it; a milestone under it stays drawn. The set is applied
    canonically: an id that collapses nothing, or sits under another collapsed
    epic, is dropped.
  - The `initiativeDetail` answer carries `layout` for exactly the graph it
    carries: node boxes, lanes, Project groups, the milestone column and
    orthogonal arrow routes. The layout reads only structure — the members and
    their order, the hierarchy, each root's Project, the milestone marks and the
    `blocks` links — and its `key` is a digest of that and the collapsed set.
    Layouts are cached by Initiative and key, so a status, title, blocked or
    archive change keeps the layout while the Initiative's revision, which they
    do move, still dates the graph. The read checks the structure again once the
    layout is done and lays it out anew if it moved.
  - A layout that cannot be computed leaves the graph in the answer and says why
    in `layoutError`. Over 1,000 drawn nodes, or an ELK error, the answer stands
    until the structure changes. Everything else is transient and a read 5 s
    later lays the map out again, with no write: a pass past its 20 s limit, a
    layout past its 60 s deadline (its waits for the worker included), a worker
    that was lost or could not start, or a refusal because too many layouts are
    running (8 at once, 3 of them for one map). One layout runs per drawing
    however many reads wait on it, and a newer structure or a deleted Initiative
    lets the older drawings go before their next pass.
- **Sidebar location.** Initiatives are a group at the top of the Projects
  section, since they sit above Projects (`app/web/docs/ui-shell.md`).
