import { createContext, useContext, type ReactNode } from "react";

/**
 * Where a Knowledge entry named anywhere in the app can be OPENED, published
 * once by the app shell.
 *
 * A transcript card is the reason this is a context rather than a prop: the
 * chat renders inside the main pane and inside the Personal Assistant panel,
 * and neither route threads Knowledge navigation through the message list. Both
 * reach the same two surfaces through this channel.
 */
export interface KnowledgeOpenTargets {
  /**
   * Open the entry in the right panel's Knowledge tab, beside whatever the main
   * pane is showing. Absent on small screens, where that panel does not exist
   * (`app/web/docs/ui-shell.md`, Small Screens) — there, reading an entry means
   * going to its route.
   */
  openInPanel?: ((entryId: string) => void) | undefined;
  /** Open the entry's canonical Knowledge route in the main pane. */
  openInMain: (entryId: string) => void;
}

const KnowledgeOpenTargetsContext = createContext<KnowledgeOpenTargets | null>(
  null,
);

export function KnowledgeOpenTargetsProvider({
  targets,
  children,
}: {
  /** Hold this stable while it says the same thing — cards re-render on it. */
  targets: KnowledgeOpenTargets;
  children: ReactNode;
}) {
  return (
    <KnowledgeOpenTargetsContext.Provider value={targets}>
      {children}
    </KnowledgeOpenTargetsContext.Provider>
  );
}

/** The app's Knowledge open targets, or null outside the shell (tests, previews). */
export function useKnowledgeOpenTargets(): KnowledgeOpenTargets | null {
  return useContext(KnowledgeOpenTargetsContext);
}
