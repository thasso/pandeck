# Agent definitions

**Status:** design for [Task-780](pa://task/780). The shared library core is
implemented ([Task-781](pa://task/781)); the agent library, spawning by name,
and the UI are not yet.

An agent definition is a user-authored Markdown file that describes a reusable
agent: which persona it builds on, which model and effort it runs at, which
tools it must not use, and the role instructions it follows. Any session can
spawn one by name ("spawn a test-reviewer agent"), and the result is an ordinary
peer session the user can watch and take over.

## Skill or agent

A skill and an agent definition answer different questions:

- A **skill** says how to do something. It loads into the context of the agent
  that is already running, when that agent asks for it.
- An **agent definition** says who does it. Spawning one creates a fresh session
  with its own context, persona, model, effort, narrowed tools, and role
  instructions, and that session reports back to whoever spawned it.

Use an agent definition when the job needs fresh context, a different model, or
fewer tools than the caller has. A reviewer that must not share the
implementer's context and must not push is the typical case. Procedures that any
agent can follow in place stay skills, and an agent definition can mount skills
for its own use.

Other tools have the same idea: opencode reads `.opencode/agent/*.md` and Claude
Code reads `.claude/agents/*.md`. Both run their agents in-process as subagents.
Pandeck runs each one as a full peer session through the existing
`session_spawn` path, so the frontmatter keys match theirs where the meaning
matches (`name`, `description`, `model`, `tools`) and differ where Pandeck needs
more.

## The library

Definitions live in `DATA_DIR/agents`, a dedicated Git working tree owned by the
user. It follows every storage rule of the skills library (`docs/skills.md`):
lazy idempotent bootstrap with `git init -b main` and nothing more, the user
owns branches and remotes, hand-authoring is first-class, and tool mutations
refuse to run while the tree holds uncommitted changes.

```text
DATA_DIR/agents/
  <source-folder>/
    AGENT.md
    ... optional supporting files
```

The layout is the skills layout with `AGENT.md` in place of `SKILL.md`. That is
deliberate: the scanner, the anchored no-follow reads, rename as a folder move,
delete, and the supporting-file tools all work unchanged. A definition rarely
needs supporting files, since reference material belongs in a skill that the
definition mounts, but the layout costs nothing to keep.

## The file

```markdown
---
name: test-reviewer
description:
  Verifies that the tests a branch adds fail without its code changes. Use after
  an implementer reports done.
persona: developer
model: opus
effort: high
tools:
  deny: [worktree_commit, worktree_push, worktree_create_pull_request]
---

You are a test reviewer. ...
```

| Key           | Required | Meaning                                                                                            |
| ------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Declared name; same rule as skills (`isSafeEntryName` in `app/shared/library.ts`).                 |
| `description` | yes      | When to use this agent. What callers see when they choose one. Same bounds as a skill description. |
| `persona`     | yes      | `developer` or `assistant`, the same values `session_spawn` accepts as `agentType`.                |
| `model`       | yes      | An alias or an exact model id. See [Model and effort](#model-and-effort).                          |
| `effort`      | no       | A `ThinkingLevel`. Lowered to what the model supports. Defaults to the model's default.            |
| `tools.deny`  | no       | Tools this agent must not have. Can only narrow the persona's tools. See [Tools](#tools).          |
| `skills`      | no       | Library skills to mount for this agent, on top of the globally enabled set. `developer` only.      |

The body is the role instructions. It must be non-empty, and the whole
`AGENT.md` has a size bound (`maxManifestBytes`, proposed: 16 KiB) so a
definition cannot carry a prompt the persona budgets never accounted for.

One rule decides validity, and the scanner and the authoring tools ask it from
both sides, as `library/entryManifest.ts` does for skills. A hand-written file
the rule rejects shows up as a scan diagnostic. The tools refuse to write one.

## Model and effort

`model` takes:

1. An exact model id from a connected account (`claude-opus-5-5`, `gpt-6-luna`).
   This pins a version.
2. A Claude family alias: `opus`, `sonnet`, `haiku`, `fable`. These are what
   `claudeModelAlias` already resolves to and what the Claude SDK accepts, so
   `opus` follows the latest Opus.
3. A short OpenAI name (`luna`) that matches exactly one model id from the
   connected OpenAI accounts on a whole hyphen-separated token. More than one
   match, or none, is a validation error, never a guess.

The resolved model decides the provider and therefore the harness. `effort` is
clamped with `supportedThinkingLevelsForModel`, as spawn already does for
thinking hints.

Validation at write time checks that the model resolves against the accounts
connected right now. A spawn resolves it again. A model that stopped resolving,
because an account was removed, refuses the spawn with the reason. There is no
fallback to another model.

### The account

A definition never names an account. A spawn takes the account for the resolved
provider from ONE function, which calls `automaticProfileIdFor(provider)` today:
the first enabled account for that provider, in Settings order. Usage-aware
account routing is out of scope here and will replace that function without
touching anything else in this design.

## Tools

`tools.deny` lists tools the spawned session must not have. It narrows the
persona's normal toolset and can never add to it. Entries are:

- **App tools** by their unprefixed name (`worktree_push`, not
  `mcp__pa__worktree_push`). The session tool server's existing active-tool
  filter (`activeToolNames` in `mcp/sessionToolServer.ts`) removes them.
- **Native capabilities** by harness-neutral names: `bash`, `edit`, `write`.
  Each harness maps them to its own tools: Claude's `disallowedTools`, pi's tool
  policy. Reading stays available to every agent.

An entry naming a tool the persona does not have, or no tool at all, is a
validation error. A typo would otherwise silently leave a tool enabled.

Removing a deny entry gives back a tool the persona has anyway, so it is not an
escalation. Approvals, Plan mode, and every other gate apply to the spawned
session exactly as they apply to any session of that persona.

## Authoring tools

The `agent_*` tools mirror the `skill_*` tools (`docs/skills.md`) and come from
the same code: `agent_list`, `agent_get`, `agent_read_file`, `agent_create`,
`agent_edit`, `agent_manage_files`, `agent_rename`, `agent_delete`,
`agent_history`, `agent_diff`. They are one deferred catalog group for the
`assistant`, `personal-assistant`, `developer`, and `workshop` personas. Reads
are `sideEffects: "none"` and mutations `"local"`, so Plan mode exposes only the
reads. Every mutation needs a reason, may name a Task, and is one commit with
the session's provenance.

### Model and effort changes need approval

The Settings roster of approved peer runtimes exists so the user controls what
spawned sessions cost. A definition that names its own model moves that control
into the file. A hand edit is the user's own choice. An agent-tool mutation that
sets `model` or `effort` on create, or changes either on edit, therefore goes
through an approval card (`docs/approvals.md`) showing the old and new values.
Nothing is written or committed until the user approves. Mutations that leave
both keys alone commit directly, like skill mutations.

## Spawning by name

`session_spawn` gains:

- `operation: "agents"`, read-only and available in Plan: the valid definitions
  as name, description, persona, and resolved model and effort. Diagnostics are
  included so a caller knows why a definition it was told about cannot be used.
- An `agent` field on a `spawn` row, naming a definition. The row then needs no
  `profileId` and no `agentType`. Model, effort, and persona come from the
  definition and the account from the account function. `worktreeId` is still
  required for a `developer` definition. `title` and `prompt` stay required: the
  prompt is the target and the task, the definition is the role.

The opening prompt still carries the coordinator's session id and the
instruction to report back, as for any spawn.

### What a spawn freezes

At spawn the server resolves the definition and stores it in an insert-only
per-session row: name, the `AGENT.md` blob hash, resolved persona, provider,
model, effort, deny list, mounted skills, and the body text. Like
`session_skills`, the first insert wins for the session's life, a fork copies
the parent's row, and resumes read the row rather than the library. Editing or
deleting a definition affects new spawns only.

The row needs a migration (`docs/migrations.md`). It adds a table, so existing
data stays readable.

### How the definition reaches the model

- The body is one more system-prompt layer, appended after the persona's layers.
  It survives compaction and the coordinator cannot paraphrase it away, which it
  could if the body travelled in the opening prompt.
- The deny list feeds the active-tool filter and the native-tool mapping above.
- `skills` joins the globally enabled skills in the session's frozen skill list,
  so the skills runtime mounts them through the existing path.

The session inspector shows the agent name with a link to its definition, as it
shows frozen skills.

## Shared library core

Agents are the second Git-backed library, and they are not a copy of the first.
The kind-neutral parts of the skills library are one core that takes a
`LibraryKind` ([Task-781](pa://task/781), implemented):

| Module                                            | Owns                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `library/libraryKind.ts`                          | The descriptor: nouns, manifest file, trailer prefix, manifest rule, publish. |
| `library/libraryStore.ts`                         | Bootstrap, clean-tree refusal, locked commit with provenance, history, diff.  |
| `library/entrySource.ts`                          | Anchored no-follow access to an entry's files.                                |
| `library/libraryScanner.ts`                       | Scan and diagnostics, with the manifest rule supplied by the kind.            |
| `library/entryManifest.ts`                        | The shared `name` + `description` rule, formatting, declared-name rewrite.    |
| `library/libraryAuthoring.ts`                     | Create, edit, rename, delete, manage files, post-write scan check.            |
| `library/entryFiles.ts`, `library/entryDetail.ts` | Bounded file tree and reads, one entry by declared name.                      |
| `tools/library/libraryTools.ts`                   | The tool factory that builds a kind's `<prefix>_*` group.                     |
| `app/shared/library.ts`                           | Kind-neutral summary, diagnostic, file-tree and detail wire types.            |

A kind supplies its descriptor, its manifest rule (built from the shared one),
how a create renders its manifest, and the consequences its rename and delete
tools report. Skills are `skills/skillLibrary.ts` (descriptor, store, topic),
`skills/createSkill.ts` and `tools/skills/skillLibraryTools.ts` (the factory
spec). The `skill_*` tools the factory builds are byte-identical to the
hand-written ones they replaced: names, labels, descriptions and parameter
schemas.

These stay skills-only: the global on/off map, session freezing
(`sessionSkills.ts`), the runtime materializer, and invocation tracking. Agents
have their own freeze (above) and no on/off map: a definition the user does not
want is deleted or renamed. The skills browser topic and HTTP reads are still
skill-specific; they become per-kind when the Agents page needs them
([Task-784](pa://task/784)).

The core's wire and message vocabulary is kind-neutral where a kind name would
be wrong for another kind: the file-level diagnostic codes are
`missing-manifest`, `unreadable-manifest` and `symlinked-source`, a detail read
answers `kind: "entry"`, and a removal moves its tree aside as
`.pa-removing-<uuid>`. Every message the core builds that names the kind
(`skill`, `skills repository`, `Skill-*` trailers) comes from the descriptor, so
those are unchanged for skills. The low-level filesystem errors in
`entrySource.ts` have no kind and say `library` instead
(`symlinked library source`); they reach an agent only embedded in a write or
edit refusal.

A kind with fields beyond `name` and `description` builds its rule with
`parseManifestWith`, which runs the shared checks and hands the kind the same
frontmatter mapping and issue list. `LibraryKind<M>` types that manifest for
code holding the concrete kind; the store and the core see only the base
`LibraryKind`, so kind-specific code (agent spawning) uses its own kind
directly. `library/libraryKind.test.ts` proves the core with a fixture kind
(`WIDGET.md`, `Widget-*` trailers) that is not a skill.

`parseManifest` judges content only: the core may hand it a body clipped to its
own read bounds. A kind that bounds its manifest's size sets `maxManifestBytes`,
and the core enforces that from the file's real size at every scan, detail read,
source read, edit, rename and create, and when the manifest is read as a file,
reporting `manifest-too-large`. Skills set none and keep their large bodies. A
rule may read the body only when `maxManifestBytes` is within the core's
smallest read bound (256 KiB), so every path hands it the whole file; otherwise
it depends on the frontmatter alone.

The test for "shared enough": adding a third library kind needs a manifest rule,
a kind descriptor, a create renderer, and nothing else.

## UI

Settings gets an Agents page next to Skills, built from the same components: the
list, diagnostics, the file viewer, and history. The new-session picker can
start a session from a definition, with the definition's persona, model, and
effort preselected. This comes last. Agent-driven spawning does not depend on
it.

## Out of scope

- **Account routing.** One function picks the account. Usage-aware routing is
  being built separately.
- **Workflow roles.** The code-delivery recipe could later fill a role from a
  definition. `docs/agent-workflows.md` lists declarative definitions as
  deferred, and this design does not change that.
- **Repository-local definitions** such as `.pandeck/agents/`. The user-owned
  library comes first.
- **Allow lists and widening.** A definition only ever removes tools.
