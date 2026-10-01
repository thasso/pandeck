import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgentTool } from "../../mcp/tool.ts";
import { notifySessionBlocked } from "../../webPush.ts";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionChoice,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentQuestionStyle,
  AnsweredAgentQuestion,
} from "@assistant/shared";
import { DATA_DIR } from "../../config.ts";

const MAX_QUESTIONS = 12;
const MAX_CHOICES = 20;
const MAX_TEXT_CHARS = 4000;
/** Keep the most recent resolved question flows per session for the in-band card. */
const MAX_ANSWERED_PER_SESSION = 20;

type QuestionToolParams = {
  title?: string;
  intro?: string;
  questions?: Array<{
    id?: string;
    title?: string;
    prompt?: string;
    helpText?: string;
    style?: AgentQuestionStyle;
    required?: boolean;
    choices?: Array<{ id?: string; label?: string; description?: string }>;
    allowTypedAnswer?: boolean;
    typedAnswerLabel?: string;
    placeholder?: string;
    defaultChoiceIds?: string[];
    defaultText?: string;
  }>;
};

type QuestionChangeListener = (sessionId: string) => void;

interface PendingQuestion {
  request: AgentQuestionRequest;
}

const listeners = new Set<QuestionChangeListener>();

/**
 * Pending questions persist across restarts/reloads so a session that's idle
 * waiting for an answer keeps its card (and its `idleReason`) when the server
 * comes back — the question is the reason it's idle, so losing it would strand
 * the session. Keyed by session id; the resume on answer works regardless of
 * agent kind (pi `prompt` / Claude `--resume`). Lives at
 * `<DATA_DIR>/pending-questions.json`.
 */
const PENDING_FILE = join(DATA_DIR, "pending-questions.json");
/** Resolved question flows per session, so the in-band card persists across reconnect/restart. */
const ANSWERED_FILE = join(DATA_DIR, "answered-questions.json");

function loadPersistedPending(): Map<string, PendingQuestion> {
  try {
    const raw = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as Record<
      string,
      AgentQuestionRequest
    >;
    return new Map(
      Object.entries(raw).map(([id, request]) => [id, { request }]),
    );
  } catch {
    return new Map();
  }
}

const pendingBySession = loadPersistedPending();

function persistPending(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, AgentQuestionRequest> = {};
    for (const [id, pending] of pendingBySession) obj[id] = pending.request;
    writeFileSync(PENDING_FILE, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort: a lost pending question only means the user must re-ask.
  }
}

function loadPersistedAnswered(): Map<string, AnsweredAgentQuestion[]> {
  try {
    const raw = JSON.parse(readFileSync(ANSWERED_FILE, "utf8")) as Record<
      string,
      AnsweredAgentQuestion[]
    >;
    return new Map(Object.entries(raw).map(([id, list]) => [id, list]));
  } catch {
    return new Map();
  }
}

const answeredBySession = loadPersistedAnswered();

function persistAnswered(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      ANSWERED_FILE,
      `${JSON.stringify(Object.fromEntries(answeredBySession), null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Best-effort: a lost answered record only means the in-band card shows the
    // questions without the recorded answers.
  }
}

/** Resolved question flows for a session (newest last), for the in-band card. */
export function getAnsweredAgentQuestions(
  sessionId: string,
): AnsweredAgentQuestion[] {
  return answeredBySession.get(sessionId) ?? [];
}

/**
 * First line of the hidden prompt that resumes a session once the user answers.
 * The agent reads the answers from it; our chat views drop any message carrying
 * this marker (the question card already shows the answers), the same way relay
 * prompts are hidden. Keep in sync with the chat filters in hub
 * `snapshot`/`prompt` (pi) and the Claude SDK session.
 */
export const QUESTION_ANSWERS_MARKER = "[ask_questions: user answers]";

const askQuestionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    intro: { type: "string", description: "Shown above the questions." },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: "Asked in the order given.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Unique within the flow." },
          title: { type: "string", description: "Question heading." },
          prompt: { type: "string", description: "Further text or context." },
          helpText: { type: "string" },
          style: {
            type: "string",
            enum: [
              "text",
              "textarea",
              "single_choice",
              "multi_choice",
              "confirm",
            ],
          },
          required: { type: "boolean", default: true },
          choices: {
            type: "array",
            maxItems: MAX_CHOICES,
            description:
              "For single_choice/multi_choice; confirm supplies its own yes/no.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
            },
          },
          allowTypedAnswer: {
            type: "boolean",
            description:
              "Let the user answer a choice/confirm question in their own words; set it whenever none of the options may fit.",
          },
          typedAnswerLabel: { type: "string" },
          placeholder: { type: "string" },
          defaultChoiceIds: { type: "array", items: { type: "string" } },
          defaultText: { type: "string" },
        },
      },
    },
  },
  required: ["questions"],
} as const;

/**
 * Subscribe a live web session to pending-question state changes for its session id.
 * The actual question payload is exposed through SessionState.pendingQuestion.
 */
export function subscribeAgentQuestionChanges(
  listener: QuestionChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingAgentQuestion(
  sessionId: string,
): AgentQuestionRequest | undefined {
  return pendingBySession.get(sessionId)?.request;
}

/**
 * Replace an MCP-generated/internal question tool id with the provider-visible
 * tool-use id once a harness can correlate them. Claude SDK receives only the
 * MCP request id inside the tool, but the transcript card is keyed by Claude's
 * `toolu_*` id; relinking keeps persisted pending/answered question records
 * directly addressable by the in-band tool card after reloads.
 */
export function relinkAgentQuestionToolCallId(
  sessionId: string,
  requestId: string,
  toolCallId: string,
): boolean {
  let changed = false;
  const pending = pendingBySession.get(sessionId);
  if (
    pending?.request.requestId === requestId &&
    pending.request.toolCallId !== toolCallId
  ) {
    pending.request = { ...pending.request, toolCallId };
    persistPending();
    changed = true;
  }

  const answered = answeredBySession.get(sessionId);
  if (answered) {
    const next = answered.map((entry) =>
      entry.requestId === requestId && entry.toolCallId !== toolCallId
        ? { ...entry, toolCallId }
        : entry,
    );
    if (next.some((entry, index) => entry !== answered[index])) {
      answeredBySession.set(sessionId, next);
      persistAnswered();
      changed = true;
    }
  }

  if (changed) emitQuestionChange(sessionId);
  return changed;
}

/**
 * Record the user's answers and produce the prompt that resumes the session.
 *
 * The question tool no longer blocks: it posed the questions, the agent ended
 * its turn, and the session went idle showing the card. Answering doesn't
 * "return" to a waiting tool call — it RESUMES the session with a fresh (hidden)
 * prompt carrying the answers, which the caller injects (pi `prompt`, Claude
 * `submitLine`). Returns the resume prompt, or `undefined` to leave the session
 * idle (the user cancelled — they'll type their own message).
 */
export function submitAgentQuestionResponse(
  sessionId: string,
  rawResponse: AgentQuestionResponse,
): { response: AgentQuestionResponse; resumePrompt?: string } {
  const pending = pendingBySession.get(sessionId);
  if (!pending) throw new Error("No pending question flow for this session.");
  if (rawResponse.requestId !== pending.request.requestId) {
    throw new Error(
      "Question response does not match the active question flow.",
    );
  }

  const response = normalizeResponse(pending.request, rawResponse);
  pendingBySession.delete(sessionId);
  persistPending();
  recordAnswered(sessionId, pending.request, response);
  emitQuestionChange(sessionId);
  const resumePromptValue = buildResumePrompt(pending.request, response);
  return {
    response,
    ...(resumePromptValue !== undefined
      ? { resumePrompt: resumePromptValue }
      : {}),
  };
}

/** Record a resolved question flow so the in-band card can show what was answered. */
function recordAnswered(
  sessionId: string,
  request: AgentQuestionRequest,
  response: AgentQuestionResponse,
): void {
  const entry: AnsweredAgentQuestion = {
    toolCallId: request.toolCallId,
    requestId: request.requestId,
    title: request.title,
    ...(request.intro ? { intro: request.intro } : {}),
    questions: request.questions,
    response,
  };
  const list = (answeredBySession.get(sessionId) ?? []).filter(
    (a) => a.requestId !== entry.requestId,
  );
  list.push(entry);
  answeredBySession.set(sessionId, list.slice(-MAX_ANSWERED_PER_SESSION));
  persistAnswered();
}

/** Drop a session's pending + answered questions (e.g. the session was deleted). */
export function clearPendingQuestion(sessionId: string): void {
  const hadAnswered = answeredBySession.delete(sessionId);
  if (hadAnswered) persistAnswered();
  if (!pendingBySession.delete(sessionId)) {
    if (hadAnswered) emitQuestionChange(sessionId);
    return;
  }
  persistPending();
  emitQuestionChange(sessionId);
}

/** The hidden prompt that hands the user's answers back to the agent. */
function buildResumePrompt(
  request: AgentQuestionRequest,
  response: AgentQuestionResponse,
): string | undefined {
  if (response.status === "cancelled") return undefined; // leave idle; the user will type
  const { text } = formatQuestionToolResult(request, response);
  return [
    QUESTION_ANSWERS_MARKER,
    "The user answered the questions you asked in the question panel. Continue using these answers (do not re-ask):",
    "",
    text,
  ].join("\n");
}

function emitQuestionChange(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

/** Register a pending question for a session (non-blocking) so the UI shows its card. */
function registerPendingQuestion(
  sessionId: string,
  request: AgentQuestionRequest,
): void {
  if (pendingBySession.has(sessionId)) {
    throw new Error("A question flow is already pending for this session.");
  }
  pendingBySession.set(sessionId, { request });
  persistPending();
  emitQuestionChange(sessionId);
  // Same rule as an approval: the agent cannot continue without an answer, so
  // this is push-eligible even though nothing has finished. Once only, at
  // registration — the card and the inbox tier carry it from here.
  void notifySessionBlocked(
    sessionId,
    "question",
    request.title ?? request.questions[0]?.title,
  ).catch(() => {});
}

/**
 * @payload AgentQuestionRequest
 * @purpose Interactive composer-docked question flow requested by the ask_questions tool.
 * @renderWhen Use when multiple clarifications, choices, or mixed typed/choice answers are easier than prose.
 * @bounds Up to 12 questions and 20 choices per question; answer text is trimmed before returning to the agent.
 * @client The web UI renders questions above the composer, supports cancel/discuss-later, and shows a review step before submit.
 */
export const askQuestionsTool = defineAgentTool<QuestionToolParams>({
  name: "ask_questions",
  label: "Ask Questions",
  description:
    "Ask the user an interactive question flow in the web UI: use it for more than one clarification or for structured choices, and keep prose for a single simple question. A question they return with disposition=discuss is a request to continue that point in chat, not an answer.",
  parameters: askQuestionsSchema,
  executionMode: "sequential",
  async execute(params, ctx) {
    const sessionId = ctx.session.sessionId;

    // Non-blocking: post the questions and return immediately so the tool call
    // never times out (it used to block waiting for the user, which timed out
    // long human pauses — especially for Claude over MCP). The session goes idle
    // showing the question card; answering resumes it with a fresh hidden prompt.
    const request = buildRequest(sessionId, ctx.toolCallId, params);
    registerPendingQuestion(sessionId, request);
    const status = `Posted ${request.questions.length} question${request.questions.length === 1 ? "" : "s"} to the user; awaiting their response.`;
    ctx.progress?.({
      content: [{ type: "text", text: status }],
      details: { status },
    });
    const text = [
      `Posted ${request.questions.length} question${request.questions.length === 1 ? "" : "s"} to the user in the app's question panel.`,
      "STOP HERE: end your turn now and wait. Do NOT guess, assume, or fill in answers, and do not keep working.",
      "The user's answers (or a cancellation) will arrive as a separate follow-up message that resumes this session.",
    ].join(" ");
    return {
      content: [{ type: "text", text }],
      details: {
        status: "awaiting-user",
        requestId: request.requestId,
        questionCount: request.questions.length,
      },
    };
  },
});

function buildRequest(
  sessionId: string,
  toolCallId: string,
  params: QuestionToolParams,
): AgentQuestionRequest {
  const questions = (params.questions ?? [])
    .slice(0, MAX_QUESTIONS)
    .map(normalizeQuestion);
  if (questions.length === 0)
    throw new Error("ask_questions requires at least one question.");
  const used = new Set<string>();
  const uniqueQuestions = questions.map((q, index) => {
    let id = q.id || `q${index + 1}`;
    if (used.has(id)) id = `${id}_${index + 1}`;
    used.add(id);
    return { ...q, id };
  });
  const introValue = cleanOptionalMultilineText(params.intro, 800);
  return {
    requestId: `question-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toolCallId,
    sessionId,
    title: cleanText(params.title, 120) || "A few questions",
    ...(introValue !== undefined ? { intro: introValue } : {}),
    questions: uniqueQuestions,
    createdAt: Date.now(),
  };
}

function normalizeQuestion(
  raw: NonNullable<QuestionToolParams["questions"]>[number],
  index: number,
): AgentQuestion {
  const style = normalizeStyle(raw.style, raw.choices);
  const choices =
    style === "confirm" ? confirmChoices() : normalizeChoices(raw.choices);
  const defaultChoiceIds = (raw.defaultChoiceIds ?? []).filter((id) =>
    choices.some((choice) => choice.id === id),
  );
  const promptValue = cleanOptionalMultilineText(raw.prompt, 1200);
  const helpTextValue = cleanOptionalMultilineText(raw.helpText, 600);
  const typedAnswerLabelValue = cleanOptionalText(raw.typedAnswerLabel, 120);
  const placeholderValue = cleanOptionalText(raw.placeholder, 200);
  const defaultTextValue = cleanOptionalMultilineText(
    raw.defaultText,
    MAX_TEXT_CHARS,
  );
  return {
    id: slug(raw.id || raw.title || `q${index + 1}`) || `q${index + 1}`,
    title: cleanText(raw.title, 200) || `Question ${index + 1}`,
    ...(promptValue !== undefined ? { prompt: promptValue } : {}),
    ...(helpTextValue !== undefined ? { helpText: helpTextValue } : {}),
    style,
    required: raw.required !== false,
    ...(choices.length > 0 ? { choices: choices } : {}),
    allowTypedAnswer:
      Boolean(raw.allowTypedAnswer) || style === "text" || style === "textarea",
    ...(typedAnswerLabelValue !== undefined
      ? { typedAnswerLabel: typedAnswerLabelValue }
      : {}),
    ...(placeholderValue !== undefined
      ? { placeholder: placeholderValue }
      : {}),
    defaultChoiceIds,
    ...(defaultTextValue !== undefined
      ? { defaultText: defaultTextValue }
      : {}),
  };
}

function normalizeStyle(
  style: AgentQuestionStyle | undefined,
  choices: unknown,
): AgentQuestionStyle {
  if (
    style === "text" ||
    style === "textarea" ||
    style === "single_choice" ||
    style === "multi_choice" ||
    style === "confirm"
  )
    return style;
  return Array.isArray(choices) && choices.length > 0
    ? "single_choice"
    : "textarea";
}

function normalizeChoices(
  rawChoices:
    Array<{ id?: string; label?: string; description?: string }> | undefined,
): AgentQuestionChoice[] {
  return (rawChoices ?? []).slice(0, MAX_CHOICES).map((choice, index) => {
    const label = cleanText(choice.label, 200) || `Option ${index + 1}`;
    const descriptionValue = cleanOptionalText(choice.description, 500);
    return {
      id: slug(choice.id || label) || `option_${index + 1}`,
      label,
      ...(descriptionValue !== undefined
        ? { description: descriptionValue }
        : {}),
    };
  });
}

function confirmChoices(): AgentQuestionChoice[] {
  return [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ];
}

function normalizeResponse(
  request: AgentQuestionRequest,
  raw: AgentQuestionResponse,
): AgentQuestionResponse {
  if (raw.status === "cancelled") {
    const cancelledReasonValue = cleanOptionalText(raw.cancelledReason, 500);
    return {
      requestId: request.requestId,
      status: "cancelled",
      answers: [],
      ...(cancelledReasonValue !== undefined
        ? { cancelledReason: cancelledReasonValue }
        : {}),
      submittedAt: Date.now(),
    };
  }

  const rawAnswers = new Map(
    (raw.answers ?? []).map((answer) => [answer.questionId, answer]),
  );
  const answers: AgentQuestionAnswer[] = request.questions.map((question) => {
    const rawAnswer = rawAnswers.get(question.id);
    const choices = new Set(
      (question.choices ?? []).map((choice) => choice.id),
    );
    const choiceIds = (rawAnswer?.choiceIds ?? []).filter((id) =>
      choices.has(id),
    );
    const text = cleanOptionalMultilineText(rawAnswer?.text, MAX_TEXT_CHARS);
    let disposition = rawAnswer?.disposition;
    if (
      disposition !== "answered" &&
      disposition !== "discuss" &&
      disposition !== "skipped"
    ) {
      disposition =
        text || choiceIds.length > 0
          ? "answered"
          : question.required
            ? "discuss"
            : "skipped";
    }
    if (disposition === "answered" && !text && choiceIds.length === 0) {
      disposition = question.required ? "discuss" : "skipped";
    }
    return {
      questionId: question.id,
      choiceIds,
      ...(text !== undefined ? { text } : {}),
      disposition,
    };
  });

  return {
    requestId: request.requestId,
    status: "submitted",
    answers,
    submittedAt: Date.now(),
  };
}

function formatQuestionToolResult(
  request: AgentQuestionRequest | undefined,
  response: AgentQuestionResponse,
) {
  const questions = request?.questions ?? [];
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const enriched = response.answers.map((answer) => {
    const question = byQuestion.get(answer.questionId);
    const choiceLabels = (answer.choiceIds ?? []).map(
      (id) =>
        question?.choices?.find((choice) => choice.id === id)?.label ?? id,
    );
    return {
      questionId: answer.questionId,
      title: question?.title,
      disposition: answer.disposition,
      choiceIds: answer.choiceIds ?? [],
      choiceLabels,
      text: answer.text ?? "",
    };
  });

  const details = {
    requestId: response.requestId,
    status: response.status,
    cancelledReason: response.cancelledReason,
    submittedAt: response.submittedAt,
    answers: enriched,
    followupRequested: enriched.filter(
      (answer) => answer.disposition === "discuss",
    ),
    presentationGuidance:
      response.status === "cancelled"
        ? "The user cancelled the question flow and returned to chat. Do not assume missing answers; continue conversationally if clarification is still needed."
        : "Use disposition=answered responses as user-provided answers. For disposition=discuss, continue in chat instead of assuming an answer. For skipped optional questions, proceed only if safe.",
  };

  const text = JSON.stringify(details, null, 2);
  return { text, details };
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function cleanOptionalText(value: unknown, max: number): string | undefined {
  const cleaned = cleanText(value, max);
  return cleaned || undefined;
}

function cleanMultilineText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim().slice(0, max).trim();
}

function cleanOptionalMultilineText(
  value: unknown,
  max: number,
): string | undefined {
  const cleaned = cleanMultilineText(value, max);
  return cleaned || undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
