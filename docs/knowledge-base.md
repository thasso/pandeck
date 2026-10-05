# Integrated Knowledge Base contract

This document is the implementation contract for the first-class Knowledge Base
(KB). The executable constants and path helpers that mirror the storage
boundaries live in `app/server/src/knowledgeBaseContract.ts`; generic `pa://`
object-link parsing/formatting lives in `app/shared/objectLinks.ts`.

## Product model

- Knowledge is a first-class app object type alongside Sessions, Tasks,
  Projects, and Worktrees.
- A KB entry has a stable id and may move paths without breaking durable links.
- The canonical internal link form is `pa://knowledge/<id>` for entries. The
  generic `pa://` object scheme also reserves `pa://task/<id>`,
  `pa://project/<id>`, `pa://session/<id>`, `pa://worktree/<id>`, and
  `pa://approval/<id>` (an approval card, opened at its row in the session that
  proposed it). An entry's `links` and source refs refuse approval links
  (`isPaRelationLink`): a card is a decision inside one session, not an object
  to relate an entry to.
- Markdown rendering must allow empty-title internal links such as
  `[](pa://knowledge/kb-example)` or `<pa://task/256>` and resolve their visible
  titles at render time.
- Agents and UI surfaces should prefer compact tree/search rows by default and
  require explicit detail levels before returning large content.

## Repository and filesystem layout

`DATA_DIR/knowledge/` is the source-of-truth KB repository. It is a dedicated
Git repo, independent from the application source repo.

```text
DATA_DIR/knowledge/
  .git/                         # KB history; managed by KB storage code
  .kb/
    comments/<entry-id>.jsonl    # retired comment logs, kept, never read
    generated/                   # rebuildable indexes, extracts, caches
  <entry-slug>/
    index.md                     # Markdown-first entry body + frontmatter
    assets/...                   # entry-local source assets
  <folder>/<entry-slug>/
    index.md
    assets/...
```

Contracts:

- Folder entries are preferred. The entry body is always `index.md` inside the
  entry folder.
- Entry folders use human-readable slugs. Slugs are not durable identifiers; the
  frontmatter id is durable.
- `assets/` is reserved inside an entry folder for source assets such as PDFs,
  documents, images, and arbitrary files. Assets are part of the source of truth
  unless explicitly marked generated. Asset path handling, compact listing,
  bounded reads, and add/update helpers are owned by
  `app/server/src/knowledgeBaseAssets.ts`; APIs accept entry-local paths such as
  `assets/source.pdf` and reject traversal or paths outside the entry folder.
- `.kb/comments/` holds the append-only JSONL logs of the retired server-side
  comment threads. Nothing reads or writes them any more; they stay in the repo
  and its history, and the path stays classified (`comment`) so they are never
  mistaken for an entry or an asset. Entry comments are browser-local now
  (`docs/comments.md`).
- `.kb/generated/` stores rebuildable artifacts only: tree/search indexes,
  extracted text/OCR, render caches, and other derived data. Generated artifacts
  must not be required to reconstruct entries or assets. Generated text extracts
  for source assets live under `.kb/generated/extracts/<entry-id>/assets/...txt`
  and may be referenced by `kb.assets[].extractPath`; they are safe to delete
  and rebuild. The tree index and search projections are owned by
  `app/server/src/knowledgeBaseIndex.ts`, which persists a deterministic
  write-if-changed index at `.kb/generated/index/kb-index.json` and rebuilds it
  whenever the KB HEAD commit moves.
- `.git/` and `.kb/generated/` are reserved implementation paths and must not be
  exposed as normal tree entries.

## Entry frontmatter schema v1

Each `index.md` starts with YAML frontmatter. The executable parser, validator,
deterministic formatter, and tool-facing pre-write helper live in
`app/server/src/knowledgeBaseEntry.ts`.

```yaml
---
kb:
  schema: 1
  id: kb-example-stable-id
  type: note
  title: Example entry title
  status: active
  summary: One short optional summary for compact views.
  tags: [example]
  aliases: [Optional alternate title]
  links:
    - pa://task/256
  createdAt: "2026-07-07T10:00:00.000Z"
  updatedAt: "2026-07-07T10:00:00.000Z"
  source:
    kind: manual
    refs: []
  assets: []
---
```

Required fields in v1:

- `kb.schema`: literal `1`.
- `kb.id`: stable entry id, unique across the KB repo. IDs survive moves and
  title changes.
- `kb.type`: one of `note`, `brief`, `workflow`, `plan`, `reference`, `project`,
  `daily-summary`, or `decision`.
- `kb.title`: human title used for tree/search/link title resolution.
- `kb.status`: one of `draft`, `active`, or `archived`.
- `kb.createdAt` and `kb.updatedAt`: ISO-8601 timestamps.

Optional v1 fields:

- `kb.summary`: compact one-sentence summary.
- `kb.tags` and `kb.aliases`: arrays of non-empty strings.
- `kb.links`: related `pa://` object links.
- `kb.source`: structured provenance. `kind` is `manual`, `import`, `meeting`,
  `email`, `slack`, `jira`, `project`, or `agent`; `refs` is a list of source
  URLs or `pa://` links.
- `kb.assets`: asset metadata records with entry-local `path`, optional `title`,
  optional MIME/type hints, optional `kind`, and optional generated extract
  references. Asset files can also exist without metadata; compact listing must
  still surface them for the UI, but metadata is preferred for titles, MIME
  hints, and generated extract links.

The Markdown body after frontmatter is the primary editable knowledge content.
Generated extracts may be referenced from metadata, but must live under
`.kb/generated/` and be rebuildable. Agent-visible asset reads must be bounded:
compact asset lists contain metadata and byte sizes only, binary/download reads
return at most an explicit byte limit, and text previews/extract reads are
truncated with a `truncated` flag instead of dumping full files into context.

Validation/formatting contracts:

- Writes that accept user or agent-supplied KB entry Markdown must validate and
  format before touching the KB working tree.
- Validation errors must name the exact frontmatter field, for example
  `kb.links` or `kb.createdAt`, and state the expected shape.
- Unknown frontmatter fields are rejected so stale metadata cannot silently
  persist.
- Formatting is deterministic for entry frontmatter and local text formats:
  Markdown prose is softly wrapped near 80 columns while preserving tables, code
  fences, headings, and URLs; JSON and JSONL are normalized with stable local
  formatting; YAML support is intentionally limited to the KB schema subset and
  other simple mappings/lists until a formatter dependency is introduced.

## Git/versioning contract

- KB mutations are serialized by a repository lock before filesystem writes and
  Git commits.
- That lock is the folder's ordinary repo lock (`repoLockKey`), the same one the
  worktree Commit takes, so a KB write and a commit from the browser never
  interleave. Concurrent stores initializing one new folder share a single
  in-flight init, since the key changes when `git init` creates `.git`.
- Each successful mutation creates a Git commit with structured metadata in the
  message or trailer block: actor, session id, task id, entry id(s), reason, and
  changed paths (`KB-Actor`, `KB-Session`, `KB-Task`, `KB-Entry`, `KB-Paths`).
  Older commits may also carry `KB-Comment`; commits that touched only
  `.kb/comments/` stay out of an entry's history view.
- Validation must happen before committing. Failed validation must leave the
  repo without partial source-of-truth changes.
- History/diff APIs should answer whole-KB and per-entry questions without
  loading unrelated large files into agent context.

## Browser Knowledge surfaces

The KB folder is also readable as a checkout under the reserved worktree id
`knowledge` (`KNOWLEDGE_WORKTREE_ID`,
`app/server/src/worktrees/knowledgeCheckout.ts`): the worktree file routes serve
its tree, files, raw bytes, History and uncommitted Changes, and Commit commits
edits made outside the app. Every other worktree verb — push, pull requests,
merge, clean, retire, hosting — answers 404 for it. Only the surfaces that call
`resolveReadableWorktreeRow` (the worktree file routes, document grants, the
change watcher) see the id; session placement, spawning, agent worktree tools,
comments and delivery resolve through `resolveWorktreeRow`, which never returns
the KB.

Browser read APIs live in `app/server/src/knowledgeBaseHttp.ts` under
`/api/knowledge/*`:

- `/tree` returns the compact app-shell tree used by the Knowledge sidebar.
- `/entry` returns one readable main-pane document with body Markdown,
  frontmatter-derived metadata, assets, and resolved `pa://` references.
- `/inspect` returns the right-inspector projection only: compact summary,
  frontmatter metadata, related `pa://` objects, assets, recent Git history, and
  a bounded diff preview. It intentionally omits body Markdown so inspector
  refreshes do not duplicate full entry reads.
- `/asset` streams one entry-local source asset for inline images/downloads.

Every committed KB mutation emits an entry invalidation so an open viewer and
Details inspector refetch after an agent edit. Comments on an entry are the
shared browser-local tray (`docs/comments.md`): no KB write, no wire command.

An entry is readable in TWO places: the `/knowledge/:entryId` route in the main
pane, and the right panel's Knowledge tab, which browses the same compact tree
and then draws the same loader and viewer beside whatever the main pane is on
(`app/web/docs/ui-shell.md`, Object panel). One surface, not a second
implementation: both follow the same entry invalidation and read and write the
same comment tray. The panel scopes its own comment/primary-action channels so
its controls speak for the entry it shows, and it links the entry to its
canonical route rather than replacing it.

Starting a session from a Knowledge entry stages the entry's own `index.md` as a
generic file context (`docs/document-presentation.md`, Starting a session from a
document): the agent gets the file's name, absolute path and viewer route, never
its content.

## Agent-facing KB tools

First-class KB v1 agent tools live in
`app/server/src/tools/knowledgeBaseTools.ts`. They expose object-oriented,
token-sparse operations over the Git-backed KB repo:

- Discovery: `kb_tree` and `kb_search` return compact bounded rows by default.
- Reads: `kb_get_entry` returns metadata by default and only returns source
  Markdown when `detail: "full"` is explicitly requested; asset listings and
  generated extract reads are separately bounded.
- Mutations: `kb_write_entry`, `kb_edit_entry`, `kb_add_asset`, and
  `kb_move_entry` validate paths/schema before touching the working tree and
  commit through the KB storage layer with actor, session, task, entry, reason,
  and changed-path metadata.
- Audit: `kb_history` and `kb_diff` expose bounded Git history/diff views so
  agents can answer review questions without dumping unrelated entries.
- Handover: `kb_show_entry` puts one entry in front of the USER as a transcript
  card that opens it in the Knowledge side panel or the main Knowledge view. It
  resolves the entry against the index and re-spells its id, title, path and
  summary from there, so a card can only name an entry that exists; the agent
  contributes one short plain-text note and nothing else. It carries no entry
  content in either direction — it is a pointer at a reading surface, not a read
  (`renderKind: "knowledgeEntry"`; the shared card parser in
  `app/shared/toolCards.ts` decides, for both the web renderer and the server's
  timeline payload policy, when a payload is a card).

Tool callers must not write `DATA_DIR/knowledge` directly. Validation errors are
part of the agent repair loop and should name the actionable schema, path, or
format issue that must be fixed before retrying.

Reliable-KB behavior is taught to agents through TWO surfaces
([Task-284](pa://task/284)):

1. **Eager pointer** (`knowledgeBaseBehaviorGuidance()` in
   `app/server/src/knowledgeBasePrompt.ts`): injected as an eager
   `promptAssets.ts` layer for every persona on both harnesses. Minimal (~600
   chars) — names the KB, forbids direct filesystem writes, and triggers when to
   search (before answering durable questions or asking the user about facts it
   may already hold). Since [Task-286](pa://task/286) deferred the KB read tools
   too, it is also the DISCOVERY surface: it says the `kb_*` tools load on
   demand and names the tool search that finds them ("knowledge base"), in
   harness-neutral wording (pi `find_tools`, Claude's native ToolSearch). No
   `kb_*` tool is eager any more, so weakening this pointer silently stops
   sessions from consulting the KB at all.

2. **Tool descriptions** (each `kb_*` tool's `description` field in
   `app/server/src/tools/knowledge/knowledgeBaseTools.ts`): comprehensive
   operational guidance on when/how to read/write, general/project/task scope
   isolation, `pa://` linking, stable `kb.id` references, frontmatter/validation
   repair, bounded asset reads, provenance recording, and never storing secrets
   or raw sensitive bodies. These descriptions activate when a deferred
   knowledge tool group loads — `knowledge-core` (`kb_search`, `kb_get_entry`,
   carrying the search hints discovery ranks on) or `knowledge` (everything
   else: writes, moves, audits, and the remaining reads `kb_tree`, and
   `kb_read_asset`/`kb_read_extract`).

The `kb_*` tools used to repeat all of these rules verbatim in a per-tool
`promptGuidelines` array — 16 copies, ~25 KB of the deferred tool universe —
which [Task-282](pa://task/282) deleted. A tool-LOCAL rule (for example that
`kb_read_asset` reads committed assets while `kb_read_extract` reads generated
extracts) belongs only in that tool's `description`. The eager pointer is a
discovery pointer and safety guardrail; operational rules live on the tools and
are NOT duplicated in the eager text.

## Fast regression and token/performance audit

`pnpm run test:kb` is the focused fast regression suite for KB work. It runs the
server tests covering contracts, schema validation, formatting, Git storage,
index/tree/search, assets, HTTP projections, agent tools, prompt behavior, and
the final large-ish fixture token/performance audit in
`app/server/src/knowledgeBaseRegression.test.ts`; it also runs the web tests for
canonical Knowledge routing, tree selection, Markdown/`pa://` rendering, entry
viewer, and inspector projections.

The final audit fixture keeps default agent-tool output compact and bounded:
`kb_tree` is capped and body-free by default, `kb_search` defaults to compact
rows and caps `maxResults`, `kb_get_entry` omits source Markdown unless
`detail: "full"` is explicit, and `kb_diff` always enforces `maxChars`. The
large-ish fixture test indexes, searches, and reads history for 120 entries
inside a generous fast-suite budget so workflow agents can run it before commit
without enabling slow integration tests.

No slow/manual KB tests are required by default. For a broader closeout, run the
standard repository gates as exact commands: `pnpm run test`,
`pnpm run typecheck`, and `pnpm run build`.

## Local reset boundary

The one-time importer used for the previous skill-based KB has been removed. If
a local KB needs a clean reset, delete `DATA_DIR/knowledge` and let the KB repo
re-initialize empty on the next server start.
