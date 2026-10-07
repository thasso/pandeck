import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleHelp, MessageCircleQuestion } from "lucide-react";
import { applyPatch } from "@assistant/shared";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionAnswerDisposition,
  Patch,
  AgentQuestionRequest,
  AgentQuestionResponse,
} from "@assistant/shared";
const QUESTION_DRAFT_STORAGE_PREFIX = "assistant.agentQuestionDraft.";
const QUESTION_DRAFT_STORAGE_VERSION = 1;

/**
 * @component AgentQuestionForm
 * @purpose In-band wizard for the ask_questions tool: answer multiple structured questions and review before submit.
 * @useWhen Rendered inside the in-band `ask_questions` chat card while its question flow is the session's active pendingQuestion.
 * @avoidWhen A simple one-line clarification in normal assistant text is enough.
 * @intent Compact step-by-step form with inline back/next/review/submit + cancel, selectable “discuss in chat”, and a final review step.
 * @related AgentQuestionToolCard, ask_questions server tool payload AgentQuestionRequest.
 */
export function AgentQuestionForm({
  request,
  onRespond,
  notice,
}: {
  request: AgentQuestionRequest | undefined;
  onRespond: (response: AgentQuestionResponse) => void;
  /** Where the answers go when they cannot reach the agent immediately. */
  notice?: string | undefined;
}) {
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadedRequestId, setLoadedRequestId] = useState<string | null>(null);

  // Keyed on the request ID alone: this restores the panel for a DIFFERENT
  // question set, so `request` is read through a ref rather than depended on.
  // The object is rebuilt on every broadcast, and re-running here would throw
  // away the answers being typed into it.
  const requestRef = useRef(request);
  requestRef.current = request;
  const requestId = request?.requestId ?? null;
  useEffect(() => {
    const current = requestRef.current;
    if (!current) {
      setLoadedRequestId(null);
      return;
    }
    const restored = readStoredQuestionPanelState(current);
    setIndex(restored?.index ?? 0);
    setDrafts(restored?.drafts ?? initialDrafts(current.questions));
    setError(null);
    setLoadedRequestId(current.requestId);
  }, [requestId]);

  useEffect(() => {
    if (!request || loadedRequestId !== request.requestId) return;
    writeStoredQuestionPanelState(request, { index, drafts });
  }, [request, loadedRequestId, index, drafts]);

  const questions = request?.questions ?? [];
  const current = questions[index];
  const summary = Boolean(request && index >= questions.length);
  const answers = useMemo(
    () => (request ? buildAnswers(request.questions, drafts) : []),
    [request, drafts],
  );
  const discussCount = answers.filter(
    (answer) => answer.disposition === "discuss",
  ).length;

  if (!request) return null;

  const setDraft = (questionId: string, patch: Patch<QuestionDraft>) => {
    setDrafts((currentDrafts) => {
      const base = currentDrafts[questionId] ?? { choiceIds: [], text: "" };
      return {
        ...currentDrafts,
        [questionId]: applyPatch(base, patch),
      };
    });
    setError(null);
  };

  const cancel = () => {
    clearStoredQuestionPanelState(request);
    onRespond({
      requestId: request.requestId,
      status: "cancelled",
      answers: [],
      cancelledReason: "User cancelled the question flow and returned to chat.",
      submittedAt: Date.now(),
    });
  };

  const goNext = () => {
    if (!current) return;
    const validation = validateAnswer(current, drafts[current.id]);
    if (validation) {
      setError(validation);
      return;
    }
    setIndex((i) => Math.min(i + 1, questions.length));
    setError(null);
  };

  const submit = () => {
    clearStoredQuestionPanelState(request);
    onRespond({
      requestId: request.requestId,
      status: "submitted",
      answers,
      submittedAt: Date.now(),
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-foreground">
        <MessageCircleQuestion size={15} className="shrink-0 text-primary" />
        <span className="min-w-0 truncate font-medium">{request.title}</span>
      </div>
      {request.intro ? (
        <p className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
          {request.intro}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {summary ? "Review" : `Question ${index + 1} of ${questions.length}`}
        </span>
        <span>{questions.length} total · review before submit</span>
      </div>
      <ProgressBar
        value={summary ? questions.length : index}
        max={questions.length}
      />

      {summary ? (
        <QuestionSummary
          questions={questions}
          answers={answers}
          onEdit={(questionIndex) => setIndex(questionIndex)}
        />
      ) : current ? (
        <QuestionStep
          question={current}
          draft={drafts[current.id] ?? initialDraft(current)}
          onDraft={setDraft}
        />
      ) : null}

      {notice ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={cancel}
          className="rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded-lg border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:border-input hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          {summary ? (
            <button
              type="button"
              onClick={submit}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Check size={12} /> {discussCount ? "Submit + discuss" : "Submit"}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              className="rounded-lg bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {index === questions.length - 1 ? "Review" : "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface QuestionDraft {
  choiceIds: string[];
  text: string;
  disposition?: AgentQuestionAnswerDisposition;
}

function initialDraft(question: AgentQuestion): QuestionDraft {
  return {
    choiceIds: question.defaultChoiceIds ?? [],
    text: question.defaultText ?? "",
  };
}

function initialDrafts(
  questions: AgentQuestion[],
): Record<string, QuestionDraft> {
  return Object.fromEntries(
    questions.map((question) => [question.id, initialDraft(question)]),
  );
}

interface StoredQuestionPanelState {
  version: typeof QUESTION_DRAFT_STORAGE_VERSION;
  requestId: string;
  index: number;
  drafts: Record<string, QuestionDraft>;
  updatedAt: number;
}

function questionDraftStorageKey(request: AgentQuestionRequest): string {
  return `${QUESTION_DRAFT_STORAGE_PREFIX}${request.sessionId}.${request.requestId}`;
}

function readStoredQuestionPanelState(
  request: AgentQuestionRequest,
): Pick<StoredQuestionPanelState, "index" | "drafts"> | null {
  try {
    const raw = window.localStorage.getItem(questionDraftStorageKey(request));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredQuestionPanelState>;
    if (
      parsed.version !== QUESTION_DRAFT_STORAGE_VERSION ||
      parsed.requestId !== request.requestId
    )
      return null;
    return {
      index: clampQuestionIndex(parsed.index, request.questions.length),
      drafts: sanitizeStoredDrafts(request.questions, parsed.drafts),
    };
  } catch {
    return null;
  }
}

function writeStoredQuestionPanelState(
  request: AgentQuestionRequest,
  state: Pick<StoredQuestionPanelState, "index" | "drafts">,
): void {
  try {
    const payload: StoredQuestionPanelState = {
      version: QUESTION_DRAFT_STORAGE_VERSION,
      requestId: request.requestId,
      index: clampQuestionIndex(state.index, request.questions.length),
      drafts: sanitizeStoredDrafts(request.questions, state.drafts),
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(
      questionDraftStorageKey(request),
      JSON.stringify(payload),
    );
  } catch {
    // Best-effort browser-local convenience only; the flow still works without storage.
  }
}

function clearStoredQuestionPanelState(request: AgentQuestionRequest): void {
  try {
    window.localStorage.removeItem(questionDraftStorageKey(request));
  } catch {
    // Best-effort browser-local convenience only.
  }
}

function sanitizeStoredDrafts(
  questions: AgentQuestion[],
  rawDrafts: unknown,
): Record<string, QuestionDraft> {
  const source =
    rawDrafts && typeof rawDrafts === "object"
      ? (rawDrafts as Record<string, Partial<QuestionDraft>>)
      : {};
  return Object.fromEntries(
    questions.map((question) => {
      const fallback = initialDraft(question);
      const raw = source[question.id];
      const allowedChoiceIds = new Set(
        (question.choices ?? []).map((choice) => choice.id),
      );
      const choiceIds = Array.isArray(raw?.choiceIds)
        ? raw.choiceIds.filter(
            (id): id is string =>
              typeof id === "string" && allowedChoiceIds.has(id),
          )
        : fallback.choiceIds;
      const disposition =
        raw?.disposition === "answered" ||
        raw?.disposition === "discuss" ||
        raw?.disposition === "skipped"
          ? raw.disposition
          : undefined;
      return [
        question.id,
        {
          choiceIds,
          text: typeof raw?.text === "string" ? raw.text : fallback.text,
          ...(disposition !== undefined ? { disposition } : {}),
        } satisfies QuestionDraft,
      ];
    }),
  );
}

function clampQuestionIndex(value: unknown, questionCount: number): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(numeric, questionCount));
}

function QuestionStep({
  question,
  draft,
  onDraft,
}: {
  question: AgentQuestion;
  draft: QuestionDraft;
  onDraft: (questionId: string, patch: Patch<QuestionDraft>) => void;
}) {
  const typedLabel =
    question.typedAnswerLabel ??
    (isChoiceStyle(question) ? "Typed answer or extra context" : "Answer");
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card/60 p-3">
      <div>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {question.title}
          </h3>
          {!question.required && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Optional
            </span>
          )}
        </div>
        {question.prompt ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {question.prompt}
          </p>
        ) : null}
        {question.helpText ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {question.helpText}
          </p>
        ) : null}
      </div>

      {isChoiceStyle(question) ? (
        <ChoiceList question={question} draft={draft} onDraft={onDraft} />
      ) : null}

      {question.style === "text" ||
      question.style === "textarea" ||
      question.allowTypedAnswer ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-muted-foreground">
            {typedLabel}
          </span>
          {question.style === "text" ? (
            <input
              value={draft.text}
              onChange={(event) =>
                onDraft(question.id, { text: event.target.value })
              }
              placeholder={question.placeholder ?? "Type your answer…"}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-input"
            />
          ) : (
            <textarea
              value={draft.text}
              onChange={(event) =>
                onDraft(question.id, { text: event.target.value })
              }
              rows={3}
              placeholder={question.placeholder ?? "Type your answer…"}
              className="max-h-36 min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-input"
            />
          )}
        </label>
      ) : null}

      <DiscussAnswerOption
        question={question}
        draft={draft}
        onDraft={onDraft}
      />
    </section>
  );
}

function DiscussAnswerOption({
  question,
  draft,
  onDraft,
}: {
  question: AgentQuestion;
  draft: QuestionDraft;
  onDraft: (questionId: string, patch: Patch<QuestionDraft>) => void;
}) {
  const active = draft.disposition === "discuss";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={() =>
        onDraft(question.id, { ...(!active ? { disposition: "discuss" } : {}) })
      }
      className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary/40 bg-accent text-foreground"
          : "border-border bg-background text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground"
      }`}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input"
        }`}
        aria-hidden="true"
      >
        {active ? <Check size={11} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <CircleHelp size={12} className="text-primary" /> Discuss in chat
          instead
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          Return this item as a follow-up topic rather than an assumed answer.
        </span>
      </span>
    </button>
  );
}

function ChoiceList({
  question,
  draft,
  onDraft,
}: {
  question: AgentQuestion;
  draft: QuestionDraft;
  onDraft: (questionId: string, patch: Patch<QuestionDraft>) => void;
}) {
  const multiple = question.style === "multi_choice";
  const choices = question.choices ?? [];
  const toggle = (id: string) => {
    const selected = new Set(draft.choiceIds);
    if (multiple) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      onDraft(question.id, {
        choiceIds: [...selected],
        disposition: undefined,
      });
    } else {
      onDraft(question.id, { choiceIds: [id], disposition: undefined });
    }
  };

  return (
    <div
      className="space-y-1.5"
      role={multiple ? "group" : "radiogroup"}
      aria-label={question.title}
    >
      {choices.map((choice) => {
        const active = draft.choiceIds.includes(choice.id);
        return (
          <button
            key={choice.id}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={active}
            onClick={() => toggle(choice.id)}
            className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
              active
                ? "border-primary/40 bg-accent text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground"
            }`}
          >
            <span
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${
                multiple ? "rounded" : "rounded-full"
              } ${active ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
              aria-hidden="true"
            >
              {active ? <Check size={11} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{choice.label}</span>
              {choice.description ? (
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {choice.description}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function QuestionSummary({
  questions,
  answers,
  onEdit,
}: {
  questions: AgentQuestion[];
  answers: AgentQuestionAnswer[];
  onEdit: (index: number) => void;
}) {
  return (
    <section className="space-y-2 rounded-2xl border border-border bg-card/60 p-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          Review before submitting
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Answers marked “Discuss in chat” will be returned to the agent as
          follow-up topics, not assumptions.
        </p>
      </div>
      <div className="space-y-2">
        {questions.map((question, index) => {
          const answer = answers.find(
            (item) => item.questionId === question.id,
          );
          return (
            <div
              key={question.id}
              className="rounded-xl border border-border bg-background px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {question.title}
                  </div>
                  <AnswerPreview question={question} answer={answer} />
                </div>
                <button
                  type="button"
                  onClick={() => onEdit(index)}
                  className="shrink-0 rounded-lg px-2 py-1 text-sm text-primary transition-colors hover:bg-accent"
                >
                  Edit
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AnswerPreview({
  question,
  answer,
}: {
  question: AgentQuestion;
  answer: AgentQuestionAnswer | undefined;
}) {
  if (!answer || answer.disposition === "skipped")
    return <div className="mt-1 text-sm text-muted-foreground">Skipped</div>;
  if (answer.disposition === "discuss") {
    return (
      <div className="mt-1 whitespace-pre-wrap text-sm text-primary">
        Discuss in chat{answer.text?.trim() ? ` · ${answer.text.trim()}` : ""}
      </div>
    );
  }
  const choiceLabels = (answer.choiceIds ?? []).map(
    (id) => question.choices?.find((choice) => choice.id === id)?.label ?? id,
  );
  const pieces = [...choiceLabels, answer.text?.trim()].filter(Boolean);
  return (
    <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
      {pieces.join(choiceLabels.length && answer.text ? " · " : "") || "—"}
    </div>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function isChoiceStyle(question: AgentQuestion): boolean {
  return (
    question.style === "single_choice" ||
    question.style === "multi_choice" ||
    question.style === "confirm"
  );
}

function validateAnswer(
  question: AgentQuestion,
  draft: QuestionDraft | undefined,
): string | null {
  if (!question.required || draft?.disposition === "discuss") return null;
  const hasChoice = Boolean(draft?.choiceIds.length);
  const hasText = Boolean(draft?.text.trim());
  if (hasChoice || hasText) return null;
  return "Answer this question, or choose “Discuss in chat” to handle it as a follow-up.";
}

function buildAnswers(
  questions: AgentQuestion[],
  drafts: Record<string, QuestionDraft>,
): AgentQuestionAnswer[] {
  return questions.map((question) => {
    const draft = drafts[question.id] ?? initialDraft(question);
    const choiceIds = draft.choiceIds;
    const text = draft.text.trim() || undefined;
    const hasAnswer = choiceIds.length > 0 || Boolean(text);
    const disposition =
      draft.disposition ??
      (hasAnswer ? "answered" : question.required ? "discuss" : "skipped");
    return {
      questionId: question.id,
      choiceIds,
      ...(text !== undefined ? { text } : {}),
      disposition,
    };
  });
}
