import { useStoredOpen } from "../../hooks/useStoredOpen.ts";
import {
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "../common/PropertyList.tsx";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  MessageSquareQuote,
  MousePointerClick,
  ScanSearch,
} from "lucide-react";
import { useCommentActuation } from "../review/CommentActuation.tsx";
import {
  primarySlotShowsReview,
  usePublishRouteSecondaryActions,
  useRoutePrimaryAction,
  useRouteSecondaryActionHost,
} from "./RoutePrimaryAction.tsx";
import { EmptyBox, Skeleton } from "../common/load.tsx";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

/**
 * Chrome the HOST surface supplies instead of the inspector. The mobile object
 * dock is a sheet over the object you are already looking at, so its identity
 * header would repeat the screen's own header one row below it — the dock drops
 * it here rather than every per-object assembly having to thread a flag through.
 */
const InspectorChromeContext = createContext<{
  header: boolean;
  /** A desktop tab host owns the visible panel header. */
  desktopTabs: boolean;
  onAct?: () => void;
}>({ header: true, desktopTabs: false });

/** Called after a row acts, so a dock sheet can get out of the way. */
export function useInspectorAct(): (() => void) | undefined {
  return useContext(InspectorChromeContext).onAct;
}

export function InspectorChromeProvider({
  header,
  desktopTabs = false,
  onAct,
  children,
}: {
  header: boolean;
  /** Hide the Inspector header under the desktop right-panel tab bar. */
  desktopTabs?: boolean;
  /**
   * Called after the user follows a relation or runs an action here. A dock sheet
   * collapses on it: the result of acting is almost always a change to the screen
   * the sheet is covering, so staying open hides the very thing you asked for.
   * Actions that change nothing visible opt out with `InspectorAction.keepOpen`.
   */
  onAct?: () => void;
  children: ReactNode;
}) {
  return (
    <InspectorChromeContext.Provider
      value={{
        header,
        desktopTabs,
        ...(onAct !== undefined ? { onAct } : {}),
      }}
    >
      {children}
    </InspectorChromeContext.Provider>
  );
}

/** One related-object row: a resolved reference rendered as a main-pane link. */
interface InspectorRelation {
  key: string;
  icon?: ReactNode;
  title: string;
  /** The title as the object reads elsewhere (a project's key and muted name). */
  titleContent?: ReactNode;
  /** Relation qualifier, e.g. "Parent task", "Started from this task". */
  subtitle?: string;
  /** Optional source-style change counters, rendered with the normal +/- colors. */
  counters?: { additions: number; deletions: number };
  /** Expanded child rows for hierarchy, such as Project → worktree or Task → subtask. */
  children?: InspectorRelation[];
  /** Opens the object in the main pane; must not move the sidebar (rule 2). */
  onOpen: () => void;
}

export interface InspectorRelationGroup {
  /** Stable storage/render id. Falls back to a slug of label. */
  id?: string;
  label: string;
  icon?: ReactNode;
  /** Compact right-aligned section metadata, e.g. "0 doing · 1 task · 2 done". */
  summary?: string;
  /** Defaults to true. Disable only for static, non-empty content. */
  collapsible?: boolean;
  /** Initial expanded state when no persisted preference exists. Defaults to true. */
  defaultOpen?: boolean;
  /**
   * Show only this many TOP-LEVEL rows until the reader asks for the rest, so a
   * long group (a session's task tree) cannot push the sections under it off
   * the panel. Unset means every row.
   */
  maxVisibleItems?: number;
  items: InspectorRelation[];
  /**
   * The group's body when its objects have a row of their own elsewhere in the
   * app (sessions draw the composer strip's rows), so the panel does not grow
   * a second rendering of them. `items` still decides whether the group shows.
   */
  content?: ReactNode;
  /**
   * Shown although it has no relation rows: a group that is ONLY `content` (a
   * session's Details), placed among the relations rather than after them.
   */
  alwaysShown?: boolean;
}

/** One object-aware action, e.g. "Start session", "Archive". */
export interface InspectorAction {
  key: string;
  icon?: ReactNode;
  label: string;
  onRun: () => void;
  /** Busy only this initiating action while its correlated mutation settles. */
  busy?: boolean;
  /** Inert until the action's prerequisite is available. */
  disabled?: boolean;
  /** Tooltip explaining how to satisfy a disabled action's prerequisite. */
  disabledReason?: string;
  /**
   * Extra information about the action, right-aligned on its row like a
   * section's summary — the panel's one way of adding a detail to a label.
   * Omit it when there is nothing to say (no "0").
   */
  hint?: string;
  /** Preserve a comment surface's captured target while this action is pressed. */
  commentActuation?: boolean;
  /**
   * Keep a collapse-on-act host (the mobile dock) open after this runs. For
   * actions with no visible effect on the surface underneath — copying a link,
   * for instance — where collapsing would just cost the user their place.
   */
  keepOpen?: boolean;
  /**
   * The object's headline action (every agent-enabled type leads with "Start a new
   * session"). A host that surfaces it itself — the mobile dock's header row —
   * hoists it out of this list rather than showing the same button twice.
   */
  primary?: boolean;
}

function counterTitle(
  counters: InspectorRelation["counters"],
): string | undefined {
  return counters ? `+${counters.additions}/-${counters.deletions}` : undefined;
}

function sectionIdFromTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

/** One label/value pair of an inspector section's facts. */
export interface InspectorFact {
  label: string;
  value: ReactNode;
  /** Render the value in the mono stack (ids, paths, branches, oids). */
  mono?: boolean;
  /** Hover title for a value that truncates. */
  title?: string;
  /**
   * Which END of a too-long value gives way. `start` is for values whose tail
   * identifies them (a checkout path: every worktree shares the prefix), and
   * relies on RTL base direction to move the ellipsis, so it is only correct
   * for a plain string value.
   */
  truncate?: "end" | "start";
}

/**
 * @component InspectorFacts
 * @purpose The ONE way an inspector section states an object's flat facts:
 *   label/value rows, flush with the section, no box.
 * @useWhen A section shows read-only metadata (frontmatter, a checkout, working
 *   tree counts, the current view).
 * @avoidWhen The rows are navigable objects (use the frame's relations) or
 *   editable fields (those own their controls).
 * @intent Nested cards inside an already-bordered panel gave every section a
 *   second frame and made a scan of the panel a scan of boxes. The panel is the
 *   card; a section is a heading and its rows.
 */
export function InspectorFacts({ facts }: { facts: InspectorFact[] }) {
  // The property list every editable field uses too, so read-only facts and
  // editable ones share one label column wherever they appear.
  return (
    <PropertyList>
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <PropertyLabel>{fact.label}</PropertyLabel>
          <PropertyText
            // Left-trimming is the block's DIRECTION (that is what moves the
            // ellipsis to the start), with the value itself back in ltr so the
            // path still reads forwards.
            dir={fact.truncate === "start" ? "rtl" : undefined}
            className={`truncate ${fact.truncate === "start" ? "text-left" : ""} ${fact.mono ? "font-mono text-xs text-muted-foreground" : "text-foreground"}`}
            title={fact.title}
          >
            {fact.truncate === "start" ? (
              <span dir="ltr">{fact.value}</span>
            ) : (
              fact.value
            )}
          </PropertyText>
        </Fragment>
      ))}
    </PropertyList>
  );
}

/**
 * @component InspectorSection
 * @purpose Shared compact section chrome for right-side inspectors/drawers:
 * chevron, aligned icon/title, optional right-side summary/actions, separator,
 * and persisted expansion when given a storage scope.
 * @useWhen Adding Workspace/Tasks/Actions or contextual sections inside the
 * generic Inspector or SessionContextSections.
 * @avoidWhen A page-level card or long form needs its own header hierarchy.
 * @intent Keep inspector content visually aligned and scannable; section bodies
 * own their domain rows while the shell owns collapse/separator behavior.
 */
export function InspectorSection({
  id,
  storageScope,
  title,
  icon,
  summary,
  children,
  actions,
  defaultOpen = true,
  collapsible = true,
  forceOpen = false,
  contentClassName,
}: {
  id: string;
  storageScope?: string | undefined;
  title: string;
  icon?: ReactNode;
  summary?: string | undefined;
  children: ReactNode;
  /** Optional compact controls rendered in the section header, e.g. add buttons. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  /** Keep the body visible regardless of persisted collapse, e.g. while adding. */
  forceOpen?: boolean;
  contentClassName?: string;
}) {
  const storageKey = storageScope
    ? `inspector-section:${storageScope}:${id}`
    : undefined;
  const [storedOpen, toggleOpen] = useStoredOpen(storageKey, defaultOpen);
  const open = forceOpen || (collapsible && storedOpen);

  return (
    <Collapsible
      open={open}
      onOpenChange={toggleOpen}
      disabled={!collapsible}
      render={<section />}
      className="border-t border-border pt-3 first:border-t-0 first:pt-0"
    >
      <div className="mb-2 flex w-full items-center gap-2">
        {/* `grow`, not `flex-1`: from a zero basis the trigger's width was only
            its share of free space, so a long summary squeezed it to nothing
            and then pushed the row past the panel. From a content basis both
            give way, and the trigger is still the only growing item. */}
        <CollapsibleTrigger className="flex min-h-7 min-w-0 grow items-center gap-2 rounded-md text-left text-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 disabled:no-underline [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          <ChevronRight
            className={`transition-transform ${open ? "rotate-90" : ""}`}
          />
          {icon}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </CollapsibleTrigger>
        {summary ? (
          // Shrinkable, and the FIRST to give way: the summary only echoes what
          // the open section shows, so a narrow row should eat it before it eats
          // the section's name.
          <span className="min-w-0 shrink-[3] truncate text-sm text-muted-foreground">
            {summary}
          </span>
        ) : null}
        {actions ? (
          <span className="flex shrink-0 items-center gap-1">{actions}</span>
        ) : null}
      </div>
      <CollapsibleContent className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A group's rows, bounded to `maxVisible` top-level rows until the reader opens
 * the rest. Subtrees always come with their parent: hiding a row's children
 * would misreport the object, while hiding whole roots only defers them.
 *
 * "Show more" is a reading choice about ONE object, not a preference: the
 * caller keys this by the inspected object, so the next object opens bounded
 * again instead of inheriting how far the previous one was unfolded.
 */
function RelationRows({
  items,
  maxVisible,
}: {
  items: InspectorRelation[];
  maxVisible?: number | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const limit =
    maxVisible !== undefined && !showAll ? maxVisible : items.length;
  const hidden = items.length - limit;
  return (
    <div className="flex flex-col gap-0.5">
      {items.slice(0, limit).map((item) => (
        <RelationRow key={item.key} item={item} />
      ))}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(true)}
          className="justify-start"
        >
          Show {hidden} more
        </Button>
      ) : null}
    </div>
  );
}

function RelationRow({
  item,
  depth = 0,
}: {
  item: InspectorRelation;
  depth?: number;
}) {
  const title = [item.title, item.subtitle, counterTitle(item.counters)]
    .filter(Boolean)
    .join(" — ");
  const { onAct } = useContext(InspectorChromeContext);
  return (
    <div>
      <Item
        size="xs"
        render={<button type="button" />}
        onClick={() => {
          // Opening a related object moves the main pane, which on a phone is
          // behind this sheet.
          item.onOpen();
          onAct?.();
        }}
        title={title}
        className="flex-nowrap text-left hover:bg-muted"
      >
        {depth > 0 ? (
          <span aria-hidden="true" className="text-sm text-muted-foreground">
            ↳
          </span>
        ) : null}
        {item.icon ? <ItemMedia variant="icon">{item.icon}</ItemMedia> : null}
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <span className="truncate">{item.titleContent ?? item.title}</span>
          </ItemTitle>
          {item.subtitle || item.counters ? (
            <ItemDescription className="truncate">
              {item.subtitle}
              {item.counters ? (
                <span className="font-mono">
                  {item.subtitle ? " · " : ""}
                  <span className="text-success">
                    +{item.counters.additions}
                  </span>{" "}
                  <span className="text-destructive">
                    −{item.counters.deletions}
                  </span>
                </span>
              ) : null}
            </ItemDescription>
          ) : null}
        </ItemContent>
      </Item>
      {item.children?.length ? (
        <div className="ml-4 border-l border-border pl-1">
          {item.children.map((child) => (
            <RelationRow key={child.key} item={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  /** The object this panel addresses has not arrived yet; reserve its body. */
  loading?: boolean;
  relations: InspectorRelationGroup[];
  actions: InspectorAction[];
  /** Stable scope for persisting section expansion, usually object-kind:id. */
  sectionStorageScope?: string;
  /** Object-specific extra content rendered between relations and actions. */
  children?: ReactNode;
  /**
   * Whether this panel feeds the page header's actions menu (wide layouts).
   * False where the page publishes its actions itself on every layout (the
   * chat session header): the panel then must not overwrite or clear them.
   */
  ownsHeaderActions?: boolean;
}

/**
 * @component Inspector
 * @purpose Generic right-sidebar inspector for the current main-pane object per
 * app/web/docs/ui-shell.md: a stable Inspector identity, object-aware actions,
 * then related objects as links.
 * @useWhen Rendering the right shell panel for an object type. Compose it from
 * a thin per-object assembly that resolves that type's references into
 * InspectorRelationGroup rows (see objectInspectors.tsx).
 * @avoidWhen The panel needs live feature content (chat, diffs, workflow runs);
 * the inspector is for connections and actions, not a second navigation tree.
 * @intent Content-agnostic frame: everything domain-specific arrives resolved
 * via props. Relation rows navigate the main pane and must preserve sidebar
 * state (navigation rule 2). Workspace/Tasks/Actions and contextual drawer
 * content share InspectorSection for consistent collapsible section chrome.
 */
export function Inspector({
  loading = false,
  relations,
  actions: allActions,
  sectionStorageScope,
  children,
  ownsHeaderActions = true,
}: Props) {
  const groups = relations.filter(
    (group) => group.items.length > 0 || group.alwaysShown,
  );
  const {
    header: showHeader,
    desktopTabs,
    onAct,
  } = useContext(InspectorChromeContext);
  const wideChrome = showHeader || desktopTabs;
  const publishSecondaryActions = usePublishRouteSecondaryActions();
  const hasSecondaryActionHost = useRouteSecondaryActionHost();
  const commentActuation = useCommentActuation();
  // Whichever chrome is closest to the reader — the wide page header, the dock's
  // action row — draws the object's primary action in ONE slot, so listing it
  // here as well would be the same button twice. But that slot belongs to the
  // pending review while there is one: then nothing outside this panel is
  // showing the primary, and the panel is where it stays reachable.
  const routePrimary = useRoutePrimaryAction();
  const primaryShownElsewhere =
    routePrimary !== null &&
    !primarySlotShowsReview(commentActuation?.pendingCount);
  const commentActions: InspectorAction[] = [
    ...(commentActuation?.onComment
      ? [
          {
            key: "comment-actuation:add",
            icon: <MessageSquareQuote size={15} />,
            label: commentActuation.commentLabel ?? "Add comment",
            onRun: commentActuation.onComment,
            disabled: commentActuation.canComment !== true,
            ...(!(commentActuation.canComment === true)
              ? { disabledReason: "Select text to comment" }
              : {}),
            commentActuation: true,
          },
        ]
      : []),
  ];
  const objectActions = primaryShownElsewhere
    ? allActions.filter((action) => !action.primary)
    : allActions;
  // On wide layouts secondary object actions move to the page header's overflow
  // menu. Comment actuation already has a dedicated visible page-header control,
  // so it never joins that menu. The dock has no overflow menu, so on mobile the
  // panel keeps the full action section.
  const actionsInHeader = wideChrome && hasSecondaryActionHost;
  useEffect(() => {
    if (!ownsHeaderActions) return;
    publishSecondaryActions(actionsInHeader ? objectActions : []);
  }, [
    actionsInHeader,
    objectActions,
    ownsHeaderActions,
    publishSecondaryActions,
  ]);
  useEffect(
    () => () => {
      if (ownsHeaderActions) publishSecondaryActions([]);
    },
    [ownsHeaderActions, publishSecondaryActions],
  );
  const inspectorActions = actionsInHeader
    ? []
    : [...commentActions, ...objectActions];
  // What the reader came to DO leads the panel on mobile; the object's references and
  // sections read below it. No count in the header: an always-open section of
  // labelled buttons already shows how many there are.
  const actionsSection =
    inspectorActions.length > 0 ? (
      <InspectorSection
        id="actions"
        storageScope={sectionStorageScope}
        title="Actions"
        icon={<MousePointerClick size={13} />}
      >
        <div className="flex flex-col gap-0.5">
          {inspectorActions.map((action) => (
            <Button
              key={action.key}
              variant="ghost"
              busy={action.busy === true}
              disabled={action.disabled}
              title={action.disabledReason}
              data-comment-actuation={action.commentActuation || undefined}
              onPointerDown={
                action.commentActuation
                  ? (event) => event.preventDefault()
                  : undefined
              }
              onClick={() => {
                if (action.busy || action.disabled) return;
                action.onRun();
                // Running an action normally changes the surface underneath
                // (a route, a panel, a mutation), so a dock sheet gets out
                // of the way — unless the action opted out.
                if (!action.keepOpen) onAct?.();
              }}
              className="w-full justify-start"
            >
              {action.busy ? null : action.icon}
              <span className="min-w-0 flex-1 truncate text-left">
                {action.label}
              </span>
              {action.hint ? (
                <span className="font-normal text-muted-foreground">
                  {action.hint}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      </InspectorSection>
    ) : null;
  return (
    <aside
      className={`flex h-full w-full shrink-0 flex-col overflow-hidden surface-sidebar border-border ${desktopTabs ? "" : "desktop:border-l"}`}
    >
      {showHeader && (
        <header className="flex min-h-11 items-center gap-2 border-b border-border px-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
            <ScanSearch size={16} />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
            Inspector
          </h2>
        </header>
      )}

      {/* The busy flag lives HERE, on the body that survives the swap, and not
          on the announcing region inside it: this element is still mounted when
          the object lands, so it goes true→false the way ARIA describes, while
          a live region marked busy may simply never be read out. */}
      <div
        aria-busy={loading || undefined}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {loading && groups.length === 0 && (
          <div
            role="status"
            aria-label="Loading Inspector details"
            className="space-y-4"
          >
            {[0, 1].map((section) => (
              <div key={section} className="space-y-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-7" />
                <Skeleton className="h-7" />
              </div>
            ))}
          </div>
        )}
        {!loading && groups.length === 0 && !children && (
          <EmptyBox>No related objects yet.</EmptyBox>
        )}
        <div className="space-y-4">
          {actionsSection}

          {groups.map((group) => (
            <InspectorSection
              key={group.id ?? group.label}
              id={`relations:${group.id ?? sectionIdFromTitle(group.label)}`}
              storageScope={sectionStorageScope}
              title={group.label}
              icon={group.icon}
              summary={group.summary}
              collapsible={group.collapsible ?? true}
              defaultOpen={group.defaultOpen ?? true}
            >
              {/* Remount per inspected object: the section itself is keyed by
                  the group id, which is the SAME across objects, so without
                  this an expanded group ("Show N more") — the generic rows or
                  a group's own content — stays expanded for the next one. */}
              <Fragment key={sectionStorageScope ?? "unscoped"}>
                {group.content ?? (
                  <RelationRows
                    items={group.items}
                    maxVisible={group.maxVisibleItems}
                  />
                )}
              </Fragment>
            </InspectorSection>
          ))}

          {/* Not wrapped: a section is separated from the one above it by its
              own top border, and `first:` only suppresses that for the FIRST
              child of a container. A wrapper here made every child section
              believe it opened the panel, so the seam between the last relation
              group and the first contextual section (Workspace → Profile) went
              missing and the spacing came out uneven. */}
          {children}
        </div>
      </div>
    </aside>
  );
}
