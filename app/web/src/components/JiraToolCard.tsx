import { useMemo } from "react";
import {
  ExternalLink,
  FolderKanban,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import type { DisplayBlock } from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { normalizedToolName } from "./tools/toolName.ts";
import {
  ChatWideCard,
  EmptyRow,
  ExpandableRow,
  ExternalTitle,
  Panel,
} from "./ChatWideCard.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
    <ChatWideCard
      maxWidth={1500}
      icon={<FolderKanban className="size-4 shrink-0 text-primary" />}
      title="Jira issue search"
      description={
        payload.jiraSearchUrl ? (
          <a
            href={payload.jiraSearchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1 font-mono text-primary hover:underline"
            title="Open JQL in Jira"
          >
            <span className="truncate">{payload.jql || "JQL search"}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <span className="font-mono">{payload.jql || "JQL search"}</span>
        )
      }
      meta={
        <>
          <div>
            {issues.length} issue{issues.length === 1 ? "" : "s"}
          </div>
          {payload.total !== undefined && <div>total {payload.total}</div>}
        </>
      }
    >
      <Table className="w-max min-w-full">
        <TableHeader>
          <TableRow>
            <TableHead className="w-9" aria-label="Expand" />
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={issueColumnClass(column.id)}
              >
                {column.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue, issueIndex) => (
            <JiraIssueRow
              key={issue.key ?? issue.id ?? issueIndex}
              issue={issue}
              columns={columns}
            />
          ))}
          {issues.length === 0 && (
            <EmptyRow span={columns.length + 1}>No Jira issues found.</EmptyRow>
          )}
        </TableBody>
      </Table>
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
  const fieldMap = useMemo(
    () => new Map((issue.fields ?? []).map((field) => [field.id, field])),
    [issue.fields],
  );
  return (
    <ExpandableRow
      expandLabel="Expand issue"
      collapseLabel="Collapse issue"
      span={columns.length + 1}
      cells={columns.map((column) => (
        <TableCell
          key={column.id}
          className={`${issueColumnClass(column.id)} align-top`}
        >
          {renderIssueCell(issue, column.id, fieldMap.get(column.id))}
        </TableCell>
      ))}
      details={<JiraIssueDetails issue={issue} fields={issue.fields ?? []} />}
    />
  );
}

function JiraIssueDetails({
  issue,
  fields,
}: {
  issue: JiraIssue;
  fields: JiraRenderField[];
}) {
  const returned = fields.filter((field) => field.valueText);
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <Panel title="Issue details">
        <div className="font-medium">
          <ExternalTitle
            title={`${issue.key ?? "Issue"}: ${issue.summary ?? ""}`}
            href={issue.issueUrl}
          />
        </div>
        {issue.descriptionMarkdown?.trim() ? (
          <div className="mt-3 max-h-72 min-w-0 overflow-auto">
            <Markdown text={issue.descriptionMarkdown} />
          </div>
        ) : issue.description?.trim() ? (
          <pre className="mt-3 max-h-72 overflow-auto font-sans whitespace-pre-wrap break-words">
            {issue.description}
          </pre>
        ) : (
          <p className="mt-3 text-muted-foreground">No description returned.</p>
        )}
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <dl className="grid grid-cols-2 gap-2">
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
          </dl>
        </Panel>
        <Panel title="Returned fields">
          <dl className="max-h-72 divide-y overflow-auto">
            {returned.map((field) => (
              <div key={field.id} className="flex gap-2 py-1.5">
                <dt
                  className="w-36 shrink-0 truncate text-muted-foreground"
                  title={field.id}
                >
                  {field.name}
                </dt>
                <dd className="min-w-0 break-words">{field.valueText}</dd>
              </div>
            ))}
          </dl>
          {returned.length === 0 && (
            <p className="text-muted-foreground">
              No non-empty extra fields returned.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function JiraProjectsCard({ payload }: { payload: JiraProjectsPayload }) {
  const projects = payload.projects ?? [];
  return (
    <ChatWideCard
      icon={<FolderKanban className="size-4 text-primary" />}
      title="Jira projects"
      description={payload.query || "Visible projects"}
      meta={
        <>
          <div>
            {projects.length} project{projects.length === 1 ? "" : "s"}
          </div>
          {payload.total !== undefined && <div>total {payload.total}</div>}
        </>
      }
    >
      <Table className="min-w-190">
        <TableHeader>
          <TableRow>
            <TableHead className="w-9" />
            <TableHead>Project</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Lead</TableHead>
            <TableHead>Issue types</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project, projectIndex) => (
            <ExpandableRow
              key={project.id ?? project.key ?? project.name ?? projectIndex}
              expandLabel="Expand project"
              collapseLabel="Collapse project"
              span={5}
              cells={
                <>
                  <TableCell className="align-top">
                    <div className="flex min-w-0 items-center gap-2">
                      <UserAvatar
                        src={project.avatarUrl}
                        label={project.key || project.name || "P"}
                      />
                      <div className="min-w-0">
                        <ExternalTitle
                          title={`${project.key ?? ""}${project.key && project.name ? " · " : ""}${project.name ?? ""}`}
                          href={project.projectUrl}
                        />
                        <div className="text-muted-foreground">
                          {project.id}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">
                    {project.projectTypeKey || "—"}
                    {project.category?.name ? (
                      <div>{project.category.name}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    <UserPill user={project.lead} />
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">
                    {project.issueTypes?.length ?? 0}
                  </TableCell>
                </>
              }
              details={<ProjectDetails project={project} />}
            />
          ))}
          {projects.length === 0 && (
            <EmptyRow span={5}>No Jira projects found.</EmptyRow>
          )}
        </TableBody>
      </Table>
    </ChatWideCard>
  );
}

function ProjectDetails({ project }: { project: JiraProject }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Description">
        <p className="whitespace-pre-wrap">
          {project.description || "No description returned."}
        </p>
      </Panel>
      <Panel title="Issue types">
        <div className="flex flex-wrap gap-1.5">
          {(project.issueTypes ?? []).map((type, typeIndex) => (
            <Badge key={type.id ?? type.name ?? typeIndex} variant="secondary">
              {type.iconUrl && <img src={type.iconUrl} alt="" />}
              {type.name}
            </Badge>
          ))}
          {!project.issueTypes?.length && (
            <span className="text-muted-foreground">
              No issue types returned.
            </span>
          )}
        </div>
      </Panel>
    </div>
  );
}

function JiraUsersCard({ payload }: { payload: JiraUsersPayload }) {
  const users = payload.users ?? [];
  return (
    <ChatWideCard
      maxWidth={1050}
      icon={<Users className="size-4 text-primary" />}
      title="Jira users"
      description={
        payload.assignableOnly
          ? `Assignable in ${payload.projectKey}`
          : payload.query || "Visible users"
      }
      meta={`${users.length} user${users.length === 1 ? "" : "s"}`}
    >
      <Table className="min-w-180">
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Account ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Timezone</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user, userIndex) => (
            <TableRow
              key={
                user.accountId ??
                user.emailAddress ??
                user.displayName ??
                user.self ??
                userIndex
              }
            >
              <TableCell>
                <UserPill user={user} link />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {user.emailAddress || "—"}
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">
                {user.accountId || "—"}
              </TableCell>
              <TableCell>
                {user.active === true ? (
                  <Badge variant="success">
                    <ShieldCheck /> Active
                  </Badge>
                ) : user.active === false ? (
                  <Badge variant="destructive">Inactive</Badge>
                ) : (
                  <Badge variant="outline">Unknown</Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {user.timeZone || user.accountType || "—"}
              </TableCell>
            </TableRow>
          ))}
          {users.length === 0 && (
            <EmptyRow span={5}>No Jira users found.</EmptyRow>
          )}
        </TableBody>
      </Table>
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
      <div className="truncate font-medium" title={issue.summary || undefined}>
        {issue.summary || "—"}
      </div>
    );
  if (id === "status")
    return (
      <Badge
        variant={statusVariant(
          issue.status?.colorName || field?.value?.colorName,
          issue.status?.category || field?.value?.category,
        )}
        title={issue.status?.name || field?.valueText || undefined}
      >
        {issue.status?.name || field?.valueText || "—"}
      </Badge>
    );
  if (id === "assignee")
    return issue.assignee ? (
      <UserPill user={issue.assignee} />
    ) : (
      <span className="text-muted-foreground">Unassigned</span>
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
      <span className="font-mono text-muted-foreground">
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
  if (id === "summary") return "w-128 min-w-96 max-w-128";
  if (
    id === "status" ||
    id === "created" ||
    id === "updated" ||
    id === "duedate"
  )
    return "w-44 min-w-44 max-w-44";
  if (id === "assignee" || id === "reporter") return "w-56 min-w-56 max-w-56";
  if (id === "issuetype" || id === "priority") return "w-40 min-w-40 max-w-40";
  return "w-48 min-w-48 max-w-48";
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
      <UserAvatar
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
        <ExternalLink className="size-3 shrink-0" />
      </a>
    );
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-muted-foreground">
      {inner}
    </span>
  );
}

function UserAvatar({
  src,
  label,
}: {
  src?: string | null | undefined;
  label: string;
}) {
  return (
    <Avatar size="sm">
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>
        {label.trim().slice(0, 2).toUpperCase() || <UserRound />}
      </AvatarFallback>
    </Avatar>
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

/** Jira's status colour family, as a Badge variant. */
function statusVariant(
  colorName?: string | null,
  category?: string | null,
): "success" | "secondary" | "destructive" | "outline" {
  const value = `${colorName ?? ""} ${category ?? ""}`.toLowerCase();
  if (/green|done|closed/.test(value)) return "success";
  if (/yellow|progress/.test(value)) return "secondary";
  if (/red|blocked/.test(value)) return "destructive";
  return "outline";
}

function ChipList({ values }: { values: string[] }) {
  if (values.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex max-w-72 flex-wrap gap-1">
      {values.slice(0, 5).map((value) => (
        <Badge key={value} variant="secondary">
          {value}
        </Badge>
      ))}
      {values.length > 5 && (
        <span className="text-muted-foreground">+{values.length - 5}</span>
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{value || "—"}</dd>
    </div>
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
