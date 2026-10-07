import { Fragment, useMemo, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  FolderKanban,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import type { DisplayBlock } from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { normalizedToolName } from "./tools/toolName.ts";
import { ChatWideCard } from "./ChatWideCard.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

type JiraRenderColumn = { id: string; name: string; type?: string | null };
type JiraRenderField = {
  id: string;
  name: string;
  type?: string | null;
  valueText?: string | null;
  value?: any;
};
type JiraUser = {
  accountId?: string | null;
  accountType?: string | null;
  displayName?: string | null;
  emailAddress?: string | null;
  active?: boolean | null;
  timeZone?: string | null;
  locale?: string | null;
  self?: string | null;
  userUrl?: string | null;
  avatarUrl?: string | null;
};
type JiraProject = {
  id?: string | null;
  key?: string | null;
  name?: string | null;
  projectUrl?: string | null;
  description?: string | null;
  projectTypeKey?: string | null;
  simplified?: boolean | null;
  style?: string | null;
  isPrivate?: boolean | null;
  category?: { name?: string | null; description?: string | null } | null;
  lead?: JiraUser | null;
  avatarUrl?: string | null;
  issueTypes?: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
    iconUrl?: string | null;
    subtask?: boolean | null;
  }>;
};
type JiraIssue = {
  id?: string | null;
  key?: string | null;
  issueUrl?: string | null;
  summary?: string | null;
  description?: string | null;
  descriptionMarkdown?: string | null;
  project?: { key?: string | null; name?: string | null } | null;
  issueType?: { name?: string | null; iconUrl?: string | null } | null;
  status?: {
    name?: string | null;
    category?: string | null;
    colorName?: string | null;
  } | null;
  priority?: { name?: string | null; iconUrl?: string | null } | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  creator?: JiraUser | null;
  labels?: string[];
  components?: Array<{ name?: string | null }>;
  fixVersions?: Array<{ name?: string | null; released?: boolean | null }>;
  created?: string | null;
  updated?: string | null;
  dueDate?: string | null;
  parent?: {
    key?: string | null;
    issueUrl?: string | null;
    summary?: string | null;
    status?: string | null;
  } | null;
  subtasks?: Array<{
    key?: string | null;
    issueUrl?: string | null;
    summary?: string | null;
    status?: string | null;
  }>;
  fields?: JiraRenderField[];
};

type JiraSearchPayload = {
  jql?: string;
  jiraSearchUrl?: string;
  total?: number;
  returned?: number;
  startAt?: number;
  renderColumns?: JiraRenderColumn[];
  issues?: JiraIssue[];
};
type JiraProjectsPayload = {
  query?: string | null;
  total?: number;
  returned?: number;
  projects?: JiraProject[];
};
type JiraUsersPayload = {
  query?: string;
  projectKey?: string | null;
  assignableOnly?: boolean;
  returned?: number;
  users?: JiraUser[];
};

export function shouldRenderJiraTool(block: ToolBlock): boolean {
  if (!block.done || block.isError) return false;
  const name = normalizedToolName(block.name);
  if (name !== "jira_search_issues" && name !== "jira_lookup") return false;
  const args = block.args as { render?: unknown } | null;
  if (args?.render !== true) return false;
  const payload = parseJson(block.output) as { kind?: unknown } | null;
  if (!payload) return false;
  if (
    name === "jira_lookup" &&
    payload.kind !== "projects" &&
    payload.kind !== "users"
  )
    return false;
  return true;
}

export function JiraToolCard({ block }: { block: ToolBlock }) {
  const payload = parseJson(block.output);
  if (!payload) return null;
  const name = normalizedToolName(block.name);
  if (name === "jira_search_issues")
    return <JiraIssueSearchCard payload={payload as JiraSearchPayload} />;
  if (name === "jira_lookup") {
    const kind = (payload as { kind?: string }).kind;
    if (kind === "projects")
      return <JiraProjectsCard payload={payload as JiraProjectsPayload} />;
    if (kind === "users")
      return <JiraUsersCard payload={payload as JiraUsersPayload} />;
  }
  return null;
}

function JiraIssueSearchCard({ payload }: { payload: JiraSearchPayload }) {
  const issues = payload.issues ?? [];
  const columns = normalizeColumns(payload.renderColumns);
  return (
    <ChatWideCard maxWidth={1500}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FolderKanban size={18} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              Jira issue search
            </div>
            {payload.jiraSearchUrl ? (
              <a
                href={payload.jiraSearchUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex max-w-full items-center gap-1 font-mono text-sm text-primary hover:underline"
                title="Open JQL in Jira"
              >
                <span className="truncate">{payload.jql || "JQL search"}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
            ) : (
              <div className="truncate font-mono text-sm text-muted-foreground">
                {payload.jql || "JQL search"}
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right text-sm text-muted-foreground">
          <div>
            {issues.length} issue{issues.length === 1 ? "" : "s"}
          </div>
          {payload.total !== undefined && <div>total {payload.total}</div>}
        </div>
      </header>
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="w-max min-w-full border-separate border-spacing-0 text-left text-sm">
          <thead className="bg-background/70 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th
                className="sticky left-0 z-30 w-9 bg-background/95 px-2 py-2 font-medium shadow-[1px_0_0_var(--color-line)]"
                aria-label="Expand"
              />
              {columns.map((column) => (
                <th
                  key={column.id}
                  className={`${issueColumnClass(column.id)} ${stickyHeaderClass(column.id)} px-3 py-2 font-medium`}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, issueIndex) => (
              <JiraIssueRow
                key={issue.key ?? issue.id ?? issueIndex}
                issue={issue}
                columns={columns}
              />
            ))}
            {issues.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No Jira issues found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ChatWideCard>
  );
}

function JiraIssueRow({
  issue,
  columns,
}: {
  issue: JiraIssue;
  columns: JiraRenderColumn[];
}) {
  const [open, setOpen] = useState(false);
  const fieldMap = useMemo(
    () => new Map((issue.fields ?? []).map((field) => [field.id, field])),
    [issue.fields],
  );
  return (
    <Fragment>
      <tr className="group border-t border-border odd:bg-background/30">
        <td className="sticky left-0 z-20 border-t border-border bg-card px-2 py-3 text-center align-top shadow-[1px_0_0_var(--color-line)] group-odd:bg-background">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
            title={open ? "Collapse issue" : "Expand issue"}
          >
            <ChevronDown
              size={15}
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        </td>
        {columns.map((column) => (
          <td
            key={column.id}
            className={`${issueColumnClass(column.id)} ${stickyCellClass(column.id)} border-t border-border px-3 py-3 align-top`}
          >
            {renderIssueCell(issue, column.id, fieldMap.get(column.id))}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="bg-background/60">
          <td
            colSpan={columns.length + 1}
            className="border-t border-border p-0"
          >
            <div className="sticky left-0 w-[min(1500px,calc(var(--shell-main-width,100vw)_-_2rem))] max-w-full px-4 py-3">
              <JiraIssueDetails issue={issue} fields={issue.fields ?? []} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function JiraIssueDetails({
  issue,
  fields,
}: {
  issue: JiraIssue;
  fields: JiraRenderField[];
}) {
  return (
    <div className="w-full min-w-0 space-y-3">
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Issue details
        </div>
        <div className="text-sm font-semibold text-foreground">
          <ExternalTitle
            title={`${issue.key ?? "Issue"}: ${issue.summary ?? ""}`}
            href={issue.issueUrl}
          />
        </div>
        {issue.descriptionMarkdown?.trim() ? (
          <div className="mt-3 max-h-72 min-w-0 overflow-auto text-sm">
            <Markdown text={issue.descriptionMarkdown} />
          </div>
        ) : issue.description?.trim() ? (
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
            {issue.description}
          </pre>
        ) : (
          <div className="mt-3 text-sm text-muted-foreground">
            No description returned.
          </div>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <div className="grid min-w-0 grid-cols-2 gap-2 rounded-xl border border-border bg-card p-3 text-sm">
          <Detail
            label="Project"
            value={[issue.project?.key, issue.project?.name]
              .filter(Boolean)
              .join(" · ")}
          />
          <Detail label="Type" value={issue.issueType?.name} />
          <Detail label="Status" value={issue.status?.name} />
          <Detail label="Priority" value={issue.priority?.name} />
          <Detail
            label="Assignee"
            value={issue.assignee?.displayName || "Unassigned"}
          />
          <Detail label="Reporter" value={issue.reporter?.displayName} />
          <Detail label="Created" value={formatDate(issue.created)} />
          <Detail label="Updated" value={formatDate(issue.updated)} />
        </div>
        <div className="min-w-0 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Returned fields
          </div>
          <div className="max-h-72 overflow-auto pr-1">
            {fields
              .filter((field) => field.valueText)
              .map((field) => (
                <div
                  key={field.id}
                  className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 border-t border-border/70 py-1.5 first:border-t-0"
                >
                  <div
                    className="truncate text-sm text-muted-foreground"
                    title={field.id}
                  >
                    {field.name}
                  </div>
                  <div className="min-w-0 break-words text-sm text-foreground">
                    {field.valueText}
                  </div>
                </div>
              ))}
            {!fields.some((field) => field.valueText) && (
              <div className="text-sm text-muted-foreground">
                No non-empty extra fields returned.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JiraProjectsCard({ payload }: { payload: JiraProjectsPayload }) {
  const projects = payload.projects ?? [];
  return (
    <ChatWideCard maxWidth={1120}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderKanban size={18} className="text-primary" />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Jira projects
            </div>
            <div className="text-sm text-muted-foreground">
              {payload.query || "Visible projects"}
            </div>
          </div>
        </div>
        <div className="text-right text-sm text-muted-foreground">
          <div>
            {projects.length} project{projects.length === 1 ? "" : "s"}
          </div>
          {payload.total !== undefined && <div>total {payload.total}</div>}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
          <thead className="bg-background/70 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-9 px-2 py-2" />
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Lead</th>
              <th className="px-3 py-2 font-medium">Issue types</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project, projectIndex) => (
              <JiraProjectRow
                key={project.id ?? project.key ?? project.name ?? projectIndex}
                project={project}
              />
            ))}
            {projects.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No Jira projects found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ChatWideCard>
  );
}

function JiraProjectRow({ project }: { project: JiraProject }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr className="border-t border-border odd:bg-background/30">
        <td className="border-t border-border px-2 py-3 text-center align-top">
          <ExpandButton open={open} onClick={() => setOpen((v) => !v)} />
        </td>
        <td className="border-t border-border px-3 py-3 align-top">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar
              src={project.avatarUrl}
              label={project.key || project.name || "P"}
              square
            />
            <div className="min-w-0">
              <ExternalTitle
                title={`${project.key ?? ""}${project.key && project.name ? " · " : ""}${project.name ?? ""}`}
                href={project.projectUrl}
              />
              <div className="text-sm text-muted-foreground">{project.id}</div>
            </div>
          </div>
        </td>
        <td className="border-t border-border px-3 py-3 align-top text-muted-foreground">
          {project.projectTypeKey || "—"}
          {project.category?.name ? (
            <div className="text-muted-foreground">{project.category.name}</div>
          ) : null}
        </td>
        <td className="border-t border-border px-3 py-3 align-top">
          <UserPill user={project.lead} />
        </td>
        <td className="border-t border-border px-3 py-3 align-top text-muted-foreground">
          {project.issueTypes?.length ?? 0}
        </td>
      </tr>
      {open && (
        <tr className="bg-background/60">
          <td colSpan={5} className="border-t border-border px-4 py-3">
            <ProjectDetails project={project} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ProjectDetails({ project }: { project: JiraProject }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Description
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {project.description || "No description returned."}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Issue types
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(project.issueTypes ?? []).map((type, typeIndex) => (
            <span
              key={type.id ?? type.name ?? typeIndex}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-sm text-muted-foreground"
            >
              {type.iconUrl && (
                <img src={type.iconUrl} alt="" className="size-4" />
              )}
              {type.name}
            </span>
          ))}
          {!project.issueTypes?.length && (
            <span className="text-sm text-muted-foreground">
              No issue types returned.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function JiraUsersCard({ payload }: { payload: JiraUsersPayload }) {
  const users = payload.users ?? [];
  return (
    <ChatWideCard maxWidth={1050}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-primary" />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Jira users
            </div>
            <div className="text-sm text-muted-foreground">
              {payload.assignableOnly
                ? `Assignable in ${payload.projectKey}`
                : payload.query || "Visible users"}
            </div>
          </div>
        </div>
        <div className="text-right text-sm text-muted-foreground">
          {users.length} user{users.length === 1 ? "" : "s"}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-sm">
          <thead className="bg-background/70 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Account ID</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Timezone</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user, userIndex) => (
              <tr
                key={
                  user.accountId ??
                  user.emailAddress ??
                  user.displayName ??
                  user.self ??
                  userIndex
                }
                className="border-t border-border odd:bg-background/30"
              >
                <td className="border-t border-border px-3 py-3">
                  <UserPill user={user} link />
                </td>
                <td className="border-t border-border px-3 py-3 text-muted-foreground">
                  {user.emailAddress || "—"}
                </td>
                <td className="border-t border-border px-3 py-3 font-mono text-sm text-muted-foreground">
                  {user.accountId || "—"}
                </td>
                <td className="border-t border-border px-3 py-3">
                  <StatusPill active={user.active} />
                </td>
                <td className="border-t border-border px-3 py-3 text-muted-foreground">
                  {user.timeZone || user.accountType || "—"}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No Jira users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ChatWideCard>
  );
}

function renderIssueCell(
  issue: JiraIssue,
  id: string,
  field?: JiraRenderField,
) {
  if (id === "key")
    return (
      <div className="truncate">
        <ExternalTitle title={issue.key || "—"} href={issue.issueUrl} mono />
      </div>
    );
  if (id === "summary")
    return (
      <div
        className="truncate font-medium text-foreground"
        title={issue.summary || undefined}
      >
        {issue.summary || "—"}
      </div>
    );
  if (id === "status")
    return (
      <StatusChip
        label={issue.status?.name || field?.valueText}
        category={issue.status?.category || field?.value?.category}
        colorName={issue.status?.colorName || field?.value?.colorName}
      />
    );
  if (id === "assignee")
    return issue.assignee ? (
      <UserPill user={issue.assignee} />
    ) : (
      <span className="whitespace-nowrap text-muted-foreground">
        Unassigned
      </span>
    );
  if (id === "reporter") return <UserPill user={issue.reporter} />;
  if (id === "project")
    return (
      <span className="block truncate" title={field?.valueText || undefined}>
        {[issue.project?.key, issue.project?.name]
          .filter(Boolean)
          .join(" · ") ||
          field?.valueText ||
          "—"}
      </span>
    );
  if (id === "issuetype")
    return (
      <IconLabel
        iconUrl={issue.issueType?.iconUrl || field?.value?.iconUrl}
        label={issue.issueType?.name || field?.valueText || "—"}
      />
    );
  if (id === "priority")
    return (
      <IconLabel
        iconUrl={issue.priority?.iconUrl || field?.value?.iconUrl}
        label={issue.priority?.name || field?.valueText || "—"}
      />
    );
  if (id === "created" || id === "updated" || id === "duedate")
    return (
      <span className="block whitespace-nowrap font-mono text-sm text-muted-foreground">
        {formatDate(
          field?.valueText ||
            (id === "created"
              ? issue.created
              : id === "updated"
                ? issue.updated
                : issue.dueDate),
        )}
      </span>
    );
  if (id === "labels") return <ChipList values={issue.labels ?? []} />;
  if (id === "components")
    return (
      <ChipList
        values={
          (issue.components ?? [])
            .map((component) => component.name)
            .filter(Boolean) as string[]
        }
      />
    );
  return <FieldValue field={field} />;
}

function FieldValue({ field }: { field?: JiraRenderField | undefined }) {
  if (!field?.valueText)
    return <span className="text-muted-foreground">—</span>;
  if (field.type === "user" && field.value)
    return <UserPill user={field.value} />;
  if (field.value?.iconUrl)
    return <IconLabel iconUrl={field.value.iconUrl} label={field.valueText} />;
  if (Array.isArray(field.value))
    return (
      <ChipList
        values={field.value
          .map((item: any) => item?.name || item?.key || String(item))
          .filter(Boolean)}
      />
    );
  return (
    <span
      className="block truncate text-muted-foreground"
      title={field.valueText}
    >
      {field.valueText}
    </span>
  );
}

function normalizeColumns(columns?: JiraRenderColumn[]): JiraRenderColumn[] {
  const raw = columns?.length
    ? columns
    : [
        { id: "key", name: "Key", type: "issueKey" },
        { id: "summary", name: "Summary" },
        { id: "status", name: "Status" },
        { id: "assignee", name: "Assignee" },
        { id: "updated", name: "Updated" },
      ];
  return raw.map((column) => ({ ...column, id: normalizeColumnId(column.id) }));
}

function normalizeColumnId(value: string): string {
  if (/^issueType$/i.test(value)) return "issuetype";
  if (/^dueDate$/i.test(value)) return "duedate";
  return value;
}

function issueColumnClass(id: string): string {
  if (id === "key") return "w-36 min-w-36 max-w-36";
  if (id === "summary") return "w-[32rem] min-w-[24rem] max-w-[32rem]";
  if (id === "status") return "w-44 min-w-44 max-w-44";
  if (id === "created" || id === "updated" || id === "duedate")
    return "w-44 min-w-44 max-w-44 whitespace-nowrap";
  if (id === "assignee" || id === "reporter") return "w-56 min-w-56 max-w-56";
  if (id === "issuetype" || id === "priority") return "w-40 min-w-40 max-w-40";
  return "w-48 min-w-48 max-w-48";
}

function stickyHeaderClass(id: string): string {
  if (id === "key")
    return "sticky left-9 z-30 bg-background/95 shadow-[1px_0_0_var(--color-line)]";
  if (id === "summary")
    return "sticky left-[11.25rem] z-30 bg-background/95 shadow-[1px_0_0_var(--color-line)]";
  return "whitespace-nowrap";
}

function stickyCellClass(id: string): string {
  if (id === "key")
    return "sticky left-9 z-20 bg-card shadow-[1px_0_0_var(--color-line)] group-odd:bg-background";
  if (id === "summary")
    return "sticky left-[11.25rem] z-20 bg-card shadow-[1px_0_0_var(--color-line)] group-odd:bg-background";
  return "";
}

function ExpandButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
      title={open ? "Collapse" : "Expand"}
    >
      <ChevronDown
        size={15}
        className={`transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function UserPill({
  user,
  link = false,
}: {
  user?: JiraUser | null | undefined;
  link?: boolean;
}) {
  if (!user) return <span className="text-muted-foreground">—</span>;
  const inner = (
    <>
      <Avatar
        src={user.avatarUrl}
        label={user.displayName || user.emailAddress || "U"}
      />
      <span className="truncate">
        {user.displayName ||
          user.emailAddress ||
          user.accountId ||
          "Unknown user"}
      </span>
    </>
  );
  if (link && user.userUrl)
    return (
      <a
        href={user.userUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex max-w-full items-center gap-2 text-primary hover:underline"
      >
        {inner}
        <ExternalLink size={12} className="shrink-0" />
      </a>
    );
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-muted-foreground">
      {inner}
    </span>
  );
}

function Avatar({
  src,
  label,
  square = false,
}: {
  src?: string | null | undefined;
  label: string;
  square?: boolean;
}) {
  const className = `inline-flex size-6 shrink-0 items-center justify-center ${square ? "rounded-md" : "rounded-full"} bg-muted text-xs font-semibold text-muted-foreground`;
  if (src)
    return <img src={src} alt="" className={`${className} object-cover`} />;
  return (
    <span className={className}>
      {label.trim().slice(0, 2).toUpperCase() || <UserRound size={12} />}
    </span>
  );
}

function IconLabel({
  iconUrl,
  label,
}: {
  iconUrl?: string | null;
  label?: string | null;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground">
      {iconUrl && <img src={iconUrl} alt="" className="size-4 shrink-0" />}
      <span className="truncate" title={label || undefined}>
        {label || "—"}
      </span>
    </span>
  );
}

function StatusChip({
  label,
  category,
  colorName,
}: {
  label?: string | null | undefined;
  category?: string | null;
  colorName?: string | null;
}) {
  const color = statusColorClass(colorName, category);
  return (
    <span
      className={`inline-flex max-w-full whitespace-nowrap rounded px-2 py-0.5 text-sm font-bold uppercase tracking-wide ${color}`}
      title={label || undefined}
    >
      <span className="truncate">{label || "—"}</span>
    </span>
  );
}

function statusColorClass(
  colorName?: string | null,
  category?: string | null,
): string {
  const value = `${colorName ?? ""} ${category ?? ""}`.toLowerCase();
  if (/green|done|closed/.test(value))
    return "bg-emerald-400/25 text-emerald-100";
  if (/yellow|progress/.test(value)) return "bg-blue-400/25 text-blue-100";
  if (/red|blocked/.test(value)) return "bg-red-400/25 text-red-100";
  if (/blue/.test(value)) return "bg-slate-400/25 text-slate-100";
  return "bg-muted text-muted-foreground";
}

function StatusPill({ active }: { active?: boolean | null | undefined }) {
  if (active === true)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-sm text-emerald-300">
        <ShieldCheck size={12} /> Active
      </span>
    );
  if (active === false)
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-1 text-sm text-destructive">
        Inactive
      </span>
    );
  return (
    <span className="rounded-full bg-muted px-2 py-1 text-sm text-muted-foreground">
      Unknown
    </span>
  );
}

function ChipList({ values }: { values: string[] }) {
  if (values.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex max-w-[18rem] flex-wrap gap-1">
      {values.slice(0, 5).map((value) => (
        <span
          key={value}
          className="rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground"
        >
          {value}
        </span>
      ))}
      {values.length > 5 && (
        <span className="text-sm text-muted-foreground">
          +{values.length - 5}
        </span>
      )}
    </span>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value?: string | null | undefined;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 break-words text-foreground">{value || "—"}</div>
    </div>
  );
}

function ExternalTitle({
  title,
  href,
  mono = false,
}: {
  title: string;
  href?: string | null | undefined;
  mono?: boolean;
}) {
  const className = `inline-flex min-w-0 items-center gap-1 ${mono ? "font-mono" : "font-medium"} text-primary hover:underline`;
  if (!href)
    return (
      <span className={mono ? "font-mono text-foreground" : "text-foreground"}>
        {title}
      </span>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      <span className="truncate">{title}</span>
      <ExternalLink size={12} className="shrink-0" />
    </a>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseJson(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
