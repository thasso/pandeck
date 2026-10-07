import { ExternalLink, FileText, Hammer } from "lucide-react";
import type { AgentType, DisplayBlock } from "@assistant/shared";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

interface WorkshopDraftHandoffPayload {
  renderKind: "workshopDraftHandoff";
  version: 1;
  title: string;
  category: string;
  proposalPath: string;
  draftPrompt: string;
  createdAt: string;
}

/**
 * @widget WorkshopDraftHandoffCard
 * @purpose Renders Assistant-to-Workshop implementation proposals with an explicit editable draft-session handoff.
 * @payload `workshop_draft_handoff` tool output (`workshopDraftHandoff`).
 * @useWhen Assistant proposes code/tool/UI changes that should be reviewed in Workshop before submission.
 * @avoidWhen The assistant can answer directly or only needs to write durable knowledge.
 * @intent Keep implementation handoff user-controlled: create a Workshop session and prefill the composer, but never auto-submit.
 */
export function shouldRenderWorkshopDraftHandoffTool(
  block: ToolBlock,
): boolean {
  if (!block.done || block.isError || block.name !== "workshop_draft_handoff")
    return false;
  const payload = parseJson(block.output) as WorkshopDraftHandoffPayload | null;
  return payload?.renderKind === "workshopDraftHandoff";
}

export function WorkshopDraftHandoffToolCard({
  block,
  onCreateDraftSession,
}: {
  block: ToolBlock;
  onCreateDraftSession?:
    | ((agentType: AgentType, draftText: string, notice?: string) => void)
    | undefined;
}) {
  const payload = parseJson(block.output) as WorkshopDraftHandoffPayload | null;
  if (!payload || payload.renderKind !== "workshopDraftHandoff") return null;
  const canOpen = Boolean(onCreateDraftSession);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
      <div className="flex items-start gap-3 border-b border-line px-3 py-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
          <Hammer size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-body font-semibold text-fg">
              {payload.title}
            </div>
            <span className="rounded-full border border-line bg-raised px-1.5 py-0.5 text-micro uppercase tracking-wide text-faint">
              {payload.category}
            </span>
          </div>
          <div className="mt-0.5 text-caption text-muted-foreground">
            Workshop proposal saved. Opening a draft will not submit anything.
          </div>
        </div>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-raised px-2 py-1.5 text-caption text-muted-foreground">
          <FileText size={13} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {payload.proposalPath}
          </span>
        </div>
        <div className="rounded-lg border border-line bg-surface px-2 py-1.5 text-caption text-faint">
          You can change the Workshop model and thinking level, edit the
          prefilled prompt, and then submit manually.
        </div>
        <button
          type="button"
          disabled={!canOpen}
          onClick={() =>
            onCreateDraftSession?.(
              "workshop",
              payload.draftPrompt,
              "Workshop draft created — review model/thinking and edit before sending.",
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-caption font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            canOpen
              ? "Create a Workshop session with this prompt as an editable draft"
              : "Workshop handoff is unavailable"
          }
        >
          <ExternalLink size={13} />
          Open Workshop draft
        </button>
      </div>
    </div>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
