import { BookOpen, PanelRight, SquareArrowOutUpRight } from "lucide-react";
import type { KnowledgeEntryCard } from "@assistant/shared";
import { useKnowledgeOpenTargets } from "./KnowledgeOpenTargets.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button } from "@/components/ui/button";
import { AppCard } from "./common/AppCard.tsx";

/**
 * @component KnowledgeEntryToolCard
 * @purpose The `kb_show` card: a Knowledge Base file an agent is pointing at,
 * with the two ways to read it — the side panel beside this conversation, or
 * the main Knowledge view.
 * @useWhen Rendering a completed `kb_show` tool result in a transcript.
 * @avoidWhen Linking a file inside prose; `pa://knowledge/<path>` already
 * resolves to a link the Markdown renderer opens.
 * @intent The card is the whole point of the call, so it shows with tools
 * hidden. It carries no file content: reading happens on a Knowledge surface,
 * which is also where history and live updates live.
 */
export function KnowledgeEntryToolCard({ card }: { card: KnowledgeEntryCard }) {
  const targets = useKnowledgeOpenTargets();
  const openInPanel = targets?.openInPanel;
  return (
    <AppCard
      className="not-prose text-left"
      icon={<BookOpen />}
      label="Knowledge Base"
      actions={
        targets ? (
          <>
            {openInPanel ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => openInPanel(card.path)}
              >
                <PanelRight />
                Open in side panel
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => targets.openInMain(card.path)}
            >
              <SquareArrowOutUpRight />
              Open in Knowledge
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate font-medium" title={card.title}>
          {card.title}
        </p>
        {card.path ? (
          <p
            className="truncate text-xs text-muted-foreground"
            title={card.path}
          >
            {card.path}
          </p>
        ) : null}
      </div>
      {(card.note ?? card.summary) ? (
        <p className="line-clamp-3 text-xs text-muted-foreground">
          <Markdown text={card.note ?? card.summary ?? ""} inline />
        </p>
      ) : null}
    </AppCard>
  );
}
