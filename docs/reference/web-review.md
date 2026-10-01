# Web review surfaces — implementation reference

Relocated from `app/web/src/components/review/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

The domain-neutral surfaces and shell channel for REVIEW work on comment
threads, used by worktree diffs, plus the actuation channel and send sheet that
document comment trays (`../DocumentComments.tsx`) reuse.

## Module ownership

- `reviewThread.ts` owns the domain-neutral `ReviewThreadView` and the pure list
  math over it (`groupReviewThreads`, `dispatchableThreads`,
  `pendingReviewThreadIds`, `firstLineOf`), unit-tested in
  `reviewThread.test.ts`. `pendingReviewThreadIds` is the REVIEW IN PROGRESS —
  open threads no session was ever handed — and it is derived, never stored: a
  comment nobody has been told about is pending by definition, so the
  GitHub-style "draft review" needs no pending flag, no protocol change and
  cannot go stale. Every domain's adapter supplies the `sent` bit it is computed
  from. A worktree anchors a comment to `path:line` in a commit, but the list
  speaks this shape rather than that domain's types. Each domain owns its own
  adapter next to its types (`../worktree/worktreeReview.tsx`'s
  `worktreeReviewThreads`).
- `ReviewCommentList.tsx` owns the roster: two-line rows grouped into **Open**,
  **Unanchored** (open but the passage is gone — the only threads with no place
  in the document, so this list is their only surface) and **Resolved**
  (history, never in the way), with selection and bulk dispatch. A row shows the
  comment's FIRST LINE and where it sits — never the quote, which is what
  jumping is for. A row does ONE of two things on a tap, and the HOST picks
  which by passing either callback (they are mutually exclusive in the props
  type):
  - `renderThread` — the row EXPANDS in place, for a list that sits WITH the
    content (a page section), which is also how a reply happens without leaving
    a mobile sheet.
  - `onOpen` — the row is a LINK that opens the thread where it lives, for a
    list that sits BESIDE the content (the object panel, a sheet over the
    document). Such a row carries no jump control either, because the whole row
    is the jump, and the list then hosts no thread actions at all: a second
    surface for reading and answering the same comment is one too many. The
    roster does not own pending-review actuation. Hand-picking a SUBSET is the
    exception: a leading checkbox on open rows plus an `All` quick-select,
    offered only in expand mode, because picking is an editing act and belongs
    where threads are read and answered.
- `CommentActuation.tsx` owns the route-level, domain-neutral publication
  channel. The active surface publishes optional
  `{ canComment, onComment, pendingCount, onSubmitReview, composerOpen }`; the
  shell consumes it in the page header on wide layouts and the object dock row
  on small layouts. `composerOpen` is what a surface says when its own composer
  has taken the phone's bottom edge, and the shell answers by standing the dock
  down — one slot, one occupant (`app/web/docs/ui-shell.md`), exactly as a
  session screen's composer already displaces it. Add comment is shell-owned in
  the inspector too, while worktree inspector actions own Submit review. The
  shell knows no anchors, threads, or transport. Add comment remains visible but
  disabled without a captured target; Submit review appears ONLY while something
  is pending, in the primary SLOT of whichever chrome is closest to the reader
  (the wide header's, the dock row's last position), badged with the count. With
  nothing pending that slot holds the object's own action instead
  (`shell/RoutePrimaryAction.tsx`) — the batch is derived, so an empty review
  would send nothing, and a zero is not news. Every shell control carries
  `[data-comment-actuation]` and prevents the pointer-down default: selection
  hooks exempt that marker from outside-press dismissal so the following click
  can consume the captured target before the browser collapses it.
- `SendCommentsSheet.tsx` owns SUBMITTING a review: the target picker (new
  session, or one already running with the ones already linked to this object
  first) plus one optional **message** covering the batch — the review body. A
  bottom `ui/Sheet` on a phone and a centered card on a wide layout; the caller
  resolves the session list and owns what submitting does. The message is
  offered for an EXISTING session in every domain, because that send is
  immediate and there is nowhere else to say anything; a NEW session instead
  stages an editable draft on the new-session page, where the prompt is written
  anyway — which is what `newLabel`/`newDetail`/ `newSubmitLabel` exist to say
  in the domain's own words, keeping ONE picker rather than two that drift.
  `startWithout` is the way out that is not a review: the object's own action,
  which this sheet's slot took while comments were waiting, so a pending review
  is never the only thing a reader can start.

- Submitting is a LIST action, never a per-comment one: a thread card offers
  reply, resolve and delete, and nothing that hands one comment to an agent. One
  comment is simply a review of one.
- The adopter's "sent" record: a worktree comment carries `attachedSessionId`,
  written on every send path, so "pending" is honest without new persistence.
  Submitting does NOT resolve a thread: resolve means the point is settled, and
  handing it to an agent is not that. A thread therefore leaves the review bar
  (it has been sent) while staying in **Open** until someone closes it.
- Agent-authored worktree findings may belong to a durable review set. The
  worktree inspector renders each set's model attribution, in-progress/verdict
  state, summary, and derived open/addressed counts above the ordinary thread
  roster. Inline threads render the finding severity and the author's model;
  human comments continue to omit both.

## Contract notes and rationale

- Keep this folder domain-neutral: no KB or worktree types, no socket state. A
  new reviewable object adds an adapter in its own module, not a branch here.
- The list is for triage and history. Reading and answering a thread in the
  content it annotates belongs to that content's own inline annotation
  (`../diff/comments.tsx` for diffs) — which is what link mode routes to.
- Pure math stays in `reviewThread.ts` with tests; the components stay
  presentational.

## Verification commands

- Run `pnpm --filter @assistant/web test` for the pure list math.
- Run `pnpm --filter @assistant/web build` for this subtree.
