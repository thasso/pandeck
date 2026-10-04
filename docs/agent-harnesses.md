# Agent harnesses

A harness is the engine that runs a session: `pi` (the `@earendil-works/*` SDK)
or `claude-sdk` (`@anthropic-ai/claude-agent-sdk`). This document is the
contract for how app code reaches a harness, and the migration that moves the
server from two hand-wired engines to one seam with two backends behind it.

The migration lands as a series of small pull requests. Until the last one
lands, the "Target" section describes where the code is going, and "Status" says
what already holds.

## Vocabulary

- **Harness** (`Harness` in `app/shared/protocol.ts`): which engine runs a
  session. Persisted on the session row; never changes for a session.
- **Persona** (`agentType`): the system prompt and toolset a session presents
  (`assistant`, `developer`, …). Independent of the harness: every persona runs
  on either engine.
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
   - `HarnessRegistry` resolves a session id or harness id to its backend and
     owns acquire, create, fork, rename and remove.
   - `LiveSession` is the one driver interface every resident session
     implements: the read surface (`HarnessDriver`), prompting through the
     runtime, and the mutations (mode, model, thinking level, compact, clear,
     rename). An engine-only feature is an optional method, not an `instanceof`
     check.
   - `runOneShot()` runs a single prompt on whichever engine a model slot names
     and returns one result shape: text, `AgentUsage`, and a thrown error on
     failure. It records the internal usage session itself.
   - The models and usage ports list and resolve models per credential profile
     and read subscription usage.
3. **Engines** (`piSdk/`, `claudeSdk/`) each export one backend object and are
   the only place their SDK package is imported. Each session class composes the
   shared session host kit (`session/host/`: viewer set, idle eviction,
   synthetic host-command turns, display-block helpers) instead of carrying a
   copy.
4. **`session/`**: the runtime, log and transport core and the
   `PromptableAdapter` contract are already harness-neutral and do not change.
   Two pieces of the folder are still migration work: the adapter bridge
   `session/adapters/claudeSdk.ts` imports the engine's `modelSettings.ts`, and
   `session/planHint.ts` branches on a harness id. Both are pinned below.

`HARNESSES` in `app/shared/` is the one table that maps a harness to its account
provider, model provider, label and capabilities (fork, steering,
background-work backends). Server and web read it instead of repeating the
mapping.

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
  but repeats the harness mapping until step 4, or scripts outside the server
  source such as `scripts/bun-runtime-probe.mjs`, which imports
  `piSdk/models.ts` on purpose to probe the packaged runtime.
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
| 2    | Remove leftovers: identity helpers, unused types, stale comments, copied code | open   |
| 3    | One persona type instead of `AgentKind`/`AgentType`/`SessionAgentType`        | open   |
| 4    | `HARNESSES` descriptor in `shared/`, read by server and web                   | open   |
| 5    | `runOneShot()` and its 10 callers                                             | open   |
| 6    | Models and usage ports                                                        | open   |
| 7    | `LiveSession` interface; no `instanceof` on session classes                   | open   |
| 8    | Shared session host kit                                                       | open   |
| 9    | `HarnessRegistry` over both stores; `hub.ts` stops dispatching by hand        | open   |
| 10   | One first-send path for both harnesses                                        | open   |
| 11   | Spawn, workflow, fork, delete and rename through the registry                 | open   |
| 12   | Allowlists down to named measurement modules; rule moves into `CLAUDE.md`     | open   |

Steps 2–6 are independent of each other. Step 8 needs 7, and 9–12 run in order
after 7.

Out of scope: splitting `ClaudeSdkSession.ts` internally. Step 8 removes its
duplicated plumbing first, which makes that split a separate, smaller change.
