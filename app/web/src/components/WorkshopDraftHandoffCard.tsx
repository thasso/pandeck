import { ExternalLink, FileText, Hammer } from "lucide-react";
import type { AgentType, DisplayBlock } from "@assistant/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <Card size="sm" className="my-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Hammer className="size-4 text-primary" />
          <span className="truncate">{payload.title}</span>
          <Badge variant="outline">{payload.category}</Badge>
        </CardTitle>
        <CardDescription>
          Workshop proposal saved. Opening a draft will not submit anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-muted-foreground">
        <p className="flex min-w-0 items-center gap-2">
          <FileText className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {payload.proposalPath}
          </span>
        </p>
        <p>
          You can change the Workshop model and thinking level, edit the
          prefilled prompt, and then submit manually.
        </p>
      </CardContent>
      <CardFooter>
        <Button
          size="sm"
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
      </CardFooter>
    </Card>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
