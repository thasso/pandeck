# Side activity in chat

The transcript prioritizes the user's conversation with the agent. Peer
exchanges and automation remain in chronological order, but start as one-line
rows rather than message bubbles. `ChatActivityRow` owns the shared disclosure.

## Included content

- Sent peer prompts, including queued tool results, and received peer prompts.
- Background-work updates, one row per delivered update.
- Context compaction, with token counts in the collapsed line and the retained
  summary inside.
- Visible non-human prompts without a specialized presentation, including system
  prompts and agent continuations. Their full displayed text and attachments
  remain available when expanded.

The rule applies to incoming automation prompts, not the assistant's answers to
those prompts. Assistant answers remain visible. Hidden approval/question
handoffs stay hidden, rather than gaining duplicate receipts.

## Disclosure behavior

Each row identifies its source, previews its content, and shows its status where
one exists. Previews are bounded plain text; expansion renders the original
Markdown or specialized body. Long previews and source names truncate rather
than wrap. The expanded body makes clipped source names and details readable.

Peer session links are separate from the disclosure button. Clicking a name
opens the peer; clicking the preview or chevron toggles the body. Modified link
clicks retain native browser behavior. The disclosure is a keyboard-operable
button with its expanded state exposed to assistive technology.

Rows start collapsed. Status changes leave the reader's choice alone. Ordinary
status labels may reduce to labeled icons at phone widths; exceptional outcomes
retain visible text. Failure details can wait inside the body, but the failure
indicator cannot. Background updates retain their distinct completed, failed,
stopped, lost, and activity states. Omitted-update counts remain visible.

Copy and fork actions belong inside the expanded incoming activity body, not on
another line below a collapsed row. Background command/output details and the
registry action also remain inside. Closed rows do not mount those bodies or
fetch their output.

Adjacent activity-only messages use the row's padding rather than the larger
chat-turn gap. They remain separate transcript rows with their existing scroll
anchors. A message containing ordinary assistant text keeps normal spacing.

## Deliberately separate

Approvals, questions, actionable result cards, and session errors keep their
existing presentation. Generic tool calls and thinking blocks retain their own
visibility controls, live-body loading, and expand-all behavior. The new side
activity rows remain visible when generic tools are hidden.

Context-cleared and fork boundaries remain separators. Delivery labels attached
to human messages still explain when the agent received them. Human prompts and
their actions are unchanged.

## Preview and regression coverage

`chat-activity-transcript` stories project wire-level fixtures through
`entriesToDisplayMessages` and render the production `MessageList` and
`Composer`. Desktop and phone cases cover collapsed and expanded messages;
`chat-activity` retains the isolated row examples.

The component and transcript tests cover default collapse, expansion, source
navigation, status updates, hidden actions, attachments, compaction summaries,
and the unaffected human/assistant conversation. Background-work tests cover
command/output disclosure, clipped labels, registry navigation, omitted updates,
and status distinctions.
