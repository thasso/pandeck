import { isPersonalAssistantAgentType } from "@assistant/shared";
import type { SessionListItem } from "@assistant/shared";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "../ui/combobox.tsx";
import { ErrorNote, PaneLoading } from "../common/load.tsx";

export interface ScheduleTargetOption {
  id: string;
  title: string;
}

interface ScheduleTargetGroup {
  value: "live" | "archived";
  items: ScheduleTargetOption[];
}

/** What the Archived group can honestly say about its read. */
export type ArchivedTargetsStatus =
  { kind: "ready" } | { kind: "loading" } | { kind: "failed"; error: string };

export interface ArchivedTargetsRead {
  sessions: readonly SessionListItem[];
  loaded: boolean;
  /** A read is queued or in flight. */
  pending: boolean;
  /** Why the last read released unanswered. */
  error: string | null;
}

/**
 * The picker's options (U4): every session the user can see, live then
 * archived, without the Personal Assistant. The current target is always
 * offered, titled through the resolver when no list holds it. The archived
 * read is reported as loading, failed or ready, never as an empty group
 * before it answered.
 */
export function scheduleTargetOptions({
  live,
  archived,
  currentId,
  titleOf,
}: {
  live: readonly SessionListItem[];
  archived: ArchivedTargetsRead;
  currentId: string;
  titleOf: (id: string) => PaObjectLinkResolution | undefined;
}): { groups: ScheduleTargetGroup[]; archivedStatus: ArchivedTargetsStatus } {
  const pick = (rows: readonly SessionListItem[]) =>
    rows
      .filter((row) => !isPersonalAssistantAgentType(row.agentType))
      .map((row) => ({ id: row.id, title: row.title }));
  const liveItems = pick(live.filter((row) => !row.archived));
  const archivedItems = archived.loaded ? pick(archived.sessions) : [];
  const held = [...liveItems, ...archivedItems].some(
    (option) => option.id === currentId,
  );
  if (!held)
    liveItems.unshift({
      id: currentId,
      title: titleOf(currentId)?.title ?? currentId,
    });
  const archivedStatus: ArchivedTargetsStatus = archived.loaded
    ? { kind: "ready" }
    : archived.pending || archived.error === null
      ? { kind: "loading" }
      : { kind: "failed", error: archived.error };
  return {
    groups: [
      { value: "live", items: liveItems },
      ...(archivedItems.length > 0
        ? [{ value: "archived" as const, items: archivedItems }]
        : []),
    ],
    archivedStatus,
  };
}

/**
 * @component ScheduleTargetPicker
 * @purpose Choose the session a Schedule delivers to (`docs/schedules.md`,
 *   Web; U4).
 * @useWhen The Schedule detail's Target section.
 * @intent Opening it asks for the archived slice through the app's one
 *   archived read, whose pending and failed states show in the Archived group
 *   with Retry.
 */
export function ScheduleTargetPicker({
  labelId,
  value,
  live,
  archived,
  titleOf,
  onRequestArchived,
  onChange,
}: {
  labelId: string;
  value: string;
  live: readonly SessionListItem[];
  archived: ArchivedTargetsRead;
  titleOf: (id: string) => PaObjectLinkResolution | undefined;
  onRequestArchived: () => void;
  onChange: (sessionId: string) => void;
}) {
  const { groups, archivedStatus } = scheduleTargetOptions({
    live,
    archived,
    currentId: value,
    titleOf,
  });
  const selected =
    groups.flatMap((group) => group.items).find((o) => o.id === value) ?? null;
  return (
    <Combobox<ScheduleTargetOption>
      items={groups}
      value={selected}
      itemToStringLabel={(option) => option.title}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={(next) => {
        if (next) onChange(next.id);
      }}
      onOpenChange={(open) => {
        if (open && !archived.loaded && !archived.pending) onRequestArchived();
      }}
    >
      <ComboboxInput
        aria-labelledby={labelId}
        placeholder="Choose a session"
        className="w-full"
      />
      <ComboboxContent>
        <ComboboxList>
          {(group: ScheduleTargetGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.value === "archived" ? (
                <ComboboxLabel>Archived</ComboboxLabel>
              ) : null}
              <ComboboxCollection>
                {(option: ScheduleTargetOption) => (
                  <ComboboxItem key={option.id} value={option}>
                    {option.title}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {archivedStatus.kind === "ready" ? null : (
          <div className="border-t border-border p-1">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Archived
            </div>
            {archivedStatus.kind === "loading" ? (
              <PaneLoading
                label="Loading archived sessions…"
                className="flex-none p-2"
              />
            ) : (
              <ErrorNote
                message={archivedStatus.error}
                onRetry={onRequestArchived}
              />
            )}
          </div>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
