# Server package — implementation reference

Relocated from `app/server/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Node ESM server package for HTTP endpoints, WebSocket sessions, pi/Claude SDK
orchestration, MCP/tool integrations, and runtime persistence.

## Module ownership

- `src/` owns all server implementation and tests.
- `package.json`, `tsconfig.json`, and `vitest.config.ts` define the server
  workspace contract.
- Runtime state belongs under `DATA_DIR` (default `assistant-data/`) and must
  not be committed.

- `tasks.ts`'s `resolveStatusWrite` is the ONE place that decides who may write
  a Task's status. An `agent` actor's `done` or `todo` becomes a
  `statusSuggestion` (the two suggestible values; `doing` has none because
  saying nothing already means "leave it in doing"). A `done` suggestion also
  moves the Task out of `doing` into `todo`, so an agent's closeout needs no
  corrective second write; a `todo` suggestion moves nothing, since paused work
  is honestly still `doing` until the user answers. Repeating the same
  suggestion keeps the first timestamp; a different one replaces it. A real user
  status CHANGE or an explicit `clearStatusSuggestion` clears it, and a save
  that leaves the status alone deliberately does NOT. `system` actors are
  excluded on purpose, and `userRequestedStatus` is the explicit escape hatch:
  the agent's write is applied AND recorded as the claim, with agent provenance.
  One consequence to keep in mind: an unasked agent completion writes no `done`
  `task_status_events` row.

- `tasks.ts`'s `resolveTriage` decides when a Task stops waiting in the Inbox.
  Triage is IMPLICIT on any USER-actor update — if you changed something about a
  Task you have seen it, and asking you to dismiss it as well would be a second
  chore for a decision already made — and the explicit `triaged` flag covers the
  one act that changes nothing else (dismissing something that needs no action)
  plus putting a Task back.

- WHICH browser commands count as that user act is decided in ONE table, not per
  handler: `connection.ts`'s `tasksProcessedByUserCommand(msg)` is a total
  switch naming the Task ids each client command processes, and `handle` calls
  `markTaskProcessed` on them after a successful dispatch (never on a failure —
  a refused save is not a decision about the Task). That outcome comes from the
  `MutationScope`, which is why `handle` opens one for EVERY command rather than
  only for correlated ones: most Task commands carry no `requestId`, and a
  handler refuses by sending an `error` instead of throwing, so dispatching
  outside a scope left nothing to notice the refusal. `markTaskProcessed` is
  idempotent and only ever sets the FIRST decision — when a Task was processed
  is a fact about that decision, not about the most recent touch. One EXPLICIT
  state choice outranks that implicit rule: a save carrying `triaged: false` is
  the put-it-back operation, so the table returns nothing for it — processing
  the Task a line after the handler restored it made the wire's own restore
  impossible, and neither the domain test nor the mapper test could see that
  alone. Two commands are deliberately excluded: `deleteTask` (the Task is gone)
  and `reorderTasks`, which is handled in the domain instead because a drop
  renumbers every sibling — `reorderTasks(..., byUser)` triages only the Tasks
  whose PARENT moved, so dragging one Task past a dozen arrivals does not
  process them. Reads are excluded for the same reason triage is NOT triggered
  by READING. `taskTriageCoverage.test.ts` guards all of it: it scrapes the
  dispatcher's own `case` labels and fails when a Task command has neither a
  triage decision nor a recorded exclusion. It also drives a REFUSED
  uncorrelated command and an explicit put-back through a real `Connection`,
  proving both paths triage nothing. It is deliberately NOT triggered by
  READING: an inbox that empties itself when you glance at a row cannot track
  what you still owe an answer to, and opening a Task from a link or a search
  would silently process it. `createTask` takes an explicit `triaged` input
  rather than inferring from `source.createdBy`: the browser's own save path
  (the one place a Task is TYPED) passes it, and every other creator — agent
  tools, Slack shortcut intake — is an arrival that queues. Inferring from the
  creator kept Slack imports, which honestly record the user as creator, out of
  the Inbox entirely. Agents can read the queue (`task_read`'s `untriaged`) but
  never write triage: it is the user's act.

## Contract notes and rationale

- Keep API, WebSocket, and MCP surfaces protected by the existing token/origin
  checks.
- Never write real secrets into source or example config; store live credentials
  in local runtime data or environment variables.
- Shared wire shapes come from `@assistant/shared`; update shared and web call
  sites with server protocol changes.
- Server TypeScript uses strict NodeNext ESM with explicit source extensions.

## Working notes

- Keep integration families coherent: settings validation, tools, protocol
  types, and UI render data should evolve together.
- Server Vitest runs suppress stdout/stderr for passing tests
  (`silent: "passed-only"`); keep logs useful for failures, not required for
  passing assertions.
- Avoid broad edits to `hub.ts` or `connection.ts` unless the cross-session
  behavior requires it; prefer smaller domain modules.

## Verification commands

- Run `pnpm --filter @assistant/server test` to run the tests.
- Run `pnpm --filter @assistant/server test:kb` for the focused server Knowledge
  Base regression and token/performance audit.
- Run `pnpm --filter @assistant/server typecheck` for server-only changes.
- Run root `pnpm run typecheck` when shared or web contracts are affected.
- Run root `pnpm run build` before closeout.
