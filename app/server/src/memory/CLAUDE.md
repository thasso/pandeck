# Agent memory

Product contract: `docs/agent-memory.md`.

- Enterprise-required sessions never enter automatic memory capture or
  processing.
- A mutation on an existing card is revision-checked: never silently overwrite a
  newer card.
- A correction MUST supersede-then-create atomically — never erase history and
  never leave a contradictory active duplicate.
- Scope is intersection semantics: every dimension a card specifies must match,
  and an absent dimension is global. Ordinary `assistant` and the singleton
  `personal-assistant` are isolated personas.
- Automatic memory (delivery, capture, flushes, maintenance) reads its switches
  through `memorySettingsInEffect()` (`memoryGate.ts`), never
  `getSettings().memory`: while first run is `pending` memory is off whatever is
  stored. Learning `off` drops queued observations instead of processing them.
