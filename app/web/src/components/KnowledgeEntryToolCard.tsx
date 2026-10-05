import { BookOpen, PanelRight, SquareArrowOutUpRight } from "lucide-react";
import type { KnowledgeEntryCard } from "@assistant/shared";
import { useKnowledgeOpenTargets } from "./KnowledgeOpenTargets.tsx";

/**
 * @component KnowledgeEntryToolCard
 * @purpose The `kb_show_entry` card: a Knowledge entry an agent is pointing at,
 * with the two ways to read it — the side panel beside this conversation, or
 * the main Knowledge view.
 * @useWhen Rendering a completed `kb_show_entry` tool result in a transcript.
 * @avoidWhen Linking an entry inside prose; `pa://knowledge/<id>` already
 * resolves to a link the Markdown renderer opens.
 * @intent The card is the whole point of the call, so it shows with tools
 * hidden. It carries no entry content: reading happens on a Knowledge surface,
 * which is also where commenting and live updates live.
 */
export function KnowledgeEntryToolCard({ card }: { card: KnowledgeEntryCard }) {
  const targets = useKnowledgeOpenTargets();
  const openInPanel = targets?.openInPanel;
  // The card names the entry's folder; the entry is its `index.md` file.
  const entryFile = `${card.path}/index.md`;
  return (
    <div className="not-prose my-2 overflow-hidden rounded-xl border border-line bg-surface text-left shadow-sm">
      <div className="flex items-start gap-2 p-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <BookOpen size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <span
            className="block truncate text-caption font-medium text-fg"
            title={card.title}
          >
            {card.title}
          </span>
          {card.path ? (
            <span
              className="block truncate text-micro text-faint"
              title={card.path}
            >
              {card.path}
            </span>
          ) : null}
          {(card.note ?? card.summary) ? (
            <p className="mt-1 line-clamp-3 text-micro text-muted">
              {card.note ?? card.summary}
            </p>
          ) : null}
        </div>
      </div>
      {targets ? (
        <div className="flex items-center gap-1 border-t border-line px-2.5 py-1.5">
          {openInPanel ? (
            <button
              type="button"
              onClick={() => openInPanel(entryFile)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption font-medium text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <PanelRight size={13} />
              Open in side panel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => targets.openInMain(entryFile)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption font-medium text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <SquareArrowOutUpRight size={13} />
            Open in Knowledge
          </button>
        </div>
      ) : null}
    </div>
  );
}
