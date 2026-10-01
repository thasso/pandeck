import { useEffect, useRef } from "react";
import { Composer } from "../Composer.tsx";
import { MessageList } from "../MessageList.tsx";
import type { TranscriptViewPrefs } from "../transcriptView.ts";
import { useAssistant } from "../../hooks/useAssistant.ts";
import { PaneLoading } from "../ui/load.tsx";

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
export function PersonalAssistantPanel() {
  const { state, actions } = useAssistant({ isolated: true });
  const openedRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    actions.openPermanentAssistant();
  }, [actions]);

  if (!state.session)
    return <PaneLoading label="Opening Personal Assistant…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MessageList
          sessionId={state.session.sessionId}
          messages={state.messages}
          timeline={state.timeline}
          sessionStreaming={state.liveStreams.length > 0}
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
        streaming={state.liveStreams.length > 0}
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
