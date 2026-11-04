import { ChevronsUpDown } from "lucide-react";
import { memo, useEffect, useMemo } from "react";
import { useAssistant } from "../../hooks/useAssistant.ts";
import type { SessionChatHost } from "../../hooks/useSessionChat.tsx";
import { useSessionStorageState } from "../../hooks/useSessionStorageState.ts";
import { EmptyBox, PaneLoading } from "../common/load.tsx";
import { SearchPicker } from "../common/SearchPicker.tsx";
import { sessionHeaderIcon } from "../PageHeader.tsx";
import { UnavailableSessionPanel } from "../SessionStage.tsx";
import { Button } from "../ui/button.tsx";
import { PanelChatHeader, PanelSessionChat } from "./PanelSessionChat.tsx";

const SESSION_STORAGE_KEY = "assistant.right-panel-session.v1";

function decodeSessionId(raw: string): string | null {
  return raw || null;
}

function encodeSessionId(value: string | null): string {
  return value ?? "";
}

/**
 * Which session the panel shows: panel state, kept with the tabs in
 * `sessionStorage`. The app holds it so a request survives the tab being shut.
 */
export function useSessionPanelTarget() {
  return useSessionStorageState<string | null>(
    SESSION_STORAGE_KEY,
    null,
    decodeSessionId,
    encodeSessionId,
  );
}

/** Its own draft: two composers on one key would overwrite each other. */
function panelDraftStorageKey(sessionId: string): string {
  return `assistant.composerDraft.panel:${sessionId}`;
}

/**
 * @component SessionPanel
 * @purpose Any session, beside whatever the main pane shows, on a connection of
 * its own.
 * @useWhen Mounted by the desktop right-panel tab host.
 * @avoidWhen Showing the routed session's own chat; that is the main pane's.
 * @intent The server binds one viewed session per connection, so a second
 * session needs a second connection. Which session it shows is panel state: the
 * address bar keeps naming the main pane's object.
 */
export const SessionPanel = memo(function SessionPanel({
  visible = true,
  host,
  sessionId,
  onSelectSession,
}: {
  visible?: boolean;
  host: SessionChatHost;
  sessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const { state, actions } = useAssistant({ isolated: true });

  useEffect(() => {
    if (visible && state.connected && sessionId) actions.loadSession(sessionId);
  }, [visible, state.connected, sessionId, actions]);

  // Viewing is what marks a session read, so a hidden panel must not keep its
  // view. The transcript stays, and the next show asks only for the delta.
  useEffect(() => {
    if (!visible && state.connected && sessionId)
      actions.releaseSessionView(sessionId);
  }, [visible, state.connected, sessionId, actions]);

  // A new draft is created on this connection, which is now viewing it, so the
  // panel goes with it. Only that: a draft staged in place names this session.
  const draftSessionId = state.forkDraft?.sessionId;
  const draftToken = state.forkDraft?.token;
  useEffect(() => {
    if (draftToken !== undefined && draftSessionId)
      onSelectSession(draftSessionId);
  }, [draftToken, draftSessionId, onSelectSession]);

  const items = useMemo(
    () =>
      host.sessions
        .filter((session) => !session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => {
          const title = session.title.trim() || "Untitled session";
          return {
            id: session.id,
            search: `${title} ${session.id}`,
            icon: sessionHeaderIcon("session", {
              harness: session.harness ?? "pi",
              agentType: session.agentType ?? "assistant",
            }).icon,
            label: <span className="truncate">{title}</span>,
            current: session.id === sessionId,
          };
        }),
    [host.sessions, sessionId],
  );
  const row = host.sessions.find((session) => session.id === sessionId);
  const title = row?.title.trim() || "Untitled session";
  const picker = (
    <SearchPicker
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start"
          aria-label="Switch session"
          title="Switch session"
        />
      }
      groups={[items]}
      placeholder="Filter sessions…"
      onSelect={onSelectSession}
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {sessionId ? title : "Choose a session"}
      </span>
      <ChevronsUpDown />
    </SearchPicker>
  );

  if (!sessionId)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelChatHeader title={picker} />
        <EmptyBox className="m-3">
          Choose a session to keep it open beside the main pane.
        </EmptyBox>
      </div>
    );

  const unavailable = state.unopenableSessions[sessionId];
  const session = state.session?.sessionId === sessionId ? state.session : null;
  if (!session)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelChatHeader title={picker} />
        {unavailable ? (
          <UnavailableSessionPanel title={title} message={unavailable} />
        ) : (
          <PaneLoading label="Opening session…" />
        )}
      </div>
    );

  return (
    <PanelSessionChat
      state={state}
      actions={actions}
      session={session}
      host={host}
      visible={visible}
      draftStorageKey={panelDraftStorageKey(sessionId)}
      title={picker}
      onOpenInMain={() => host.onOpenSession(sessionId)}
    />
  );
});
