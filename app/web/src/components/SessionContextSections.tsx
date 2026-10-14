import { useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  MonitorPlay,
  Lock,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { approvalGrantLabel, GRANTABLE_OPERATIONS } from "@assistant/shared";
import { useDialogs } from "./common/dialogs.tsx";
import type {
  ApprovalGrant,
  BrowserRuntimeInfo,
  PendingPostReloadContinuation,
  SessionAgentSummary,
  SessionArtifact,
  SessionSkillInvocation,
  SessionToolExposure,
  EntryLibraryList,
} from "@assistant/shared";
import { relativeTime } from "../lib/sessionRows.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { formatFileSize } from "../lib/servedFiles.ts";
import { parseDocumentTarget } from "@assistant/shared/documentTargets";
import { ArtifactOverlay } from "./ArtifactOverlay.tsx";
import { DisclosureRow } from "./common/DisclosureRow.tsx";
import { relativeAge } from "../lib/relativeTime.ts";
import { useElapsedNow } from "./useElapsedNow.ts";
import {
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
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
 * continuation, the agent definition it runs as, library skills (loaded /
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
  /** The agent definition the session runs as, when it has one. */
  agent?: SessionAgentSummary | undefined;
  /** Open an agent definition on the Agents settings page. */
  onOpenAgent?: ((name: string) => void) | undefined;
  /** Frozen library skill names; defined (possibly empty) for coding sessions. */
  activeSkills?: string[] | undefined;
  /** Loads of those skills' bodies, newest last. */
  skillInvocations?: SessionSkillInvocation[] | undefined;
  /** Current skills-library scan, used to show mounted and unmounted skills. */
  skillLibrary?: LoadState<EntryLibraryList> | undefined;
  artifacts?: SessionArtifact[];
  pendingPostReloadContinuation?: PendingPostReloadContinuation | undefined;
  browserRuntimes?: BrowserRuntimeInfo[];
  onCancelPostReloadContinuation?: () => void;
  /** Operations the user approved for the rest of this session. */
  approvalGrants?: readonly ApprovalGrant[] | undefined;
  onRevokeApprovalGrant?: (sessionId: string, key: string) => void;
  /** Grant one operation for the rest of this session, before a card asks. */
  onGrantApproval?: (sessionId: string, key: string) => void;
}

export function SessionContextSections({
  sessionId = "current",
  toolExposure,
  agent,
  onOpenAgent,
  activeSkills,
  skillInvocations,
  skillLibrary,
  artifacts = [],
  pendingPostReloadContinuation,
  browserRuntimes = [],
  onCancelPostReloadContinuation,
  approvalGrants = [],
  onRevokeApprovalGrant,
  onGrantApproval,
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

      {agent && (
        <AgentSection
          sessionId={sessionId}
          agent={agent}
          onOpenAgent={onOpenAgent}
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

      {approvalGrants.length > 0 || onGrantApproval ? (
        <ApprovalGrantsSection
          sessionId={sessionId}
          grants={approvalGrants}
          onRevoke={onRevokeApprovalGrant}
          onGrant={onGrantApproval}
        />
      ) : null}

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
 * The agent definition this session runs as, as it was frozen at its start:
 * a later edit to the definition changes new spawns only, so this shows what
 * THIS session runs as.
 */
function AgentSection({
  sessionId,
  agent,
  onOpenAgent,
}: {
  sessionId: string;
  agent: SessionAgentSummary;
  onOpenAgent?: ((name: string) => void) | undefined;
}) {
  return (
    <InspectorSection
      id="agent"
      storageScope={`session:${sessionId}`}
      title="Agent"
      icon={<Bot size={13} />}
      summary={agent.name}
    >
      {agent.unreadable ? (
        <ErrorNote message="This session's stored agent definition is unreadable, so it refuses to run." />
      ) : (
        <PropertyList size="sm" align="start">
          <PropertyLabel>Name</PropertyLabel>
          {onOpenAgent ? (
            // The definition as the library holds it NOW, which may have
            // changed since this session froze it.
            <Button
              variant="link"
              size="xs"
              className="justify-self-start"
              onClick={() => onOpenAgent(agent.name)}
            >
              {agent.name}
            </Button>
          ) : (
            <PropertyText className="text-foreground">
              {agent.name}
            </PropertyText>
          )}
          <PropertyLabel>Runs on</PropertyLabel>
          <PropertyText className="text-foreground">
            {agent.model}, {agent.effort} effort
          </PropertyText>
          {agent.denyTools.length > 0 ? (
            <>
              <PropertyLabel>Denied tools</PropertyLabel>
              <PropertyText className="text-foreground">
                {agent.denyTools.join(", ")}
              </PropertyText>
            </>
          ) : null}
          {agent.skills.length > 0 ? (
            <>
              <PropertyLabel>Skills</PropertyLabel>
              <PropertyText className="text-foreground">
                {agent.skills.join(", ")}
              </PropertyText>
            </>
          ) : null}
          <PropertyLabel>Definition</PropertyLabel>
          <PropertyText title={`AGENT.md blob ${agent.blob}`}>
            {agent.blob.slice(0, 12)}
          </PropertyText>
        </PropertyList>
      )}
    </InspectorSection>
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
  skillLibrary?: LoadState<EntryLibraryList> | undefined;
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
      ...(library?.entries.map((skill) => skill.name) ?? []),
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

/**
 * Every operation an approval card can ask for, in ONE list of the panel's
 * rows: the ones this session allows without a click first (with when), then
 * the ones that still ask, then those only ever approved on their own card.
 * A row opens to what the operation covers and its status, with Revoke or
 * Allow… under that; allowing ahead of a card asks for confirmation.
 */
function ApprovalGrantsSection({
  sessionId,
  grants,
  onRevoke,
  onGrant,
}: {
  sessionId: string;
  grants: readonly ApprovalGrant[];
  onRevoke?: ((sessionId: string, key: string) => void) | undefined;
  onGrant?: ((sessionId: string, key: string) => void) | undefined;
}) {
  const dialogs = useDialogs();
  const byKey = new Map(grants.map((grant) => [grant.key, grant]));
  const listed = new Set(
    GRANTABLE_OPERATIONS.map((operation) => operation.key),
  );
  // A grant the list does not name (one tag, from its card) still shows.
  const rows = [
    ...grants
      .filter((grant) => !listed.has(grant.key))
      .map((grant) => ({
        key: grant.key,
        label: approvalGrantLabel(grant.key),
        covers: "Exactly what its card approved.",
        cardOnly: true,
      })),
    ...GRANTABLE_OPERATIONS,
  ].sort(
    (a, b) =>
      Number(byKey.has(b.key)) - Number(byKey.has(a.key)) ||
      Number(a.cardOnly) - Number(b.cardOnly),
  );
  const allow = async (key: string) => {
    if (!onGrant) return;
    const confirmed = await dialogs.confirm({
      title: `Allow “${approvalGrantLabel(key)}” without asking?`,
      body: "For the rest of this session, cards for this operation run without waiting for your click. You can revoke it here at any time.",
      confirmLabel: "Allow for this session",
    });
    if (confirmed) onGrant(sessionId, key);
  };
  return (
    <InspectorSection
      id="approval-grants"
      storageScope={`session:${sessionId}`}
      title="Approvals"
      icon={<ShieldCheck size={13} />}
      summary={grants.length ? `${grants.length} allowed` : "All ask first"}
      defaultOpen={grants.length > 0}
    >
      <ul className="-mx-3 divide-y" aria-label="Approvals for this session">
        {rows.map((operation) => {
          const grant = byKey.get(operation.key);
          return (
            <DisclosureRow
              key={operation.key}
              rowId={operation.key}
              inset={0.3125}
              head={
                <>
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center ${grant ? "text-success" : "text-muted-foreground"}`}
                  >
                    {grant ? (
                      <ShieldCheck size={13} aria-label="Allowed" />
                    ) : operation.cardOnly ? (
                      <Lock size={12} aria-label="Card only" />
                    ) : (
                      <Shield size={13} aria-label="Asks first" />
                    )}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate text-left text-sm ${grant ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {operation.label}
                  </span>
                </>
              }
              age={grant ? relativeTime(grant.grantedAt) : ""}
              {...(grant
                ? { ageTitle: new Date(grant.grantedAt).toLocaleString() }
                : {})}
            >
              <PropertyList size="sm" align="start">
                <PropertyLabel>Status</PropertyLabel>
                <PropertyText className="text-foreground">
                  {grant
                    ? `Allowed since ${new Date(grant.grantedAt).toLocaleString()}`
                    : operation.cardOnly
                      ? "Approved on its card, every time"
                      : "Asks first"}
                </PropertyText>
                <PropertyLabel>Covers</PropertyLabel>
                <PropertyText className="text-foreground">
                  {operation.covers}
                </PropertyText>
                <PropertyLabel>Key</PropertyLabel>
                <PropertyText className="truncate font-mono text-foreground">
                  {operation.key}
                </PropertyText>
              </PropertyList>
              {grant && onRevoke ? (
                <div className="mt-1.5 flex justify-end">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onRevoke(sessionId, operation.key)}
                  >
                    <ShieldOff />
                    Revoke — ask again next time
                  </Button>
                </div>
              ) : !grant && !operation.cardOnly && onGrant ? (
                <div className="mt-1.5 flex justify-end">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => void allow(operation.key)}
                  >
                    <ShieldCheck />
                    Allow for this session…
                  </Button>
                </div>
              ) : null}
            </DisclosureRow>
          );
        })}
      </ul>
      {/* What the list cannot show: the steps that never raise a card. */}
      <p className="mt-2 px-1 text-xs text-muted-foreground">
        Never asks: a managed worktree&rsquo;s own commit, push, pull request
        and merge into a non-default branch.
      </p>
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
  // The "x ago" labels drift; nothing here is running, so a slow tick.
  const now = useElapsedNow(false);
  return (
    <InspectorSection
      id="artifacts"
      storageScope={`session:${sessionId}`}
      title="Artifacts"
      icon={<ImageIcon size={13} />}
      summary={`${artifacts.length}`}
      defaultOpen={false}
    >
      {/* The panel's session rows (`DisclosureRow`): edge to edge, one line
          each — the artifact's thumbnail or kind glyph and its label, its age,
          and Open (↗) for the full-screen viewer; the line unfolds a larger
          preview and the file's facts. */}
      <ul className="-mx-3 divide-y" aria-label="Session artifacts">
        {newestFirst.map((artifact) => {
          const target = parseDocumentTarget(artifact.url);
          const path =
            target?.kind === "sessionArtifact" ? target.path : undefined;
          const KindIcon = ARTIFACT_KIND_ICON[artifact.kind];
          const image = artifact.mimeType.startsWith("image/");
          const open = () => {
            if (path)
              setOpened({
                sessionId: artifact.sessionId,
                path,
                label: artifact.label,
              });
          };
          return (
            <DisclosureRow
              key={artifact.id}
              rowId={artifact.id}
              // The Details labels' line, as the session rows above.
              inset={0.3125}
              head={
                <>
                  <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm">
                    {image ? (
                      <img
                        src={artifactHttpUrl(artifact.url)}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <KindIcon size={13} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {artifact.label}
                  </span>
                </>
              }
              age={relativeAge(artifact.createdAt, now)}
              ageTitle={new Date(artifact.createdAt).toLocaleString()}
              openLabel={`Open ${artifact.label}`}
              onOpen={open}
            >
              {image ? (
                <Button
                  variant="ghost"
                  className="mb-2 h-auto w-full justify-start p-0"
                  title="Open full screen"
                  onClick={open}
                >
                  <img
                    src={artifactHttpUrl(artifact.url)}
                    alt={artifact.label}
                    loading="lazy"
                    className="max-h-40 max-w-full rounded-md border object-contain"
                  />
                </Button>
              ) : null}
              <PropertyList size="sm">
                <PropertyLabel>File</PropertyLabel>
                <PropertyText className="truncate font-mono text-foreground">
                  {artifact.name}
                </PropertyText>
                <PropertyLabel>Type</PropertyLabel>
                <PropertyText className="truncate text-foreground">
                  {artifact.mimeType}
                </PropertyText>
                <PropertyLabel>Size</PropertyLabel>
                <PropertyText className="text-foreground">
                  {formatFileSize(artifact.size)}
                </PropertyText>
                {artifact.sourceTool ? (
                  <>
                    <PropertyLabel>Captured by</PropertyLabel>
                    <PropertyText className="truncate font-mono text-foreground">
                      {artifact.sourceTool}
                    </PropertyText>
                  </>
                ) : null}
              </PropertyList>
            </DisclosureRow>
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
