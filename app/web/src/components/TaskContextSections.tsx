import { useState } from "react";
import {
  ArrowUpRight,
  ExternalLink,
  GitBranch,
  Link2,
  MessageCircle,
  Plus,
  Server,
  Tickets,
  Trash2,
  X,
} from "lucide-react";
import type {
  ProjectRecord,
  TaskExternalLink,
  TaskExternalLinkSource,
  TaskSummary,
} from "@assistant/shared";
import {
  isForgejoInstanceUrl,
  normalizeGithubIssueRefs,
  parseGithubIssueRef,
} from "@assistant/shared";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { TaskTicketProperty, type TaskTicket } from "./TaskTicketProperty.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import { Item } from "./ui/item.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";
import {
  PROPERTY_TRIGGER,
  PropertyLabel,
  TaskPlanningSection,
  type TaskPlanningPatch,
} from "./TaskPlanningSection.tsx";

/** A partial task save issued from the inspector's context sections. */
export interface TaskContextPatch extends TaskPlanningPatch {
  projectId?: string | null;
  jiraIssueKeys?: string[];
  githubIssues?: string[];
  externalLinks?: TaskExternalLink[];
}

/**
 * @component TaskContextSections
 * @purpose The task inspector's editable context: planning (priority + the two
 * dates), project assignment, linked Jira tickets and GitHub issues, and
 * external links (source + related).
 * @useWhen Rendered inside the task Inspector's children slot. The task page
 * itself stays a clean document (title, status, description).
 * @avoidWhen Task list browsing or description editing; those live elsewhere.
 * @intent Compact inspector-density sections using shared InspectorSection
 * chrome. All edits flow through a single onPatch callback the parent turns
 * into a task save.
 */
export function TaskContextSections({
  task,
  projects,
  projectsById,
  onPatch,
  onOpenProject,
  jiraHost,
  forgejoBaseUrl,
}: {
  task: TaskSummary;
  /** Selector offer list (active projects). */
  projects: ProjectRecord[];
  /** Includes archived projects so stale assignments still resolve names. */
  projectsById: Map<string, ProjectRecord>;
  onPatch: (patch: TaskContextPatch) => void;
  onOpenProject?: (id: string) => void;
  /** Configured Jira host used when a task stores only an issue key. */
  jiraHost?: string;
  /** Configured Forgejo instance base URL — the only way to spot its links. */
  forgejoBaseUrl?: string;
}) {
  const links = task.externalLinks ?? [];
  const jiraKeys = normalizeJiraKeys(task.jiraIssueKeys ?? []);
  const githubRefs = normalizeGithubIssueRefs(task.githubIssues ?? []);
  const ticket: TaskTicket | null = jiraKeys[0]
    ? { source: "jira", ref: jiraKeys[0] }
    : githubRefs[0]
      ? { source: "github", ref: githubRefs[0] }
      : null;
  const ticketScope = ticketSearchScope(
    task.projectId ? projectsById.get(task.projectId) : undefined,
  );
  const removeLink = (url: string) =>
    onPatch({ externalLinks: links.filter((link) => link.url !== url) });
  const addLink = (link: TaskExternalLink) =>
    onPatch({ externalLinks: [...links, link] });

  return (
    // A fragment, not a wrapper: the inspector spaces its sections and a
    // section draws its own top divider unless it is the panel's FIRST child —
    // inside a wrapper, Details believed it was, and lost both.
    <>
      {/* Planning leads: it is what the Backlog's Focus view reads, and the
          fields most often changed on a Task that already exists. */}
      <TaskPlanningSection
        task={task}
        onPatch={onPatch}
        leading={
          <>
            <PropertyLabel>Project</PropertyLabel>
            <div className="flex min-w-0 items-center gap-0.5">
              <ProjectSelector
                currentId={task.projectId ?? null}
                projects={projects}
                projectsById={projectsById}
                onChange={(projectId) =>
                  onPatch({ projectId: projectId || null })
                }
                label={null}
                emptyLabel="None"
                grow
                className={`${PROPERTY_TRIGGER} min-w-0 flex-1 justify-start`}
              />
              {task.projectId && onOpenProject ? (
                <IconButton
                  label="Open project"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenProject(task.projectId!)}
                >
                  <ArrowUpRight />
                </IconButton>
              ) : null}
            </div>
            {/* One ticket per Task, picked from a search over Jira and
                GitHub. A Task still carrying several shows its first; picking
                replaces them all. */}
            <PropertyLabel>Ticket</PropertyLabel>
            <TaskTicketProperty
              ticket={ticket}
              fallbackUrl={
                ticket?.source === "jira"
                  ? jiraUrlForKey(ticket.ref, links, jiraHost)
                  : ticket
                    ? githubIssueUrl(ticket.ref)
                    : undefined
              }
              jiraProjects={ticketScope.jiraProjects}
              repos={ticketScope.repos}
              onChange={(next) =>
                onPatch({
                  jiraIssueKeys: next?.source === "jira" ? [next.ref] : [],
                  githubIssues: next?.source === "github" ? [next.ref] : [],
                })
              }
            />
          </>
        }
      />

      <LinksSection
        taskId={task.id}
        links={links}
        forgejoBaseUrl={forgejoBaseUrl}
        onAdd={addLink}
        onRemove={removeLink}
      />
    </>
  );
}

function addAction(title: string, adding: boolean, onToggleAdd: () => void) {
  return (
    <IconButton
      label={adding ? `Cancel adding to ${title}` : `Add to ${title}`}
      onClick={onToggleAdd}
    >
      {adding ? <X /> : <Plus />}
    </IconButton>
  );
}

export function githubIssueUrl(ref: string): string | undefined {
  const parts = parseGithubIssueRef(ref);
  // `/issues/<n>` redirects to `/pull/<n>` when the number is a pull request.
  return parts
    ? `https://github.com/${parts.owner}/${parts.repo}/issues/${parts.number}`
    : undefined;
}

function LinksSection({
  taskId,
  links,
  forgejoBaseUrl,
  onAdd,
  onRemove,
}: {
  taskId: string;
  links: TaskExternalLink[];
  forgejoBaseUrl?: string | undefined;
  onAdd: (link: TaskExternalLink) => void;
  onRemove: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const valid = /^https?:\/\//i.test(url.trim());
  const add = (type: TaskExternalLink["type"]) => {
    if (!valid) return;
    const titleValue = title.trim() || undefined;
    onAdd({
      url: url.trim(),
      ...(titleValue !== undefined ? { title: titleValue } : {}),
      type,
      source: detectLinkSource(url.trim(), forgejoBaseUrl),
      addedAt: Date.now(),
    });
    setUrl("");
    setTitle("");
    setAdding(false);
  };
  return (
    <InspectorSection
      id="links"
      storageScope={`task:${taskId}`}
      title="Links"
      icon={<Link2 size={13} />}
      summary={links.length ? `${links.length}` : undefined}
      actions={addAction("Links", adding, () => setAdding((value) => !value))}
      collapsible={links.length > 0 || adding}
      forceOpen={adding}
    >
      <div className="space-y-1 px-1">
        {links.map((link) => (
          <Item
            key={link.url}
            size="sm"
            className="min-w-0 items-center gap-1.5"
          >
            <ProviderIcon source={link.source} size={13} />
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 flex-1 truncate text-foreground hover:text-primary hover:underline"
              title={link.url}
            >
              {link.title?.trim() || link.url.replace(/^https?:\/\//, "")}
            </a>
            {link.type === "source" ? (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                src
              </span>
            ) : null}
            <IconButton
              variant="destructive"
              size="icon-xs"
              label="Remove link"
              onClick={() => onRemove(link.url)}
            >
              <Trash2 />
            </IconButton>
          </Item>
        ))}
        {adding ? (
          <div className="space-y-1.5 rounded-lg border border-border bg-background p-2">
            <Input
              value={url}
              autoFocus
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
                if (event.key === "Enter") add("related");
              }}
              placeholder="https://…"
              aria-label="Link URL"
            />
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
                if (event.key === "Enter") add("related");
              }}
              placeholder="Optional label"
              aria-label="Optional link label"
            />
            <div className="flex justify-end gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => add("source")}
                disabled={!valid}
              >
                <Link2 /> Source
              </Button>
              <Button
                size="sm"
                onClick={() => add("related")}
                disabled={!valid}
              >
                <Plus /> Related
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}

export function normalizeJiraKeys(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim().toUpperCase())
        .filter((value): value is string =>
          Boolean(value && /^[A-Z][A-Z0-9]+-\d+$/.test(value)),
        ),
    ),
  ];
}

export function jiraUrlForKey(
  key: string,
  links: TaskExternalLink[],
  jiraHost?: string,
): string | undefined {
  const jiraLink = links.find(
    (link) => link.source === "jira" && link.url.toUpperCase().includes(key),
  );
  const host =
    jiraHost?.trim() || (jiraLink ? jiraHostFromUrl(jiraLink.url) : undefined);
  if (!host) return jiraLink?.url;
  const base = host.match(/^https?:\/\//i) ? host : `https://${host}`;
  return `${base.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`;
}

function jiraHostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The browser twin of the server's classification. Forgejo is self-hosted, so
 * it is recognized only against the configured instance base URL; without one
 * a Forgejo link stays `unknown` here and the server re-detects on save.
 */
export function detectLinkSource(
  url: string,
  forgejoBaseUrl?: string,
): TaskExternalLinkSource {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("slack.com")) return "slack";
    if (
      host.includes("atlassian.net") ||
      /(^|\.)jira\./.test(host) ||
      /\/browse\/[A-Z][A-Z0-9]+-\d+\b/i.test(parsed.pathname)
    )
      return "jira";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (isForgejoInstanceUrl(url, forgejoBaseUrl)) return "forgejo";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function ProviderIcon({
  source,
  size = 14,
}: {
  source: TaskExternalLinkSource;
  size?: number;
}) {
  if (source === "slack")
    return <MessageCircle size={size} className="shrink-0 text-primary" />;
  if (source === "jira")
    return <Tickets size={size} className="shrink-0 text-primary" />;
  if (source === "github")
    return <GitBranch size={size} className="shrink-0 text-foreground" />;
  if (source === "forgejo")
    return <Server size={size} className="shrink-0 text-foreground" />;
  return (
    <ExternalLink size={size} className="shrink-0 text-muted-foreground" />
  );
}

/**
 * Where the ticket search looks first: the Project's Jira projects and its
 * GitHub repository (from `repoUrl`, when it is on github.com).
 */
function ticketSearchScope(project: ProjectRecord | undefined): {
  jiraProjects: string[];
  repos: string[];
} {
  const jiraProjects = [
    ...new Set(
      (project?.jira ?? [])
        .map((link) => link.projectKey?.trim().toUpperCase())
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  const repo = project?.repoUrl
    ? /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(project.repoUrl)
    : null;
  return { jiraProjects, repos: repo ? [repo[1]!] : [] };
}
