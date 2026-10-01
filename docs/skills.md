# Skills library

The skills library is user-authored source for reusable agent skills. It is
separate from project-local skills and from Pandeck's generated runtime layouts.

## Storage ownership

`DATA_DIR/skills` is a dedicated Git working tree owned by the user. Personal
Assistant bootstraps storage lazily by creating the directory and running
`git init -b main` only when `.git` is absent. Bootstrap is idempotent and
serialized across concurrent callers.

Bootstrap does not configure an author, create a commit or `.gitignore`, stage
files, or alter an existing repository. The user owns branches, remotes, merges,
and all other repository maintenance, and hand-authoring stays a first-class way
to work: uncommitted working-tree content is user-owned source, not generated
application state.

The library has two authors, and only one of them is automatic. Personal
Assistant writes ONLY when a user asks an agent to, through a `skill_*` mutation
tool ([Task-633](pa://task/633)); nothing else in the app writes here, and no
background process commits. Those tools are described under
[Agent authoring](#agent-authoring-and-history), which also states the
clean-tree refusal that keeps the two authors from writing over each other.

## Source layout

Each skill occupies one non-hidden top-level directory:

```text
DATA_DIR/skills/
  <source-folder>/
    SKILL.md
    ... optional supporting files and folders
```

Only an exact, regular-directory child and its exact `SKILL.md` are scanned.
Top-level files, hidden directories such as `.git`, and nested `SKILL.md` files
outside that shape are not library entries. Supporting scripts, references, and
assets belong to the skill folder; a skill is not only its `SKILL.md` file.

A top-level symlink is judged by what it stands in for. One that resolves to a
directory occupies the place of a skill folder, so it is listed with the
diagnostic explaining that the library will not read through it — a linked-in
skill must not simply vanish. One that resolves to anything else, or to nothing,
is an ordinary top-level file under another name and is ignored exactly as the
file itself would be.

`SKILL.md` starts at byte zero with YAML frontmatter containing `name` and
`description`. The server uses its shared YAML-subset parser rather than a
skills-specific YAML implementation. `description` must be a string. The
declared `name` must be 1–64 characters and match `^[a-z0-9]+(?:-[a-z0-9]+)*$`:
lowercase ASCII letters, digits, and single hyphens, with no leading or trailing
hyphen. That rule is `isSafeSkillName` in `app/shared/skills.ts`, shared by the
scanner and by settings, so what may be scanned and what may be toggled cannot
drift apart. `description` must be a non-empty, non-whitespace string of at most
1024 characters. These agentskills.io-compatible bounds are also safe to
materialize as exactly one runtime child.

The source folder is identity for browsing and diagnostics; it is not inferred
from, and need not equal, the declared name. A valid summary retains the
library-relative `<source-folder>/SKILL.md` path alongside the declared name and
description, and materialization retains that scanner-provided source path
rather than inferring it from the name.

## Working-tree scan and diagnostics

Every scan reads the current directory listing and current `SKILL.md` bytes. It
does not key or cache results by Git HEAD, so uncommitted edits, additions, and
removals are immediately authoritative for both browsing and later runtime
resolution.

The scan and the single-skill read reach those bytes the same way, through one
anchored no-follow seam. Each path is resolved ONCE: the library root is opened,
the source folder and its `SKILL.md` are opened below it with `O_NOFOLLOW`, and
the identity (`dev`/`ino`) and content both come from those open handles. A
pathname resolved twice is two different questions — between the answers a
`SKILL.md` can become a symlink pointing outside the library, and a scan that
checked the first answer and read the second would publish an outside file's
name and description as a library skill. Nothing is read through a pathname, so
that swap is refused (a symlink diagnostic) or harmless (the handle still names
the file that was checked), never followed. Opens are non-blocking, so a named
pipe left where `SKILL.md` belongs is reported as unreadable rather than
stalling the scan. The anchor uses `/proc/self/fd`, which makes library reads
Linux-only by construction; there is deliberately no pathname fallback, since a
fallback would restore the very re-resolution this removes.

A folder that cannot produce an injectable skill remains visible through one or
more deterministic diagnostics. The scanner distinguishes:

- missing and unreadable `SKILL.md`;
- symlinked source folders or `SKILL.md` files, which are refused rather than
  followed;
- absent/invalid frontmatter and invalid YAML (including a non-mapping root);
- missing, non-string, and unsafe `name`;
- missing, non-string, empty/whitespace-only, and over-1024-character
  `description`; and
- duplicate safe declared names.

Duplicate names are ambiguous regardless of source folder. Every folder that
declares the duplicate safe name receives a duplicate diagnostic, including a
folder that also has another metadata error, and none of those folders produces
a valid summary. Valid summaries sort by declared name then source path;
diagnostics sort by source path then diagnostic code, making repeat scans stable
across filesystem enumeration order.

## Browsing the library

`/settings/skills` is the read-only library view. The web client subscribes to
the `skills` topic only while that section renders, and the server answers each
subscribe with a fresh working-tree scan rather than a cached result, so
reopening the view always shows current source.

The topic has exactly one list shape, the `skillList` message, and one server
seam that sends it. Its `list` carries the whole read model — valid summaries,
every scan diagnostic, and the `libraryPath` the user maintains by hand — while
a scan that could not run at all sets `error` instead. An error never arrives as
an empty library: "no skills" is a claim about authored content, and a failed
read is not entitled to make it. A subscribe answers on the topic rather than
privately to the asking connection, so a second window opening the library also
refreshes the first with the same authoritative scan.

The browser holds one canonical skills load state in `useAssistant`. A first
open loads, a re-open keeps the rows on screen while the rescan runs, an
authoritative empty scan is the only thing that draws an empty state, and a
failed scan adds its error beside whatever was last read. Diagnostics render
next to the list, never dropped: a malformed or duplicate folder is visible with
its source folder and reason even though it cannot be injected. The browser is a
read-only view: there is no authoring UI, and a committed agent mutation reaches
it as one ordinary authoritative `skillList` publish.

## Reading one skill

`GET /api/skills/detail?name=<declared-name>` serves one skill's `SKILL.md` and
recursive supporting-file tree. It sits behind the same token/origin gate as the
rest of `/api/`; file bodies are too large for the list topic and are wanted for
one row at a time.

`name` is the entire address. A caller never supplies a path. The name must
satisfy `isSafeSkillName` — a name that could never be declared is refused as a
malformed request before any scan runs — and it is then resolved through a fresh
working-tree scan to the source folder that scan reported. A request therefore
cannot select a folder the scanner rejected, cannot address a skill by its
source folder name, and cannot reach outside the library.

The response is either the skill or an explicit invalid state, both naming the
requested skill:

- valid: declared name, description, source folder, library-relative `SKILL.md`
  path, the body BELOW the frontmatter, the file's size in bytes, whether it was
  truncated, and a recursive tree of the whole selected skill folder. The
  frontmatter's own two fields travel as metadata, so the raw fence is not part
  of the body. The body is bounded at 256 KiB (`MAX_SKILL_BODY_BYTES`); a bound
  reached mid-character drops that character rather than emitting a replacement
  one. The deterministic tree puts `SKILL.md` first and then sorts each folder
  by byte-stable name. It is bounded to 1,000 entries, 16 levels, and 256 KiB of
  UTF-8 name/path metadata. Diagnostic text uses that same budget. Its answer
  carries the reached limits and non-fatal listing diagnostics, and Settings
  renders them rather than presenting a partial tree as complete. An irregular
  or unreadable entry therefore cannot make the answer unbounded.
- invalid: the reason the library cannot serve that name — the scan's own
  diagnostic for a malformed or ambiguously duplicated folder, or the fact that
  the file was deleted, replaced, or stripped of its frontmatter between the
  scan and the read.

That last case is the scan/read race, and it is a normal answer rather than a
failure: the library is hand-authored and rescanned per read, so a skill can
stop being valid between a list and a click on it. The race never surfaces a raw
filesystem error (which would leak an absolute path and explain nothing) and
never falls back to another folder (which would show one skill's instructions
under another skill's name). A well-formed name the library does not declare at
all is a 404; a name it declares and cannot serve is a 200 carrying the reason.

`GET /api/skills/file?name=<declared-name>&path=<skill-relative-path>` serves
one regular file from that skill. The default answer is raw bytes, refused with
413 above 10 MiB so an image/download is never silently corrupted. Adding
`preview=text` returns the shared JSON preview union: text is bounded to 256 KiB
with full size and truncation metadata, while an unsupported MIME or NUL-bearing
payload is identified as binary without decoding it. MIME comes from a fixed
extension map and unknown types are `application/octet-stream`; raw answers add
`nosniff`, a sandbox CSP, no-store caching, and a safe inline filename.

The path is relative to the selected skill folder, not the library. Empty/dot
components, `..`, absolute and drive paths, backslashes, NULs, and overlong
paths are rejected before a scan. Percent signs are legal filename characters;
URL decoding happens before the already-decoded components are opened literally,
so a component such as `%2e%2e` is not interpreted as traversal. The declared
name is rescanned to the same source identity used by detail. Every path
component is then opened beneath the held folder file descriptor with no-follow
semantics; supporting-file symlinks are shown in the tree but cannot be read,
whether they point inside or outside. Deletion, replacement, or a symlink swap
during the open becomes a path-free 404, never a read outside the skill. The
`skill_read_file` tool resolves and opens through this same code, so every rule
in this paragraph binds it too.

`/settings/skills` renders the detail and tree beneath the list. Opening a row
fetches its body keyed by selected NAME, and opening a supporting file fetches
its preview keyed by NAME plus relative path, so switching either selection
drops the previous object's answer. `SKILL.md` and other Markdown use the shared
sanitized renderer, source/text files use `CodeBlock`, and images use the
bounded raw URL. Binary/unsupported files get only raw/download actions. The
file viewer uses the generic Tree, PageHeader, and load-state primitives; it
does not make KnowledgeBrowser or KnowledgeFileViewer generic. A rescan re-reads
the open skill in place, keeping existing content through a refresh failure.
Tree, body, and preview truncation are all stated in the pane.

Editing files in the browser and executing skill scripts remain out of scope;
authoring goes through the agent tools below.

## Agent authoring and history

Ten harness-neutral tools make the library manageable by asking an agent, with
no authoring UI. They are one deferred catalog group, `skills`, for the
`assistant`, `personal-assistant`, `developer` and `workshop` personas; the
deliberately narrow `workflow-coordinator` toolset does not include them. The
five reads are classified `sideEffects: "none"` and the five mutations
`"local"`, so Plan mode exposes the reads only.

- `skill_list` — the fresh scan (summaries plus every diagnostic), the library
  path, and compact repository state: clean or not, the uncommitted changes
  standing in the way, the branch, and HEAD.
- `skill_get` — one valid skill's metadata, its COMPLETE bounded `SKILL.md`
  source including the frontmatter, and a bounded supporting-file tree. The
  frontmatter is included because an edit replaces exact text and must be able
  to address it. The tree is metadata: `skill_read_file` is what reads a listed
  file's content.
- `skill_read_file` — one supporting file as a WINDOW of lines: `offset` is the
  1-based first line, `limit` the line count (400 by default, at most 2,000 and
  further cut at 64 KiB of text), and the answer states the file's size, the
  window's first and last line, the lines it could see, and whether more
  follows. A skill's reference material is the material an agent must be able to
  read without pulling all of it into context, and without a filesystem tool: it
  is the one read that makes `SKILL.md`'s own pointers usable through this
  group. Text is served verbatim — byte-order mark included — because it is the
  text an edit then has to match; a file that is not text, or that is not valid
  UTF-8, is refused rather than decoded into replacement characters standing
  where content is. A NUL scan alone would pass one stray Latin-1 byte in a
  `.md` file, so the decode itself is what refuses. Only a file's first 256 KiB
  is reachable, and the one character that bound may cut is not bad content: the
  prefix ends a line early instead of failing. That tolerance is spent only when
  the bound really cut the file — one read whole that ends mid-character is
  refused, since the bytes alone cannot tell the two apart.
- `skill_create` — `<name>/SKILL.md` from a safe declared name, a validated
  description, and a Markdown body. The tool-created folder equals the declared
  name and the source is formatted deterministically, so writing the same
  content twice is a no-op rather than a churn commit.
- `skill_edit` — exact, unique, non-overlapping text replacements against source
  that was read first. It validates the whole result and refuses a declared-name
  change: renaming is a folder move as well, so it has its own tool.
- `skill_manage_files` — one atomic batch of supporting-file writes, edits,
  deletes, and imports of a CURRENT-session attachment beneath one skill. Binary
  bytes are copied server-side and never pass through model context. An `edit`
  applies the same exact, unique, non-overlapping replacements `skill_edit`
  applies to `SKILL.md`, so a long reference is patched rather than resent
  whole; it rewrites an EXISTING UTF-8 text file through one open description,
  never creates one, and refuses a file that is not valid UTF-8 rather than
  committing the replacement characters a lossy decode would invent. A leading
  byte-order mark survives: the edited text is re-encoded whole, so a decoder
  that ate the BOM would change bytes no replacement matched.
- `skill_rename` — the folder move and the frontmatter name change in one
  commit.
- `skill_delete` — the whole folder, resolved from the current declared name.
- `skill_history` / `skill_diff` — bounded log and unified diff for the whole
  library or one skill/source scope. Both validate revisions against
  option-shaped input and pass `--end-of-options`; a path scope still works for
  a folder that was deleted, which is how a removed skill stays inspectable.

Every mutation needs a concise reason and may carry a related Task id.

### What a mutation guarantees

`SkillLibraryStore` is the one storage seam for both halves of the domain, so
there is no second Git path. Under the canonical repository lock
(`withRepoLock(await repoLockKey(root), …)`, never nested) one mutation:
initializes, verifies the repository is ENTIRELY clean and that Git can take the
index lock, resolves and validates every target and path, applies the complete
operation, re-scans, stages only the paths it registered, commits, and publishes
one fresh `skillList` — all before the lock is released, so no publish can
describe the NEXT mutation's half-written files, and a failed publish never
unmakes a commit that is already made. Any failure restores every touched path
in the index and the working tree and emits no success broadcast.

The rollback PROVES itself. Each restore command is best-effort on its own (a
path that was never in HEAD makes `checkout` fail, which is normal), so what
decides the outcome is the repository's status afterwards: if the tree is not
clean again, the caller is told what failed AND what is left behind instead of
receiving the original error over a working tree that still holds the tool's
write. A stale `.git/index.lock` was the case that produced exactly that — it
coexists with a clean status and fails staging and restoring alike — so it is
now a pre-flight refusal before anything is written.

The handoff to Git is the one step that is not anchored to an inode: `add` and
`checkout` take pathnames, and the repository lock does not serialize the person
editing the same working tree. So a mutation hands Git only the paths it MADE,
never the broad names it touched — staging a folder would put a file a hand
author queued inside it into this tool's commit — and the index is read back
before the commit is allowed. Every staged entry has to answer for itself: a
deletion must fall below a path the mutation removed, and an addition or
modification must be a claimed path whose PROOF holds. A claim carries either
the exact bytes the mutation wrote, and the index entry's object id must be the
id those bytes hash to, or — for content it MOVED rather than wrote — the path
it came from, and the index entry must be exactly what the repository has
committed there, mode and object alike. Both are claims about CONTENT — and
about the MODE, which is the other half of an index entry and just as much a
change somebody else could have made, so a concurrent `chmod +x` refuses the
commit like any other. An inode is not such a claim: a hard link keeps its
number through a truncate-and-rewrite, so "still the entry I placed" says
nothing about what is inside it. Nor is metadata: a size can be matched and a
modification time put back with `utimes`. Every removal therefore reads what it
is about to remove, under the private name where nothing else can address it,
and takes a file back only while it still hashes to what this mutation put there
or found committed — a whole source tree included, because the manifest a rename
reads is also the one file it does not carry across, so a hand author editing it
after that read keeps its inode and would otherwise have their work deleted
under a commit describing the version the tool read. The expectation is the
bytes the mutation wrote, or the object the repository has committed. Every
placed file says WHICH of those it is, and a symlink says explicitly that it
needs no check, its target being unable to change without the inode changing
with it; nothing is ever removed merely because no expectation was recorded,
which is how a freshly written manifest came to be taken back on the strength of
its inode alone.

Detaching a name stops new opens; it does not stop a writer who took a
descriptor before that, and a hash is many reads. So every hash over a
descriptor is bracketed: the size and the inode's `ctime` must be the same after
it as before, and one byte past the hashed length must be absent — `ctime` moves
on any write and `utimes` cannot set it back, so a modification anywhere in the
file is visible even when the length is not. An answer that fails any of those
is no answer at all, and nothing is removed on it. Proving a tree and emptying
it are also two walks, and the first has no bound — one large sibling stretches
it as long as a writer needs — so each entry's proof carries the `ctime` it was
taken at, DIRECTORIES INCLUDED, and the walk that removes rereads each one
immediately before it acts: a directory before it lists it, a file before the
unlink. Creating an entry moves its directory's `ctime`, which is what catches a
file added through a descriptor held from before the detach — the private name
stops opens, not that. And an entry with NO reading recorded is refused rather
than removed: it was not there when the tree was proved, so it is not this
removal's to take. Either way the removal stops where it stands, which is a
partial removal and reported as one. The same expectation governs a delete,
built from what the repository has COMMITTED under the folder, because removing
a skill is not licence to remove a file somebody put beside it — read in ONE Git
call and bounded by the same 512-entry ceiling a rename places under, so the
size of a hand-authored folder never decides how much a mutation reads, hashes
or holds open. What that record yields is whole ENTRIES, not object ids: a Git
entry is a mode and an object, and only the mode says whether the path is a
regular file, an executable one, or a symlink whose object is its TARGET. Kept
as bare ids they are three indistinguishable things, and a delete would accept —
and commit — a symlink standing where a file was committed, a committed symlink
repointed somewhere else, and a `chmod +x` on a file whose bytes never moved. So
each is checked as what it is: a symlink's target is read back and hashed as the
blob Git stores for it, bracketed by its own `ctime` because a symlink cannot be
written through, only REPLACED; a regular file's exec bit is compared inside the
same bracket as its content, and in Git's own terms, so a repository with
`core.fileMode` off — where a `chmod` is not a change Git can see at all — is
not refused over a difference the user never made. Putting a tree BACK is
bounded the same way and proved the same way: each pass links across what it
finds and then empties the aside of exactly what it linked, so an entry created
behind the walk is never the copy that goes, and what a racer keeps adding is
left under the private name and reported rather than cleared. What no POSIX call
can exclude is a write landing in the gap between that last reading and the
`unlink` itself: there is no compare-and-unlink, and `unlinkat` takes no "only
if unchanged" flag, so the design puts those two syscalls next to each other and
says plainly that it stops there.

Bounded is not the same as brief, so a mutation takes the tool call's
`AbortSignal` as well — but it honours it only at points that name themselves,
never at whatever `await` happens to be running. Those points are the ones where
stopping costs nothing: throughout the read-only work that precedes the first
write, the scan of the whole library included; throughout the proofs, which read
and hash but change nothing; and between the 64 KiB chunks of one hash, because
a file a hand author left beside a skill can be as large as they like. A stop
there takes the same path as any other refusal — the detached tree is
reassembled at its public name FIRST and the cancellation surfaces only after,
so the caller reads "you stopped this" instead of a phantom conflict over a
folder nobody touched. Past the point of no return it is ignored, and
deliberately: the first truncation, the first removal, a proved tree about to be
emptied, the Git handoff, and every undo. An interrupted removal is worse than a
slow one, and an undo abandoned halfway is worse than both — an undo checks each
file's content through the same hashing, so a signal still live there would
leave exactly the assembled folder it was meant to take back. A cancelled
mutation therefore always means nothing happened, never that half of it did.

The commit is read back too, not only the index that made it: a `pre-commit`
hook runs between the two with the index in its hands, and a hook that stages a
file of its own would otherwise land content in the commit that no claim covers
while the result names only what the mutation did. A commit holding anything
unclaimed is undone — the ref goes back and the index with it, the working tree
untouched, so nothing anybody wrote is destroyed — and the refusal names what
was in it.

A path is not a proof: the name can be the one this mutation claimed and the
content somebody else's, which is exactly what committing it would publish as
the tool's work. Anything unproven refuses, and nothing is committed. Restoring
is the mirror of that claim. `git checkout HEAD -- <path>` reverts whatever
differs from the commit no matter who wrote it, so it runs only while the path
still holds what this mutation left there: the exact bytes it wrote, or nothing
where it removed. A hook or a hand author who rewrote the path afterwards owns
it now, and the post-rollback status check reports it instead. The one exception
is a path a mutation TRUNCATED and then could not rewrite, including a tree
removal that failed halfway: there the committed copy is the only intact one,
and it is restored unconditionally.

Generic undo stops where ownership stops. Git undoes only what Git can prove:
the index, and content it has committed. There is no `git clean` in the
rollback, because a path Git cannot restore is exactly a path this mutation
created, and by the time a rollback runs that NAME may hold a file a hand author
wrote in its place — cleaning it to tidy up would destroy content the mutation
never made. So everything a mutation brings into existence — a created skill
folder, a rename's new folder, a batch's new supporting file, the parent
directories a nested write had to make, none of which Git can undo, since it
tracks no empty directory — is taken back by the mutation itself, entry by
entry, against an inode it PINNED at creation: each file only while it is still
the one written or linked there, each directory only while it is empty. A
failure that lands after the work is done, such as a rejecting `pre-commit`
hook, gives a hand author time to replace or add to what the mutation made;
their file survives, stops the removal of its own parents, and is reported by
the post-rollback status check instead of being destroyed by the undo.

Cleanliness includes untracked files, and that is the point twice over. It keeps
an agent from absorbing, describing, or committing the user's in-progress hand
edits — the refusal names the changes and says to resolve them in that
repository, while reads, history and diffs stay available. And because nothing
untracked can already be lying around, a successful commit contains the complete
created, edited or deleted content it claims.

Validation is the scanner's own rule, not a second "tool-valid" schema:
`skillManifest.ts` parses and validates frontmatter for the scan and for every
mutation, and formats the source a tool writes. A mutation must leave its target
valid and introduce no new diagnostic or duplicate-name collision. Pre-existing
unrelated diagnostics stay visible and stay uncommitted — a mutation neither
repairs them nor inherits them.

Writes use the same anchored no-follow seam as reads (`skillSource.ts`): a path
is resolved once below a held descriptor, so a component swapped for a symlink
is refused rather than followed. Nothing authors a symlink; a manually authored
supporting symlink remains browseable under the Phase 1 contract, but no tool
writes through it or deletes it.

Anchoring alone is not enough for a repository the user also edits by hand: the
lock serializes the app against itself, not against a person. So every mutation
is bound to the INODE its scan selected — and, where it DESTROYS something, to a
descriptor it holds rather than to the number the scan wrote down. A delete and
a rename open the scanned folder, pin it and its `SKILL.md`, and read that
manifest through the pinned handle to confirm it still declares the skill the
caller named; the removal is then bound to those pins and refuses a tree that no
longer holds that manifest. Without that a folder somebody removed and recreated
would be recognised as the scanned one — the freed inode number is handed
straight to the replacement — and a skill this tool never read would be deleted
in its place. The source folder is opened and its `dev`/`ino` compared with the
scan's before anything is written, an edit reads and rewrites `SKILL.md` through
ONE open description rather than by name, a delete empties the verified folder
through that same handle and then removes only an EMPTY name, and a
supporting-file removal moves the verified file to a private name before
unlinking it — putting it back and refusing if what moved was not what it
checked. A folder replaced between the scan and the write is therefore refused,
never deleted.

A rename, a create and a delete all end in an operation on a NAME, which is what
makes them dangerous here. POSIX `rename` REPLACES its destination when that
destination is an empty directory, and no check in front of it closes that
window; `renameat2(RENAME_NOREPLACE)` is not reachable from this runtime. So a
rename is not what moves a skill.

Instead the new name is ASSEMBLED out of calls that already refuse: `mkdir` for
the folder and each subfolder, `link` for every supporting file and symlink, and
`O_CREAT|O_EXCL` for the rewritten `SKILL.md`. Each of those is create-or-fail
in one syscall, so no step can take a name something else already holds — there
is no window to guard, because there is no replacement to prevent. `link` also
makes the move free and provable: the new name is the SAME inode, so nothing is
copied, and "did this mutation create that name?" is later answered by comparing
inodes instead of by trusting a path. The old folder is then emptied of exactly
those inodes and removed with `rmdir`, which refuses a directory that anything
was put back into.

A create writes its manifest through the descriptor of the folder it reserved,
never through the name a second time, and then proves the name still resolves to
that folder.

REMOVAL is the mirror image of that, and it has the same problem in reverse:
`unlink` and `rmdir` take names too, and an `lstat` followed by an `unlink` of
the same name is a guess — the name can be something else by the time the second
call runs. So nothing is removed under a public name. A whole tree is renamed to
a private `.pa-skill-removing-<uuid>` first and only then identified, checked
against what the mutation put there, and emptied; a single file is moved aside
the same way before it is examined and unlinked. Putting a rejected tree BACK is
assembly, not a rename: `mkdir` claims the public name or fails, and the files
are hard-linked across, so a directory a hand edit created at that name in the
meantime is never replaced by the restore. A delete, a rename's cleanup of the
old folder, and a rename's undo of the new one all go through that one
primitive, so a file a hand edit wrote into the tree stops the removal instead
of disappearing with it, and a folder that turns out not to be the recorded one
is renamed back untouched.

Identity comparisons only mean something while the inode is PINNED, because an
inode number is reused the instant its file is deleted — measured, for files and
directories alike, and pinned by a test. So a mutation PINS everything it
creates, with a descriptor that refers to the inode without opening it for I/O
(`O_PATH`, which is also the only open a symlink accepts), and the store holds
those descriptors until the commit attempt has settled. That is the lifetime
that matters: an undo runs after the commit was refused, long after the
mutation's own scope closed, and a number it merely recorded would by then fit
the folder or file a hand author put at the same name exactly as well as its
own. While the descriptor is held the inode cannot be freed, so no replacement
can ever be given its number, and "the name still resolves to this identity"
means "this is still the entry we made".

Every recorded identity comes from a pin taken at the moment of creation: a
created file from the descriptor it was written through, a created directory
from the re-opened name it must find EMPTY, a hard-linked child from a pin
checked against the source link that still holds the same inode. Because each
pin costs a descriptor, a rename places at most 512 entries and refuses a larger
folder outright, rather than placing what it could not take back again — and it
reads the folder LAZILY, so that ceiling bounds the read as well and no
hand-authored million siblings are listed into memory before the refusal. Taking
a pin can itself fail, under descriptor pressure most plausibly; a primitive
that cannot pin what it just created takes the creation back on the spot,
because a created name whose ownership nothing can prove is one no undo would
ever dare remove.

Rollback draws the same distinction between staging and restoring. Registering a
path puts it in the commit; only a path the mutation reports having CHANGED is
handed to `git checkout HEAD --`, because that command reverts whatever differs
from the commit regardless of who wrote it. The report follows the change rather
than the intent: a write reports at the truncating OPEN, which is where the old
bytes go, and a removal reports only after it succeeded, because an inode-bound
removal that refuses has put the hand author's file back and changed nothing. So
an operation that refused leaves a concurrent edit exactly as it found it, and
the post-rollback status check reports the tree instead of quietly reverting
somebody else's work — while an operation that DID change a path still has it
restored, which is what keeps a refused commit (a rejecting `pre-commit` hook,
say) from leaving an edit, a rename or a delete applied.

There is one thing no syscall offers: creating a directory and receiving its
descriptor in the same step. A reservation may therefore turn out to be a
directory a hand edit created in that instant. It cannot cost anything: the
reservation must be EMPTY when it is opened, everything written into it goes
through that descriptor, and every name below it is claimed with a
create-or-fail call. When the public name stops resolving to the reservation,
the mutation refuses and says so.

Undo follows the same rule as placement. A file is removed only while it is
still the PINNED inode this mutation linked, a directory only while it is still
the pinned one this mutation made and empty, and the destination folder only
while the name still resolves to the pinned reservation. So a folder another
author removed and recreated under the same name is left entirely alone,
including a `SKILL.md` of their own inside it, however the inode numbers fell. A
supporting file moved aside for removal is restored with `link`, which fails
rather than overwriting a file that appeared at its name. What an undo cannot
remove without destroying someone else's content, it leaves — and the
post-rollback status check reports it. A leftover is a complaint, never a
deletion.

Nothing a directly authored library contains is read without a bound. The scan
reads folders in batches rather than opening two descriptors per folder at once,
and reads each `SKILL.md` up to a generous cap instead of in full; the
supporting-file tree holds only as many names at a time as it could ever answer
with, and stops the moment an entry, metadata or depth bound is reached;
`skill_list` bounds both of its lists and reports the true totals with an
explicit `truncated`. An attachment import is checked against the per-file and
whole-batch budgets on its RECORDED SIZE before a byte of it is read, and the
read itself is bounded — looping to EOF, because one `read` is not a whole file,
and refusing when what arrives is not the size the budgets were spent on, since
a prefix of somebody's binary file is not what anyone asked to import.

Bounds are the viewer's, not new ones: `SKILL.md` source is bounded at
`MAX_SKILL_BODY_BYTES` (256 KiB), one supporting text write at
`MAX_SKILL_FILE_PREVIEW_BYTES` (256 KiB), one attachment import at
`MAX_SKILL_RAW_FILE_BYTES` (10 MiB), and one batch at 20 operations and 16 MiB.
A path may not be absolute, traverse, contain a backslash or NUL, or be
`SKILL.md` itself.

Commits are attributed from `ToolCallContext.session` with a deterministic local
author (`<actor-slug>@skills.local`) and `Skill-Actor`, `Skill-Session`,
optional `Skill-Task`, `Skill-Names` and `Skill-Paths` trailers. `Skill-Paths`
is a JSON array so every legal Git filename remains exact and unambiguous.
Signing and detached auto-GC are disabled PER INVOCATION rather than written
into the user's repository config, so a commit depends on no machine-global Git
setting and no maintenance process outlives the lock. The result returns the
full and short commit ids and the paths the commit actually changed.

A trailer block is line-structured, so provenance is bounded single-line text on
both sides of the seam. The tools refuse a `reason` over 200 characters or a
`taskId` over 64, and refuse either carrying a newline or control character —
that is model-supplied input, and a value that would forge a `Skill-*` line is
not a reason. The store sanitizes as well, so a session title (which the user
chose, not the model) becomes one bounded line rather than a refusal.

History reads are bounded the same way. `git log` returns the subject and
trailers only, with the subject truncated BY GIT, and the stream is capped:
loading whole commit messages meant one hand-authored megabyte-long message
could overflow the executor and be reported as an EMPTY history. Nothing else
may report one either. An UNBORN repository is the single empty answer, decided
by a `rev-parse` whose EXIT status is distinguished from a git that could not
run at all; every other failure throws. And when the cap cuts the stream, the
partial trailing record is kept if its identity fields are complete — they come
first — rather than dropped, because dropping it turned a single commit with an
enormous trailer block into "this library has no history". The read says
`truncated` when older commits were left unread, so a bounded answer is never
mistaken for a short one. A diff also streams under the shared read fan-out
bound and stops with its caller — an abandoned call kills the Git process, and
one still QUEUED for a slot leaves the queue immediately instead of waiting for
a stranger's read to finish.

### Rename and delete consequences

A session freezes declared NAMES (see below), and the global toggle map is keyed
by name as well. A rename therefore has effects no tool tries to hide: sessions
that already froze the old name keep it and can no longer materialize it, the
old name's stored `"on"` stays as the user's historical decision, and the new
name defaults off until the user enables it — exactly the existing missing-skill
settings contract. Deleting has the same shape: frozen sessions and stored
settings are not rewritten. Both tools state this in their result rather than
attempting a non-atomic cross-store settings migration.

Git history is the recovery path for a delete or an unwanted rename. This slice
deliberately ships no restore or revert tool, and no remote/push management.

## Global on/off state

`AppSettings.skills` is a sparse map from declared skill name to `"on"` or
`"off"`. A name with no entry resolves OFF, and `isSkillEnabled` in
`app/shared/skills.ts` is the one rule every surface reads it through: absence,
an empty section, and settings that have not been fetched yet all mean off, so
nothing but a deliberate `"on"` ever enables a skill. A stored `"off"` is kept
rather than pruned — it is what the user said — and has exactly the effect of
absence.

The map is keyed by declared name, not source folder: the name is what a session
freezes and what a runtime layout materializes, so renaming a folder does not
change which skill is on.

`settings.ts` normalizes the section on read and on write. An entry is dropped
when its key is not a safe skill name or its value is not exactly one of the two
states; nothing is coerced, because reading a stray truthy value as `"on"` would
enable a skill nobody enabled. An entry whose name the current scan does not
declare is KEPT: the library is hand-authored, so a name goes missing during an
edit, a rename, a branch switch, or a scan that failed entirely, and dropping
the entry would silently discard the decision. Normalization therefore never
consults the scanner.

A patch replaces the whole section, so a control sends every entry it is
keeping, and only a real map may replace it — `updateSettings` ignores anything
else and `validateClientMessage` rejects a section that is not a map of the two
states. Both matter in the same direction: the normalizer answers a malformed
value with an empty map, which would otherwise turn off every skill the user
enabled. An empty map is still a legitimate patch; that is how the last entry
goes.

`/settings/skills` renders one toggle per valid scanned skill. A row from the
diagnostics list has no toggle: there is no valid declared name to enable. The
control holds no state of its own — it renders `settings.skills` and asks
`useAssistant` to turn one name on or off — so a click that was not persisted
cannot leave a skill looking enabled, and the settings echo is what turns it on.

Because nothing moves on screen before that echo, the map a write is built FROM
cannot be the displayed one: while a save is in flight the displayed map still
lacks the change it carries, so a second toggle built on it would send a
replacement that turns the first skill back off. `useAssistant` therefore keeps
the map it last SENT, never rendered, and starts the next write from it.

Writes overlap, so that base is keyed by REQUEST and only its own answer retires
it. Each write is echoed as the server stores it, and an echo names no request:
one arriving while a later write is still out describes settings the browser is
already ahead of, and clearing the base on it would send the next toggle without
the change in flight — turning that skill back off, the same defect one step
later. The answer that does retire it is the `mutationSettled` naming that
request (sent after the echo, so the stored state is already applied), or its
refusal, or the mutation timeout: a write the server did not take must stop
being re-asserted by later ones. A dropped socket discards the base too —
nothing sent is then known to have arrived. Once nothing is in flight, the base
is `settings.skills` again, which is what the server actually holds, including
where it dropped an entry it will not store.

Project and session scopes ([Task-532](pa://task/532)) are later layers. Phase 1
passes the global map as the resolver's only explicit layer.

## Session resolution and freezing

`sessionSkills.ts` is the one lifecycle seam. For `developer` and `workshop`
sessions it scans the current working tree, intersects the valid summaries with
the ordered settings layers, sorts the resulting declared names, and stores the
JSON list in `session_skills`. The row is INSERT-ONLY: the first successful
freeze wins for the session's life. Settings or library changes therefore affect
new sessions only; reopen and resumed turns read the stored list rather than
resolving again.

The seam runs on ordinary pi and Claude creation, approved peer spawns, workflow
executor role creation, forks, and the common runtime prompt boundary. The
runtime boundary is the backstop for every resume path and for legacy sessions:
a pre-upgrade coding session with no row freezes when it is first started by the
upgraded runtime, before the runtime session exists or a user turn is appended.
Rendering `SessionState` is read-only and never creates that missing row.

A fork first reads (or, for a legacy parent, freezes) the parent's list and
inserts that exact list for the child. It does not resolve against current
settings. Concurrent starts are safe because every contender reads back the row
that won the insert.

`assistant`, `personal-assistant`, and `workflow-coordinator` never scan,
resolve, or persist library skills. Their `SessionState` omits `activeSkills`.
Coding sessions carry `activeSkills` even when it is empty; both harness
projections read only `session_skills`. Malformed frozen JSON fails closed to an
empty list and remains the freeze rather than being replaced from live settings.

A frozen name makes a skill AVAILABLE, not loaded: only its name and description
reach the model, and the `SKILL.md` body enters the context when the agent asks
for it. `SessionState.skillInvocations` is that record — a bounded, newest-last
trail present exactly when `activeSkills` is, derived from the committed
transcript by `skills/skillInvocations.ts` at projection time, never stored. Two
calls count: Claude's native `Skill` tool naming the skill under this session's
own runtime plugin (`pa-skills-<hash16>:<name>`; an unqualified or foreign
qualifier is a repository or CLI skill sharing the name), and a read of the
materialized `<hash>/skills/<name>/SKILL.md` (Claude `Read`, pi `read`) — the
location both harnesses advertise and what pi's skill prompt asks the model to
do. A call counts only once its result is in and not an error: a refused read or
failed Skill call put nothing in context, and a call still running has not yet.
A shell `cat`, a supporting file, or the library source folder is invisible to
it. Claude walks its committed entries, pi its persisted branch rather than
`state.messages`, which a context clear empties.

The session inspector shows each library skill in one of three states: loaded
(with the count and the last load), available (mounted, body not in context), or
not mounted. It is informational only: global controls remain in Settings →
Skills.

Both harnesses consume that frozen name list directly. Neither harness resolves
live settings while building resumed-session options.

## Generated runtime layouts

`DATA_DIR/skills-runtime` contains generated, shared harness layouts. It is
separate from the library, is never source of truth, and is not created or
written by the library bootstrap. For a sorted unique frozen name set, the
directory name is the lowercase full SHA-256 of the JSON-encoded name array.
Input order and duplicate names therefore do not change its identity:

```text
DATA_DIR/skills-runtime/<name-set-hash>/
  .claude-plugin/plugin.json
  .pa-skills-runtime.json
  skills/
    <declared-name> -> DATA_DIR/skills/<source-folder>
```

The generated Claude manifest makes the hash directory a valid local plugin. The
`skills/` child is pi's additional skill root. Each declared-name child is one
symlink to the whole scanner-identified source folder, never a link to
`SKILL.md` alone, so relative scripts, references, and assets remain available.

Whole-folder symlinks are the shared representation for both harnesses. A live
compatibility check on 2026-08-24 passed with Claude Agent SDK 0.3.219 and
Claude Code CLI 2.1.222, including a skill reading a relative supporting file
through the link. No Claude-only copy fallback or copy-refresh rule is needed.
Because the links retain the library working tree as source, uncommitted edits
to files inside an unchanged source folder are visible immediately without
rematerialization.

Materialization accepts one complete scanner result and resolves every requested
frozen name only through its valid summaries. Missing, malformed, duplicate, or
unsafe names fail loudly; a caller cannot supply a source path. The materializer
also rejects malformed summary paths, missing source folders or `SKILL.md`, and
a source folder that is a symlink at materialization time. A same-name skill
moved to another source folder causes the hash directory's link topology to be
regenerated from the newer scan.

Construction happens in a unique sibling staging directory. The manifest,
whole-folder links, and completion metadata are all written there before one
atomic rename publishes the hash directory. Repeated and concurrent calls
validate and reuse an already complete matching directory. An interrupted or
otherwise partial hash directory is quarantined and replaced atomically; stale
staging/quarantine directories are generated debris, not valid layouts. Library
bootstrap never creates or writes these generated directories.

## pi injection and precedence

`piSdk/options.ts` gives `developer` and `workshop` resource loaders the
materialized `<hash>/skills` directory as `additionalSkillPaths`. It first scans
the current library and materializes the session's frozen names, including the
deterministic empty-set layout. Missing or now-invalid frozen names fail option
construction instead of silently shrinking a session's skill set. The loader
retains those names and repeats the same scan/materialization before every
resource reload, so a generated layout removed by cache cleanup is recreated
without consulting live settings. Creation, reopen, and fork all reach that
builder through `piStore` with the list returned by the insert-only session
freeze.

pi loads its normal profile skill directory and the repository's `.pi/skills`
before `additionalSkillPaths`. If a normal and library path resolve to the same
`SKILL.md`, pi deduplicates that realpath silently. If distinct skill folders
declare the same name, the earlier normal skill wins and pi emits its
`collision` diagnostic for the losing library path. A repository `.pi/skills`
skill therefore deliberately shadows a same-name library skill. Supporting files
keep working because the injected path is the runtime symlink to the whole
library folder, and pi resolves relative references against that scanned folder.

`assistant`, `personal-assistant`, and `workflow-coordinator` keep
`noSkills: true`; they receive no library path even if a caller supplies frozen
names.

## Claude injection and repository discovery

Every ordinary Claude query for a `developer` or `workshop` session reads the
session's insert-only frozen name row, rescans the current library working tree,
and materializes or validates that exact generated runtime before calling the
SDK. This applies to the first query, every provider resume, and a fork's first
resumed query. Removing generated output is therefore recoverable; changing
settings cannot move an existing session. A frozen name that is no longer valid
fails query preparation loudly rather than silently shrinking the set.

A non-empty set adds exactly one SDK plugin:

```text
{ type: "local", path: DATA_DIR/skills-runtime/<hash>, skipMcpDiscovery: true }
```

An empty set adds no plugin. `assistant`, `personal-assistant`, and
`workflow-coordinator` add no plugin and retain `settingSources: []`, even if a
caller supplies names. Coding personas continue to omit `settingSources`, so
normal project settings and repository `.claude/skills` discovery retain the CLI
defaults. The SDK `skills` filter is deliberately omitted: library plugin
injection augments repository skills rather than replacing or filtering them.
Plugin skill names are Claude's plugin-qualified names; repository and plugin
precedence otherwise remain the CLI's behavior.

The `Skill` tool stays in the coding-persona `tools` allowlist in both Build and
Plan modes. Loading skill context is non-mutating even when the instructions
later describe edits. Manual `/compact` is a different, CLI-local path: it
carries the frozen list through option construction for continuity but sets the
explicit no-tool policy, mounts no plugin, exposes neither `Skill` nor
`ToolSearch`, and does not recreate generated output. Compaction cannot invoke a
skill and must not pay discovery work accidentally.

## Source of truth and garbage collection

Runtime layouts and their completion metadata are caches, never authored state
and never an input to library scanning. The current library working tree is the
content source of truth; a session's frozen name list is the selection source of
truth. A runtime layout cannot rescue a frozen name that is no longer valid in a
fresh scanner result.

A layout can be regenerated from its frozen names and a current scan, so unused
hash directories may be garbage-collected. Garbage collection must not remove a
layout currently referenced by a live harness process. Orphan staging and
quarantine directories may be removed only when no materialization using that
runtime root is active. Automated garbage collection is not part of Phase 1.
