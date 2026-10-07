import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  ExternalLink,
  FolderKanban,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Link2,
  MessageCircle,
  Plus,
  Server,
  Tickets,
  Trash2,
  X,
} from "lucide-react";
import type {
  GithubLinkedIssue,
  ProjectRecord,
  TaskExternalLink,
  TaskExternalLinkSource,
  TaskSummary,
} from "@assistant/shared";
import {
  isForgejoInstanceUrl,
  normalizeGithubIssueRef,
  normalizeGithubIssueRefs,
  parseGithubIssueRef,
} from "@assistant/shared";
import { fetchGithubLinkedIssues } from "../lib/githubApi.ts";
import { fetchJiraLinkedIssues } from "../lib/jiraApi.ts";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { GhostIconButton } from "./ui/GhostIconButton.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";
import {
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
  const removeLink = (url: string) =>
    onPatch({ externalLinks: links.filter((link) => link.url !== url) });
  const addLink = (link: TaskExternalLink) =>
    onPatch({ externalLinks: [...links, link] });

  return (
    <div className="space-y-4">
      {/* Planning leads: it is what the Backlog's Focus view reads, and the
          fields most often changed on a Task that already exists. */}
      <TaskPlanningSection task={task} onPatch={onPatch} />

      <InspectorSection
        id="project"
        storageScope={`task:${task.id}`}
        title="Project"
        icon={<FolderKanban size={13} />}
        summary={
          task.projectId
            ? (projectsById.get(task.projectId)?.key ?? task.projectId)
            : undefined
        }
      >
        <div className="flex items-center gap-1 px-1">
          <ProjectSelector
            currentId={task.projectId ?? null}
            projects={projects}
            projectsById={projectsById}
            onChange={(projectId) => onPatch({ projectId: projectId || null })}
            label={null}
          />
          {task.projectId && onOpenProject ? (
            <GhostIconButton
              icon={<ArrowUpRight size={13} />}
              label="Open project"
              onClick={() => onOpenProject(task.projectId!)}
            />
          ) : null}
        </div>
      </InspectorSection>

      <JiraTicketsSection
        taskId={task.id}
        keys={jiraKeys}
        links={links}
        jiraHost={jiraHost}
        onChange={(keys) => onPatch({ jiraIssueKeys: keys })}
      />
      <GithubIssuesSection
        taskId={task.id}
        refs={task.githubIssues ?? []}
        onChange={(refs) => onPatch({ githubIssues: refs })}
      />
      <LinksSection
        taskId={task.id}
        links={links}
        forgejoBaseUrl={forgejoBaseUrl}
        onAdd={addLink}
        onRemove={removeLink}
      />
    </div>
  );
}

function addAction(title: string, adding: boolean, onToggleAdd: () => void) {
  return (
    <GhostIconButton
      icon={adding ? <X size={13} /> : <Plus size={13} />}
      label={adding ? `Cancel adding to ${title}` : `Add to ${title}`}
      onClick={onToggleAdd}
    />
  );
}

function JiraTicketsSection({
  taskId,
  keys,
  links,
  jiraHost,
  onChange,
}: {
  taskId: string;
  keys: string[];
  links: TaskExternalLink[];
  jiraHost?: string | undefined;
  onChange: (keys: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const keyQuery = keys.join(",");

  useEffect(() => {
    const controller = new AbortController();
    setSummaries({});
    fetchJiraLinkedIssues(
      keyQuery ? keyQuery.split(",") : [],
      controller.signal,
    )
      .then(({ issues }) =>
        setSummaries(
          Object.fromEntries(issues.map((issue) => [issue.key, issue.summary])),
        ),
      )
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError"))
          setSummaries({});
      });
    return () => controller.abort();
  }, [keyQuery]);

  const add = () => {
    const next = normalizeJiraKeys([...keys, draft]);
    if (next.length === keys.length) return;
    onChange(next);
    setDraft("");
    setAdding(false);
  };
  return (
    <InspectorSection
      id="jira-tickets"
      storageScope={`task:${taskId}`}
      title="Jira tickets"
      icon={<Tickets size={13} />}
      summary={keys.length ? `${keys.length}` : undefined}
      actions={addAction("Jira tickets", adding, () =>
        setAdding((value) => !value),
      )}
      collapsible={keys.length > 0 || adding}
      forceOpen={adding}
    >
      <div className="divide-y divide-line px-1">
        {keys.map((key) => {
          const url = jiraUrlForKey(key, links, jiraHost);
          const summary = summaries[key];
          const label = (
            <>
              <span className="block truncate font-mono text-caption text-primary">
                {key}
              </span>
              {summary ? (
                <span className="block truncate text-caption text-fg">
                  {summary}
                </span>
              ) : null}
            </>
          );
          return (
            <div
              key={key}
              className="group flex min-w-0 items-start gap-2 py-2 first:pt-1"
            >
              <Tickets size={13} className="mt-0.5 shrink-0 text-primary" />
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 hover:[&>span]:underline"
                  title={`Open ${key}${summary ? ` — ${summary}` : ""} in Jira`}
                >
                  {label}
                </a>
              ) : (
                <span className="min-w-0 flex-1" title="No URL stored">
                  {label}
                </span>
              )}
              <GhostIconButton
                danger
                revealOnHover
                icon={<Trash2 size={12} />}
                label={`Unlink ${key}`}
                onClick={() => onChange(keys.filter((item) => item !== key))}
              />
            </div>
          );
        })}
        {adding ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
            <Tickets size={13} className="shrink-0 text-faint" />
            <input
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
                if (event.key === "Escape") setAdding(false);
              }}
              placeholder="ABC-123"
              className="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-caption text-fg outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={add}
              disabled={normalizeJiraKeys([draft]).length === 0}
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-caption text-muted-foreground hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Link
            </button>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}

function githubIssueUrl(ref: string): string | undefined {
  const parts = parseGithubIssueRef(ref);
  // `/issues/<n>` redirects to `/pull/<n>` when the number is a pull request.
  return parts
    ? `https://github.com/${parts.owner}/${parts.repo}/issues/${parts.number}`
    : undefined;
}

function GithubIssueIcon({ issue }: { issue: GithubLinkedIssue | undefined }) {
  const cls = "mt-0.5 shrink-0";
  if (issue?.state === "merged")
    return <GitMerge size={13} className={`${cls} text-primary`} />;
  if (issue?.isPullRequest)
    return (
      <GitPullRequest
        size={13}
        className={`${cls} ${issue.state === "closed" ? "text-faint" : "text-primary"}`}
      />
    );
  if (issue?.state === "closed")
    return <CircleCheck size={13} className={`${cls} text-faint`} />;
  return <CircleDot size={13} className={`${cls} text-primary`} />;
}

function GithubIssuesSection({
  taskId,
  refs,
  onChange,
}: {
  taskId: string;
  refs: string[];
  onChange: (refs: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [issues, setIssues] = useState<Record<string, GithubLinkedIssue>>({});
  const refQuery = refs.join(",");

  useEffect(() => {
    const controller = new AbortController();
    setIssues({});
    fetchGithubLinkedIssues(
      refQuery ? refQuery.split(",") : [],
      controller.signal,
    )
      .then(({ issues: found }) =>
        setIssues(Object.fromEntries(found.map((issue) => [issue.ref, issue]))),
      )
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError"))
          setIssues({});
      });
    return () => controller.abort();
  }, [refQuery]);

  const add = () => {
    const next = normalizeGithubIssueRefs([...refs, draft]);
    if (next.length === refs.length) return;
    onChange(next);
    setDraft("");
    setAdding(false);
  };
  return (
    <InspectorSection
      id="github-issues"
      storageScope={`task:${taskId}`}
      title="GitHub issues"
      icon={<CircleDot size={13} />}
      summary={refs.length ? `${refs.length}` : undefined}
      actions={addAction("GitHub issues", adding, () =>
        setAdding((value) => !value),
      )}
      collapsible={refs.length > 0 || adding}
      forceOpen={adding}
    >
      <div className="divide-y divide-line px-1">
        {refs.map((ref) => {
          const issue = issues[ref];
          const url = issue?.url ?? githubIssueUrl(ref);
          return (
            <div
              key={ref}
              className="group flex min-w-0 items-start gap-2 py-2 first:pt-1"
            >
              <GithubIssueIcon issue={issue} />
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 hover:[&>span]:underline"
                title={`Open ${ref}${issue ? ` — ${issue.title} (${issue.state})` : ""} on GitHub`}
              >
                <span className="block truncate font-mono text-caption text-primary">
                  {ref}
                </span>
                {issue?.title ? (
                  <span className="block truncate text-caption text-fg">
                    {issue.title}
                  </span>
                ) : null}
              </a>
              <GhostIconButton
                danger
                revealOnHover
                icon={<Trash2 size={12} />}
                label={`Unlink ${ref}`}
                onClick={() => onChange(refs.filter((item) => item !== ref))}
              />
            </div>
          );
        })}
        {adding ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
            <CircleDot size={13} className="shrink-0 text-faint" />
            <input
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
                if (event.key === "Escape") setAdding(false);
              }}
              placeholder="owner/repo#123 or issue URL"
              className="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-caption text-fg outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={add}
              disabled={!normalizeGithubIssueRef(draft)}
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-caption text-muted-foreground hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Link
            </button>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
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
          <div
            key={link.url}
            className="group flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-raised"
          >
            <ProviderIcon source={link.source} size={13} />
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 flex-1 truncate text-fg hover:text-primary hover:underline"
              title={link.url}
            >
              {link.title?.trim() || link.url.replace(/^https?:\/\//, "")}
            </a>
            {link.type === "source" ? (
              <span className="shrink-0 rounded bg-raised px-1 py-0.5 text-micro uppercase tracking-wide text-faint">
                src
              </span>
            ) : null}
            <GhostIconButton
              danger
              revealOnHover
              icon={<Trash2 size={12} />}
              label="Remove link"
              onClick={() => onRemove(link.url)}
            />
          </div>
        ))}
        {adding ? (
          <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2">
            <input
              value={url}
              autoFocus
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
                if (event.key === "Enter") add("related");
              }}
              placeholder="https://…"
              className="w-full rounded-md border border-line bg-panel px-2 py-1 text-caption text-fg outline-none focus:border-primary"
            />
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
                if (event.key === "Enter") add("related");
              }}
              placeholder="Optional label"
              className="w-full rounded-md border border-line bg-panel px-2 py-1 text-caption text-fg outline-none focus:border-primary"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => add("source")}
                disabled={!valid}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-caption text-muted-foreground hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Link2 size={11} /> Source
              </button>
              <button
                type="button"
                onClick={() => add("related")}
                disabled={!valid}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-caption font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={11} /> Related
              </button>
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
    return <GitBranch size={size} className="shrink-0 text-fg" />;
  if (source === "forgejo")
    return <Server size={size} className="shrink-0 text-fg" />;
  return <ExternalLink size={size} className="shrink-0 text-faint" />;
}
