import { memo, useEffect } from "react";
import { useAssistant } from "../../hooks/useAssistant.ts";
import type { SessionChatHost } from "../../hooks/useSessionChat.tsx";
import { PERMANENT_ASSISTANT_PATH } from "../../hooks/useSessionRouting.ts";
import { PaneLoading } from "../common/load.tsx";
import { PanelSessionChat } from "./PanelSessionChat.tsx";

/**
 * @component PersonalAssistantPanel
 * @purpose An independent connection to the permanent Personal Assistant, usable
 * beside rather than in place of the routed session.
 * @useWhen Mounted by the desktop right-panel tab host.
 * @avoidWhen Rendering `/assistant`; that route keeps the full main-column chat.
 */
export const PersonalAssistantPanel = memo(function PersonalAssistantPanel({
  visible = true,
  host,
}: {
  visible?: boolean;
  host: SessionChatHost;
}) {
  const { state, actions } = useAssistant({ isolated: true });
  const sessionId = state.session?.sessionId;

  useEffect(() => {
    if (visible && state.connected) actions.openPermanentAssistant();
  }, [visible, state.connected, actions]);

  useEffect(() => {
    // A pending open can finish after the panel was hidden. Release it as
    // soon as its id arrives, without discarding the retained transcript.
    if (!visible && state.connected && sessionId)
      actions.releaseSessionView(sessionId);
  }, [visible, state.connected, sessionId, actions]);

  if (!state.session)
    return <PaneLoading label="Opening Personal Assistant…" />;

  return (
    <PanelSessionChat
      state={state}
      actions={actions}
      session={state.session}
      host={host}
      visible={visible}
      draftStorageKey="assistant.personal-assistant-panel-draft.v1"
      title={
        <span className="block truncate px-2 text-sm font-medium">
          Personal Assistant
        </span>
      }
      onOpenInMain={() => host.onNavigate(PERMANENT_ASSISTANT_PATH)}
      pinned
    />
  );
});
