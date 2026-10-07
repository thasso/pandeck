import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, CircleHelp, Info, MessageCircleQuestion } from "lucide-react";
import { applyPatch } from "@assistant/shared";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionAnswerDisposition,
  Patch,
  AgentQuestionRequest,
  AgentQuestionResponse,
} from "@assistant/shared";
import { ErrorNote } from "./common/load.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

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
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 truncate">{request.title}</span>
        </CardTitle>
        {request.intro ? (
          <CardDescription>{request.intro}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress
          value={
            questions.length > 0
              ? ((summary ? questions.length : index) / questions.length) * 100
              : 0
          }
        >
          <ProgressLabel>
            {summary
              ? "Review"
              : `Question ${index + 1} of ${questions.length}`}
          </ProgressLabel>
          <span className="ml-auto text-sm text-muted-foreground">
            {questions.length} total · review before submit
          </span>
        </Progress>
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
          <Alert role="note">
            <Info />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {error ? <ErrorNote message={error} /> : null}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
          >
            Back
          </Button>
          {summary ? (
            <Button size="sm" onClick={submit}>
              <Check /> {discussCount ? "Submit + discuss" : "Submit"}
            </Button>
          ) : (
            <Button size="sm" onClick={goNext}>
              {index === questions.length - 1 ? "Review" : "Next"}
            </Button>
          )}
        </div>
      </CardFooter>
    </>
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
  const id = useId();
  const typedLabel =
    question.typedAnswerLabel ??
    (isChoiceStyle(question) ? "Typed answer or extra context" : "Answer");
  const active = draft.disposition === "discuss";
  return (
    <FieldSet>
      <FieldLegend className="flex w-full items-start justify-between gap-3">
        {question.title}
        {!question.required && <Badge variant="secondary">Optional</Badge>}
      </FieldLegend>
      {question.prompt ? (
        <FieldDescription className="whitespace-pre-wrap">
          {question.prompt}
        </FieldDescription>
      ) : null}
      {question.helpText ? (
        <FieldDescription>{question.helpText}</FieldDescription>
      ) : null}
      <FieldGroup className="gap-3">
        {isChoiceStyle(question) ? (
          <ChoiceList question={question} draft={draft} onDraft={onDraft} />
        ) : null}
        {question.style === "text" ||
        question.style === "textarea" ||
        question.allowTypedAnswer ? (
          <Field>
            <FieldLabel htmlFor={`${id}-text`}>{typedLabel}</FieldLabel>
            {question.style === "text" ? (
              <Input
                id={`${id}-text`}
                value={draft.text}
                onChange={(event) =>
                  onDraft(question.id, { text: event.target.value })
                }
                placeholder={question.placeholder ?? "Type your answer…"}
              />
            ) : (
              <Textarea
                id={`${id}-text`}
                value={draft.text}
                onChange={(event) =>
                  onDraft(question.id, { text: event.target.value })
                }
                placeholder={question.placeholder ?? "Type your answer…"}
                className="max-h-36"
              />
            )}
          </Field>
        ) : null}
        <Field orientation="horizontal">
          <Checkbox
            id={`${id}-discuss`}
            checked={active}
            onCheckedChange={(checked) =>
              onDraft(question.id, {
                disposition: checked ? "discuss" : undefined,
              })
            }
          />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-discuss`}>
              <CircleHelp className="size-3 text-primary" /> Discuss in chat
              instead
            </FieldLabel>
            <FieldDescription>
              Return this item as a follow-up topic rather than an assumed
              answer.
            </FieldDescription>
          </FieldContent>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

/** One choice: the whole row is the label of its radio or checkbox. */
function ChoiceField({
  id,
  choice,
  control,
}: {
  id: string;
  choice: NonNullable<AgentQuestion["choices"]>[number];
  control: ReactNode;
}) {
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        {control}
        <FieldContent>
          <FieldTitle>{choice.label}</FieldTitle>
          {choice.description ? (
            <FieldDescription>{choice.description}</FieldDescription>
          ) : null}
        </FieldContent>
      </Field>
    </FieldLabel>
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
  const id = useId();
  const choices = question.choices ?? [];
  if (question.style !== "multi_choice")
    return (
      <RadioGroup
        aria-label={question.title}
        value={draft.choiceIds[0] ?? null}
        onValueChange={(value) =>
          onDraft(question.id, {
            choiceIds: [value as string],
            disposition: undefined,
          })
        }
      >
        {choices.map((choice) => (
          <ChoiceField
            key={choice.id}
            id={`${id}-${choice.id}`}
            choice={choice}
            control={
              <RadioGroupItem value={choice.id} id={`${id}-${choice.id}`} />
            }
          />
        ))}
      </RadioGroup>
    );
  const toggle = (choiceId: string, checked: boolean) => {
    const selected = new Set(draft.choiceIds);
    if (checked) selected.add(choiceId);
    else selected.delete(choiceId);
    onDraft(question.id, { choiceIds: [...selected], disposition: undefined });
  };
  return (
    <FieldGroup role="group" aria-label={question.title} className="gap-2">
      {choices.map((choice) => (
        <ChoiceField
          key={choice.id}
          id={`${id}-${choice.id}`}
          choice={choice}
          control={
            <Checkbox
              id={`${id}-${choice.id}`}
              checked={draft.choiceIds.includes(choice.id)}
              onCheckedChange={(checked) => toggle(choice.id, checked)}
            />
          }
        />
      ))}
    </FieldGroup>
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
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="font-medium">Review before submitting</h3>
        <p className="text-muted-foreground">
          Answers marked “Discuss in chat” will be returned to the agent as
          follow-up topics, not assumptions.
        </p>
      </div>
      <ItemGroup className="gap-2">
        {questions.map((question, index) => (
          <Item key={question.id} variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{question.title}</ItemTitle>
              <AnswerPreview
                question={question}
                answer={answers.find((item) => item.questionId === question.id)}
              />
            </ItemContent>
            <ItemActions>
              <Button variant="ghost" size="sm" onClick={() => onEdit(index)}>
                Edit
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
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
    return <ItemDescription>Skipped</ItemDescription>;
  if (answer.disposition === "discuss") {
    return (
      <ItemDescription className="whitespace-pre-wrap text-primary">
        Discuss in chat{answer.text?.trim() ? ` · ${answer.text.trim()}` : ""}
      </ItemDescription>
    );
  }
  const choiceLabels = (answer.choiceIds ?? []).map(
    (id) => question.choices?.find((choice) => choice.id === id)?.label ?? id,
  );
  const pieces = [...choiceLabels, answer.text?.trim()].filter(Boolean);
  return (
    <ItemDescription className="whitespace-pre-wrap">
      {pieces.join(choiceLabels.length && answer.text ? " · " : "") || "—"}
    </ItemDescription>
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
