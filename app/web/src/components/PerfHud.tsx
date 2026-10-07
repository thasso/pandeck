import { useEffect, useState } from "react";
import {
  perfSnapshot,
  perfStatsEnabled,
  setPerfStatsEnabled,
  subscribePerfStats,
  type PerfSnapshot,
} from "../lib/perfStats.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * @component PerfHud
 * @purpose Dev-only overlay: inbound server traffic per message type per second
 * (UTF-8 wire bytes and `JSON.parse` time), React commit counts and durations
 * for the instrumented subtrees over the same second, and the phases of the
 * latest session load (request → snapshot → commit → paint).
 * @useWhen Diagnosing "the UI is slow while agents run" — the two questions that
 * answers are what the socket is delivering and what re-renders because of it.
 * @avoidWhen In production; it is rendered only under `import.meta.env.DEV` and
 * records nothing until toggled on.
 * @intent The numbers behind every performance decision in this client (a Task
 * mutation's list size, the ~4x/second session broadcast, the per-frame message
 * deltas) were previously found by hand-instrumenting for one investigation and
 * then removing it, so no two changes were ever comparable. Toggle with
 * Ctrl/Cmd+Shift+P.
 * @related lib/perfStats.ts (`usePerfRenderCount`)
 */
export function PerfHud() {
  const [enabled, setEnabled] = useState(perfStatsEnabled);
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null);

  useEffect(() => subscribePerfStats(() => setEnabled(perfStatsEnabled())), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "p"
      )
        return;
      event.preventDefault();
      setPerfStatsEnabled(!perfStatsEnabled());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    const timer = window.setInterval(() => setSnapshot(perfSnapshot()), 500);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled || !snapshot) return null;

  const load = snapshot.sessionLoad;
  return (
    <Card
      size="sm"
      className="pointer-events-none fixed bottom-2 left-2 z-100 max-h-3/5 w-64 overflow-y-auto"
    >
      <CardHeader>
        <CardTitle>perf · {snapshot.windowMs}ms</CardTitle>
        <CardDescription>
          {formatBytes(snapshot.totalBytes)}/s · parse{" "}
          {snapshot.totalParseMs.toFixed(1)}ms
        </CardDescription>
      </CardHeader>
      <CardContent className="font-mono text-xs text-muted-foreground">
        {snapshot.messages.length === 0 ? <div>no traffic</div> : null}
        {snapshot.messages.map((stat) => (
          <HudRow
            key={stat.type}
            label={stat.type}
            value={`${stat.count}× ${formatBytes(stat.bytes)}${
              stat.parseMs >= 0.5 ? ` ${stat.parseMs.toFixed(1)}ms` : ""
            }`}
          />
        ))}
        {load ? (
          <>
            <Separator className="my-1" />
            <div className="text-foreground">session load</div>
            <HudRow
              label="request → snapshot"
              value={formatGap(load.requestAt, load.snapshotParsedAt)}
            />
            <HudRow
              label="snapshot → commit"
              value={formatGap(load.snapshotParsedAt, load.committedAt)}
            />
            <HudRow
              label="commit → paint"
              value={formatGap(load.committedAt, load.paintedAt)}
            />
          </>
        ) : null}
        <Separator className="my-1" />
        <div className="text-foreground">renders/s</div>
        {snapshot.renders.length === 0 ? <div>none</div> : null}
        {snapshot.renders.map((render) => (
          <HudRow
            key={render.name}
            label={render.name}
            value={`${render.count}${
              render.durationMs > 0 ? ` ${render.durationMs.toFixed(1)}ms` : ""
            }`}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function HudRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

function formatGap(from: number | undefined, to: number | undefined): string {
  if (from === undefined) return "–";
  if (to === undefined) return "…";
  return `${(to - from).toFixed(0)}ms`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}
