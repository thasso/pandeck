import { Check, CircleSlash, MessageCircleQuestion } from "lucide-react";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AnsweredAgentQuestion,
  DisplayBlock,
} from "@assistant/shared";
import { AgentQuestionForm } from "./AgentQuestionForm.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

/**
 * @component AgentQuestionToolCard
 * @purpose In-band, persistent rendering of an `ask_questions` tool call: the live
 *   answer form while the flow is pending, then a read-only record of the Q&A.
 * @intent So the chat history shows that the user was asked something and what they
 *   answered (surviving reconnect), instead of a transient composer-docked panel.
 */
export function AgentQuestionToolCard({
  block,
  pendingQuestion,
  answeredQuestions,
  onRespond,
  notice,
}: {
  block: ToolBlock;
  pendingQuestion?: AgentQuestionRequest | undefined;
  answeredQuestions?: AnsweredAgentQuestion[] | undefined;
  onRespond?: ((response: AgentQuestionResponse) => void) | undefined;
  /** Where the answers go when the session cannot take them right now. */
  notice?: string | undefined;
}) {
  const answered = answeredQuestions?.find((a) =>
    answeredQuestionBelongsToBlock(a, block),
  );
  const pending =
    pendingQuestion &&
    !answered &&
    questionRequestBelongsToBlock(pendingQuestion, block)
      ? pendingQuestion
      : undefined;

  return (
    <div className="my-2 rounded-2xl border border-line bg-panel/60 p-3">
      {pending && onRespond ? (
        <AgentQuestionForm
          request={pending}
          onRespond={onRespond}
          {...(notice !== undefined ? { notice } : {})}
        />
      ) : answered ? (
        <AnsweredView answered={answered} />
      ) : (
        <FallbackView block={block} />
      )}
    </div>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 text-fg">
      <MessageCircleQuestion size={15} className="shrink-0 text-primary" />
      <span className="min-w-0 truncate font-medium text-caption">{title}</span>
    </div>
  );
}

function AnsweredView({ answered }: { answered: AnsweredAgentQuestion }) {
  const cancelled = answered.response.status === "cancelled";
  const byId = new Map(answered.response.answers.map((a) => [a.questionId, a]));
  return (
    <div className="space-y-2.5 text-caption">
      <CardHeader title={answered.title} />
      {answered.intro ? (
        <p className="text-caption text-faint">{answered.intro}</p>
      ) : null}
      {cancelled ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-raised/40 px-3 py-2 text-caption text-muted-foreground">
          <CircleSlash size={13} className="shrink-0 text-faint" />
          You cancelled this question flow.
        </div>
      ) : (
        <ul className="space-y-2">
          {answered.questions.map((q) => (
            <li
              key={q.id}
              className="rounded-xl border border-line bg-surface px-3 py-2"
            >
              <div className="text-caption font-medium text-fg">{q.title}</div>
              <AnswerLine question={q} answer={byId.get(q.id)} />
            </li>
          ))}
        </ul>
      )}
      {!cancelled && (
        <div className="flex items-center gap-1 text-caption text-faint">
          <Check size={12} className="text-primary" /> Answered
        </div>
      )}
    </div>
  );
}

function questionRequestBelongsToBlock(
  request: AgentQuestionRequest,
  block: ToolBlock,
): boolean {
  if (request.toolCallId === block.toolId) return true;
  return mcpGeneratedToolCallMatchesBlock(request, block);
}

function answeredQuestionBelongsToBlock(
  answered: AnsweredAgentQuestion,
  block: ToolBlock,
): boolean {
  if (answered.toolCallId === block.toolId) return true;
  return mcpGeneratedToolCallMatchesBlock(answered, block);
}

function mcpGeneratedToolCallMatchesBlock(
  request: Pick<AgentQuestionRequest, "toolCallId" | "title" | "questions">,
  block: ToolBlock,
): boolean {
  // Claude SDK custom tools are executed through the in-process MCP bridge. The
  // MCP server receives the MCP request id (currently a small numeric string),
  // not Claude's provider `toolu_*` id, while the transcript card keeps the
  // provider id. Older bridge variants used a `claude-mcp-*` synthetic id. For
  // those generated ids, fall back to matching the normalized question payload
  // against the tool input so the live form and answered record attach to the
  // correct in-band card.
  if (!isMcpGeneratedToolCallId(request.toolCallId)) return false;
  return questionShapeMatchesBlock(request, block);
}

function isMcpGeneratedToolCallId(toolCallId: string): boolean {
  return toolCallId.startsWith("claude-mcp-") || /^\d+$/.test(toolCallId);
}

function questionShapeMatchesBlock(
  request: Pick<AgentQuestionRequest, "title" | "questions">,
  block: ToolBlock,
): boolean {
  const args = block.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const record = args as { title?: unknown; questions?: unknown };
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  if (
    rawQuestions.length === 0 ||
    rawQuestions.length !== request.questions.length
  )
    return false;

  const argTitle = compactText(record.title);
  if (argTitle && argTitle !== request.title) return false;

  return rawQuestions.every((raw, index) =>
    questionMatchesRawInput(request.questions[index], raw, index),
  );
}

function questionMatchesRawInput(
  question: AgentQuestion | undefined,
  raw: unknown,
  index: number,
): boolean {
  if (!question || !raw || typeof raw !== "object" || Array.isArray(raw))
    return false;
  const record = raw as { id?: unknown; title?: unknown };
  const rawId = compactText(record.id);
  if (rawId && rawId === question.id) return true;
  const rawTitle = compactText(record.title) || `Question ${index + 1}`;
  return rawTitle === question.title;
}

function compactText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function AnswerLine({
  question,
  answer,
}: {
  question: AgentQuestion;
  answer?: AgentQuestionAnswer | undefined;
}) {
  if (!answer || answer.disposition === "skipped") {
    return (
      <div className="mt-0.5 text-caption text-faint italic">No answer</div>
    );
  }
  const labels = (answer.choiceIds ?? [])
    .map((id) => question.choices?.find((c) => c.id === id)?.label ?? id)
    .filter(Boolean);
  return (
    <div className="mt-1 space-y-1">
      {answer.disposition === "discuss" && (
        <div className="text-caption font-medium text-primary">
          Marked to discuss in chat
        </div>
      )}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label, i) => (
            <span
              key={i}
              className="rounded-md bg-accent px-1.5 py-0.5 text-caption text-primary"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {answer.text ? (
        <div className="whitespace-pre-wrap text-caption text-muted-foreground">
          {answer.text}
        </div>
      ) : null}
      {labels.length === 0 &&
      !answer.text &&
      answer.disposition !== "discuss" ? (
        <div className="text-caption text-faint italic">No answer</div>
      ) : null}
    </div>
  );
}

/** No live pending flow and no recorded answer (e.g. a pre-feature session): show
 *  the questions from the tool args, read-only and best-effort. */
function FallbackView({ block }: { block: ToolBlock }) {
  const args = block.args as {
    title?: unknown;
    intro?: unknown;
    questions?: unknown;
  } | null;
  const title =
    typeof args?.title === "string" && args.title
      ? args.title
      : "A few questions";
  const intro = typeof args?.intro === "string" ? args.intro : undefined;
  const questions = Array.isArray(args?.questions) ? args!.questions : [];
  return (
    <div className="space-y-2 text-caption">
      <CardHeader title={title} />
      {intro ? <p className="text-caption text-faint">{intro}</p> : null}
      <ul className="space-y-1.5">
        {questions.map((q, i) => {
          const qt =
            q && typeof q === "object"
              ? (q as { title?: unknown }).title
              : undefined;
          return (
            <li
              key={i}
              className="rounded-xl border border-line bg-surface px-3 py-2 text-caption text-muted-foreground"
            >
              {typeof qt === "string" ? qt : `Question ${i + 1}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
