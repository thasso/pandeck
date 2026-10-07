import { BookOpen, PanelRight, SquareArrowOutUpRight } from "lucide-react";
import type { KnowledgeEntryCard } from "@assistant/shared";
import { useKnowledgeOpenTargets } from "./KnowledgeOpenTargets.tsx";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <Card size="sm" className="not-prose my-2 text-left">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <BookOpen className="size-4 shrink-0 text-primary" />
          <span className="truncate" title={card.title}>
            {card.title}
          </span>
        </CardTitle>
        {card.path ? (
          <CardDescription className="truncate text-xs" title={card.path}>
            {card.path}
          </CardDescription>
        ) : null}
      </CardHeader>
      {(card.note ?? card.summary) ? (
        <CardContent>
          <p className="line-clamp-3 text-xs text-muted-foreground">
            {card.note ?? card.summary}
          </p>
        </CardContent>
      ) : null}
      {targets ? (
        <CardFooter className="gap-1">
          {openInPanel ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInPanel(card.path)}
            >
              <PanelRight />
              Open in side panel
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => targets.openInMain(card.path)}
          >
            <SquareArrowOutUpRight />
            Open in Knowledge
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
