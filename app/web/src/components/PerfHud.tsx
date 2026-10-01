import { useEffect, useState } from "react";
import {
  perfSnapshot,
  perfStatsEnabled,
  setPerfStatsEnabled,
  subscribePerfStats,
  type PerfSnapshot,
} from "../lib/perfStats.ts";

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

  return (
    <div className="pointer-events-none fixed bottom-2 left-2 z-[100] max-h-[60vh] w-64 overflow-y-auto rounded-xl border border-line bg-panel/95 p-2 font-mono text-micro text-muted shadow-2xl">
      <div className="mb-1 flex items-center justify-between text-fg">
        <span>perf · {snapshot.windowMs}ms</span>
        <span>
          {formatBytes(snapshot.totalBytes)}/s · parse{" "}
          {snapshot.totalParseMs.toFixed(1)}ms
        </span>
      </div>
      {snapshot.messages.length === 0 ? (
        <div className="text-faint">no traffic</div>
      ) : null}
      {snapshot.messages.map((stat) => (
        <div
          key={stat.type}
          className="flex items-center justify-between gap-2"
        >
          <span className="truncate">{stat.type}</span>
          <span className="shrink-0 tabular-nums">
            {stat.count}× {formatBytes(stat.bytes)}
            {stat.parseMs >= 0.5 ? ` ${stat.parseMs.toFixed(1)}ms` : ""}
          </span>
        </div>
      ))}
      {snapshot.sessionLoad ? (
        <>
          <div className="mt-1 border-t border-line pt-1 text-fg">
            session load
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">request → snapshot</span>
            <span className="shrink-0 tabular-nums">
              {formatGap(
                snapshot.sessionLoad.requestAt,
                snapshot.sessionLoad.snapshotParsedAt,
              )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">snapshot → commit</span>
            <span className="shrink-0 tabular-nums">
              {formatGap(
                snapshot.sessionLoad.snapshotParsedAt,
                snapshot.sessionLoad.committedAt,
              )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">commit → paint</span>
            <span className="shrink-0 tabular-nums">
              {formatGap(
                snapshot.sessionLoad.committedAt,
                snapshot.sessionLoad.paintedAt,
              )}
            </span>
          </div>
        </>
      ) : null}
      <div className="mt-1 border-t border-line pt-1 text-fg">renders/s</div>
      {snapshot.renders.length === 0 ? (
        <div className="text-faint">none</div>
      ) : null}
      {snapshot.renders.map((render) => (
        <div
          key={render.name}
          className="flex items-center justify-between gap-2"
        >
          <span className="truncate">{render.name}</span>
          <span className="shrink-0 tabular-nums">
            {render.count}
            {render.durationMs > 0 ? ` ${render.durationMs.toFixed(1)}ms` : ""}
          </span>
        </div>
      ))}
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
