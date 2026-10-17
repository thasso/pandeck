import { Check, CircleSlash, MessageCircleQuestion } from "lucide-react";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AnsweredAgentQuestion,
  DisplayBlock,
} from "@assistant/shared";
import { AgentQuestionForm, QuestionSubject } from "./AgentQuestionForm.tsx";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "./Markdown.tsx";
import { AppCard } from "./common/AppCard.tsx";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";

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

  return pending && onRespond ? (
    <AgentQuestionForm
      request={pending}
      onRespond={onRespond}
      {...(notice !== undefined ? { notice } : {})}
    />
  ) : answered ? (
    <AnsweredView answered={answered} />
  ) : (
    <FallbackView block={block} />
  );
}

function AnsweredView({ answered }: { answered: AnsweredAgentQuestion }) {
  const cancelled = answered.response.status === "cancelled";
  const byId = new Map(answered.response.answers.map((a) => [a.questionId, a]));
  return (
    <AppCard
      tone={cancelled ? "neutral" : "success"}
      icon={cancelled ? <CircleSlash /> : <Check />}
      label={cancelled ? "Question cancelled" : "Question answered"}
    >
      <QuestionSubject title={answered.title} intro={answered.intro} />
      {cancelled ? (
        <p className="text-muted-foreground">
          You cancelled this question flow.
        </p>
      ) : (
        <ItemGroup className="gap-2">
          {answered.questions.map((q) => (
            <Item key={q.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>
                  <Markdown text={q.title} inline />
                </ItemTitle>
                <AnswerLine question={q} answer={byId.get(q.id)} />
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </AppCard>
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
  const labels =
    answer && answer.disposition !== "skipped"
      ? (answer.choiceIds ?? [])
          .map((id) => question.choices?.find((c) => c.id === id)?.label ?? id)
          .filter(Boolean)
      : [];
  if (
    !answer ||
    answer.disposition === "skipped" ||
    (labels.length === 0 && !answer.text && answer.disposition !== "discuss")
  )
    return <ItemDescription className="italic">No answer</ItemDescription>;
  return (
    <div className="flex flex-col gap-1">
      {answer.disposition === "discuss" && (
        <p className="font-medium text-primary">Marked to discuss in chat</p>
      )}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label, i) => (
            <Badge key={i} variant="secondary">
              <Markdown text={label} inline />
            </Badge>
          ))}
        </div>
      )}
      {answer.text ? (
        <ItemDescription className="whitespace-pre-wrap">
          {answer.text}
        </ItemDescription>
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
    <AppCard icon={<MessageCircleQuestion />} label="Question">
      <QuestionSubject title={title} intro={intro} />
      <ItemGroup className="gap-1.5">
        {questions.map((q, i) => {
          const qt =
            q && typeof q === "object"
              ? (q as { title?: unknown }).title
              : undefined;
          return (
            <Item key={i} variant="outline" size="xs">
              <ItemContent>
                <ItemTitle className="font-normal text-muted-foreground">
                  <Markdown
                    text={typeof qt === "string" ? qt : `Question ${i + 1}`}
                    inline
                  />
                </ItemTitle>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </AppCard>
  );
}
