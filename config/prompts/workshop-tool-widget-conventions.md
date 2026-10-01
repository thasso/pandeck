# Workshop tool-widget conventions

Use this document when changing assistant tools that render custom UI inside the
chat window, including server tool payloads in `app/server`/`app/shared` and
rich renderers in `app/web`.

Custom tool widgets are part UI component design and part tool/API design. They
should be explicit, bounded, understandable to agents, and consistent with the
rest of the chat experience.

## Core principles

- A rich tool widget should exist because it improves comprehension or
  interaction, not because the raw tool output is inconvenient to format in
  prose.
- Keep rendering explicit. The agent/tool should request a visual widget only
  when the user asks for a visual display, table, agenda, dashboard, browsable
  result, preview, or similar UI.
- Do not duplicate full widget content in the assistant’s text response. If the
  widget already shows the data, prose should add concise interpretation,
  caveats, or next steps.
- Keep payloads structured and stable. Widgets should render JSON/data
  contracts, not scrape human-formatted text.
- Keep payloads bounded. Use counts, snippets, summaries, pagination, row
  expansion, or browser-only lazy preview endpoints for large content.
- Preserve privacy and context boundaries. If data is loaded only in the browser
  and is not added to assistant context, make that visible to the user.
- Reuse general UI conventions from `config/prompts/workshop-ui-conventions.md`
  for layout, component documentation, theming, and accessibility.

## Keeping conventions current

Update this document when you introduce or intentionally change a reusable
tool-widget concept.

Update it when:

- adding a new kind of rich tool widget or widget payload contract;
- changing when tools should request rich rendering;
- changing how widgets break out of the normal chat column;
- introducing lazy preview, pagination, browser-only loading, mutation, or
  confirmation behavior;
- introducing a shared renderer-dispatch pattern;
- learning a better way for agents to discover existing widget components or
  payload conventions.

Do not use this document as a cleanup backlog. Capture durable conventions and
decision rules, not lists of existing widget inconsistencies to fix later.

## Finding existing widgets and payload contracts

Before adding a widget or changing a tool payload:

1. Search for existing rich tool renderers and their top-of-file briefs.
2. Search server tool schemas/instructions for similar `render` behavior or
   payload fields.
3. Check shared protocol types before adding new client/server concepts.
4. Inspect the smallest relevant files first; use doc comments and payload type
   names to decide whether more context is needed.

Useful commands:

```bash
rg "@component|@widget|@payload|render\?: boolean|renderRequested|presentationGuidance|shouldRender" app/web/src app/server/src app/shared
rg "tool widget|rich renderer|preview|browser-only|lazy" app/web/src app/server/src app/shared config/prompts
```

## Widget and payload brief convention

Rich widget components should use the UI component brief convention, with
widget-specific fields when helpful:

```tsx
/**
 * @widget WidgetName
 * @purpose What tool result this renders and why it needs a custom UI.
 * @payload Stable payload shape or server tool that produces it.
 * @useWhen When a tool/agent should request this widget.
 * @avoidWhen When plain text or the generic tool card is preferable.
 * @intent Layout and interaction intent, including breakout/lazy-loading behavior.
 * @contextBoundary What data is or is not added to assistant context, if relevant.
 */
```

Server-side tool modules that produce rich-render payloads should document the
matching contract near the schema or payload type:

```ts
/**
 * @payload PayloadName
 * @purpose Structured data returned for a rich chat widget.
 * @renderWhen User intent required before setting render=true.
 * @bounds Max results, truncation, preview, pagination, or lazy-loading behavior.
 * @client Renderer expectations and important UI caveats.
 */
```

Keep these comments concise and update them when the payload or rendering intent
changes.

## Render-request contract

The preferred pattern is an explicit render request in the tool input, such as
`render?: boolean`, plus structured output that tells the assistant how the UI
will present the result.

A rich-render-capable tool should document:

- when the agent should set the render flag;
- when the agent should not set it;
- what fields are included only for rendering;
- what data is omitted, truncated, lazy-loaded, or browser-only;
- how the assistant should summarize the result without duplicating the widget.

The output should include enough metadata for the assistant to understand the
presentation, such as:

- whether rendering was requested;
- counts, truncation status, and source links;
- concise presentation guidance for the assistant response;
- stable IDs/URLs needed for client-side expansion or preview.

## Chat breakout behavior

Some widgets need more width than a normal assistant message. This is allowed,
but it should be deliberate and reusable.

- Use `ChatWideCard` for wide chat widgets in the web client. It centers within
  the message column while clamping to the available chat area via
  `--chat-area-width`.
- Avoid copy/pasting raw width calculations or positioning tricks into new
  widgets.
- Breakout layouts should remain responsive and should not make normal chat
  messages feel misaligned.
- Wide tables should handle horizontal overflow predictably and keep
  result/action columns icon-sized when text is not needed.
- Expansion and lazy-loaded content should preserve a reasonable chat scrolling
  experience.

## Renderer dispatch: registry or not?

Avoid a registry solely for documentation or discoverability. Top-of-file briefs
and searchable tags should be the first discovery mechanism.

A registry or central renderer map can be useful only when it solves a real
implementation problem, such as:

- many independent widgets require repetitive dispatch conditionals;
- renderer ordering or fallback behavior becomes error-prone;
- tool widgets need shared policy for visibility, loading, errors, or feature
  gating;
- server payloads expose a stable `renderKind` that should map declaratively to
  a renderer.

If there are only a few widgets, explicit imports and direct conditionals are
acceptable. If a registry is introduced, keep it small and boring: descriptors
with `canRender(block)` and `render(block)` are enough. Do not make a plugin
framework unless the product needs one.

## Store-driven persisted-card pattern

Some widgets are not produced by a tool call that lands in the agent transcript.
Instead, the server maintains a durable external store (for example the approval
table, `db/approvalStore.ts`) and interleaves synthetic `DisplayMessage` entries
into `snapshot()`. These cards:

- Are upserted in place (mutable, not append-only) so status updates are
  reflected without transcript pollution.
- Use deterministic message IDs (for example `approval-{approvalId}`) so the
  client can find and update them via a targeted websocket message without
  re-fetching the full history.
- Never appear in the agent's own transcript, keeping the origin session idle
  and uncluttered.
- Are broadcast as first-class server→client messages (for example
  `approvalUpdate`) so live viewers see updates immediately.

Use this pattern for out-of-band proposal lifecycles where the origin session
must stay idle (not streaming/generating) and the card state changes
asynchronously.

## Draft handoff widgets

- Tools that propose code, UI, workflow, or capability changes for a different
  agent should prefer a draft handoff over starting work automatically. The
  widget may create/switch to a new session and pre-fill the composer, but it
  must not submit the prompt.
- Draft handoff payloads should include the saved proposal path and complete
  draft prompt. The target session should let the user change model/thinking
  level and edit the prompt before manual submission.
- Use draft handoff widgets for implementation proposals, not for ordinary
  answers or simple knowledge updates that a constrained write tool can perform
  directly.

## Feature / agent assistance widgets

- Tools that raise feature requests, cross-session blockers, tool/UI friction,
  or self-improvement opportunities should render an approval widget, not
  silently start another agent or implementation. User approval should first
  create/elevate a durable Task that records the source session, helper session
  when any, autonomy mode, milestones, relay history, and resolution.
- Assistance widgets should render the requested issue/task body as a compact
  Markdown document while preserving the structured payload underneath. Header
  rows should follow the chat-docked panel pattern: vertically centered
  icon/title, title using available space, and a right-aligned high-contrast
  badge. Separate action buttons from configuration options: use clear button
  styling for actions that immediately do something (for example Ignore, Capture
  only, Start now), place helper model/thinking selectors on the left of the
  action row when starting another agent, right-align the action buttons by
  default, and use the same custom checkbox-button visual pattern as the agent
  question dialog for options that modify the start action (for example review
  helper prompt first, allow bounded auto-relay). Keep labels user-readable and
  avoid jargon; more nuanced relay policies can remain in the underlying data
  model.
- Default helper context should be bounded: a concise problem summary plus a
  recent transcript tail or selected excerpts. Avoid embedding an entire source
  session unless the user explicitly chooses that.
- Assistance relay tools should use explicit identity/routing metadata rather
  than prose-only notes: assistance Task/request id, sender/recipient role and
  session, correlation/thread id, exchange count/limit, response-requested flag,
  and delivery status. Agent-visible delivered relay prompts must clearly say
  who is speaking, who should respond, and where responses should be sent.

## Mutation-capable approval widgets

- Approval widgets for external-system writes should use a typed approval
  contract: the persisted record names a constrained `kind`, a stable approval
  id, a compact summary, current status, and the bounded payload needed for
  review. Browser actions must send only the approval id and action; the server
  executes kind-specific logic rather than arbitrary instructions.
- Tools that prepare external-system writes should separate preparation from
  execution: the tool returns a persisted pending proposal, and a user action in
  the widget sends a small approval command back to the server.
- Approval/execution results must be persisted as structured session data, not
  only as transient UI state. Render enough ids/timestamps/status to tell which
  proposal was approved and whether execution succeeded, partially succeeded, or
  failed.
- Keep pending proposal payloads complete but bounded. The approval command
  should reference the persisted proposal id rather than resending
  secret-bearing credentials or large row payloads from the browser.
- Pending widgets should state clearly that nothing has been written yet.
  Executed widgets should state the result per row and prevent the assistant
  from claiming success before the persisted result appears.

## Widget UX rules

- Session artifacts that are useful visual evidence, such as browser
  screenshots, may render as inline chat artifact cards. Load previews from the
  persisted artifact URL in the browser, provide an explicit open-in-new-window
  action, and state that the preview bytes are not added to assistant context.
  Keep automatic inline rendering bounded to visual artifacts; non-visual files
  can stay in the session drawer or render only when explicitly linked.
- Make widgets scannable: compact header, clear title, source/system identity,
  counts/date/query metadata, and obvious empty states.
- Put expensive or verbose details behind expansion, pagination, or explicit
  preview actions.
- Prefer source-system links over embedding excessive raw data.
- Show caveats clearly when data is incomplete, truncated, lazily loaded,
  browser-only, or not present in assistant context.
- Use consistent icons, status colors, chips, buttons, and table behavior with
  the rest of the UI.
- Mutation-capable widgets require explicit user intent, clear confirmation for
  destructive actions, and visually distinct danger states.

## Server/tool implementation rules

- Read tools should be compact by default. Return IDs, links, counts,
  timestamps, summaries, and short excerpts first; require explicit parameters
  such as `fields`, `detailLevel`, `includeDescriptions`, `includeArtifacts`,
  `includeRaw`, or `render=true` before returning verbose bodies, nested raw
  objects, transcripts, full prompt text, or large metadata.
- Tool descriptions and prompt guidance should tell agents how to ask for
  additional data explicitly. If a source has discoverable fields or custom
  fields, provide a compact discovery tool or mode (for example a field catalog)
  instead of returning every possible field in ordinary searches.
- Prefer progressive disclosure in both agent context and UI: broad discovery
  calls should produce small candidate ledgers; targeted follow-up calls may
  fetch full details for selected IDs.
- Server tools and web widgets should evolve together. If a widget needs a new
  field, define and populate it deterministically server-side.
- Keep tool descriptions, prompt snippets, schemas, payload comments, and
  presentation guidance aligned with the actual widget behavior.
- Do not put secrets, tokens, or hidden credentials into tool output or widget
  props.
- For read-only tools, preserve read-only behavior in both implementation and UI
  affordances.
- For large or sensitive content, prefer lazy preview endpoints with explicit
  user action over automatically returning everything in the tool result.
- Chat transcript snapshots should not inline verbose historical tool bodies or
  thinking content by default. Send compact previews/metadata with stable lazy
  refs, then load full block bodies only when the user expands the relevant
  thinking/tool disclosure. Preserve full outputs for rich-card tools through a
  small explicit policy/registry so existing widget renderers still receive the
  structured payloads they need.

## Response expectations after widget changes

When reporting tool-widget work, briefly mention:

- whether the change affected the server payload contract, client renderer, or
  both;
- how render intent is controlled;
- whether any data is truncated, lazy-loaded, browser-only, or excluded from
  assistant context;
- whether this document was updated because the change introduced a new durable
  widget convention.
