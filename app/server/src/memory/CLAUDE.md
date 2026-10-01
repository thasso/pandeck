# Agent memory

Product contract: `docs/agent-memory.md`.

- A mutation on an existing card is revision-checked: never silently overwrite a
  newer card.
- A correction MUST supersede-then-create atomically — never erase history and
  never leave a contradictory active duplicate.
- Scope is intersection semantics: every dimension a card specifies must match,
  and an absent dimension is global. Ordinary `assistant` and the singleton
  `personal-assistant` are isolated personas.
