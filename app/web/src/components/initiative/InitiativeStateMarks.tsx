import { Archive, ExternalLink } from "lucide-react";
import { Badge } from "../ui/badge.tsx";
import { LIVE_PULSE } from "../common/load.tsx";
import { TaskBlockedIndicator } from "../TaskBlockedIndicator.tsx";
import type { InitiativeMember } from "../../lib/initiativeView.ts";

/**
 * @component InitiativeStateMarks
 * @purpose A member's state as glanceable marks, the same on a map node and a
 *   list row (`docs/initiatives.md`, The Initiative page).
 * @intent Each fact is its own mark, with a word or the app's own glyph as
 *   well as a colour, so a greyscale copy still reads:
 *   - **Ready** (a todo with no open blocker, not archived) is the only filled
 *     chip: it is what the reader came to find.
 *   - **Doing** is an outlined chip.
 *   - **Blocked** is the app's blocked marker with its open-blocker count,
 *     apart from the chips, so a started Task that is still blocked shows
 *     Doing AND blocked.
 *   - **Running** is a session started from the Task running a turn, a fact
 *     apart from the Doing status.
 *   - Done carries no chip: its check glyph and receding title say it.
 *   - **Archived** is shelved and never Ready or Blocked.
 *   - **Outside** marks a blocker that is not a member, whose state still shows.
 */
export function InitiativeStateMarks({
  member,
  outside = false,
}: {
  member: InitiativeMember | undefined;
  outside?: boolean;
}) {
  if (!member) return null;
  return (
    <>
      {outside ? (
        <Badge variant="outline">
          <ExternalLink />
          Outside
        </Badge>
      ) : null}
      {member.startable ? <Badge>Ready</Badge> : null}
      {member.status === "doing" && !member.archived ? (
        <Badge variant="outline">Doing</Badge>
      ) : null}
      {member.blocked ? (
        <TaskBlockedIndicator openBlockers={member.openBlockers} />
      ) : null}
      {member.archived ? (
        <Badge variant="secondary">
          <Archive />
          Archived
        </Badge>
      ) : null}
      {member.running ? (
        <Badge variant="secondary">
          <span
            aria-hidden
            className={`size-1.5 rounded-full bg-primary ${LIVE_PULSE}`}
          />
          Running
        </Badge>
      ) : null}
    </>
  );
}

/**
 * The status band on a member's leading edge, by the same states. The band
 * repeats a mark's colour; it never carries a state alone.
 */
export function memberBandClass(member: InitiativeMember | undefined): string {
  if (!member || member.archived) return "bg-border";
  if (member.status === "done") return "bg-success";
  if (member.status === "doing") return "bg-foreground";
  if (member.startable) return "bg-primary";
  return "bg-border";
}
