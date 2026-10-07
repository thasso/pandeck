import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { AnsiText } from "./common/AnsiText.tsx";
import { CollapsibleOutput } from "./common/CollapsibleOutput.tsx";
import { ErrorNote } from "./common/load.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { Button } from "@/components/ui/button";

/** How much of a captured log the panel holds in memory; the link has the rest. */
const BACKGROUND_OUTPUT_INLINE_MAX_BYTES = 64 * 1024;

export interface BackgroundWorkOutputProps {
  /** The authenticated artifact URL. Resolved by the host; never an id or a path. */
  url: string;
  /** The retained size, for the toggle's label. */
  capturedBytes?: number | undefined;
  /** The capture itself was cut at the server's cap. */
  truncated?: boolean | undefined;
  className?: string | undefined;
}

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; text: string; cut: boolean }
  | { state: "error"; message: string };

/**
 * @component BackgroundWorkOutput
 * @purpose The captured output of a background item, read inline on demand:
 * a toggle with the size, then the log itself, reloadable, with the full file
 * one link away.
 * @useWhen A background card or row has an artifact URL for its output.
 * @avoidWhen The item is still running — nothing is captured yet, and this
 * component has no live tail.
 * @intent The output NEVER travels with the row or the card; the panel fetches
 * the artifact only when opened and keeps a bounded head of it. Combined
 * stdout and stderr, as the process wrote them, through the same ANSI renderer
 * the foreground shell tool uses.
 * @related BackgroundWorkRow, BackgroundWorkCommand, MessageList
 */
export function BackgroundWorkOutput({
  url,
  capturedBytes,
  truncated = false,
  className,
}: BackgroundWorkOutputProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "idle" });

  const fetchOutput = useCallback(
    async (signal: AbortSignal) => {
      setLoad({ state: "loading" });
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const cut = body.length > BACKGROUND_OUTPUT_INLINE_MAX_BYTES;
        setLoad({
          state: "loaded",
          text: cut ? body.slice(0, BACKGROUND_OUTPUT_INLINE_MAX_BYTES) : body,
          cut,
        });
      } catch (error) {
        if (signal.aborted) return;
        setLoad({
          state: "error",
          message: error instanceof Error ? error.message : "Could not load",
        });
      }
    },
    [url],
  );

  useEffect(() => {
    if (!open || load.state !== "idle") return;
    const controller = new AbortController();
    void fetchOutput(controller.signal);
    return () => controller.abort();
  }, [open, load.state, fetchOutput]);

  const sizeLabel =
    capturedBytes !== undefined ? ` · ${formatBytes(capturedBytes)}` : "";
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? "Hide output" : "Output"}
          {sizeLabel}
          {truncated ? " · truncated" : ""}
        </Button>
        {open ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setLoad({ state: "idle" })}
            busy={load.state === "loading"}
            title="Reload the captured output"
            aria-label="Reload the captured output"
          >
            <RefreshCw aria-hidden="true" />
            Reload
          </Button>
        ) : null}
        {/* The file itself is always one link away, whether or not the inline
            panel is open: the panel holds a bounded head, the link has it all. */}
        <LinkButton
          variant="ghost"
          size="xs"
          href={url}
          target="_blank"
          rel="noreferrer"
          title="Open the captured output file"
        >
          <ExternalLink aria-hidden="true" />
          Open file
        </LinkButton>
      </div>
      {open ? (
        load.state === "error" ? (
          <ErrorNote
            className="mt-1"
            message={`Could not load the output (${load.message}).`}
            onRetry={() => setLoad({ state: "idle" })}
          />
        ) : (
          <div className="mt-1 rounded-md border bg-muted/60 px-2 py-1 text-sm text-muted-foreground">
            {load.state === "loading" || load.state === "idle" ? (
              <p>Loading output…</p>
            ) : load.text.length === 0 ? (
              <p>The process wrote nothing.</p>
            ) : (
              <CollapsibleOutput
                text={load.text}
                collapsedLines={20}
                renderContent={(visible) => (
                  <AnsiText
                    text={visible}
                    className="max-w-full overflow-x-auto whitespace-pre-wrap break-words text-sm text-foreground"
                  />
                )}
                footerActions={
                  load.cut ? (
                    <span>
                      First{" "}
                      {Math.round(BACKGROUND_OUTPUT_INLINE_MAX_BYTES / 1024)} KB
                      shown; open the file for the rest.
                    </span>
                  ) : undefined
                }
              />
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
