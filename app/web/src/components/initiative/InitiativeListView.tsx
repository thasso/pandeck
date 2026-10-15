import { memo } from "react";
import { Archive, Ban, Flag } from "lucide-react";
import { Item } from "../ui/item.tsx";
import { LIVE_PULSE } from "../common/load.tsx";
import { TaskStatusIcon } from "../TaskStatusIcon.tsx";
import { TaskBlockedIndicator } from "../TaskBlockedIndicator.tsx";
import { TaskIdBadge } from "../TaskIdBadge.tsx";
import {
  flattenTree,
  memberStateLabel,
  type InitiativeMember,
  type MemberTreeRow,
} from "../../lib/initiativeView.ts";

/**
 * @component InitiativeListView
 * @purpose The Initiative page's List view: the members as a tree, each epic
 *   with its own progress, milestones marked where they stand.
 * @useWhen The List view of `InitiativeDetailPage`, the default on a phone, and
 *   the map's stand-in whenever no layout could be drawn.
 * @intent Every Task appears once, in the read's order. A row opens its Task in
 *   the object panel, the same act as selecting a node on the map. Archived
 *   members stay in the tree, toned back.
 */
export function InitiativeListView({
  tree,
  milestones,
  selectedTaskId,
  onSelectTask,
}: {
  tree: readonly MemberTreeRow[];
  milestones: readonly InitiativeMember[];
  selectedTaskId: string | null;
  /** Stable: every row takes the Task id rather than closing over itself. */
  onSelectTask: (taskId: string) => void;
}) {
  const rows = flattenTree(tree);
  return (
    <div className="flex flex-col gap-4">
      {milestones.length > 0 ? (
        <section aria-label="Milestones" className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            Milestones
          </h3>
          <div className="flex flex-wrap gap-2">
            {milestones.map((member) => (
              <span
                key={member.id}
                className="inline-flex min-w-0 items-center gap-1.5 text-sm"
              >
                <Flag size={14} aria-hidden />
                <TaskStatusIcon status={member.status} size={14} />
                <span className="truncate">{member.title}</span>
                <span className="sr-only">{memberStateLabel(member)}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <ul aria-label="Members" className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <MemberRow
            key={row.member.id}
            row={row}
            selected={row.member.id === selectedTaskId}
            onSelectTask={onSelectTask}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One member. It takes the Task id in its handler and gets that handler,
 * stable, from the page, so it never closes over its own row.
 */
const MemberRow = memo(function MemberRow({
  row,
  selected,
  onSelectTask,
}: {
  row: MemberTreeRow;
  selected: boolean;
  onSelectTask: (taskId: string) => void;
}) {
  const { member, depth, progress } = row;
  const epic = progress !== undefined;
  return (
    <li
      data-list-row-id={member.id}
      className={member.archived ? "opacity-60" : undefined}
      style={{ paddingLeft: depth * 20 }}
    >
      <Item
        size="xs"
        variant={selected ? "muted" : "default"}
        aria-current={selected ? "true" : undefined}
        aria-label={`${member.title}, Task-${member.id}, ${memberStateLabel(member)}${
          member.milestone ? ", milestone" : ""
        }${epic ? `, ${progress.done} of ${progress.total} done` : ""}`}
        onClick={() => onSelectTask(member.id)}
        render={<button type="button" />}
      >
        <span
          aria-hidden
          className="flex w-full min-w-0 items-center gap-2 text-left"
        >
          <TaskStatusIcon status={member.status} size={14} />
          <span
            className={`min-w-0 flex-1 truncate ${epic ? "font-medium" : ""}`}
          >
            {member.title}
          </span>
          {member.milestone ? <Flag size={12} /> : null}
          {member.blocked ? (
            member.openBlockers ? (
              <TaskBlockedIndicator openBlockers={member.openBlockers} />
            ) : (
              <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                <Ban size={10} /> Blocked
              </span>
            )
          ) : null}
          {member.archived ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
              <Archive size={10} /> Archived
            </span>
          ) : null}
          {member.running ? (
            <span className="inline-flex items-center gap-1 text-xs text-primary">
              <span
                className={`size-1.5 rounded-full bg-primary ${LIVE_PULSE}`}
              />
              Running
            </span>
          ) : null}
          {epic ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {progress.done}/{progress.total} done
            </span>
          ) : null}
          <TaskIdBadge id={member.id} />
        </span>
      </Item>
    </li>
  );
});
