# Web tool cards — implementation reference

Relocated from `app/web/src/components/tools/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

Tool rendering registry for converting shared `DisplayBlock` tool calls into
rich cards or disclosure bodies.

## Module ownership

- `registry.tsx` owns renderer matching, lazy card imports, native tool body
  dispatch, and fallback output presentation. WHICH payload is a card is not
  decided here: every card `match` calls `@assistant/shared/toolCards`
  (`acceptsGoogleWorkspaceCard`, `taskManagePayloadOf`, `peerPromptCardOf`,
  `showFilesCardRowsOf`, …), the one rule the server's payload policy also
  applies to keep a card's payload whole on the wire, so a card that shows live
  never turns into a clipped generic row on reload. The registry adds only the
  client's `done` precondition, and `lib/showFilesCard.ts` supplies the
  origin-checked address resolver the shared parser is handed. A generic
  disclosure is `GenericToolBlock`: its body is a render callback (built only
  once expanded and near the viewport), a withheld body
  (`argsLazy`/`outputLazy`) is loaded the moment the body is VISIBLE — the
  reader's toggle and the transcript's expand-all alike — and a live one
  (`argsLive`/`outputLive`) is subscribed to through
  `ToolRenderContext.onLiveBodyDemand` for as long as it stays visible. Whether
  a block has a body to open is decided from the refs, not the text: the text is
  empty precisely because it has not been asked for. Cards are the exception and
  never go through this: their payload arrives whole (server
  `timelinePayloadPolicy.ts`).
- `NativeToolBodies.tsx` owns the `read`/`write`/`edit`/`bash` bodies, which
  share ONE presentation: the `.tool-code` block shell (`index.css`, mirroring
  Shiki's look), a SINGLE line-number gutter, and horizontal scrolling by
  default. Rules that must hold:
  - Exactly one gutter, carrying the file's REAL lines. Claude's `Read` returns
    a `cat -n` gutter inside the text (lifted out by `lib/toolOutput.ts` so it
    is not rendered a second time beside a 1..N counter); pi's `read` returns
    raw text positioned by the call's `offset`.
  - `edit` prefers the provider's positioned diff (`DisplayBlock.resultDiff`,
    from pi's `details.diff`) and otherwise diffs the call's own old/new strings
    and shows NO numbers — snippet-relative numbers look like file lines and are
    not. It no longer uses the @pierre/diffs stack (removed `ToolDiff.tsx`) but
    must KEEP pierre-grade diff reading: whole-line add/remove colouring PLUS
    word-level marks inside replaced lines (`lib/toolOutput.ts`'s
    `markIntralineChanges` pairs a del-run with the following add-run
    positionally and marks the changed spans, using `tokenizeCode` granularity
    so a mark lands on the identifier, not the whole blob; a pair changed beyond
    `INTRALINE_MAX_CHANGE_RATIO` stays whole-line). Do not regress this to
    line-only colouring — intra-line detail is why the app renders diffs rather
    than before/after text.
  - `bash` renders as a shell session: the FULL command (`$ …`; the collapsed
    header only has a truncated summary) then its output, which grows live — pi
    streams bash output through `tool_execution_update` → `toolUpdate` → the
    tool block's `output`.
  - Wrapping is opt-in per user (`prefs.wrapToolLines`, off by default) and
    arrives as `ToolRenderContext.wrapLines`; code and shell output are
    column-aligned, so wrapping is never the default.
  - Bodies are VIEWPORT-GATED by `ToolCallBlock` (`common/useNearViewport.ts`):
    expand-all opens every block in the transcript, and building all those
    bodies in one commit is what froze the main thread on long chats. Keep new
    bodies cheap on first paint and never assume a body mounts the moment its
    block opens.
- `toolName.ts` owns provider-specific tool-name normalization.
- `../PeerPromptCard.tsx` owns BOTH halves of a peer conversation, so the two
  transcripts read the same way: the sender's card is matched here on
  `session_send_prompt`'s `sessionPeerPrompt` render kind, and the recipient's
  is the same component rendered from the `peerPrompt` display block
  (`MessageList.tsx`). The message is agent-authored Markdown and renders
  through `Markdown.tsx`, never as preformatted text. The header names the OTHER
  party and links to its session from `PeerPromptCard.peerSessionId` — a real
  `<a href>` (so new-tab gestures work) that falls back to
  `ToolRenderContext.onOpenSession` for in-app navigation, and to plain text on
  a card whose id is missing or not a string — the link component validates that
  itself, since it is what builds the href and what calls `onOpenSession`. The
  tool payload is model-authored, so it is VALIDATED (`lib/peerPromptCard.ts`
  `parsePeerPromptCard`) before the card matches at all, never cast:
  `direction`, a string `message` and a known `state` decide the card and are
  required — a non-string message would throw inside the Markdown renderer
  rather than degrade — while the remaining fields are coerced or dropped, so an
  incomplete card still renders. The view reads the same fields defensively on
  top of that, because the recipient's path takes a durable card that an older
  build wrote. The sent side depends on `session/log/timelinePayloadPolicy.ts`
  keeping this tool's output whole: a clipped payload does not parse, and an
  unmatched tool block is hidden with tools off, which is how the sent half of
  every exchange went missing.
- `../TaskManageToolCard.tsx` owns the Task MUTATION card, matched on
  `task_manage` plus the server's `taskManage` render kind (Task-297).
  `task_read` deliberately carries no render kind and stays a body — a read is
  the agent's business, a write is the user's data changing, so it shows with
  tools hidden. The card reads `changed[]`, `deletedIds` and `warnings` out of
  the result text; the VERBS ("created", "archived") come from the call's own
  `operations`, which `changed` follows in order, because the payload reports
  the outcome and not the operation. When the two cannot be lined up (a lazily
  summarized input, a batch that partly threw) the verb is simply omitted, and
  an entry the server flagged `deduplicated` reads "already imported" rather
  than the op's "created". A pending `statusSuggestion` gets a confirm button,
  using `lib/backlogTree.ts`'s `pendingStatusSuggestion` so a suggestion the
  status already satisfies stays provenance rather than a question, and
  `acceptStatusSuggestionSave` so confirming here and confirming in the
  Backlog's Focus row produce the same state. Confirming is an ordinary user
  save routed through `ToolRenderContext.onApplyTaskStatusSuggestion` →
  `App.tsx`: it resumes NO session, so answering costs no provider call, and it
  carries only the id and the status — never the card's frozen copy of the
  title, which is why `TaskSaveRequest.title` is optional on an update. Only the
  confirm half lives here — disagreeing is a judgement about the Task, which is
  Focus's job. The answer is remembered LOCALLY (the transcript holds no `tasks`
  subscription), so a reload shows the recorded suggestion again and
  re-confirming is a no-op save.

## Contract notes and rationale

- Match tools by normalized names and explicit render flags/kinds; avoid brittle
  provider-only labels.
- Card renderers replace the full tool presentation and must work even when
  generic tool details are hidden.
- Body renderers live inside `ToolCallBlock` and should preserve raw/debug
  visibility.
- All JSON parsing must be defensive; malformed tool output should fall back to
  readable raw output.

## Working notes

- Add new rich cards through the registry with a focused `shouldRender...`
  predicate and lazy import when the card is heavy.
- Keep server `renderKind` outputs and web predicates synchronized.

## Verification commands

- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
