# Agent definitions

**Status:** implemented by [Task-780](pa://task/780): the shared library core
([Task-781](pa://task/781)), the agent library with its `agent_*` tools
([Task-782](pa://task/782)), spawning by name ([Task-783](pa://task/783)), and
the UI ([Task-784](pa://task/784)).

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

| Key           | Required | Meaning                                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`        | yes      | Declared name; same rule as skills (`isSafeEntryName` in `app/shared/library.ts`).                     |
| `description` | yes      | When to use this agent. What callers see when they choose one. Same bounds as a skill description.     |
| `persona`     | yes      | `developer` or `assistant`, the same values `session_spawn` accepts as `agentType`.                    |
| `model`       | yes      | An alias or an exact model id. See [Model and effort](#model-and-effort).                              |
| `effort`      | no       | A `ThinkingLevel`. Fitted to the levels the model supports. Defaults to `medium`, fitted the same way. |
| `tools.deny`  | no       | Tools this agent must not have. Can only narrow the persona's tools. See [Tools](#tools).              |
| `skills`      | no       | Library skills to mount for this agent, on top of the globally enabled set. `developer` only.          |

The body is the role instructions. It must be non-empty, and the whole
`AGENT.md` has a size bound (`maxManifestBytes`, proposed: 16 KiB) so a
definition cannot carry a prompt the persona budgets never accounted for.

One rule decides validity, and the scanner and the authoring tools ask it from
both sides, as `library/entryManifest.ts` does for skills. A hand-written file
the rule rejects shows up as a scan diagnostic. The tools refuse to write one.

## Model and effort

`model` takes:

1. An exact model id from a connected account (`gpt-6-luna`). This pins a
   version. When two providers offer the same id, `provider/id`
   (`openai-codex/gpt-6-luna`, or a pin such as `claude-sdk/claude-opus-5-5`)
   names one of them.
2. A Claude family alias: `opus`, `sonnet`, `haiku`, `fable`. With the Claude
   integration enabled these are the Claude SDK's own model ids, so `opus`
   follows the latest Opus; without it, an alias is matched like any short name
   (rule 3) and can be ambiguous. A concrete Claude id (`claude-opus-5-5`) pins
   a version: it resolves to its alias only while that alias runs exactly that
   version (`pinnedModelIdsFor` in `harnesses/models.ts`), and is refused once
   the alias has moved on, never carried along to a newer one.
3. A short name (`luna`) that matches exactly one model id from the connected
   accounts on a whole hyphen-separated token. More than one match, or none, is
   a validation error, never a guess.

The resolved model decides the provider and therefore the harness. `effort` is
fitted to the levels the model supports (`clampThinkingLevelForModel`, which
tries the next level up before the next one down), as spawn already does for
thinking hints. A definition without `effort` runs at `medium`
(`AGENT_DEFAULT_EFFORT`), fitted the same way. The card shows that level, and
approval checks it like an explicit one (`checkAgentRuntime`).

Validation at write time checks that the model resolves against the accounts
connected right now. A spawn resolves it again. A model that stopped resolving,
because an account was removed, refuses the spawn with the reason. There is no
fallback to another model.

### The account

A definition never names an account. A spawn takes the account for the resolved
provider from ONE function (`accountFor` in `agents/agentSpawn.ts`), which calls
`automaticProfileIdFor(provider)` today: the first enabled account for that
provider, in Settings order. An account that does not offer the resolved model
refuses the spawn. Usage-aware account routing is out of scope here and will
replace that function without touching anything else in this design.

## Tools

`tools.deny` lists tools the spawned session must not have. It narrows the
persona's normal toolset and can never add to it. Entries are:

- **App tools** by their unprefixed name (`worktree_push`, not
  `mcp__pa__worktree_push`). They leave the session's toolset entirely
  (`withoutDeniedTools` in `agents/sessionAgent.ts`): Claude's session tool
  server neither lists nor serves them (`claudeSdk/toolServer.ts`), and pi never
  registers them (`piSdk/options.ts`), nor can its `find_tools` find or load
  them. pi also excludes the name itself, so a pi built-in or extension tool of
  the same name (`ls`) stays off whatever the repository's pi settings enable.
- **Native capabilities** by harness-neutral names: `bash`, `edit`, `write`, for
  the `developer` persona (an `assistant` has none). Claude drops them from
  `tools:` and therefore lists them in `disallowedTools` (`bash` → `Bash` and
  `Monitor`, which runs commands too; `edit` → `Edit`, `MultiEdit`,
  `NotebookEdit`; `write` → `Write`). pi excludes its built-ins of the same
  names. `bash` stands for command execution as a whole, so in pi it also
  excludes `powershell` and drops the background `bash` and `monitor` tools.
  Reading stays available to every agent.

An entry naming a tool the persona does not have, or no tool at all, is a
validation error. A typo would otherwise silently leave a tool enabled.

Removing a deny entry gives back a tool the persona has anyway, so it is not an
escalation. Approvals, Plan mode, and every other gate apply to the spawned
session exactly as they apply to any session of that persona.

## Authoring tools

The `agent_*` tools are the shared library tool factory
(`tools/library/libraryTools.ts`) with the agent kind's spec
(`tools/agents/agentLibraryTools.ts`): `agent_list`, `agent_get`,
`agent_read_file`, `agent_create`, `agent_edit`, `agent_manage_files`,
`agent_rename`, `agent_delete`, `agent_history`, `agent_diff`. They are one
deferred catalog group (`agents`) for the `assistant`, `personal-assistant`,
`developer`, and `workshop` personas. Reads are `sideEffects: "none"` and
mutations `"local"`, so Plan mode exposes only the reads. Every mutation needs a
reason, may name a Task, and is one commit with `Agent-*` provenance trailers.

`agent_create` takes the definition as fields (`persona`, `model`, `effort`,
`denyTools`, `skills`, `body`) and renders `AGENT.md` deterministically
(`formatAgentManifest`). Before anything reaches the user, the definition must
satisfy the content rule and the runtime check (`agents/agentRuntime.ts`): the
model resolves against the enabled accounts, the denied tools are the persona's
own or native, the skills are valid library skills.

### Model and effort changes need approval

The Settings roster of approved peer runtimes exists so the user controls what
spawned sessions cost. A definition that names its own model moves that control
into the file. A hand edit is the user's own choice. An agent-tool mutation that
sets what a definition runs on therefore goes through an `agentDefinition`
approval card (`docs/approvals.md`):

- **Create** always sets a model, so every `agent_create` is a card. It shows
  the persona, the model as written and the connected model it resolved to, the
  effort, and the complete `AGENT.md`. Nothing is written until approval; the
  executor checks the runtime again and creates the entry.
- **Edit** is previewed first (`previewEntryEdit`). When the result changes
  `model` or `effort`, it is a card showing before and after, and the executor
  applies the same edits only if the model still resolves to what the card
  showed, at the effort the card showed, and the locked result is byte-for-byte
  the `AGENT.md` the card showed, so a hand edit made while the card waited
  refuses rather than being carried along. An edit may never change the declared
  name: the card names its target by it. Any other edit commits directly; inside
  the locked write it is judged again (`editEntrySource`'s `check`), and the
  file must still hold the bytes that were judged when the write starts: model
  and effort must still be unchanged, and the denied tools and skills must still
  exist. Every locked agent edit, approved or direct, also re-reads the file
  after its check and refuses if a hand edit landed meanwhile, leaving that edit
  in place. A direct edit does not re-resolve the model, so a definition whose
  account went away can still have its instructions fixed.
- Rename, delete and supporting files never change what a definition runs on and
  commit directly; `AGENT.md` itself is refused by `agent_manage_files`.

## Spawning by name

`session_spawn` has:

- `operation: "agents"`, read-only and available in Plan: every definition with
  its description, persona, and the model, effort and account it would run on
  now. A definition that cannot be spawned is listed with the reason, so a
  caller knows why one it was told about cannot be used.
- An `agent` field on a `spawn` row, naming a definition. The row then takes no
  `profileId` and no `agentType`; stating either is refused. Model, effort, and
  persona come from the definition and the account from the account function.
  `worktreeId` is still required for a `developer` definition. `title` and
  `prompt` stay required: the prompt is the target and the task, the definition
  is the role. A `propose` row may not name an agent: the user already approved
  what a definition runs on.

The opening prompt still carries the coordinator's session id and the
instruction to report back, as for any spawn.

A spawn reads the definition twice (`resolveAgentSpawn` in
`agents/agentSpawn.ts`). The first read, with every row's structural check,
turns an unknown, invalid or unrunnable definition into a tool error with
nothing created. The second runs immediately before the row's session is
created, like a roster row's late resolution: a definition edited in between
runs as edited, one that stopped resolving fails that row, and one whose persona
changed fails it too, since the row was checked for the old persona.

### What a spawn freezes

The second read is frozen in the insert-only `session_agent` table (migration
`0079_session_agent.sql`): name, the `AGENT.md` git blob id, persona, provider,
model, the concrete version a definition pinned (`claude-opus-5-5` rather than
`opus`), effective effort, deny list, the definition's own skills, and the body
text. Like `session_skills`, the first insert wins for the session's life, a
fork copies the parent's row, and resumes read the row rather than the library.
Editing or deleting a definition affects new spawns only. A row that does not
parse fails closed: the session refuses to run rather than run without its role
and its denied tools.

The session runs the model it was spawned on, never one a harness picks:

- A Claude query of a pinned definition runs the pinned version while the
  session is on the definition's alias, however the alias is mapped later
  (`claudeQueryModel` in `claudeSdk/options.ts`, which also picks the model a
  retained process switches to). A model the user switched the session to runs
  as usual.
- pi restores a session's model from its messages. An agent session without any
  (a fork before the first prompt, a spawn reopened before it ran) starts on its
  branch's last selected model, else the frozen one, and refuses when the
  account no longer offers it. One whose model pi cannot restore refuses to
  resume rather than fall back to another (`piSdk/piStore.ts`).

### How the definition reaches the model

- The body is one more system-prompt layer, `## Agent definition: <name>`,
  appended after the persona's layers on both harnesses (`agentPromptLayer`). It
  survives compaction and the coordinator cannot paraphrase it away, which it
  could if the body travelled in the opening prompt. It ends by naming the
  denied tools, since the persona's own layers may still mention them.
- The deny list removes tools as described in "Tools".
- `skills` joins the globally enabled skills in the session's frozen skill list
  (`sessionSkillPreset`), so the skills runtime mounts them through the existing
  path.

The session inspector's Agent section shows the frozen name, model, effort,
denied tools, skills and blob id; the name opens the definition on the Agents
page (`/settings/agents?entry=<name>`), as the library holds it now.

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
want is deleted or renamed. The browser reads are per library too: one topic and
list message (`library/libraryPublish.ts`), one HTTP surface
(`library/libraryHttp.ts`) and one settings page (`LibrarySettingsSection`)
serve both (see "UI").

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

Settings → Agents (`/settings/agents`) is the shared library page
(`LibrarySettingsSection`), the one Settings → Skills uses: the list, the
folders that need a fix with their reason, one entry's files, and its recent
commits. Each row adds what the definition would run on right now (persona,
model, pinned version, effort), or why it cannot start. Nothing on the page
writes; definitions change through the `agent_*` tools or by hand.

Both pages read through the same server pieces, one per library:

- **Topic.** `skills` and `agents` each answer a subscribe with one
  `libraryList` message (`library/libraryPublish.ts`). The agents list also
  carries `agentRuntimes`, each definition's resolved runtime or problem
  (`agents/agentLibraryList.ts`), and is republished after every agent mutation.
- **HTTP.** `/api/<library>/detail`, `/file` and `/history`
  (`library/libraryHttp.ts`).

The new-session page offers the definitions as an "Agent definition" row
(`NewSessionQuickStart`): it reserves its place while the first read is out,
keeps its pills with an indicator through a rescan, says a failed read in place,
and has no row for an empty library. Picking one stages its persona, model and
effort, on an account of the model's provider. The pick lives on the staged
session record (`lib/stagedSession.ts`), so a model, effort, account or persona
pick from any picker drops it, as do a fresh start and leaving the page; staging
a worktree for the same persona keeps it. A first send retried after a failure
runs what the pickers show then (`reissuedFirstSend`). A comment-review draft
offers no definitions: its handoff creates the session without a first send. The
pick follows the agents list (`reconcileStagedAgent`): a definition that is gone
or cannot start any more is dropped, and one whose runtime changed is restaged,
so the pickers show what will run. The first send carries `agent`, and the
server resolves the definition again on the picked account
(`harnesses/firstSend.ts`): the session runs on the definition's model and
effort and freezes it exactly as a spawn does. A persona, engine, model or
effort that no longer matches the definition refuses the send rather than run
something other than what the pickers showed.

## Out of scope

- **Account routing.** One function picks the account. Usage-aware routing is
  being built separately.
- **Workflow roles.** The code-delivery recipe could later fill a role from a
  definition. `docs/agent-workflows.md` lists declarative definitions as
  deferred, and this design does not change that.
- **Repository-local definitions** such as `.pandeck/agents/`. The user-owned
  library comes first.
- **Allow lists and widening.** A definition only ever removes tools.
