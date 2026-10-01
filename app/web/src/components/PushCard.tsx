import {
  CheckCircle2,
  ChevronDown,
  CloudCheck,
  CloudUpload,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { PushDisplay } from "@assistant/shared";

function tone(push: PushDisplay): string {
  if (push.status === "pushed") return "border-success/30 bg-success-soft";
  if (push.status === "up-to-date") return "border-accent/30 bg-accent-soft";
  return "border-danger/30 bg-danger-soft";
}

function statusIcon(push: PushDisplay) {
  if (push.status === "pushed")
    return <CheckCircle2 size={16} className="text-success" />;
  if (push.status === "up-to-date")
    return <CloudCheck size={16} className="text-accent" />;
  return <XCircle size={16} className="text-danger" />;
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
    <div className={`my-1.5 overflow-hidden rounded-xl border ${tone(push)}`}>
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="mt-0.5">{statusIcon(push)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="inline-flex items-center gap-1.5 text-body font-semibold text-fg">
              <CloudUpload size={13} className="text-faint" />
              {statusLabel(push)}
            </div>
            {target && (
              <div className="font-mono text-caption text-faint">{target}</div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-caption text-muted">
            {push.repoRoot && (
              <span className="font-mono text-faint">{push.repoRoot}</span>
            )}
            {push.setUpstream && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-accent">
                set upstream
              </span>
            )}
            {push.forced && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-fg">
                force-with-lease
              </span>
            )}
            {push.localHead && (
              <span className="font-mono text-faint" title={push.localHead}>
                local {push.localHead.slice(0, 12)}
              </span>
            )}
            {push.expectedRemoteHead && (
              <span
                className="font-mono text-faint"
                title={push.expectedRemoteHead}
              >
                leased {push.expectedRemoteHead.slice(0, 12)}
              </span>
            )}
          </div>
        </div>
      </div>

      {(push.output || push.error) && (
        <div className="space-y-3 border-t border-line/60 px-3 py-3">
          {push.error && (
            <div className="rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-2 text-caption text-fg">
              {push.error}
            </div>
          )}
          {push.output && (
            <div>
              <button
                type="button"
                onClick={() => setOutputOpen((open) => !open)}
                className="mb-1 flex items-center gap-1 text-micro font-medium uppercase tracking-wide text-faint hover:text-muted"
              >
                <ChevronDown
                  size={12}
                  className={`transition-transform ${outputOpen ? "" : "-rotate-90"}`}
                />
                Git output
              </button>
              {outputOpen && (
                <pre className="whitespace-pre-wrap rounded-lg bg-raised p-2 font-mono text-caption text-fg">
                  {push.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
