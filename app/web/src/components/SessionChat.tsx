import {
  lazy,
  Profiler,
  Suspense,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { SessionChatModel } from "../hooks/useSessionChat.tsx";
import { recordRender } from "../lib/perfStats.ts";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { Composer } from "./Composer.tsx";
import { FloatingComposerDock } from "./FloatingComposerDock.tsx";
import { SessionWorktreeMissingBanner } from "./SessionWorktreeMissingBanner.tsx";
import { TaskLiveSourceProvider } from "./TaskLiveState.tsx";

let messageListPreload: Promise<typeof import("./MessageList.tsx")> | null =
  null;
export function loadMessageList() {
  messageListPreload ??= import("./MessageList.tsx");
  return messageListPreload;
}

const MessageList = lazy(() =>
  loadMessageList().then((module) => ({ default: module.MessageList })),
);

function recordTranscriptRender(
  _id: string,
  _phase: string,
  actualDuration: number,
): void {
  recordRender("Transcript", actualDuration);
}

/**
 * Inline transcript silhouette used only if a primary action beats its idle
 * preload. It occupies transcript geometry, so first send never swaps the hero
 * for a whole-pane chunk fallback or for an empty frame.
 */
function TranscriptChunkFallback() {
  return (
    <div
      role="status"
      aria-label="Opening transcript"
      className="min-h-0 flex-1 overflow-hidden bg-background"
    >
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-end gap-3 px-4 py-6">
        <div className="ml-auto w-2/3 rounded-2xl border border-border bg-card p-4">
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="mt-2 h-3 w-3/4 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/** The composer that does not float over a transcript still rides the keyboard. */
function KeyboardInsetDock({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative z-10 shrink-0 bg-transparent transition-transform duration-150 ease-out"
      style={{
        transform:
          "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
      }}
    >
      {children}
    </div>
  );
}

/**
 * @component SessionChat
 * @purpose The one chat composition: transcript, floating dock, failure notes
 * and composer, fed by a `useSessionChat` model. The center pane and the
 * right-panel chats both render this.
 * @useWhen Showing a session's conversation anywhere. Its parent must be a flex
 * column: the transcript's scroller and the dock size from it.
 * @avoidWhen Never assemble `MessageList` and `Composer` by hand beside it; a
 * surface that needs something more adds it here as an input.
 * @intent Everything only the center has rides in as a prop, so a panel gets the
 * approvals, questions, ledges and comments of the center by construction.
 */
export function SessionChat({
  chat,
  composer,
  transcript,
  showTranscript = true,
  pendingPanel,
  dockLead,
  emptySurface,
}: {
  chat: SessionChatModel;
  /** Composer props only this host has; they win over the model's. */
  composer?: Partial<ComponentProps<typeof Composer>>;
  /** Transcript props only this host has; they win over the model's. */
  transcript?: Partial<
    ComponentProps<typeof import("./MessageList.tsx").MessageList>
  >;
  /** False leaves `emptySurface` in the transcript's place. */
  showTranscript?: boolean;
  /** The session is on its way, or cannot be shown: this stands in for it. */
  pendingPanel?: ReactNode;
  /** A line above the composer, in the dock. */
  dockLead?: ReactNode;
  emptySurface?: ReactNode;
}) {
  const composerEl = (
    <>
      {chat.worktreeMissing ? (
        <SessionWorktreeMissingBanner
          onAcknowledge={chat.onAcknowledgeMissingWorktree}
        />
      ) : null}
      {/* A failure that names THIS session belongs here rather than in
          passing (`docs/messaging.md`): this is where the user acts on it,
          and it survives unrelated traffic and other sessions' failures until
          something retires it. Two things do, and both name this session: the
          dismiss below, and the session's own next send (which dispatches
          `clearSessionFailure` — the SEND does it, not its echo, because an
          attachments-only prompt echoes nothing). */}
      {chat.hopRefusal ? (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2">
          <ErrorNote message={chat.hopRefusal} />
        </div>
      ) : null}
      {chat.failure ? (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2">
          <ErrorNote
            message={chat.failure}
            onRetry={chat.onDismissFailure}
            retryLabel="Dismiss"
          />
        </div>
      ) : null}
      <Composer {...chat.composer} {...composer} />
    </>
  );

  if (pendingPanel)
    return (
      <>
        {pendingPanel}
        <KeyboardInsetDock>{composerEl}</KeyboardInsetDock>
      </>
    );

  if (showTranscript)
    return (
      <FloatingComposerDock
        transcript={
          // Commit DURATION of the transcript subtree, for the dev HUD: the
          // render counts say how often it redraws, this says what one redraw
          // costs (a no-op outside profiling builds).
          <Profiler id="Transcript" onRender={recordTranscriptRender}>
            <Suspense fallback={<TranscriptChunkFallback />}>
              <TaskLiveSourceProvider source={chat.taskLiveSource}>
                <MessageList {...chat.transcript} {...transcript} />
              </TaskLiveSourceProvider>
            </Suspense>
          </Profiler>
        }
        dock={
          <>
            {dockLead}
            {composerEl}
          </>
        }
      />
    );

  return (
    <>
      {emptySurface}
      {/* A first send that echoes no prompt of its own (a review handoff) is
          still a bootstrap: the surface says so rather than sitting empty. */}
      {dockLead}
      <KeyboardInsetDock>{composerEl}</KeyboardInsetDock>
    </>
  );
}
