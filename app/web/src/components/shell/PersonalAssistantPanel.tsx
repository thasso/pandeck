import { useEffect } from "react";
import { Composer } from "../Composer.tsx";
import { MessageList } from "../MessageList.tsx";
import type { TranscriptViewPrefs } from "../transcriptView.ts";
import { useAssistant } from "../../hooks/useAssistant.ts";
import { PaneLoading } from "../common/load.tsx";

const PANEL_TRANSCRIPT_VIEW: TranscriptViewPrefs = {
  showThinking: false,
  showTools: true,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: true,
};

/**
 * @component PersonalAssistantPanel
 * @purpose An independent connection and compact chat surface for the permanent
 * Personal Assistant, usable beside rather than in place of the routed session.
 * @useWhen Mounted by the desktop right-panel tab host.
 * @avoidWhen Rendering `/assistant`; that route keeps the full main-column chat.
 */
export function PersonalAssistantPanel({
  visible = true,
}: {
  visible?: boolean;
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
      actions.releasePermanentAssistant(sessionId);
  }, [visible, state.connected, sessionId, actions]);

  if (!state.session)
    return <PaneLoading label="Opening Personal Assistant…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MessageList
          sessionId={state.session.sessionId}
          messages={state.messages}
          timeline={state.timeline}
          sessionStreaming={state.streaming}
          runProgress={state.runProgress}
          queuedPeerCount={state.session.queuedPeerPrompts?.length ?? 0}
          queuedBackgroundCount={state.session.queuedBackgroundUpdates ?? 0}
          appearance={state.settings.appearance}
          sessions={state.sessions}
          view={PANEL_TRANSCRIPT_VIEW}
          models={state.models}
          defaultModel={state.session.model}
          defaultThinkingLevel={state.session.thinkingLevel}
          onLoadTimelineBlock={actions.loadTimelineBlock}
          onLiveBodyDemand={actions.setLiveBodyDemand}
          hasOlderMessages={state.timelineStart > 0}
          loadingOlderMessages={state.timelineRangePending !== null}
          onLoadOlderMessages={actions.loadOlderTimeline}
        />
      </div>
      <Composer
        onSend={actions.prompt}
        onAbort={actions.abort}
        streaming={state.streaming}
        disabled={!state.connected}
        contextInfo={state.contextInfo}
        session={state.session}
        models={state.models}
        slashCommands={state.slashCommands}
        actions={actions}
        draftStorageKey="assistant.personal-assistant-panel-draft.v1"
        hideRuntimeControls
      />
    </div>
  );
}
