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
import { EmptyBox, Skeleton, Spinner } from "../common/load.tsx";

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

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    if (value === "open") return true;
    if (value === "closed") return false;
  } catch {
    // Ignore storage failures and use the default state.
  }
  return fallback;
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
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-1">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt className="text-sm text-faint">{fact.label}</dt>
          <dd
            // Left-trimming is the block's DIRECTION (that is what moves the
            // ellipsis to the start), with the value itself back in ltr so the
            // path still reads forwards.
            {...(fact.truncate === "start" ? { dir: "rtl" as const } : {})}
            className={`min-w-0 truncate text-sm ${fact.truncate === "start" ? "text-left" : ""} ${fact.mono ? "font-mono text-muted-foreground" : "text-fg"}`}
            title={fact.title}
          >
            {fact.truncate === "start" ? (
              <span dir="ltr">{fact.value}</span>
            ) : (
              fact.value
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
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
  const [storedOpen, setStoredOpen] = useState(() =>
    storageKey ? readStoredBoolean(storageKey, defaultOpen) : defaultOpen,
  );
  const open = forceOpen || (collapsible && storedOpen);

  useEffect(() => {
    setStoredOpen(
      storageKey ? readStoredBoolean(storageKey, defaultOpen) : defaultOpen,
    );
  }, [storageKey, defaultOpen]);

  const toggleOpen = () => {
    if (!collapsible) return;
    setStoredOpen((current) => {
      const next = !current;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? "open" : "closed");
        } catch {
          // Ignore storage failures; collapsing is still useful for this render.
        }
      }
      return next;
    });
  };

  return (
    <section className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="mb-2 flex w-full items-center gap-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          type="button"
          onClick={toggleOpen}
          disabled={!collapsible}
          aria-expanded={collapsible ? open : undefined}
          // `grow`, not `flex-1`: with a zero basis this button's width was only
          // its share of free space, so it collapsed as the summary grew — and
          // once it hit zero the row had no give left at all (shrinkage is
          // weighted by base size, so a zero-basis item takes none of it, and
          // the summary was `shrink-0`), so a long summary pushed the row past
          // the panel. From a content basis both give way, so a long summary no
          // longer pushes the row. Growth is unchanged: this is still the only
          // growing item.
          className="flex min-w-0 grow items-center gap-2 rounded-lg text-left transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          <ChevronRight
            size={13}
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""} ${collapsible ? "" : "text-faint opacity-35"}`}
          />
          {icon ? (
            <span className="flex shrink-0 items-center text-muted-foreground">
              {icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </button>
        {summary ? (
          // Shrinkable, and the FIRST to give way: the summary only echoes what
          // the open section shows, so a narrow row should eat it before it eats
          // the section's name.
          <span className="min-w-0 shrink-[3] truncate normal-case tracking-normal text-faint">
            {summary}
          </span>
        ) : null}
        {actions ? (
          <span className="flex shrink-0 items-center gap-1 normal-case tracking-normal">
            {actions}
          </span>
        ) : null}
      </div>
      {open ? <div className={contentClassName}>{children}</div> : null}
    </section>
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
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full rounded-md px-2 py-1 text-left text-sm font-medium text-faint transition-colors hover:bg-raised hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Show {hidden} more
        </button>
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
      <button
        type="button"
        onClick={() => {
          // Opening a related object moves the main pane, which on a phone is
          // behind this sheet.
          item.onOpen();
          onAct?.();
        }}
        title={title}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span
          aria-hidden="true"
          className="w-3 shrink-0 text-center text-sm text-faint"
        >
          {depth > 0 ? "↳" : ""}
        </span>
        {item.icon && (
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {item.icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{item.title}</span>
          {(item.subtitle || item.counters) && (
            <span className="block truncate text-sm text-faint">
              {item.subtitle}
              {item.counters && (
                <span
                  className={item.subtitle ? "ml-1 font-mono" : "font-mono"}
                >
                  {item.subtitle ? "· " : ""}
                  <span className="text-emerald-400">
                    +{item.counters.additions}
                  </span>{" "}
                  <span className="text-red-400">
                    −{item.counters.deletions}
                  </span>
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {item.children?.length ? (
        <div className="ml-4 border-l border-line pl-1">
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
}: Props) {
  const groups = relations.filter((group) => group.items.length > 0);
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
            label: "Add comment",
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
  // so it never joins that menu. The dock has no overflow menu, retaining the
  // full action section on mobile.
  useEffect(() => {
    publishSecondaryActions(
      wideChrome && hasSecondaryActionHost ? objectActions : [],
    );
  }, [
    hasSecondaryActionHost,
    objectActions,
    publishSecondaryActions,
    wideChrome,
  ]);
  useEffect(() => () => publishSecondaryActions([]), [publishSecondaryActions]);
  const inspectorActions =
    wideChrome && hasSecondaryActionHost
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
            <button
              key={action.key}
              type="button"
              disabled={action.busy || action.disabled}
              aria-busy={action.busy || undefined}
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
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              {action.busy ? (
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <Spinner size="xs" />
                </span>
              ) : action.icon ? (
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {action.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.hint ? (
                <span className="shrink-0 font-normal text-faint">
                  {action.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </InspectorSection>
    ) : null;
  return (
    <aside
      className={`flex h-full w-full shrink-0 flex-col overflow-hidden border-line bg-panel ${desktopTabs ? "" : "sm:border-l"}`}
    >
      {showHeader && (
        <header className="flex min-h-11 items-center gap-2 border-b border-line px-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
            <ScanSearch size={16} />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-fg">
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
              <RelationRows
                key={sectionStorageScope ?? "unscoped"}
                // Remount per inspected object: the section itself is keyed by
                // the group id, which is the SAME across objects, so without
                // this an expanded group stays expanded for the next session.
                items={group.items}
                maxVisible={group.maxVisibleItems}
              />
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
