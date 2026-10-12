import { ChevronDown, CloudCheck, CloudUpload, XCircle } from "lucide-react";
import { useState } from "react";
import type { PushDisplay } from "@assistant/shared";
import { shortCommit } from "@assistant/shared/buildInfo";
import { ErrorNote } from "./common/load.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardTone } from "./common/AppCard.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function statusIcon(push: PushDisplay) {
  if (push.status === "pushed") return <CloudUpload />;
  if (push.status === "up-to-date") return <CloudCheck />;
  return <XCircle />;
}

function statusTone(push: PushDisplay): AppCardTone {
  if (push.status === "pushed") return "success";
  if (push.status === "up-to-date") return "neutral";
  return "destructive";
}

function statusLabel(push: PushDisplay): string {
  if (push.status === "pushed") return "Pushed";
  if (push.status === "up-to-date") return "Already up to date";
  return "Push failed";
}

export function PushCard({ push }: { push: PushDisplay }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const target =
    push.remote && push.branch
      ? `${push.remote}/${push.branch}`
      : (push.remote ?? push.branch);
  return (
    <AppCard
      tone={statusTone(push)}
      icon={statusIcon(push)}
      label={statusLabel(push)}
      status={
        push.localHead ? (
          <span className="font-mono" title={push.localHead}>
            {shortCommit(push.localHead)}
          </span>
        ) : null
      }
      contentClassName="gap-3"
    >
      {/* Where it went, and how: the card's subject. */}
      <div className="flex min-w-0 flex-col gap-0.5">
        {target ? (
          <span className="min-w-0 truncate font-mono text-foreground">
            {target}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {push.repoRoot && (
            <span className="min-w-0 font-mono wrap-anywhere">
              {push.repoRoot}
            </span>
          )}
          {push.setUpstream && <Badge variant="secondary">set upstream</Badge>}
          {push.forced && <Badge variant="warning">force-with-lease</Badge>}
          {push.expectedRemoteHead && (
            <span className="font-mono" title={push.expectedRemoteHead}>
              leased {shortCommit(push.expectedRemoteHead)}
            </span>
          )}
        </div>
      </div>
      {push.error && <ErrorNote message={push.error} />}
      {push.output && (
        <Collapsible open={outputOpen} onOpenChange={setOutputOpen}>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="xs" className="-ml-2" />}
          >
            <ChevronDown className={outputOpen ? "" : "-rotate-90"} />
            Git output
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 rounded-lg border bg-muted p-2 font-mono text-sm whitespace-pre-wrap">
              {push.output}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </AppCard>
  );
}
