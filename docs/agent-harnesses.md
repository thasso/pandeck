# Agent harnesses

A harness is the engine that runs a session: `pi` (the `@earendil-works/*` SDK)
or `claude-sdk` (`@anthropic-ai/claude-agent-sdk`). This document is the
contract for how app code reaches a harness, and the migration that moves the
server from two hand-wired engines to one seam with two backends behind it.

The migration lands as a series of small pull requests. Until the last one
lands, the "Target" section describes where the code is going, and "Status" says
what already holds.

## Vocabulary

- **Harness** (`Harness` in `app/shared/harnesses.ts`): which engine runs a
  session. Persisted on the session row; never changes for a session.
- **Persona** (`AgentType` in `app/shared/protocol.ts`, field `agentType`): the
  system prompt and toolset a session presents (`assistant`, `developer`, …).
  Independent of the harness: every persona runs on either engine.
- **Backend**: one engine's implementation of the harness seam. It owns the
  engine's session store, model catalog, one-shot runner and usage query.
- **Account provider** (`claude`, `openai-codex`): which kind of credential
  profile a harness signs in with.
- **Model provider**: the provider id a model picker reports (`claude-sdk` for
  Claude models, the pi provider id otherwise).

## Target

![Target harness architecture](agent-harnesses.svg)

Four layers, each depending only on the ones below it:

1. **App code** (`connection.ts`, `hub.ts`, `sessionSpawn.ts`, `workflow/`, the
   one-shot callers, model and usage readers, the web client) names no engine.
   It asks the seam for a session, a model list or a one-shot run, and branches
   on capabilities, never on a harness id.
2. **`harnesses/`** is the seam and the only module that imports both backends:
   - `harnessRegistry` (`harnesses/registry.ts`) resolves a session id to the
     store that holds it: it lists what both hold resident, finds a resident
     session, opens one by id, and wires both stores to the hub's behaviour
     (`HarnessHost`). Each engine answers through one `HarnessSessions` entry,
     so routing is a lookup by harness id, never a branch per method. An id
     belongs to one engine: a client-supplied id another engine holds is refused
     before anything is written for it (`otherHolder`), which lets a resident
     lookup answer from memory alone. Create, fork, rename and remove move
     behind it in step 11; until then `hub.ts` still calls the stores for them
     and builds the merged session list from each.
   - `firstSendEngine` (`harnesses/firstSend.ts`) is what a session's first send
     asks of its engine. `Connection.handleFirstSend` runs one flow for both —
     view claim, persona guard, worktree, session context, genesis card, context
     links, the prompt — and the engine answers only what differs: whether it is
     switched off (`disabled`), whether the client's id becomes the session's
     (`takesClientId`, which the view claim then names), whether that id may be
     taken (`admitId`), which persona gate applies (`personaGate`; the guard
     itself stays in `connection.ts`), the account (`account`), what it resolves
     before a worktree is provisioned (`prepare`, pi's model), and how it brings
     the session live (pi mints its id and freezes the prompt evidence inside
     creation; Claude takes the client's id, links the worktree and freezes
     first), through `createSession`.
   - `createSession` (`harnesses/create.ts`) is the one place that knows each
     engine's creation sequence; a caller names what the session starts with
     (`NewSession`: persona, model, account, cwd and worktree, prompt evidence,
     skills, title) and keeps its own admission and model resolution. It calls
     the stores directly, never `hub.ts`. A Claude session's id is checked
     against every other holder right before its registration, with nothing
     awaited in between: with the disk scan for a client-supplied id
     (`clientId`), from memory and the row for a server-minted one. Step 11b
     moves every other creation caller onto it — spawn, workflow, the
     review-comment new session, day session, new session and draft in
     `connection.ts`, the worktree merge agent and the permanent assistant — and
     retires `hub.acquireClaudeSdk` and `hub.acquireNew`.
   - `LiveSession` (`harness.ts`) is the one driver interface every resident
     session implements: the read surface (`HarnessDriver`), prompting through
     the runtime, and what the app changes on it (mode, thinking level, the
     model it carries into a new session). `isLiveSession` tells it from a
     storage-backed view by its `live` marker; an engine-only feature is an
     optional method (`acceptCommitDryRun`, pi only), not an `instanceof` check.
     Compact, clear and rename join it as later steps route them through the
     registry.
   - `runOneShot()` (`harnesses/oneShot.ts`) runs a single prompt on whichever
     engine a model slot names and returns one result shape: text and
     `AgentUsage`. A run that failed without writing anything throws
     `OneShotError` (carrying its usage); one that failed after writing text
     returns it with `failure` set, and the caller decides. A timeout or engine
     exception throws a plain error and drops partial text. It records the
     internal usage session itself when asked, for every run that reported its
     usage (so not a timeout).
   - The models port (`harnesses/models.ts`) lists the models the pickers offer
     (`pickerModels`) and an account can run (`modelsForAccount`), answers
     whether an account offers an exact model (`accountOffersModel`), and
     renders a stored session's model (`storedSessionModelOption`). The
     Claude-only curated options sit in `harnesses/curatedModels.ts`, which
     loads no engine SDK, so row projections stay cheap. The usage port
     (`harnesses/usage.ts`) reads subscription usage per account kind and
     redeems OpenAI reset credits. Model handles a session is created with still
     come from the engines until step 11 routes creation through the registry.
3. **Engines** (`piSdk/`, `claudeSdk/`) each export one backend object and are
   the only place their SDK package is imported. Each session class composes a
   shared session kit (`sessionKit/`) instead of carrying a copy:
   `SessionResidency` owns the viewer set and the idle clock, and the engine
   says only when it is idle and how its store releases it. `hostCommandTurn.ts`
   emits a synthetic host-command turn (open, progress, discard, tool output or
   card) to viewers and the runtime adapter alike, while the engine keeps the
   turn's ids, running state and teardown. A host command ends its turn with one
   `finishSyntheticCard`, whichever card it renders. The live display-block
   helpers live in `session/runtime/liveBlocks.ts`.
4. **`session/`**: the runtime, log and transport core and the
   `PromptableAdapter` contract are already harness-neutral and do not change.
   Two pieces of the folder are still migration work: the adapter bridge
   `session/adapters/claudeSdk.ts` imports the engine's `modelSettings.ts`, and
   `session/planHint.ts` branches on a harness id. Both are pinned below.

`HARNESSES` in `app/shared/harnesses.ts` is the one table that maps a harness to
its account provider, its model-picker provider (Claude only; pi models keep
their upstream provider) and its capabilities, today the background-work
backends it may own. `harnessForModelProvider`, `harnessForAccountProvider` and
`accountProviderForModelProvider` translate between the three names; server and
web call them instead of repeating the mapping. Further capabilities join the
table when a later step needs them.

## Rules

- Outside `piSdk/`, `claudeSdk/`, `harnesses/` and `test/`, a module reaches an
  engine folder only through `harnesses/`. `harnessBoundary.test.ts` pins every
  remaining exception by module and fails on a new one.
- App code does not compare a harness id against a literal. It reads a
  capability from `HARNESSES` or asks the backend. The same test pins the
  remaining comparisons per file: `==`/`===`/`!=`/`!==` with a harness-id
  literal on either side, a `case` with one, and `.includes()` on an array
  literal holding one.
- The test parses every non-test `.ts` module under `app/server/src` (and fails
  if a source with another extension appears there), so comments and unrelated
  strings never count. It does not cover the web client, which reaches no engine
  and reads the shared `HARNESSES` helpers, or scripts outside the server source
  such as `scripts/bun-runtime-probe.mjs`, which imports `piSdk/models.ts` on
  purpose to probe the packaged runtime.
- The allowlists in that test only shrink. A change that removes an engine
  import or a comparison deletes its entry in the same change; the test fails on
  a stale entry so the list cannot drift above reality.
- Unchanged by this migration: SDK packages stay inside their folders
  (`architecture.test.ts`), app prompts go through `runtimePrompt.ts`, app tools
  come from `tools/catalog.ts`, and background work goes through the ports in
  `backgroundWork/backends.ts`.

## Status

| Step | Change                                                                        | State  |
| ---- | ----------------------------------------------------------------------------- | ------ |
| 1    | This contract and the boundary ratchet                                        | landed |
| 2    | Remove leftovers: identity helpers, unused types, stale comments, copied code | landed |
| 3    | One persona type (`AgentType` in `shared/`) replaces three identical unions   | landed |
| 4    | `HARNESSES` descriptor in `shared/`, read by server and web                   | landed |
| 5    | `runOneShot()` and its 10 callers                                             | landed |
| 6    | Models and usage ports                                                        | landed |
| 7    | `LiveSession` interface; no `instanceof` on session classes                   | landed |
| 8a   | Shared session kit: viewers and idle clock (`SessionResidency`)               | landed |
| 8b   | Shared session kit: synthetic host-command turns                              | landed |
| 9    | `HarnessRegistry` over both stores; `hub.ts` stops dispatching by hand        | landed |
| 10   | One first-send path for both harnesses                                        | landed |
| 11a  | `createSession`; the first send creates through it                            | landed |
| 11b  | Every other creation caller on `createSession`                                | open   |
| 11c  | Fork, delete and rename through the registry                                  | open   |
| 12   | Allowlists down to named measurement modules; tighten the `CLAUDE.md` rule    | open   |

Steps 2–6 are independent of each other. Step 8 needs 7, and 9–12 run in order
after 7.

An id belongs to one engine, enforced in three places. Each store refuses to
register an id the other holds resident (`setHeldElsewhere`, wired by the
registry): the last word, whichever path asks. A Claude first send, the one path
that takes a client-supplied id, refuses an id another engine holds resident, on
record or on disk (`otherHolder`) before it writes anything, and checks again
with nothing awaited before the session registers. `hub.acquireClaudeSdk` checks
as a backstop for server-minted ids, from memory and the row only, and must
never be the first refusal.

Out of scope: splitting `ClaudeSdkSession.ts` internally. Step 8 removes its
duplicated plumbing first, which makes that split a separate, smaller change.
