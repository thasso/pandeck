import { useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { BackgroundWorkPromptPresentation } from "@assistant/shared/session";
import {
  backgroundWorkCommandDetail,
  backgroundWorkOutcomeDetail,
} from "../lib/backgroundWork.ts";
import { serverHttpOrigin, withToken } from "../lib/serverOrigin.ts";
import { BackgroundWorkCommand } from "./BackgroundWorkCommand.tsx";
import { BackgroundWorkOutput } from "./BackgroundWorkOutput.tsx";

type BackgroundWorkPromptUpdate =
  BackgroundWorkPromptPresentation["updates"][number];

/**
 * A SHAPE per status, not a tint per status, and the words in the accessible
 * name — the rule `SessionDeliveryMark` already follows, for the same reason: on
 * a one-line row the glyph is the whole indicator, so a mark that varied only in
 * colour would say nothing at all to a reader who cannot see the colour.
 *
 * The five statuses are NOT two. `stopped` is neither success nor failure —
 * somebody ended it on purpose — and `lost` is what an unclean server restart
 * writes, a job whose outcome nobody ever learned. `activity` is not an outcome
 * at all: a monitor streamed lines while still running, and the card is the
 * record of that one delivery rather than a live view of the job.
 */
const STATUS_MARK: Record<
  BackgroundWorkPromptUpdate["status"],
  { icon: LucideIcon; label: string; className: string }
> = {
  completed: {
    icon: CircleCheck,
    label: "Completed",
    className: "text-success",
  },
  failed: { icon: CircleX, label: "Failed", className: "text-danger" },
  stopped: { icon: CircleSlash, label: "Stopped", className: "text-muted" },
  lost: { icon: TriangleAlert, label: "Lost", className: "text-danger" },
  activity: { icon: CircleDashed, label: "Activity", className: "text-muted" },
};

function BackgroundWorkPromptRow({
  update,
  leading,
  onOpenBackgroundWork,
}: {
  update: BackgroundWorkPromptUpdate;
  /** The card's one Background-work glyph rides the first row; the rest align under it. */
  leading: boolean;
  onOpenBackgroundWork?: ((taskId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Whether the one line the reader can SEE held the whole title, sampled from
  // layout at the moment they opened the row.
  const [titleClipped, setTitleClipped] = useState(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const mark = STATUS_MARK[update.status];
  const StatusIcon = mark.icon;
  // `backgroundWorkCommandDetail` answers "does the TEXT of the title already
  // say the whole command?" — a description above it, a further line, a cut at
  // the store's cap. It cannot answer the question this card also has: the top
  // line is ellipsized by CSS at whatever width the reader has, so the same
  // command that is redundant on a desktop is unreadable on a phone, where the
  // `title` tooltip is no answer either. One toggle, both tests.
  const command =
    backgroundWorkCommandDetail(update) ??
    (titleClipped ? update.command?.trim() : undefined);
  // The same clip, applied to the title itself. Where the label came from the
  // COMMAND the block above already gives the reader the whole text; where it
  // came from a description, nothing else on the card carries it, so the body
  // repeats it wrapped — and only then, because a description the row showed
  // whole would just be the line above said twice.
  const clippedTitle =
    titleClipped && update.description ? update.description : undefined;
  const outcome = backgroundWorkOutcomeDetail(update);
  const exitDetail =
    !outcome && update.exitCode !== undefined && update.exitCode !== 0
      ? `Exited with code ${update.exitCode}`
      : undefined;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => {
          // Read the clip BEFORE the body renders; the line itself never moves.
          const node = titleRef.current;
          setTitleClipped(
            node ? node.scrollWidth > node.clientWidth + 1 : false,
          );
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        title={update.label}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {leading ? (
          <Activity
            size={13}
            aria-hidden="true"
            className="shrink-0 text-accent"
          />
        ) : (
          <span className="size-[13px] shrink-0" aria-hidden="true" />
        )}
        <span className="sr-only">Background work, {mark.label}: </span>
        <span ref={titleRef} className="min-w-0 flex-1 truncate font-medium">
          {update.label}
        </span>
        <StatusIcon
          size={13}
          aria-hidden="true"
          className={`shrink-0 ${mark.className}`}
        />
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={`shrink-0 text-faint transition-transform ${
            open ? "rotate-0" : "-rotate-90"
          }`}
        />
      </button>
      {open ? (
        <div className="mb-1.5 min-w-0 pl-[1.1875rem]">
          {clippedTitle ? (
            <p className="font-medium break-words">{clippedTitle}</p>
          ) : null}
          {(outcome ?? exitDetail) ? (
            <p className="text-caption text-muted">{outcome ?? exitDetail}</p>
          ) : null}
          {command ? (
            <BackgroundWorkCommand
              command={command}
              truncated={update.commandTruncated}
              defaultOpen
              className="mt-1"
            />
          ) : null}
          {update.output ? (
            <BackgroundWorkOutput
              url={withToken(`${serverHttpOrigin()}${update.output.url}`)}
              capturedBytes={update.output.capturedBytes}
              truncated={update.output.truncated}
              className="mt-1"
            />
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-caption">
            <button
              type="button"
              onClick={() => onOpenBackgroundWork?.(update.taskId)}
              disabled={!onOpenBackgroundWork}
              title={update.taskId}
              className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:no-underline"
            >
              Open in registry
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * @component BackgroundWorkPromptCard
 * @purpose The card for an automatic background-work turn: one line per update
 * the model was told about — what the job IS and which way it ended — opening
 * on demand to the outcome, the whole command, the captured output and the
 * registry row.
 * @useWhen A user entry carries a `background-work` prompt presentation.
 * @avoidWhen Showing background work that is still yours to act on; the session
 * inspector's `BackgroundWorkSection` and the registry own the live rows.
 * @intent The collapsed line is the resting state, because a finished job is
 * usually just an acknowledgement in a conversation about something else. It
 * says the least that is still true: the icon says this is background work, the
 * title says which job, the glyph says how it ended. It never says "Completed ·
 * exit 0" — the state IS the exit code for a PA-supervised process, and a
 * Claude-query job has no exit code at all.
 * @intent The card is a record of ONE delivery: it never updates afterwards, so
 * nothing here polls, and the top line does not move when the body opens.
 * @related BackgroundWorkCommand, BackgroundWorkOutput, BackgroundWorkRow
 */
export function BackgroundWorkPromptCard({
  presentation,
  onOpenBackgroundWork,
}: {
  presentation: BackgroundWorkPromptPresentation;
  onOpenBackgroundWork?: ((taskId: string) => void) | undefined;
}) {
  return (
    <div className="min-w-0 w-full max-w-[min(80%,36rem)] rounded-xl border border-accent/25 bg-accent-soft px-3 py-1.5 text-body text-fg shadow-sm">
      <ul className="min-w-0">
        {presentation.updates.map((update, index) => (
          <BackgroundWorkPromptRow
            key={`${update.taskId}:${update.status}:${index}`}
            update={update}
            leading={index === 0}
            onOpenBackgroundWork={onOpenBackgroundWork}
          />
        ))}
      </ul>
      {/* Dropped updates stay visible while collapsed: a signal the reader has
          to open the card to discover is one this card swallowed. */}
      {presentation.omittedCount ? (
        <p className="pl-[1.1875rem] text-micro text-faint">
          {presentation.omittedCount} more update
          {presentation.omittedCount === 1 ? "" : "s"} omitted
        </p>
      ) : null}
    </div>
  );
}
