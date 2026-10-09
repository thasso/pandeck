import { useMemo, useState } from "react";
import {
  Activity,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  MessageSquare,
  MonitorPlay,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
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
import { relativeTime } from "../lib/sessionRows.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { formatFileSize } from "../lib/servedFiles.ts";
import { parseDocumentTarget } from "@assistant/shared/documentTargets";
import { ArtifactOverlay } from "./ArtifactOverlay.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ErrorNote, PaneLoading, RefreshIndicator } from "./common/load.tsx";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
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
        className={`block min-w-0 max-w-5/6 rounded-xl px-2 py-1 transition-colors ${
          sent
            ? "bg-accent hover:bg-primary/15"
            : "border border-border bg-card/60 hover:bg-background"
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
        <p className="line-clamp-2 break-words text-sm text-foreground">
          {message.message}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {PEER_PROMPT_STATE_LABEL[message.state]} ·{" "}
          {relativeTime(message.createdAt)}
        </p>
        {message.failureReason ? (
          // The only detail kept: a failed message whose reason lived nowhere
          // else in the UI would show a state word and no way to understand it.
          <p className="mt-0.5 line-clamp-2 break-words text-xs text-destructive">
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
            className="space-y-1 border-t border-border pt-2.5 first:border-t-0 first:pt-0"
          >
            <div className="flex items-baseline gap-2">
              <a
                href={sessionPath(thread.peerSessionId)}
                title={thread.otherPartyTitle}
                className="min-w-0 truncate text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
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
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => onExpand()}
              className="w-full"
            >
              Load more history
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
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
    <Alert role="status">
      <AlertTitle>Post-reload continuation queued</AlertTitle>
      <AlertDescription className="line-clamp-3">
        {continuation.message}
      </AlertDescription>
      <AlertAction>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={!onCancel}
        >
          Cancel
        </Button>
      </AlertAction>
    </Alert>
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
        // Plain rows, as the panel's other lists: the state is the small
        // circle in front of the name, not a chip — filled once the body is
        // loaded, an outline while only its name and description are in
        // context, dashed when it is not mounted at all. Only a loaded skill
        // says more on its line (how often, when); the rest is the tooltip.
        <ul className="flex flex-col" aria-label="Session skills">
          {skills.map((name) => {
            const load = loads.get(name);
            const state: SkillState = load
              ? "Loaded"
              : mounted.has(name)
                ? "Available"
                : "Not mounted";
            const title = load
              ? `${SKILL_STATE_TITLE[state]} — ${load.count > 1 ? `${load.count} times, last ` : ""}via ${SKILL_LOAD_VIA[load.last.via]} at ${new Date(load.last.at).toLocaleTimeString()}`
              : SKILL_STATE_TITLE[state];
            return (
              <li
                key={name}
                aria-label={`${name}: ${state}`}
                title={title}
                className="flex min-h-7 min-w-0 items-center gap-2 px-1 text-sm"
              >
                {/* An 8px dot in the 14px glyph column: filled once loaded,
                    a ring while only available, a faint ring when not
                    mounted. */}
                <span
                  aria-hidden
                  className="flex size-3.5 shrink-0 items-center justify-center"
                >
                  <span
                    className={`size-2 rounded-full ${SKILL_STATE_DOT[state]}`}
                  />
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${state === "Not mounted" ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {name}
                </span>
                {load ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {load.count > 1 ? `×${load.count} · ` : ""}
                    {new Date(load.last.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !libraryPending && !libraryError ? (
        <p className="text-sm text-muted-foreground">
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

type SkillState = keyof typeof SKILL_STATE_TITLE;

const SKILL_STATE_DOT: Record<SkillState, string> = {
  Loaded: "bg-success",
  Available: "border border-muted-foreground",
  "Not mounted": "border border-muted-foreground/40",
};

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
      <Accordion>
        {groups.map((group) => {
          const loaded = group.tools.filter((tool) => tool.loaded).length;
          const usable = group.tools.filter((tool) => tool.usable).length;
          return (
            <AccordionItem key={group.id} value={group.id}>
              <AccordionTrigger className="items-center gap-2">
                <Badge
                  variant={
                    loaded > 0
                      ? "success"
                      : usable > 0
                        ? "outline"
                        : "destructive"
                  }
                  title={
                    loaded > 0
                      ? "Loaded into the model context"
                      : usable > 0
                        ? "Available (loads on demand)"
                        : "Unavailable"
                  }
                  className="tabular-nums"
                >
                  {loaded}/{group.tools.length}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
              </AccordionTrigger>
              <AccordionContent className="flex flex-wrap gap-1">
                {group.tools.map((tool) => (
                  <Badge
                    key={tool.name}
                    variant={tool.loaded ? "success" : "outline"}
                    title={`${tool.loaded ? "Loaded" : tool.usable ? "Loads on demand" : "Unavailable"} · ${tool.used ? "called" : "not called"} · ${tool.definitionChars.toLocaleString()} definition chars${tool.tokens ? ` · ~${tool.tokens} tokens` : ""}`}
                    className={`font-mono ${tool.loaded || tool.usable ? "" : "line-through"}`}
                  >
                    {tool.name}
                    {tool.loaded && !tool.used ? " · unused" : ""}
                  </Badge>
                ))}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      {exposure.counts.loadedButUnused > 0 && (
        <p className="mt-2 px-0.5 text-xs text-muted-foreground">
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
              className="truncate text-xs text-muted-foreground"
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
            className="flex items-center gap-2 text-sm text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              {approvalGrantLabel(grant.key)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {relativeTime(grant.grantedAt)}
            </span>
            {onRevoke && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onRevoke(sessionId, grant.key)}
              >
                Revoke
              </Button>
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
      <Item variant="outline" size="xs">
        <ItemContent className="min-w-0">
          <ItemTitle>
            Playwright MCP
            <Badge
              variant={
                runtime.status === "running"
                  ? "success"
                  : runtime.status === "error"
                    ? "destructive"
                    : "secondary"
              }
            >
              {runtime.status}
            </Badge>
          </ItemTitle>
          {runtime.error ? (
            <ItemDescription className="text-destructive">
              {runtime.error}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <Badge
            variant={
              runtime.agentStatus === "running" ? "secondary" : "outline"
            }
          >
            agent {runtime.agentStatus}
          </Badge>
        </ItemActions>
      </Item>
    </InspectorSection>
  );
}

/**
 * The session's artifacts as a plain list, newest first: a thumbnail where the
 * artifact is an image (its kind's glyph otherwise), the label, and the file
 * name, age and size. A row opens the artifact full screen over the app
 * (`ArtifactOverlay`), in the same viewer the artifact route uses.
 */
function ArtifactsSection({
  sessionId,
  artifacts,
}: {
  sessionId: string;
  artifacts: SessionArtifact[];
}) {
  const [opened, setOpened] = useState<{
    sessionId: string;
    path: string;
    label: string;
  } | null>(null);
  const newestFirst = useMemo(
    () => [...artifacts].sort((a, b) => b.createdAt - a.createdAt),
    [artifacts],
  );
  return (
    <InspectorSection
      id="artifacts"
      storageScope={`session:${sessionId}`}
      title="Artifacts"
      icon={<ImageIcon size={13} />}
      summary={`${artifacts.length}`}
      defaultOpen={false}
    >
      <ul className="flex flex-col" aria-label="Session artifacts">
        {newestFirst.map((artifact) => {
          const target = parseDocumentTarget(artifact.url);
          const path =
            target?.kind === "sessionArtifact" ? target.path : undefined;
          const KindIcon = ARTIFACT_KIND_ICON[artifact.kind];
          return (
            <li key={artifact.id}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 px-1 py-1.5 text-left font-normal"
                title={`${artifact.label} — ${artifact.name}`}
                disabled={!path}
                onClick={() =>
                  path &&
                  setOpened({
                    sessionId: artifact.sessionId,
                    path,
                    label: artifact.label,
                  })
                }
              >
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                  {artifact.mimeType.startsWith("image/") ? (
                    <img
                      src={artifactHttpUrl(artifact.url)}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <KindIcon size={16} aria-hidden />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">
                    {artifact.label}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {artifact.name} · {relativeTime(artifact.createdAt)} ·{" "}
                    {formatFileSize(artifact.size)}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      {opened ? (
        <ArtifactOverlay
          sessionId={opened.sessionId}
          path={opened.path}
          label={opened.label}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </InspectorSection>
  );
}

const ARTIFACT_KIND_ICON: Record<SessionArtifact["kind"], LucideIcon> = {
  screenshot: ImageIcon,
  trace: Activity,
  video: Film,
  download: Download,
  file: FileText,
};
