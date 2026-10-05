/**
 * Which tool results render as RICH CARDS, decided once for both ends of the
 * wire. The web registry (`components/tools/registry.tsx`) asks these
 * predicates whether a block gets a card; the server's timeline payload policy
 * asks the same predicates whether a result's payload has to stay whole on the
 * wire — a card is the only thing that reads a full payload, so the two must
 * agree exactly. A server that accepts more inlines bodies nobody renders; one
 * that accepts less clips a card away on reconnect that was visible live.
 *
 * Everything here is a pure function of the block's name, arguments, output
 * text and error flag. The parsers double as the cards' own parsers, so "the
 * card would render this" and "the payload stays whole" are one decision.
 */
import type {
  CommitDisplay,
  KnowledgeEntryCard,
  PeerPromptCard,
  PeerPromptState,
  PushDisplay,
  TaskStatus,
  TaskStatusSuggestion,
} from "./protocol.ts";

/** What a card decision is made from; a display block and a log row both map onto it. */
export interface ToolCardCandidate {
  name: string;
  args: unknown;
  output: string;
  isError: boolean;
}

export type ToolCardKind =
  | "googleWorkspace"
  | "jira"
  | "workshopDraftHandoff"
  | "taskManage"
  | "peerPrompt"
  | "worktreeCommit"
  | "worktreePush"
  | "showFiles"
  | "knowledgeEntry"
  | "agentQuestion";

/**
 * The bare tool name used for matching across the app. pi emits bare names
 * (`read`, `google_calendar_list_events`); the in-process Claude SDK exposes
 * our tools over the MCP bridge as `mcp__<server>__<tool>`. Stripping the
 * prefix lets both harnesses resolve to the same card.
 */
export function normalizedToolName(name: string): string {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 3
    ? parts.slice(2).join("__")
    : name;
}

/** The parsed JSON value of a tool output, or null when it is not JSON. */
function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderArg(args: unknown): unknown {
  return asRecord(args)?.render;
}

/**
 * A payload that names its card (`renderKind`) and does not refuse it
 * (`renderRequested: false` is the tool saying "this call did not ask to be
 * shown").
 */
function outputHasRenderKind(output: string, kind: string): boolean {
  const payload = asRecord(parseJsonValue(output));
  return payload?.renderKind === kind && payload.renderRequested !== false;
}

const GOOGLE_WORKSPACE_CARD_TOOLS = [
  "google_calendar_list_events",
  "google_meet_list_records",
  "google_drive_get_file",
  "google_gmail_read",
] as const;

export function acceptsGoogleWorkspaceCard(c: ToolCardCandidate): boolean {
  if (c.isError) return false;
  if (
    !(GOOGLE_WORKSPACE_CARD_TOOLS as readonly string[]).includes(
      normalizedToolName(c.name),
    )
  )
    return false;
  if (renderArg(c.args) !== true) return false;
  // Any parsed JSON the card can take apart, exactly as the card matches it:
  // an array or a string is a card (of nothing much), not a generic body.
  return Boolean(parseJsonValue(c.output));
}

export function acceptsJiraCard(c: ToolCardCandidate): boolean {
  if (c.isError) return false;
  const name = normalizedToolName(c.name);
  if (name !== "jira_search_issues" && name !== "jira_lookup") return false;
  if (renderArg(c.args) !== true) return false;
  const payload = parseJsonValue(c.output) as { kind?: unknown } | null;
  if (!payload) return false;
  // jira_lookup only has table cards for the projects/users kinds (not fields).
  if (
    name === "jira_lookup" &&
    payload.kind !== "projects" &&
    payload.kind !== "users"
  )
    return false;
  return true;
}

export function acceptsWorkshopDraftHandoffCard(c: ToolCardCandidate): boolean {
  if (c.isError || normalizedToolName(c.name) !== "workshop_draft_handoff")
    return false;
  const payload = parseJsonValue(c.output) as { renderKind?: unknown } | null;
  return payload?.renderKind === "workshopDraftHandoff";
}

/**
 * The question flow always renders in-band (interactive while pending, then a
 * read-only record) — from the call's ARGUMENTS; the card never reads the
 * output.
 */
export function acceptsAgentQuestionCard(c: ToolCardCandidate): boolean {
  return normalizedToolName(c.name) === "ask_questions" && !c.isError;
}

/* ------------------------------ peer prompts ------------------------------ */

/**
 * Every lifecycle state, as a lookup. Written as a `Record<PeerPromptState, …>`
 * so a state added to the protocol union fails the build HERE rather than
 * silently becoming an unrecognized value the card refuses to render.
 */
const PEER_PROMPT_STATES: Record<PeerPromptState, true> = {
  queued: true,
  delivered: true,
  acknowledged: true,
  completed: true,
  awaiting_response: true,
  replied: true,
  retrying: true,
  interrupted: true,
  cancelled: true,
  expired: true,
  failed: true,
};

export function isPeerPromptState(value: unknown): value is PeerPromptState {
  return typeof value === "string" && Object.hasOwn(PEER_PROMPT_STATES, value);
}

/**
 * Validate an untrusted peer-prompt card (a tool payload parsed out of model
 * output, which may be partial, streaming or malformed) into a real
 * `PeerPromptCard`, or `null` when it is not one.
 *
 * Three fields DECIDE the card and are required: `direction` (which party it
 * names), `message` (a string, because it is rendered as Markdown — an object
 * here would throw inside the renderer) and a known `state` (an unknown one
 * would show no status, or an invented one). Everything else is coerced to a
 * safe value or dropped, so a card missing a title still renders instead of
 * taking the transcript row down with it.
 */
export function parsePeerPromptCard(value: unknown): PeerPromptCard | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.direction !== "sent" && raw.direction !== "received") return null;
  if (typeof raw.message !== "string") return null;
  if (!isPeerPromptState(raw.state)) return null;
  return {
    direction: raw.direction,
    messageKey: typeof raw.messageKey === "string" ? raw.messageKey : "",
    senderTitle:
      typeof raw.senderTitle === "string" && raw.senderTitle
        ? raw.senderTitle
        : "another session",
    ...(typeof raw.recipientTitle === "string" && raw.recipientTitle
      ? { recipientTitle: raw.recipientTitle }
      : {}),
    ...(typeof raw.peerSessionId === "string" && raw.peerSessionId
      ? { peerSessionId: raw.peerSessionId }
      : {}),
    message: raw.message,
    responseRequested: raw.responseRequested === true,
    ...(typeof raw.taskTitle === "string" && raw.taskTitle
      ? { taskTitle: raw.taskTitle }
      : {}),
    ...(typeof raw.failureReason === "string" && raw.failureReason
      ? { failureReason: raw.failureReason }
      : {}),
    state: raw.state,
  };
}

/**
 * Only a payload that yields a VALID card matches: a partial, streaming or
 * malformed one has no card to show, so it stays an ordinary tool block rather
 * than a half-rendered card.
 */
export function peerPromptCardOf(c: ToolCardCandidate): PeerPromptCard | null {
  if (c.isError || normalizedToolName(c.name) !== "session_send_prompt")
    return null;
  if (!outputHasRenderKind(c.output, "sessionPeerPrompt")) return null;
  return parsePeerPromptCard(asRecord(parseJsonValue(c.output))?.card);
}

/* ------------------------------- show_files ------------------------------- */

/**
 * One `show_files` row the reader ACCEPTED: an address that resolved to an
 * internal served source, re-spelled from that resolved target. The producer's
 * own url, mime and kind never survive into the render.
 */
export interface ShowFilesCardRow {
  /** Canonical served path for the resolved target. */
  url: string;
  name: string;
  label: string;
  /** Bytes, when the row carried a usable number. Zero is a size, not absence. */
  size?: number;
}

/**
 * The canonical served path for a row's address, or null when the address is
 * not an internal host-file or session-artifact target. The web resolves
 * against its origin (`lib/documentTargets.ts`); the server, which has no page
 * origin, accepts the relative API paths the tool itself emits.
 */
export type ShowFilesTargetResolver = (url: string) => string | null;

/**
 * Validate an untrusted `show_files` payload (a tool result parsed out of the
 * transcript, which may be partial, streaming, malformed — or crafted) into the
 * rows the transcript may draw, or `null` when there is no card to draw.
 *
 * `url` DECIDES a row, and only through the caller's resolver
 * (`docs/document-presentation.md`): a foreign origin, a lookalike pathname on
 * someone else's host, an app-relative path the app does not serve, and a
 * Knowledge or worktree address this tool never produces are all dropped rather
 * than rendered. What survives is re-spelled from the resolved target, so the
 * card fetches the canonical address and classifies the file by it. Everything
 * else is coerced: a row missing its label still renders.
 */
function parseShowFilesCard(
  value: unknown,
  resolve: ShowFilesTargetResolver,
): ShowFilesCardRow[] | null {
  const list = asRecord(asRecord(value)?.card)?.files;
  if (!Array.isArray(list)) return null;
  const rows = list
    .map((row) => parseShowFilesCardRow(row, resolve))
    .filter((row): row is ShowFilesCardRow => row !== null);
  return rows.length > 0 ? rows : null;
}

function parseShowFilesCardRow(
  value: unknown,
  resolve: ShowFilesTargetResolver,
): ShowFilesCardRow | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (typeof raw.url !== "string" || !raw.url) return null;
  const url = resolve(raw.url);
  if (url === null) return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  const size = raw.size;
  return {
    url,
    name,
    label: typeof raw.label === "string" && raw.label ? raw.label : name,
    ...(typeof size === "number" && Number.isFinite(size) && size >= 0
      ? { size }
      : {}),
  };
}

/**
 * `show_files` puts the files THEMSELVES in the chat: the card is the whole
 * point of the call, and a payload that yields no file stays an ordinary tool
 * block rather than an empty card.
 */
export function showFilesCardRowsOf(
  c: ToolCardCandidate,
  resolve: ShowFilesTargetResolver,
): ShowFilesCardRow[] | null {
  if (c.isError || normalizedToolName(c.name) !== "show_files") return null;
  if (!outputHasRenderKind(c.output, "showFiles")) return null;
  return parseShowFilesCard(parseJsonValue(c.output), resolve);
}

/* --------------------------------- kb_show -------------------------------- */

/** The payload shape `kb_show` writes. */
const KNOWLEDGE_ENTRY_CARD_VERSION = 2;
/** What the card can show of one field before its own layout truncates it. */
const KNOWLEDGE_ENTRY_CARD_TEXT_CHARS = 400;

/**
 * The Knowledge Base file a `kb_show` call is offering to open, or null when
 * the payload carries no usable file.
 *
 * A card names a file by its path and title, so both are required and the
 * envelope's `version` has to be one this parser was written against. The
 * retired `kb_show_entry` (version 1) named an entry FOLDER; its cards in older
 * transcripts open that folder's `index.md`. Everything else is coerced and
 * BOUNDED: a payload is untrusted data (it may be partial, malformed, or
 * crafted), and prose is the one part of it the transcript draws verbatim.
 *
 * Bounding is all the defence the text needs, because the text decides
 * nothing: the surface that opens reads the file at that path and draws its
 * REAL content. A payload that lies about a title cannot make anyone read the
 * wrong document; it can only mislabel a button for one click.
 */
export function knowledgeEntryCardOf(
  c: ToolCardCandidate,
): KnowledgeEntryCard | null {
  if (c.isError) return null;
  const name = normalizedToolName(c.name);
  const version =
    name === "kb_show"
      ? KNOWLEDGE_ENTRY_CARD_VERSION
      : name === "kb_show_entry"
        ? 1
        : null;
  if (version === null) return null;
  if (!outputHasRenderKind(c.output, "knowledgeEntry")) return null;
  const payload = asRecord(parseJsonValue(c.output));
  if (payload?.version !== version) return null;
  const raw = asRecord(payload.card);
  if (!raw) return null;
  const { path, title, summary, note } = raw;
  const boundedPath = boundedCardText(path);
  if (!boundedPath) return null;
  const boundedTitle = boundedCardText(title);
  if (!boundedTitle) return null;
  const boundedSummary = boundedCardText(summary);
  const boundedNote = boundedCardText(note);
  return {
    path: version === 1 ? `${boundedPath}/index.md` : boundedPath,
    title: boundedTitle,
    ...(boundedSummary ? { summary: boundedSummary } : {}),
    ...(boundedNote ? { note: boundedNote } : {}),
  };
}

/** One card text field: a non-empty string, clipped, or null for anything else. */
function boundedCardText(value: unknown): string | null {
  return typeof value === "string" && value
    ? value.slice(0, KNOWLEDGE_ENTRY_CARD_TEXT_CHARS)
    : null;
}

/* ------------------------------- task_manage ------------------------------ */

/** One entry of `task_manage`'s `changed[]` (the fields the card reads). */
export interface ChangedTaskPayload {
  id: string;
  title: string;
  status: TaskStatus;
  statusSuggestion?: TaskStatusSuggestion;
  statusSetByRequest?: boolean;
  descriptionEditsApplied?: number;
  /** A create the server resolved onto an EXISTING Task (Slack dedupe). */
  deduplicated?: boolean;
}

export interface TaskManagePayload {
  changed: ChangedTaskPayload[];
  deletedIds: string[];
  /** Trace appends, by the Task they landed on (one batch may comment on several). */
  commentedIds: string[];
  warnings: string[];
}

function asStatus(value: unknown): TaskStatus | null {
  return value === "todo" || value === "doing" || value === "done"
    ? value
    : null;
}

function statusSuggestionOf(value: unknown): TaskStatusSuggestion | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const to = record.to;
  if (to !== "done" && to !== "todo") return undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  return {
    to,
    at: typeof record.at === "number" ? record.at : 0,
    ...(reason ? { reason } : {}),
  };
}

function changedTaskOf(value: unknown): ChangedTaskPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : "";
  const status = asStatus(record.status);
  if (!id || !status) return null;
  const suggestion = statusSuggestionOf(record.statusSuggestion);
  return {
    id,
    title: typeof record.title === "string" ? record.title : `Task ${id}`,
    status,
    ...(suggestion ? { statusSuggestion: suggestion } : {}),
    ...(record.statusSetByRequest === true ? { statusSetByRequest: true } : {}),
    ...(record.deduplicated === true ? { deduplicated: true } : {}),
    ...(typeof record.descriptionEditsApplied === "number"
      ? { descriptionEditsApplied: record.descriptionEditsApplied }
      : {}),
  };
}

/**
 * The card's view of a `task_manage` result. Defensive throughout: a streaming,
 * clipped or otherwise unexpected payload yields whatever parsed, and the
 * renderer shows nothing rather than a broken card.
 */
export function parseTaskManagePayload(
  output: string,
): TaskManagePayload | null {
  const record = asRecord(parseJsonValue(output));
  if (!record) return null;
  const changed = Array.isArray(record.changed)
    ? record.changed
        .map(changedTaskOf)
        .filter((entry): entry is ChangedTaskPayload => entry !== null)
    : [];
  const deletedIds = Array.isArray(record.deletedIds)
    ? record.deletedIds.filter((id): id is string => typeof id === "string")
    : [];
  const commentedIds = Array.isArray(record.comments)
    ? record.comments
        .map((comment) => asRecord(comment)?.taskId)
        .filter((id): id is string => typeof id === "string")
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((text): text is string => typeof text === "string")
    : [];
  return { changed, deletedIds, commentedIds, warnings };
}

/**
 * Task MUTATIONS only: `task_manage` carries the `taskManage` render kind and
 * `task_read` deliberately does not. The card then shows something only for a
 * payload with at least one changed, deleted or commented Task — a batch that
 * touched nothing renders nothing, so its payload is a generic body.
 */
export function taskManagePayloadOf(
  c: ToolCardCandidate,
): TaskManagePayload | null {
  if (c.isError || normalizedToolName(c.name) !== "task_manage") return null;
  if (!outputHasRenderKind(c.output, "taskManage")) return null;
  const payload = parseTaskManagePayload(c.output);
  if (
    !payload ||
    (payload.changed.length === 0 &&
      payload.deletedIds.length === 0 &&
      payload.commentedIds.length === 0)
  )
    return null;
  return payload;
}

/* ------------------------------ worktree cards ---------------------------- */

export function worktreeCommitDisplayOf(
  c: ToolCardCandidate,
): CommitDisplay | null {
  if (c.isError || normalizedToolName(c.name) !== "worktree_commit")
    return null;
  const value = parseJsonValue(c.output);
  if (!value || typeof value !== "object") return null;
  const display = value as Partial<CommitDisplay>;
  if (
    !["committed", "dry-run", "blocked", "failed"].includes(
      display.status ?? "",
    ) ||
    typeof display.dryRun !== "boolean" ||
    typeof display.forced !== "boolean" ||
    !Array.isArray(display.files) ||
    !Array.isArray(display.blockers) ||
    !Array.isArray(display.warnings) ||
    !display.totals ||
    typeof display.totals.files !== "number"
  )
    return null;
  return display as CommitDisplay;
}

export function worktreePushDisplayOf(
  c: ToolCardCandidate,
): PushDisplay | null {
  if (c.isError || normalizedToolName(c.name) !== "worktree_push") return null;
  const value = parseJsonValue(c.output);
  if (!value || typeof value !== "object") return null;
  const display = value as Partial<PushDisplay>;
  if (
    !["pushed", "up-to-date"].includes(display.status ?? "") ||
    typeof display.forced !== "boolean" ||
    typeof display.setUpstream !== "boolean" ||
    typeof display.localHead !== "string"
  )
    return null;
  return display as PushDisplay;
}

/* --------------------------------- the decision --------------------------- */

/**
 * The card a COMPLETED tool result renders as, or null for a generic body.
 * Tool names are disjoint across cards, so the order here cannot change the
 * answer. `resolveShowFilesTarget` is the caller's address resolver.
 */
export function toolCardOf(
  c: ToolCardCandidate,
  resolveShowFilesTarget: ShowFilesTargetResolver,
): ToolCardKind | null {
  if (acceptsGoogleWorkspaceCard(c)) return "googleWorkspace";
  if (acceptsJiraCard(c)) return "jira";
  if (acceptsWorkshopDraftHandoffCard(c)) return "workshopDraftHandoff";
  if (taskManagePayloadOf(c) !== null) return "taskManage";
  if (peerPromptCardOf(c) !== null) return "peerPrompt";
  if (worktreeCommitDisplayOf(c) !== null) return "worktreeCommit";
  if (worktreePushDisplayOf(c) !== null) return "worktreePush";
  if (showFilesCardRowsOf(c, resolveShowFilesTarget) !== null)
    return "showFiles";
  if (knowledgeEntryCardOf(c) !== null) return "knowledgeEntry";
  if (acceptsAgentQuestionCard(c)) return "agentQuestion";
  return null;
}

/**
 * What of the CALL each card reads, which is what has to survive a projection
 * that summarizes large inputs. The question card renders its questions from
 * the arguments and reads nothing else; the Task card lines the operations up
 * with the result to say what happened to each Task; the Google and Jira
 * cards look at the `render` marker only, which every summary keeps.
 */
export function toolCardReadsInput(kind: ToolCardKind): boolean {
  return kind === "agentQuestion" || kind === "taskManage";
}

/** Whether a card reads the result payload at all (the question card does not). */
export function toolCardReadsOutput(kind: ToolCardKind): boolean {
  return kind !== "agentQuestion";
}
