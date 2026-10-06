# Knowledge Base contract

The Knowledge Base (KB) is a folder of files in a Git repository. The app
browses it like any checkout, agents read and write it through the `kb_*` tools,
and the user edits it directly — in an editor, with `git pull`, or by committing
in the browser. Path rules live in `app/server/src/knowledgeBaseContract.ts`;
`pa://` link parsing in `app/shared/objectLinks.ts`.

## The folder

`DATA_DIR/knowledge/` is the KB, a Git repository of its own, independent of the
application's source repository. The server makes it a repository on first use
(`git init` plus an empty first commit when the branch is unborn) and otherwise
leaves its configuration and `.gitignore` alone.

- Any layout and any file type. Markdown is what knowledge is written in; PDFs,
  images, spreadsheets and other files sit beside it.
- Frontmatter is optional. `title`, `tags` and `summary` (or `description`) are
  what search, listings and link titles read; without a `title` a file is named
  by its first heading, then its file name. Entries written under the retired
  schema keep their `kb:` block, whose `title`, `tags`, `summary` and `id` are
  read the same way.
- Hidden paths — any segment starting with `.` (`.git`, `.gitignore`, the
  retired `.kb` control folder, an editor's `.obsidian`) — are not listed,
  searched, read or written by the tools.

## Links

A KB file's durable link is its path: `pa://knowledge/<path>`, e.g.
`pa://knowledge/projects/acme/plan.md`, with an optional `#L<n>` line anchor.
The knowledge type is the one `pa://` type whose id may span several segments;
`.` and `..` segments are refused. It opens on `/knowledge/files?path=<path>`
(`docs/document-presentation.md`).

Links written before links were paths name an entry's retired `kb.id`
(`pa://knowledge/kb-acme-plan`). A one-time boot task
(`app/server/src/knowledgeLinkMigration.ts`) moved them to paths:

- it froze every id → path pair the KB's frontmatter carried in the
  `knowledge_legacy_links` table, which keeps the links left in HISTORY —
  session transcripts, memory snapshots, workflow state, PR cards — resolving
  (`knowledgeLegacyLinks.ts`), whatever later happens to the frontmatter;
- it rewrote the links in the text people and agents still edit: the KB's own
  files (one commit, skipping any file with uncommitted edits), Task
  descriptions and comments (a revision bump, not an edit: `updated_at` is
  kept), and active memory cards (an ordinary memory edit);
- it took a consistent copy of the database first
  (`DATA_DIR/app.sqlite3.pre-knowledge-path-links.bak`, `VACUUM INTO`) and
  recorded what it changed in `knowledge_link_migration`, which keeps it from
  running again. A run that fails part-way records nothing; the next boot
  finishes it. A file or card it left alone (uncommitted edits, a refused memory
  edit) keeps its old links, which resolve through the map like history's.

Every `kb_*` path parameter also takes a `pa://knowledge/...` link, an old id
link included. Moving a file does not rewrite links to it: `kb_move` keeps the
frozen map current and says so, and the agent updates the links it finds.

## Git

- Every KB write by a tool is a guest in the user's working tree. It commits
  exactly its own paths (`git commit -- <paths>`), never whatever else is
  staged, and refuses a path with uncommitted changes — modified, staged,
  deleted or untracked, a folder's contents included — rather than committing or
  rolling back an edit it did not make. The refusal tells the agent to ask the
  user to commit or discard first.
- Writes take the folder's ordinary repo lock (`repoLockKey`), the same one the
  browser's Commit takes. Concurrent stores initializing one new folder share a
  single in-flight init, since the key changes when `git init` creates `.git`.
- Identity, signing and GC settings are passed per commit, never written to the
  repository config. Hooks do not run for tool commits (`--no-verify`).
- A tool commit's subject is the caller's reason; its trailers record the actor,
  session, task and changed paths (`KB-Actor`, `KB-Session`, `KB-Task`,
  `KB-Paths`). Commits made by the user carry none.
- Paths are validated before any filesystem write; a failed commit restores the
  paths it touched, which were clean by the check above.

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

The browser has no Knowledge-specific read API: it reads the KB only through
that checkout. The `/knowledge` route (`Files` and `Uncommitted changes` in the
sidebar) and the right panel's Knowledge tab both draw the worktree file page
for it (`WorktreeDetailPage`, titled "Knowledge Base", no line comments, a
Markdown file opening on its Preview with the frontmatter header). The route's
inspector (`KnowledgeInspector`) counts the uncommitted files and offers "Commit
changes…", which commits them all with the user's git identity. Live refresh is
the checkout's own change watcher: a tool commit or an external edit moves its
git status, and the open page reloads in place. A `kb_show` card opens its file
in the panel or the main pane.

Starting a session from a KB file stages it as a generic file context
(`docs/document-presentation.md`, Starting a session from a document): the agent
gets the file's name, absolute path and viewer route, never its content.

## Agent-facing KB tools

`app/server/src/tools/knowledge/knowledgeBaseTools.ts`:

- `kb_search` ranks files by title, path, tags, headings and text, optionally
  under one folder, and returns path, title and a snippet per hit.
- `kb_read` returns one text file in windows (`startLine`, `maxChars`,
  `nextStartLine`); a binary file answers with its size and absolute path, for
  `convert_pdf`/`convert_xlsx` (`kbPath`).
- `kb_list` lists folders and files with Markdown titles, depth- and
  count-bounded.
- `kb_write` creates or replaces one file from text, base64, or a session
  attachment copied server-side (`sourceAttachmentId`); `kb_edit` applies exact
  unique replacements; `kb_move` moves a file or folder. Each is one commit.
- `kb_history` lists commits for the KB, a folder or a file (followed across
  renames), or returns one commit's bounded patch.
- `kb_show` puts one file in front of the USER as a transcript card that opens
  it in the Knowledge side panel or the Knowledge route. The tool checks the
  file exists and re-spells its path and title, so a card can only name a file
  that exists; the agent contributes one short note. It carries no content
  (`renderKind: "knowledgeEntry"`, version 2; the shared parser in
  `app/shared/toolCards.ts` also opens the retired `kb_show_entry` cards of
  older transcripts on their folder's `index.md`).

What the tools know about the files — titles, tags, summaries, headings and
bounded prose — is a cache of the WORKING TREE in memory
(`app/server/src/knowledgeBaseIndex.ts`), refreshed per file by size and mtime,
so an uncommitted edit is searchable at once and nothing is written to the
folder.

KB behavior is taught to agents through TWO surfaces
([Task-284](pa://task/284)):

1. **Eager pointer** (`knowledgeBaseBehaviorGuidance()` in
   `app/server/src/knowledgeBasePrompt.ts`): injected as an eager
   `promptAssets.ts` layer for every persona on both harnesses. Minimal (at most
   600 chars) — names the KB, forbids direct filesystem writes, and says when to
   search. No `kb_*` tool is eager ([Task-286](pa://task/286)), so it is also
   the DISCOVERY surface: it says the tools load on demand and names the tool
   search that finds them ("knowledge base"). Weakening it silently stops
   sessions from consulting the KB.
2. **Tool descriptions**: the operational rules — reuse before writing, linking,
   no secrets or raw sensitive bodies, where facts came from, Memory for atomic
   facts, asking before ambiguous or broad changes, the refusal of uncommitted
   files. They load with a deferred group: `knowledge-core` (`kb_search`,
   `kb_read`, carrying the search hints discovery ranks on) or `knowledge`
   (everything else). Only the core tools' descriptions say "Knowledge Base";
   the management tools say "KB", so a search for "knowledge base" loads the
   reads.

A tool-LOCAL rule belongs only in that tool's `description`; the eager pointer
is NOT a second copy of the tool rules.

## Fast regression and token/performance audit

`pnpm run test:kb` is the focused fast regression suite for KB work: the server
tests for path rules, the Git layer, the file index, the agent tools, prompt
behavior, and the large-ish fixture audit in
`app/server/src/knowledgeBaseRegression.test.ts`; and the web tests for
Knowledge routing, the Knowledge panel, Markdown/`pa://` rendering, and the
Markdown diff used by tool cards.

The audit keeps default tool output compact and bounded — search hits carry
snippets, listings no bodies, reads are windowed, patches capped — and describes
and searches 120 files inside a CPU budget, so it runs before every commit
without slow integration tests. For a broader closeout run `pnpm run test`,
`pnpm run typecheck` and `pnpm run build`.
