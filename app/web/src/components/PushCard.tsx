import {
  CheckCircle2,
  ChevronDown,
  CloudCheck,
  CloudUpload,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { PushDisplay } from "@assistant/shared";
import { ErrorNote } from "./common/load.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function statusIcon(push: PushDisplay) {
  if (push.status === "pushed")
    return <CheckCircle2 className="size-4 text-success" />;
  if (push.status === "up-to-date")
    return <CloudCheck className="size-4 text-primary" />;
  return <XCircle className="size-4 text-destructive" />;
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
    <Card size="sm" className="my-1.5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2">
          {statusIcon(push)}
          <CloudUpload className="size-3.5 text-muted-foreground" />
          {statusLabel(push)}
          {target && (
            <span className="font-mono text-sm font-normal text-muted-foreground">
              {target}
            </span>
          )}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          {push.repoRoot && <span className="font-mono">{push.repoRoot}</span>}
          {push.setUpstream && <Badge variant="secondary">set upstream</Badge>}
          {push.forced && <Badge variant="warning">force-with-lease</Badge>}
          {push.localHead && (
            <span className="font-mono" title={push.localHead}>
              local {push.localHead.slice(0, 12)}
            </span>
          )}
          {push.expectedRemoteHead && (
            <span className="font-mono" title={push.expectedRemoteHead}>
              leased {push.expectedRemoteHead.slice(0, 12)}
            </span>
          )}
        </CardDescription>
      </CardHeader>

      {(push.output || push.error) && (
        <CardContent className="flex flex-col gap-3">
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
                <pre className="mt-1 rounded-lg bg-muted p-2 font-mono text-sm whitespace-pre-wrap">
                  {push.output}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      )}
    </Card>
  );
}
