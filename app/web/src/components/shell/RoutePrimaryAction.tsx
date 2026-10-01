import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * What the object on screen leads with — "Start session with this entry", "Start
 * session in this project" — published once by the route host and rendered by
 * whichever chrome is closest to the reader.
 *
 * It exists because three places used to define the same action: the dock row
 * built it inline, the inspector built it again as its `primary`, and the wide
 * page header had none at all — which left "start a session about this thing"
 * reachable only through a panel the reader may have closed.
 */
export interface RoutePrimaryAction {
  /** Imperative, and about the OBJECT: "Start session in this worktree". */
  label: string;
  icon: ReactNode;
  onRun: () => void;
}

const RoutePrimaryActionContext = createContext<RoutePrimaryAction | null>(
  null,
);

/** A secondary object action rendered in a wide page header's overflow menu. */
export interface RouteSecondaryAction {
  key: string;
  icon?: ReactNode;
  label: string;
  onRun: () => void;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  hint?: string;
}

const RouteSecondaryActionsContext = createContext<{
  hosted: boolean;
  actions: RouteSecondaryAction[];
  publish: (actions: RouteSecondaryAction[]) => void;
}>({ hosted: false, actions: [], publish: () => {} });

function secondaryActionSignature(actions: RouteSecondaryAction[]): string {
  return actions
    .map((action) =>
      [
        action.key,
        action.label,
        action.busy ? "busy" : "",
        action.disabled ? "disabled" : "",
        action.disabledReason ?? "",
        action.hint ?? "",
      ].join("\u0000"),
    )
    .join("\u0001");
}

export function RoutePrimaryActionProvider({
  action,
  children,
}: {
  /** Hold this stable while it says the same thing — chrome re-renders on it. */
  action: RoutePrimaryAction | null;
  children: ReactNode;
}) {
  // The inspector renders after the page header, so it publishes secondary
  // actions upward. Only a visible menu shape change may re-render the header,
  // or the provider and the inspector feed one another every time an assembly
  // allocates a fresh action array — so the SIGNATURE gates the write, and the
  // accepted array is held in state.
  //
  // It was a ref plus a revision counter, with `signatureRef.current` in the
  // memo's dependencies. That cannot work as written: mutating a ref schedules
  // nothing, so the entry was only ever a passenger of the re-render the
  // counter was already causing. State says the same thing and is checkable.
  const signatureRef = useRef("");
  const latestActionsRef = useRef(new Map<string, RouteSecondaryAction>());
  const [publishedActions, setPublishedActions] = useState<
    RouteSecondaryAction[]
  >([]);
  const publish = useCallback((actions: RouteSecondaryAction[]) => {
    // A route change can preserve the menu's visible shape while changing what
    // its actions address (Task-614 → Task-615, for example). Keep those latest
    // handlers even when the signature gate correctly avoids a header render.
    latestActionsRef.current = new Map(
      actions.map((action) => [action.key, action]),
    );
    const signature = secondaryActionSignature(actions);
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    setPublishedActions(
      actions.map((action) => ({
        ...action,
        onRun: () => latestActionsRef.current.get(action.key)?.onRun(),
      })),
    );
  }, []);
  const secondaryValue = useMemo(
    () => ({ hosted: true, actions: publishedActions, publish }),
    [publish, publishedActions],
  );
  return (
    <RoutePrimaryActionContext.Provider value={action}>
      <RouteSecondaryActionsContext.Provider value={secondaryValue}>
        {children}
      </RouteSecondaryActionsContext.Provider>
    </RoutePrimaryActionContext.Provider>
  );
}

/** The current route's primary action, if it has one. */
export function useRoutePrimaryAction(): RoutePrimaryAction | null {
  return useContext(RoutePrimaryActionContext);
}

/** Publish desktop-only secondary object actions from the active inspector. */
export function usePublishRouteSecondaryActions(): (
  actions: RouteSecondaryAction[],
) => void {
  return useContext(RouteSecondaryActionsContext).publish;
}

/** Read the active object's secondary actions for a wide page-header menu. */
export function useRouteSecondaryActions(): RouteSecondaryAction[] {
  return useContext(RouteSecondaryActionsContext).actions;
}

/** Whether a route host is available to render secondary actions in its header. */
export function useRouteSecondaryActionHost(): boolean {
  return useContext(RouteSecondaryActionsContext).hosted;
}

/**
 * Whether the primary SLOT is currently offering the review instead of the
 * object's own action.
 *
 * The slot is one place — the rightmost, most reachable control of whatever
 * chrome holds it — and what belongs there is the thing to do right now. Having
 * written comments, that is sending them; the chat screen's row swaps its
 * primary the same way (`app/web/docs/ui-shell.md`). Nothing is lost when it
 * swaps: the sheet it opens offers to start a session without the comments, and
 * the object panel lists the primary again while the slot is not showing it.
 */
export function primarySlotShowsReview(pendingCount?: number): boolean {
  return (pendingCount ?? 0) > 0;
}
