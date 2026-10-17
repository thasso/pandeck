import { ExternalLink, FileText, Hammer } from "lucide-react";
import type { AgentType, DisplayBlock } from "@assistant/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "./common/AppCard.tsx";
import { Markdown } from "./Markdown.tsx";

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
    <AppCard
      icon={<Hammer />}
      label="Workshop proposal"
      status={<Badge variant="outline">{payload.category}</Badge>}
      footerStart="Opening a draft submits nothing."
      actions={
        <Button
          size="xs"
          disabled={!canOpen}
          onClick={() =>
            onCreateDraftSession?.(
              "workshop",
              payload.draftPrompt,
              "Workshop draft created — review model/thinking and edit before sending.",
            )
          }
          title={
            canOpen
              ? "Create a Workshop session with this prompt as an editable draft"
              : "Workshop handoff is unavailable"
          }
        >
          <ExternalLink />
          Open Workshop draft
        </Button>
      }
      contentClassName="text-muted-foreground"
    >
      <p className="truncate font-medium text-foreground">
        <Markdown text={payload.title} inline />
      </p>
      <p className="flex min-w-0 items-center gap-2">
        <FileText className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {payload.proposalPath}
        </span>
      </p>
      <p>
        You can change the Workshop model and thinking level, edit the prefilled
        prompt, and then submit manually.
      </p>
    </AppCard>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
