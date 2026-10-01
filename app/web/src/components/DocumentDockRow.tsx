import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import type { DocumentNavigationRegistration } from "./DocumentNavigationShell.tsx";
import { DockAction, type DockPeek } from "./shell/ObjectDock.tsx";

/**
 * The resting dock row of an open document, in ONE place so its order is a
 * property of the app rather than of whichever surface is on screen.
 *
 * The order is the contract (`app/web/docs/ui-shell.md`, Small Screens): Back
 * and Forward are the FIXED leading pair — the two halves of one control, side
 * by side — the source's own actions and the object's review/session actions
 * fill the middle, which scrolls horizontally once a worktree document brings
 * both, and Close is pinned at the FAR RIGHT end outside that scroller. The way
 * out of a document is never what scrolls away. Detailed zoom controls are not
 * in the row at all; they are a section of the expanded sheet.
 */
export function documentDockPeek(
  navigation: DocumentNavigationRegistration,
  objectActions: ReactNode,
): DockPeek {
  return {
    back: (
      <>
        <DockAction
          icon={<ArrowLeft size={18} />}
          label="Back"
          onRun={() => void navigation.back()}
          disabled={!navigation.canBack}
        />
        <DockAction
          icon={<ArrowRight size={18} />}
          label="Forward"
          onRun={navigation.forward}
          disabled={!navigation.canForward}
        />
      </>
    ),
    actions: (
      <>
        {navigation.sourceActions.map((action) => (
          <DockAction
            key={action.id}
            icon={action.icon}
            label={action.label}
            onRun={action.onRun}
            {...(action.disabled !== undefined
              ? { disabled: action.disabled }
              : {})}
            {...(action.disabledReason !== undefined
              ? { disabledReason: action.disabledReason }
              : {})}
          />
        ))}
        {objectActions}
      </>
    ),
    trailing: (
      <DockAction
        icon={<X size={18} />}
        label="Close document"
        onRun={navigation.close}
      />
    ),
  };
}
