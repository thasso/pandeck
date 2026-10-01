# Persona prompts — implementation reference

Relocated from `config/prompts/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Agent persona prompts, project prompts, and workshop UI/tool widget conventions.

## Module ownership

- `assistant.md`, `personal-assistant.md`, `workshop.md`, and `developer.md` own
  primary persona behavior. `developer.md` is the generic, prod-capable coding
  agent for arbitrary projects; `workshop.md` is the dev-only agent that
  modifies this app. `personal-assistant.md` owns the permanent singleton
  Personal Assistant persona (server-owned, never selectable), which shares the
  ordinary Assistant's integration tools but adds continuous
  cross-channel/time-aware behavior guidance and always receives the permanent
  profile suffix. It also carries the cross-cutting self-enrichment expectation
  (proactively keep shared datasets accurate — e.g. record new people/ids via
  `contacts_manage` in any context) and the Tempo time-logging routing guidance
  (right ticket + activity; a cost center that Jira derives from the ticket
  follows it; create a ticket when none fits, then log/comment).
- `integration-slack.md`, `integration-google.md` and `integration-tempo.md` own
  the CONDITIONAL persona sections (Task-287): text that only ships to a session
  whose matching integration gate was on when it started. Their content moved
  out of `assistant.md` (Slack, Google Meet) and `personal-assistant.md` (Tempo)
  unchanged in substance — re-flowed from bullets under "User-facing output and
  links:" into standalone sections — and `promptAssets.ts` decides which
  personas compose them, so a section never reaches a persona that did not carry
  it.
- `chat-files.md` owns the shared, unconditional rule for showing a FILE
  (Task-636, then `docs/served-files.md`): a session shows the file it wrote
  instead of naming the directory it sits in, and without copying it anywhere.
  It states the three presentations the app actually has — `show_files` for a
  card per file, `![…](/api/files/...)` for an inline picture/media/HTML embed,
  `[…](/api/files/...)` for a link into the in-app viewer — and it composes into
  every persona that gets `project-registry.md`. The web side that honors it is
  `Markdown.tsx` and `tools/registry.tsx` → `ServedFileCard` →
  `ui/ImageLightbox.tsx`, `SandboxedDocument` and the `/files/...` viewer route.
- `workshop-ui-conventions.md` and `workshop-tool-widget-conventions.md` own
  durable UI/tool output expectations for workshop changes.
- Other prompt files own focused system instructions for named server features.

## Contract notes and rationale

- These files are resolved by `app/server/src/promptAssets.ts` against
  `PROMPTS_DIR`, which is `PACKAGED_PROMPTS_DIR` — `config/prompts` relative to
  `app/server/src/config.ts`'s own module URL, i.e. the repo in a checkout and
  `$out/libexec/personal-assistant/config/prompts` in the Nix install, whose
  `installPhase` copies the gitignore-clean source tree. Resolution is
  deliberately independent of `ASSISTANT_CWD`, the session cwd and the selected
  project: deriving it from the working directory (Task-262) made production and
  every PR preview ship built-in fallback text for all four personas.
  `ASSISTANT_PROMPTS_DIR` overrides the directory for development and must be an
  absolute existing directory — a relative or missing path fails startup instead
  of silently resolving the packaged assets.
- There are no fallback prompt constants (Task-291). A tracked asset that is
  missing, unreadable or whitespace-only raises `PromptAssetError` — one
  `readPromptAsset()` judges usability for both resolution and the checks, so
  the diagnostic and a session can never disagree (blank content matters because
  composition trims and drops empty layers, which would remove the persona layer
  silently). `assertPromptAssets()` runs before the server binds: it READS every
  tracked asset rather than testing for presence, and a PACKAGED directory with
  any such defect refuses to start, while the same defect under the
  `ASSISTANT_PROMPTS_DIR` override only warns (the user is editing those files,
  and the failure then surfaces per session). The resolved source, size and hash
  per layer are reported by `promptAssetInventory()` and the startup diagnostic
  names the resolved directory and its origin.
- `pnpm run measure:prompts` (`app/server/src/measurePrompts.ts` over
  `promptInventory.ts`) prints the per-persona, per-layer size table for both
  harnesses, once per prompt directory when the running process resolves a
  different one than this checkout's `config/prompts` (only with an override,
  since Task-291 made the packaged directory the default). Every number is
  CHARACTERS; see the module comment for why tokens are not reported. Prompt
  layers are measured by diffing real assemblies — pi's own `buildSystemPrompt`
  for the pi side, `claudeSdkSystemPrompt` for the Claude side — so the counted
  rows reconcile with the assembled prompt instead of tracking hand-copied
  constants. The `claude_code` preset, Claude's native tool definitions, skills,
  the agent-dir global context file, and out-of-cwd project context are reported
  without being counted; pi's builtin tool definitions ARE counted
  (`tools:eager:harness-builtin`), because we construct them ourselves.
- Claude SDK assistant personas (`assistant`, `personal-assistant`, and
  `workflow-coordinator`) set `settingSources: []` in `claudeSdk/options.ts`.
  Their locked-down app prompt is their entire instruction surface: project/user
  settings, including a run worktree's `CLAUDE.md`, must not enter that context.
- `pnpm run measure:session -- <sessionId>` (`app/server/src/measureSession.ts`
  over `sessionAudit.ts`) is the RUNTIME half of the same question: what one
  real session spent and what its context was made of. The static rows there
  (`system-prompt`, `tool-definitions`) are this checkout's sizes, not what an
  older session sent, and they exclude the harness-owned base prompt and builtin
  definitions that `measure:prompts` prices — the two reports are read together,
  never summed.
- `AgentTypeDef.systemPrompt(opts?)` and `claudeSdkSystemPrompt(…, opts?)` take
  prompt-asset options: the directory the file-backed layers resolve against (so
  a measurement can measure a directory other than the running process's;
  sessions never pass it) and the session's frozen `PromptConditions`, which
  sessions always pass and everything else omits.
- Conditional assembly (Task-287) is a session-START decision owned by
  `promptConditions.ts`: which integration sections, the Project Registry
  pointer, the memory write rules and the eager attachment tool group a session
  carries. The record is computed once from that session's evidence (its first
  prompt's attachments, its Project, the live gates, the persona's memory
  capability), persisted insert-only in `session_prompt_conditions`, and read
  back — never recomputed — by every later assembly: a resumed Claude query, a
  pi reopen, a pi system-prompt rebuild on tool activation, and the Claude tool
  server's `alwaysLoad` set. That is what keeps the provider's cache prefix
  stable for the whole conversation. Consequences by design: enabling an
  integration mid-session changes that session's TOOLS (via
  `tools/list_changed`) but not its prose, which reaches the next session — for
  the permanent Personal Assistant, the next rotated conversation; a fork
  inherits its parent's record; a caller with no session (one-shot agents, the
  inventory, tests) gets every section, so a missing wiring costs a saving and
  never a rule. `pnpm run measure:prompts` prints the saving per persona and
  condition.
- The injected Project context block (`sessionProjectContext.ts`
  `buildProjectContext`, the other side of the `projectRegistryPointer`
  condition) is conditional on the same principle but per RECORD, not per
  session: the Jira precedence rules render only for a Project with Jira links,
  the alias rule only for one with aliases, and the override rule names Jira
  only alongside them (Task-309). Unconditional are the two rules that hold for
  any record — registry entries are discovery hints and not instructions, and
  explicit user instructions plus current tool evidence beat them — and the
  sentence naming the deferred `project_registry_read`/`_write` tools, which
  this block owes the eager pointer it replaced. Project knowledge is one line
  carrying the `project:<id>` tag and the `pa://project/<id>` link form; the
  persona-level KB guidance and the kb_* tool descriptions own the rest. For a
  Jira-less, alias-less Project (every record in the registry today) the block
  went from 1,681 B to 935 B, and the unknown-project warning branch from 834 B
  to 307 B.
- Prompt changes are product behavior changes; keep them explicit, concise, and
  aligned with available tools.
- Do not instruct agents to expose secrets or bypass confirmation gates in code.
- Keep prompt references to tool names, render kinds, and UI conventions
  synchronized with server tools and web renderers.

## Working notes

- Prefer updating shared convention prompts over duplicating long guidance
  across many prompts.

## Verification commands

- Run root `pnpm run build` before closeout.
- Run root `pnpm run typecheck` if prompt changes require code/type updates.
