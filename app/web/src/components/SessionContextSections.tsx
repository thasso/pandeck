import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  ExternalLink,
  Image as ImageIcon,
  MessageSquare,
  MonitorPlay,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { approvalGrantLabel } from "@assistant/shared";
import type {
  ApprovalGrant,
  BrowserRuntimeInfo,
  PeerPromptState,
  PeerPromptThreadMessage,
  PeerPromptThreadsProjection,
  PendingPostReloadContinuation,
  SessionArtifact,
  SessionSkillInvocation,
  SessionToolExposure,
  SkillLibraryList,
} from "@assistant/shared";
import { copyWithToast } from "../lib/clipboard.ts";
import { relativeTime } from "../lib/sessionRows.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { showToast } from "../lib/toast.ts";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ImageLightbox } from "./ui/ImageLightbox.tsx";
import { ErrorNote, PaneLoading, RefreshIndicator } from "./ui/load.tsx";
import { useFetchState } from "../hooks/useFetchState.ts";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";

/**
 * @component SessionContextSections
 * @purpose The session inspector's feature content: queued post-reload
 * continuation, durable peer-prompt history, library skills (loaded /
 * available / not mounted),
 * deferred-tool exposure (the "Tools" section: loaded/available/unavailable
 * per catalog group + load trail, including the browser tool groups), the
 * session's "Approve for session" grants, browser MCP runtime, and artifacts.
 * @useWhen Rendered inside the session Inspector's children slot. Tasks,
 * workspace, and fork lineage are inspector relations, not sections here.
 * @avoidWhen Task management or long-form editing flows; use the Tasks page.
 * @intent Compact sections fed by SessionState. Section collapse state
 * persists per session via InspectorSection.
 */
interface SessionContextSectionsProps {
  sessionId?: string | undefined;
  toolExposure?: SessionToolExposure | undefined;
  /** Frozen library skill names; defined (possibly empty) for coding sessions. */
  activeSkills?: string[] | undefined;
  /** Loads of those skills' bodies, newest last. */
  skillInvocations?: SessionSkillInvocation[] | undefined;
  /** Current skills-library scan, used to show mounted and unmounted skills. */
  skillLibrary?: LoadState<SkillLibraryList> | undefined;
  artifacts?: SessionArtifact[];
  pendingPostReloadContinuation?: PendingPostReloadContinuation | undefined;
  browserRuntimes?: BrowserRuntimeInfo[];
  peerPrompts?: PeerPromptThreadsProjection | undefined;
  onExpandPeerPromptHistory?: (limit?: number) => void;
  onOpenSession?: (id: string) => void;
  /** Jump to the other party's copy of one peer-prompt message. */
  onRevealPeerPromptMessage?: (messageKey: string) => void;
  /** The message whose jump is still being resolved, if any. */
  peerPromptRevealPendingKey?: string;
  onCancelPostReloadContinuation?: () => void;
  /** Operations the user approved for the rest of this session. */
  approvalGrants?: readonly ApprovalGrant[] | undefined;
  onRevokeApprovalGrant?: (sessionId: string, key: string) => void;
}

export function SessionContextSections({
  sessionId = "current",
  toolExposure,
  activeSkills,
  skillInvocations,
  skillLibrary,
  artifacts = [],
  pendingPostReloadContinuation,
  browserRuntimes = [],
  peerPrompts,
  onExpandPeerPromptHistory,
  onOpenSession,
  onRevealPeerPromptMessage,
  peerPromptRevealPendingKey,
  onCancelPostReloadContinuation,
  approvalGrants = [],
  onRevokeApprovalGrant,
}: SessionContextSectionsProps) {
  // A fragment, not a box: these sections are siblings of the panel's other
  // sections, which is what gives them the shared separator and spacing.
  return (
    <>
      {pendingPostReloadContinuation && (
        <PostReloadContinuationCard
          continuation={pendingPostReloadContinuation}
          onCancel={onCancelPostReloadContinuation}
        />
      )}

      {peerPrompts && peerPrompts.threads.length > 0 && (
        <PeerPromptsSection
          sessionId={sessionId}
          projection={peerPrompts}
          onExpand={onExpandPeerPromptHistory}
          onOpenSession={onOpenSession}
          onRevealMessage={onRevealPeerPromptMessage}
          {...(peerPromptRevealPendingKey
            ? { revealPendingKey: peerPromptRevealPendingKey }
            : {})}
        />
      )}

      {activeSkills !== undefined && (
        <ActiveSkillsSection
          sessionId={sessionId}
          activeSkills={activeSkills}
          skillInvocations={skillInvocations}
          skillLibrary={skillLibrary}
        />
      )}

      {toolExposure && toolExposure.tools.length > 0 && (
        <ToolsSection sessionId={sessionId} exposure={toolExposure} />
      )}

      {approvalGrants.length > 0 && (
        <ApprovalGrantsSection
          sessionId={sessionId}
          grants={approvalGrants}
          onRevoke={onRevokeApprovalGrant}
        />
      )}

      <BrowserRuntimesSection
        sessionId={sessionId}
        runtimes={browserRuntimes}
      />

      {artifacts.length > 0 && (
        <ArtifactsSection sessionId={sessionId} artifacts={artifacts} />
      )}
    </>
  );
}

const PEER_PROMPT_STATE_LABEL: Record<PeerPromptState, string> = {
  queued: "Queued",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
  completed: "Completed",
  awaiting_response: "Awaiting response",
  replied: "Replied",
  retrying: "Retrying",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

/**
 * One message, as a chat bubble: the reader's own side on the right, the peer's
 * on the left, so nothing has to say "sent" or "received". The whole bubble is
 * the link to the OTHER party's copy of that message, which is the only place
 * the full text is worth reading — a real `<a href>` at the peer session, so the
 * ordinary browser gestures still work, with the precise jump on a plain click.
 */
function PeerPromptBubble({
  message,
  peerSessionId,
  busy,
  onReveal,
}: {
  message: PeerPromptThreadMessage;
  peerSessionId: string;
  busy: boolean;
  onReveal?: ((messageKey: string) => void) | undefined;
}) {
  const sent = message.direction === "sent";
  return (
    <div className={`flex ${sent ? "justify-end" : "justify-start"}`}>
      <a
        href={sessionPath(peerSessionId)}
        aria-busy={busy || undefined}
        className={`block min-w-0 max-w-[85%] rounded-xl px-2 py-1 transition-colors ${
          sent
            ? "bg-accent hover:bg-primary/15"
            : "border border-line bg-panel/60 hover:bg-surface"
        } ${busy ? "opacity-60" : ""}`}
        onClick={(event) => {
          if (
            !onReveal ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          onReveal(message.id);
        }}
      >
        {/* Already an excerpt when it arrives (`peerPromptExcerpt`): the full
            message is never on the wire, and truncating again here would only
            add a second ellipsis. */}
        <p className="line-clamp-2 break-words text-caption text-fg">
          {message.message}
        </p>
        <p className="mt-0.5 text-micro text-muted-foreground">
          {PEER_PROMPT_STATE_LABEL[message.state]} ·{" "}
          {relativeTime(message.createdAt)}
        </p>
        {message.failureReason ? (
          // The only detail kept: a failed message whose reason lived nowhere
          // else in the UI would show a state word and no way to understand it.
          <p className="mt-0.5 line-clamp-2 break-words text-micro text-danger">
            {message.failureReason}
          </p>
        ) : null}
      </a>
    </div>
  );
}

/**
 * Durable peer-prompt history, read as conversations rather than as records:
 * one flat thread per peer, its name linking to that session and each bubble to
 * the message itself over there. Collapsed by default — it is reference
 * material about work that already happened, not something to scan every visit.
 */
export function PeerPromptsSection({
  sessionId,
  projection,
  onExpand,
  onOpenSession,
  onRevealMessage,
  revealPendingKey,
}: {
  sessionId: string;
  projection: PeerPromptThreadsProjection;
  onExpand?: ((limit?: number) => void) | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
  onRevealMessage?: ((messageKey: string) => void) | undefined;
  revealPendingKey?: string;
}) {
  const messageCount = projection.threads.reduce(
    (n, t) => n + t.messages.length,
    0,
  );
  return (
    <InspectorSection
      id="peer-prompts"
      storageScope={`session:${sessionId}`}
      title="Peer prompts"
      icon={<MessageSquare size={13} />}
      defaultOpen={false}
      summary={`${projection.threads.length} thread${projection.threads.length === 1 ? "" : "s"} · ${messageCount} message${messageCount === 1 ? "" : "s"}`}
    >
      <div className="space-y-3">
        {projection.threads.map((thread) => (
          <div
            key={thread.conversationId}
            className="space-y-1 border-t border-line pt-2.5 first:border-t-0 first:pt-0"
          >
            <div className="flex items-baseline gap-2">
              <a
                href={sessionPath(thread.peerSessionId)}
                title={thread.otherPartyTitle}
                className="min-w-0 truncate text-caption font-medium text-fg underline decoration-dotted underline-offset-2 hover:decoration-solid"
                onClick={(event) => {
                  if (
                    !onOpenSession ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpenSession(thread.peerSessionId);
                }}
              >
                {thread.otherPartyTitle}
              </a>
              <span className="ml-auto shrink-0 text-micro text-faint">
                {relativeTime(
                  thread.messages[thread.messages.length - 1]?.createdAt ?? 0,
                )}
              </span>
            </div>
            {thread.messages.map((message) => (
              <PeerPromptBubble
                key={message.id}
                message={message}
                peerSessionId={thread.peerSessionId}
                busy={revealPendingKey === message.id}
                onReveal={onRevealMessage}
              />
            ))}
          </div>
        ))}
        {projection.truncated ? (
          onExpand ? (
            <button
              type="button"
              onClick={() => onExpand()}
              className="w-full rounded-lg border border-line px-2 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface hover:text-fg"
            >
              Load more history
            </button>
          ) : (
            <p className="text-micro text-faint">
              Older peer prompts are not shown.
            </p>
          )
        ) : null}
      </div>
    </InspectorSection>
  );
}

function PostReloadContinuationCard({
  continuation,
  onCancel,
}: {
  continuation: PendingPostReloadContinuation;
  onCancel?: (() => void) | undefined;
}) {
  return (
    <section className="rounded-xl border border-primary/30 bg-accent p-3 text-caption text-primary">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">Post-reload continuation queued</h3>
          <p className="mt-1 line-clamp-3 text-caption">
            {continuation.message}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={!onCancel}
          className="rounded-md border border-primary/30 px-2 py-1 text-caption transition-colors hover:bg-primary/10 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * Library skills for this coding session, in three states: mounted AND loaded
 * (the agent pulled the body in through a Skill call or SKILL.md read),
 * mounted but only available (name + description in context), or not mounted.
 */
export function ActiveSkillsSection({
  sessionId,
  activeSkills,
  skillInvocations = [],
  skillLibrary,
}: {
  sessionId: string;
  /** Skills frozen into this session when it started. */
  activeSkills: string[];
  /** Newest-last loads of those skills' bodies. */
  skillInvocations?: SessionSkillInvocation[] | undefined;
  /** Current library scan, used to show mounted and unmounted skills. */
  skillLibrary?: LoadState<SkillLibraryList> | undefined;
}) {
  const library = skillLibrary ? dataOf(skillLibrary) : undefined;
  const libraryError = skillLibrary ? errorOf(skillLibrary) : undefined;
  const libraryPending = skillLibrary ? isPending(skillLibrary) : false;
  const initialLibraryLoad =
    skillLibrary?.status === "loading" && library === undefined;
  const mounted = useMemo(() => new Set(activeSkills), [activeSkills]);
  const loads = useMemo(() => {
    const byName = new Map<
      string,
      { count: number; last: SessionSkillInvocation }
    >();
    for (const invocation of skillInvocations) {
      const entry = byName.get(invocation.name);
      if (entry) {
        entry.count += 1;
        entry.last = invocation;
      } else byName.set(invocation.name, { count: 1, last: invocation });
    }
    return byName;
  }, [skillInvocations]);
  const skills = useMemo(() => {
    const names = new Set([
      ...(library?.skills.map((skill) => skill.name) ?? []),
      ...activeSkills,
    ]);
    const rank = (name: string) =>
      loads.has(name) ? 0 : mounted.has(name) ? 1 : 2;
    return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [activeSkills, library, loads, mounted]);
  const loadedCount = activeSkills.filter((name) => loads.has(name)).length;
  const hasLibraryAnswer =
    skillLibrary !== undefined && skillLibrary.status !== "idle";
  const available = hasLibraryAnswer
    ? `${activeSkills.length}/${skills.length} available`
    : activeSkills.length === 0
      ? "None available"
      : `${activeSkills.length} available`;

  return (
    <InspectorSection
      id="active-skills"
      storageScope={`session:${sessionId}`}
      title="Skills"
      icon={<Sparkles size={13} />}
      summary={
        initialLibraryLoad
          ? "Loading…"
          : libraryError && library === undefined
            ? "Unavailable"
            : loadedCount > 0
              ? `${loadedCount} loaded · ${available}`
              : available
      }
      defaultOpen={activeSkills.length > 0}
    >
      {libraryPending && library === undefined ? (
        <PaneLoading label="Loading skills…" />
      ) : null}
      {libraryError ? (
        <ErrorNote
          {...(skills.length > 0 ? { className: "mb-2" } : {})}
          message={libraryError}
        />
      ) : null}
      {skillLibrary?.status === "refreshing" ? (
        <RefreshIndicator label="Refreshing skills" />
      ) : null}
      {skills.length > 0 ? (
        <ul className="space-y-1" aria-label="Session skills">
          {skills.map((name) => {
            const load = loads.get(name);
            const state = load
              ? "Loaded"
              : mounted.has(name)
                ? "Available"
                : "Not mounted";
            const detail = load
              ? `${load.count > 1 ? `×${load.count} · ` : ""}${SKILL_LOAD_VIA[load.last.via]} ${new Date(load.last.at).toLocaleTimeString()}`
              : undefined;
            return (
              <li
                key={name}
                aria-label={`${name}: ${state}`}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5"
              >
                <span
                  title={SKILL_STATE_TITLE[state]}
                  className={`size-2 shrink-0 rounded-full ${
                    load
                      ? "bg-emerald-500"
                      : mounted.has(name)
                        ? "border border-emerald-500"
                        : "bg-line-strong"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
                  {name}
                </span>
                <span className="shrink-0 text-micro text-faint">
                  {detail ?? state}
                </span>
              </li>
            );
          })}
        </ul>
      ) : !libraryPending && !libraryError ? (
        <p className="text-caption text-muted-foreground">
          No library skills were available when this session started.
        </p>
      ) : null}
    </InspectorSection>
  );
}

const SKILL_STATE_TITLE = {
  Loaded: "Body loaded into the model context",
  Available: "Mounted: only the name and description are in context",
  "Not mounted": "Not mounted for this session",
} as const;

const SKILL_LOAD_VIA: Record<SessionSkillInvocation["via"], string> = {
  skill_tool: "Skill tool",
  read: "read",
};

/**
 * Deferred-tool visibility: which catalog tool groups exist for this session,
 * which tools are usable (gates/approval), and which definitions are LOADED
 * into the model context right now — plus the recent load trail.
 */
function ToolsSection({
  sessionId,
  exposure,
}: {
  sessionId: string;
  exposure: SessionToolExposure;
}) {
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string;
        label: string;
        loading: "eager" | "deferred";
        tools: SessionToolExposure["tools"];
      }
    >();
    for (const tool of exposure.tools) {
      let group = byId.get(tool.group);
      if (!group) {
        group = {
          id: tool.group,
          label: tool.groupLabel,
          loading: tool.loading,
          tools: [],
        };
        byId.set(tool.group, group);
      }
      group.tools.push(tool);
    }
    // Eager groups first, then by label.
    return [...byId.values()].sort((a, b) =>
      a.loading === b.loading
        ? a.label.localeCompare(b.label)
        : a.loading === "eager"
          ? -1
          : 1,
    );
  }, [exposure.tools]);
  const recentLoads = exposure.loadEvents.slice(-3).reverse();
  return (
    <InspectorSection
      id="tools"
      storageScope={`session:${sessionId}`}
      title="Tools"
      defaultOpen={false}
      icon={<Wrench size={13} />}
      summary={`${exposure.counts.loaded}/${exposure.counts.total} in context · ${exposure.counts.loadedButUnused} unused`}
    >
      <div className="space-y-1">
        {groups.map((group) => {
          const expanded = expandedGroupId === group.id;
          const loaded = group.tools.filter((tool) => tool.loaded).length;
          const usable = group.tools.filter((tool) => tool.usable).length;
          return (
            <div
              key={group.id}
              className="rounded-xl border border-line bg-surface"
            >
              <button
                type="button"
                onClick={() => setExpandedGroupId(expanded ? null : group.id)}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div
                  title={
                    loaded > 0
                      ? "Loaded into the model context"
                      : usable > 0
                        ? "Available (loads on demand)"
                        : "Unavailable"
                  }
                  className={`size-2 shrink-0 rounded-full ${loaded > 0 ? "bg-emerald-500" : usable > 0 ? "bg-line-strong" : "bg-danger/40"}`}
                />
                <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
                  {group.label}
                </span>
                <span className="shrink-0 text-micro tabular-nums text-faint">
                  {loaded}/{group.tools.length}
                </span>
              </button>
              {expanded && (
                <div className="flex flex-wrap gap-1 border-t border-line px-2.5 py-2">
                  {group.tools.map((tool) => (
                    <span
                      key={tool.name}
                      title={`${tool.loaded ? "Loaded" : tool.usable ? "Loads on demand" : "Unavailable"} · ${tool.used ? "called" : "not called"} · ${tool.definitionChars.toLocaleString()} definition chars${tool.tokens ? ` · ~${tool.tokens} tokens` : ""}`}
                      className={`rounded-md border px-1.5 py-0.5 font-mono text-micro ${
                        tool.loaded
                          ? "border-emerald-500/40 bg-emerald-500/10 text-fg"
                          : tool.usable
                            ? "border-line text-muted-foreground"
                            : "border-line text-faint line-through"
                      }`}
                    >
                      {tool.name}
                      {tool.loaded && !tool.used ? " · unused" : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {exposure.counts.loadedButUnused > 0 && (
        <p className="mt-2 px-0.5 text-micro text-faint">
          {exposure.counts.loadedButUnused} loaded but unused ·{" "}
          {exposure.counts.loadedButUnusedDefinitionChars.toLocaleString()}{" "}
          definition chars
        </p>
      )}
      {recentLoads.length > 0 && (
        <div className="mt-2 space-y-0.5 px-0.5">
          {recentLoads.map((event) => (
            <p
              key={`${event.at}-${event.via}`}
              className="truncate text-micro text-faint"
              title={event.names.join(", ")}
            >
              {new Date(event.at).toLocaleTimeString()} ·{" "}
              {event.via.replace("_", " ")} loaded{" "}
              {event.names.length === 1
                ? event.names[0]
                : `${event.names.length} tools`}
            </p>
          ))}
        </div>
      )}
    </InspectorSection>
  );
}

/** Operations that run without a click for the rest of this session. */
function ApprovalGrantsSection({
  sessionId,
  grants,
  onRevoke,
}: {
  sessionId: string;
  grants: readonly ApprovalGrant[];
  onRevoke?: ((sessionId: string, key: string) => void) | undefined;
}) {
  return (
    <InspectorSection
      id="approval-grants"
      storageScope={`session:${sessionId}`}
      title="Approved for session"
      icon={<ShieldCheck size={13} />}
      summary={`${grants.length} operation${grants.length === 1 ? "" : "s"}`}
      defaultOpen
    >
      <ul className="space-y-1">
        {grants.map((grant) => (
          <li
            key={grant.key}
            className="flex items-center gap-2 text-caption text-fg"
          >
            <span className="min-w-0 flex-1 truncate">
              {approvalGrantLabel(grant.key)}
            </span>
            <span className="shrink-0 text-micro text-faint">
              {relativeTime(grant.grantedAt)}
            </span>
            {onRevoke && (
              <button
                type="button"
                onClick={() => onRevoke(sessionId, grant.key)}
                className="shrink-0 rounded px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-surface hover:text-fg"
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

function BrowserRuntimesSection({
  sessionId,
  runtimes,
}: {
  sessionId: string;
  runtimes: BrowserRuntimeInfo[];
}) {
  const runtime = runtimes.find((item) => item.connectedToCurrentSession);
  if (!runtime) return null;
  return (
    <InspectorSection
      id="browser-mcp"
      storageScope={`session:${sessionId}`}
      title="Browser MCP"
      icon={<MonitorPlay size={13} />}
      summary={runtime.status}
      defaultOpen={runtime.status === "error"}
    >
      <div className="rounded-xl border border-line bg-surface p-2.5">
        <div className="flex items-center gap-2">
          <div
            className={`size-2.5 shrink-0 rounded-full ${runtime.status === "running" ? "bg-emerald-500" : runtime.status === "starting" ? "bg-primary" : runtime.status === "error" ? "bg-danger" : "bg-line-strong"}`}
          />
          <p className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
            Playwright MCP
          </p>
          <span
            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-micro ${runtime.agentStatus === "running" ? "border-primary/30 text-primary" : "border-line text-faint"}`}
          >
            agent {runtime.agentStatus}
          </span>
        </div>
        {runtime.error && (
          <p className="mt-1.5 line-clamp-2 text-caption text-danger">
            {runtime.error}
          </p>
        )}
      </div>
    </InspectorSection>
  );
}

function ArtifactsSection({
  sessionId,
  artifacts,
}: {
  sessionId: string;
  artifacts: SessionArtifact[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    artifacts[0]?.id ?? null,
  );
  const selected = useMemo(
    () =>
      artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0],
    [artifacts, selectedId],
  );
  const copy = async (text: string) => {
    await copyWithToast(text, { successMessage: "Copied URL to clipboard" });
  };
  const copyImage = async (artifact: SessionArtifact) => {
    const url = artifactHttpUrl(artifact.url);
    if (window.isSecureContext && navigator.clipboard?.write) {
      try {
        const blob = await fetch(url).then((r) => r.blob());
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
        showToast("Copied image to clipboard", { tone: "success" });
        return;
      } catch {
        // Fall back to copying the URL below.
      }
    }
    await copy(url);
  };

  useEffect(() => {
    if (selected && artifacts.some((artifact) => artifact.id === selected.id))
      return;
    setSelectedId(artifacts[0]?.id ?? null);
  }, [artifacts, selected]);

  return (
    <InspectorSection
      id="artifacts"
      storageScope={`session:${sessionId}`}
      title="Artifacts"
      icon={<ImageIcon size={13} />}
      summary={`${artifacts.length}`}
      defaultOpen={false}
    >
      <div className="grid grid-cols-2 gap-2">
        {artifacts.slice(0, 12).map((artifact) => {
          const url = artifactHttpUrl(artifact.url);
          const active = artifact.id === selected?.id;
          return (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setSelectedId(artifact.id)}
              className={`overflow-hidden rounded-xl border bg-surface text-left transition-colors ${active ? "border-primary/50 ring-1 ring-primary/30" : "border-line hover:border-line-strong"}`}
            >
              {artifact.mimeType.startsWith("image/") ? (
                <img
                  src={url}
                  alt={artifact.label}
                  className="h-24 w-full object-cover"
                />
              ) : (
                <div className="flex h-24 items-center justify-center bg-panel text-muted-foreground">
                  <ImageIcon size={22} />
                </div>
              )}
              <div className="p-2">
                <p
                  className="truncate text-caption font-medium text-fg"
                  title={artifact.label}
                >
                  {artifact.label}
                </p>
                <p className="truncate text-micro text-faint">
                  {artifact.name}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <ArtifactPreview
          artifact={selected}
          onCopyUrl={() => void copy(artifactHttpUrl(selected.url))}
          onCopyImage={() => void copyImage(selected)}
        />
      )}
    </InspectorSection>
  );
}

function ArtifactPreview({
  artifact,
  onCopyUrl,
  onCopyImage,
}: {
  artifact: SessionArtifact;
  onCopyUrl: () => void;
  onCopyImage: () => void;
}) {
  const url = artifactHttpUrl(artifact.url);
  const textLike = isTextLikeArtifact(artifact);
  const [enlarged, setEnlarged] = useState(false);
  // Keyed by the artifact's URL: selecting another artifact is a different
  // object, so its body may never appear under this one's header (R3).
  const { state, reload } = useFetchState(url, fetchArtifactText, {
    enabled: textLike,
  });
  const text = dataOf(state);
  const error = errorOf(state);

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-line p-2.5">
        <div className="min-w-0">
          <p
            className="truncate text-caption font-medium text-fg"
            title={artifact.label}
          >
            {artifact.label}
          </p>
          <p className="truncate text-micro text-faint" title={artifact.name}>
            {artifact.name}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onCopyUrl}
            title="Copy artifact URL"
            className="rounded-md p-1 text-muted-foreground hover:bg-raised hover:text-fg"
          >
            <Clipboard size={12} />
          </button>
          {artifact.mimeType.startsWith("image/") && (
            <button
              type="button"
              onClick={onCopyImage}
              title="Copy image"
              className="rounded-md p-1 text-muted-foreground hover:bg-raised hover:text-fg"
            >
              <ImageIcon size={12} />
            </button>
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open artifact"
            className="rounded-md p-1 text-muted-foreground hover:bg-raised hover:text-fg"
          >
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
      {artifact.mimeType.startsWith("image/") ? (
        <>
          <button
            type="button"
            onClick={() => setEnlarged(true)}
            title="Click to enlarge"
            aria-label={`Enlarge ${artifact.label}`}
            className="block w-full cursor-zoom-in"
          >
            <img
              src={url}
              alt={artifact.label}
              className="max-h-72 w-full bg-panel object-contain"
            />
          </button>
          {enlarged ? (
            <ImageLightbox
              src={url}
              alt={artifact.label}
              caption={artifact.name}
              onClose={() => setEnlarged(false)}
            />
          ) : null}
        </>
      ) : textLike ? (
        // The three states this preview can be in, said out loud: it used to
        // render an empty box until the body landed, which reads as an empty
        // artifact rather than as a fetch.
        error !== undefined ? (
          <ErrorNote
            className="m-2.5"
            message={`Could not load this artifact: ${error}`}
            onRetry={reload}
          />
        ) : text === undefined ? (
          <PaneLoading className="py-8" label="Loading preview…" />
        ) : (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-micro text-muted-foreground">
            {text}
          </pre>
        )
      ) : (
        <div className="p-3 text-caption text-muted-foreground">
          No inline preview for this artifact type. Open it in a new tab to
          inspect it.
        </div>
      )}
    </div>
  );
}

async function fetchArtifactText(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  return body.length > 8000 ? `${body.slice(0, 8000)}\n… truncated …` : body;
}

function isTextLikeArtifact(artifact: SessionArtifact): boolean {
  return (
    /^(text\/|application\/(json|xml|yaml|x-yaml))/i.test(artifact.mimeType) ||
    /\.(txt|log|json|jsonl|ya?ml|md)$/i.test(artifact.name)
  );
}
