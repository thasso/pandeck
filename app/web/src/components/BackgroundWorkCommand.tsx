import { useState } from "react";
import { BACKGROUND_WORK_COMMAND_MAX_CHARS } from "@assistant/shared";
import { Button } from "@/components/ui/button";

export interface BackgroundWorkCommandProps {
  /** The bounded command line as the registry row carries it. */
  command: string;
  /** The row was cut at the store's cap; the reader is told rather than shown "…". */
  truncated?: boolean | undefined;
  /**
   * Start expanded, for a host that is ITSELF a disclosure: a card the reader
   * has already opened must not ask a second time to show what it opened for.
   */
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
}

/**
 * @component BackgroundWorkCommand
 * @purpose The command behind a background item: one mono line at rest, the
 * whole script on a click.
 * @useWhen A background card or row has a command that its title does not
 * already say in full (`backgroundWorkCommandDetail`).
 * @avoidWhen Rendering a foreground tool call — `tools/NativeToolBodies` owns
 * that presentation with its own reveal controls.
 * @intent A reader should never need the transcript's tool view to know what a
 * background job runs. Collapsed, the first line is the whole affordance;
 * expanded, the text wraps rather than scrolls so a phone can read it too.
 * @related BackgroundWorkRow, BackgroundWorkOutput, MessageList
 */
export function BackgroundWorkCommand({
  command,
  truncated = false,
  defaultOpen = false,
  className,
}: BackgroundWorkCommandProps) {
  const [open, setOpen] = useState(defaultOpen);
  const firstLine =
    command
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? command;
  const expandable = open || firstLine !== command.trim() || truncated;
  return (
    <div className={className}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? "Collapse the command" : "Show the whole command"}
        className={`h-auto min-h-7 w-full min-w-0 justify-start text-left font-mono ${open ? "whitespace-pre-wrap break-words" : ""}`}
      >
        <span className={open ? "" : "truncate"}>
          {open ? command : firstLine}
        </span>
        {!open && expandable ? <span aria-hidden="true">…</span> : null}
      </Button>
      {open && truncated ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cut at {Math.round(BACKGROUND_WORK_COMMAND_MAX_CHARS / 1024)} KB; the
          transcript&rsquo;s tool call holds the rest.
        </p>
      ) : null}
    </div>
  );
}
