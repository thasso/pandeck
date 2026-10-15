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
- **Milestones:** a milestone is an ordinary member Task marked as a milestone
  on its membership edge. Being a Task, it takes `blocks` links like any other,
  shows in the Backlog, and is done when its status is done. The mark is scoped
  to the Initiative, so the Task model does not change.

An Initiative does not touch a Task's project. A subtask still lives in its
parent's project (`docs/tasks.md`); the Initiative is the one thing that spans
them.

Archived member Tasks stay members. Deleting a Task drops its membership edges
like every other edge, and notifies the Initiatives it belonged to.

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
  are a `task_read` away.
- `initiative_manage`: a batch of `create`, `update` (title, description,
  state), `addMembers`, `removeMembers`, `setMilestone` / `clearMilestone`,
  `archive`, `unarchive` and `delete`. Each operation is all-or-nothing, like
  `task_manage`. `delete` only when the user explicitly asks. Adding a Task
  whose ancestor is already a member is refused with the reason, rather than
  stored twice.

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
  cursor and progress counts (total, done, doing, startable, blocked). Because
  the counts move with member Tasks, the Task notification seam also reports the
  Initiatives that hold a touched Task, member or descendant, in the same flush.
  A Task write is the only place that knows it changed, so no second path
  recomputes counts on a timer.
- The graph (nodes, the parent tree, `blocks` edges, milestones) is detail, read
  by id with the revision it is as of, the same way a Task body is. A newer
  Initiative event re-reads it.

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

A node shows the Task's title, its short label when it has one, and its state:
done, doing, startable (todo with no open blocker) or blocked. It also carries a
marker while a session is running on the Task. "Startable" and the critical path
are computed, never stored. The critical path is the longest chain of open Tasks
along `blocks` ending at the next open milestone. The map can highlight it, hide
done Tasks, and collapse a member epic into one node with its progress ("7/14
done") and expand it again.

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
  already happens on the server. The graph read carries node positions and edge
  routes, cached by graph revision and collapse state. A status change recolours
  a node and never needs a new layout.
- **Sidebar location.** Initiatives are a group at the top of the Projects
  section, since they sit above Projects (`app/web/docs/ui-shell.md`).
