/**
 * GitHub issue writes (every persona, gate `github`): approval-gated issue
 * creation, edits, comments, and label changes on issues AND pull requests —
 * GitHub keeps labels, assignees, state and comments on the issue that backs
 * every PR. Like `githubPrWriteTools.ts`, nothing writes during the model turn:
 * the tool stages a pending approval and the executor below runs only after the
 * user approves.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getGithubToolConfig } from "../../githubSettings.ts";
import {
  githubPaginate,
  githubRequest,
  resolveAuthenticatedLogin,
  type GithubApiConfig,
} from "../../githubClient.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { invalidateGithubPullRequestWrite } from "../../pullRequestInventorySync.ts";
import { resolveRepo } from "./githubTools.ts";
import { cleanLogins, isSelfAlias } from "./githubPrWriteTools.ts";
import type {
  ApprovalCard,
  GithubIssueApprovalBody,
  GithubIssueMutationOperation,
} from "@assistant/shared";

type MutateIssueParams = {
  repo: string;
  operation: GithubIssueMutationOperation;
  number?: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned";
  labels?: string[];
  assignees?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
  comment?: string;
};

/** The fields of an issue response the executor checks its writes against. */
type IssueData = {
  number?: number;
  html_url?: string;
  state?: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }>;
};

function namesOf(labels: IssueData["labels"]): Set<string> {
  return new Set(
    (labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase()),
  );
}

function loginsOf(issue: IssueData): Set<string> {
  return new Set(
    (issue.assignees ?? [])
      .map((user) => user.login?.toLowerCase())
      .filter((login): login is string => Boolean(login)),
  );
}

/** Requested names absent from `present` (compared case-insensitively). */
function missing(
  requested: readonly string[] | undefined,
  present: Set<string>,
): string[] {
  return (requested ?? []).filter((name) => !present.has(name.toLowerCase()));
}

/** Enough for any real repository's label set; the check only warns. */
const MAX_REPO_LABELS = 500;

/** Trimmed, de-duplicated case-insensitively (GitHub label names are). */
function cleanLabels(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of values ?? []) {
    const name = String(raw).trim();
    if (name && !out.some((item) => item.toLowerCase() === name.toLowerCase()))
      out.push(name);
  }
  return out;
}

/**
 * Map each requested label onto the repository's own spelling, and report the
 * ones it lacks: GitHub silently CREATES a label it is asked to add.
 */
async function resolveLabels(
  config: GithubApiConfig,
  repoPath: string,
  requested: string[],
  signal: AbortSignal | undefined,
): Promise<{ labels: string[]; missing: string[] }> {
  if (!requested.length) return { labels: [], missing: [] };
  const { items } = await githubPaginate<{ name?: string }>(
    config,
    `${repoPath}/labels`,
    {
      maxItems: MAX_REPO_LABELS,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  const known = new Map(
    items
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string")
      .map((name) => [name.toLowerCase(), name]),
  );
  return {
    labels: requested.map((name) => known.get(name.toLowerCase()) ?? name),
    missing: requested.filter((name) => !known.has(name.toLowerCase())),
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : undefined;
}

export const githubMutateIssueTool = defineAgentTool<MutateIssueParams>({
  name: "github_mutate_issue",
  label: "GitHub: Prepare Issue Changes",
  description:
    "Prepare a GitHub issue write for the user to approve: create an issue, edit one (title, description, open/closed state, assignees, labels), comment on it, or add/remove labels. `number` may be a pull request for label, comment, state and assignee changes — GitHub stores those on the issue behind every PR; a PR description or review goes through the github_*_pull_request tools. Use it only when the user asks for the change, and ask when the repository or value is ambiguous. Never writes until approved.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "operation"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      operation: {
        type: "string",
        enum: ["create", "edit", "comment", "label"],
        description:
          "create a new issue; edit fields; comment; label = only add/remove labels.",
      },
      number: {
        type: "number",
        description: "Issue or pull-request number. Required except on create.",
      },
      title: {
        type: "string",
        description: "create: required title. edit: replacement title.",
      },
      body: {
        type: "string",
        description:
          "create: description (Markdown). edit: COMPLETE replacement description; read the issue first, an empty string clears it.",
      },
      state: {
        type: "string",
        enum: ["open", "closed"],
        description: "edit: close or reopen.",
      },
      stateReason: {
        type: "string",
        enum: ["completed", "not_planned"],
        description: "edit: why it is closed. Defaults to completed.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "create: initial labels.",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description:
          "create: initial assignee logins. Only the exact string '@me' means the authenticated user.",
      },
      addLabels: {
        type: "array",
        items: { type: "string" },
        description:
          "edit/label: labels to add. A name the repository lacks is CREATED by GitHub; the card flags it.",
      },
      removeLabels: {
        type: "array",
        items: { type: "string" },
        description: "edit/label: labels to remove.",
      },
      addAssignees: {
        type: "array",
        items: { type: "string" },
        description:
          "edit: logins to assign. Only the exact string '@me' means the authenticated user.",
      },
      removeAssignees: {
        type: "array",
        items: { type: "string" },
        description: "edit: logins to unassign.",
      },
      comment: {
        type: "string",
        description: "comment: the comment text (Markdown).",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const repoName = `${owner}/${repo}`;
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const operation = params.operation;
    if (!["create", "edit", "comment", "label"].includes(operation))
      throw new Error("operation must be create, edit, comment, or label.");
    const number = positiveNumber(params.number);
    if (operation !== "create" && number === undefined)
      throw new Error(`${operation} needs the issue or pull-request number.`);

    // The alias is resolved on the RAW input, before `@` stripping makes `@me`
    // and the real account `me` look alike.
    const rawPeople = {
      assignees: params.assignees ?? [],
      addAssignees: params.addAssignees ?? [],
      removeAssignees: params.removeAssignees ?? [],
    };
    if (Object.values(rawPeople).some((list) => list.some(isSelfAlias))) {
      const self = await resolveAuthenticatedLogin(config, ctx.signal);
      if (!self)
        throw new Error(
          "Could not resolve '@me': the configured GitHub token did not return an authenticated user.",
        );
      for (const [key, list] of Object.entries(rawPeople))
        rawPeople[key as keyof typeof rawPeople] = list.map((value) =>
          isSelfAlias(value) ? self : value,
        );
    }

    const body: GithubIssueApprovalBody = {
      kind: "githubIssue",
      operation,
      repo: repoName,
      ...(number !== undefined && operation !== "create" ? { number } : {}),
    };
    let addLabels: string[] = [];

    if (operation === "create") {
      const title = params.title?.trim();
      if (!title) throw new Error("create needs a non-empty title.");
      body.title = title;
      const issueBody = params.body?.trim();
      if (issueBody) body.issueBody = issueBody;
      addLabels = cleanLabels(params.labels);
      const assignees = cleanLogins(rawPeople.assignees);
      if (assignees.length) body.assignees = assignees;
    } else if (operation === "comment") {
      const comment = params.comment?.trim();
      if (!comment) throw new Error("comment needs non-empty comment text.");
      body.commentBody = comment;
    } else {
      addLabels = cleanLabels(params.addLabels);
      const removeLabels = cleanLabels(params.removeLabels);
      // WHATWG URL parsing collapses a `.` or `..` path segment even when
      // percent-encoded, so the DELETE would reach a different endpoint.
      const unaddressable = removeLabels.filter((name) =>
        /^\.{1,2}$/.test(name),
      );
      if (unaddressable.length)
        throw new Error(
          `Cannot remove label ${unaddressable.map((name) => `'${name}'`).join(", ")}: GitHub's remove-label URL cannot address a name of only dots. Remove it in the GitHub UI.`,
        );
      if (removeLabels.length) body.removeLabels = removeLabels;
      if (operation === "edit") {
        const title = params.title?.trim();
        if (params.title !== undefined && !title)
          throw new Error("title cannot be empty.");
        if (title) body.title = title;
        if (params.body !== undefined) body.issueBody = params.body;
        if (params.state) body.state = params.state;
        if (params.stateReason) {
          if (params.state !== "closed")
            throw new Error("stateReason applies only with state: closed.");
          body.stateReason = params.stateReason;
        }
        const addAssignees = cleanLogins(rawPeople.addAssignees);
        const removeAssignees = cleanLogins(rawPeople.removeAssignees);
        if (addAssignees.length) body.addAssignees = addAssignees;
        if (removeAssignees.length) body.removeAssignees = removeAssignees;
      }
    }
    if (addLabels.length) {
      const { labels, missing } = await resolveLabels(
        config,
        repoPath,
        addLabels,
        ctx.signal,
      );
      if (operation === "create") body.labels = labels;
      else body.addLabels = labels;
      if (missing.length) body.newLabels = missing;
    }

    const changes = issueChangeLabels(body);
    if (operation !== "create" && operation !== "comment" && !changes.length)
      throw new Error(
        operation === "label"
          ? "Name at least one label to add or remove."
          : "Name at least one field to change.",
      );
    const target = number !== undefined ? `${repoName}#${number}` : repoName;
    const title =
      operation === "create"
        ? `Create GitHub issue in ${repoName}`
        : operation === "comment"
          ? `Comment on ${target}`
          : operation === "label"
            ? `Change labels on ${target}`
            : `Edit ${target}`;
    const summary =
      operation === "create"
        ? (body.title ?? "")
        : operation === "comment"
          ? target
          : changes.join(" · ");
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "githubIssue",
      title,
      ...(summary ? { summary } : {}),
      sourceToolCallId: ctx.toolCallId,
      body,
    });
    const newLabelNote = body.newLabels?.length
      ? ` Approving creates new label(s): ${body.newLabels.join(", ")}.`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `Prepared a GitHub issue ${operation} proposal for ${target} pending your approval.${newLabelNote} Do not claim it succeeded until the approved result appears. ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

/** The issue-field changes (one PATCH) an edit carries. */
function fieldChangeLabels(b: GithubIssueApprovalBody): string[] {
  if (b.operation !== "edit") return [];
  return [
    ...(b.title !== undefined ? ["retitle"] : []),
    ...(b.issueBody !== undefined ? ["replace description"] : []),
    ...(b.state === "closed"
      ? [`close${b.stateReason === "not_planned" ? " (not planned)" : ""}`]
      : b.state === "open"
        ? ["reopen"]
        : []),
  ];
}

/** Every change an edit/label proposal carries, for the card and the result. */
function issueChangeLabels(b: GithubIssueApprovalBody): string[] {
  const list = (verb: string, values?: string[]) =>
    values?.length ? [`${verb} ${values.join(", ")}`] : [];
  return [
    ...fieldChangeLabels(b),
    ...list("assign", b.addAssignees),
    ...list("unassign", b.removeAssignees),
    ...list("add label", b.addLabels),
    ...list("remove label", b.removeLabels),
  ];
}

registerApprovalExecutor("githubIssue", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "githubIssue")
      throw new Error("Mismatched approval body for githubIssue.");
    const b = card.body;
    try {
      return await executeApprovedIssueWrite(b);
    } finally {
      // The number may be a pull request whose state or labels the inventory
      // shows; a partial failure may already have changed it.
      if (b.number !== undefined && b.operation !== "comment") {
        const [owner, repoName] = b.repo.split("/");
        invalidateGithubPullRequestWrite(owner!, repoName!, b.number);
      }
    }
  },
});

async function executeApprovedIssueWrite(b: GithubIssueApprovalBody) {
  const config = getGithubToolConfig();
  const [owner, repoName] = b.repo.split("/");
  const repoPath = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repoName!)}`;
  const webUrl = (number: number) =>
    `https://github.com/${b.repo}/issues/${number}`;

  if (b.operation === "create") {
    const res = await githubRequest<IssueData>(
      config,
      "POST",
      `${repoPath}/issues`,
      {
        body: {
          title: b.title ?? "",
          body: b.issueBody ?? "",
          ...(b.labels?.length ? { labels: b.labels } : {}),
          ...(b.assignees?.length ? { assignees: b.assignees } : {}),
        },
      },
    );
    if (typeof res.data.number === "number") b.resultNumber = res.data.number;
    // GitHub silently drops labels and assignees the token may not set. The
    // issue exists either way, so the card stays executed and says what is
    // missing rather than failing a write that happened.
    const dropped = [
      ...missing(b.labels, namesOf(res.data.labels)).map(
        (name) => `label ${name}`,
      ),
      ...missing(b.assignees, loginsOf(res.data)).map(
        (login) => `assignee ${login}`,
      ),
    ];
    const created =
      b.resultNumber !== undefined
        ? `Created ${b.repo}#${b.resultNumber}`
        : `Created an issue in ${b.repo}`;
    return {
      resultSummary: dropped.length
        ? `${created}; warning: GitHub did not apply ${dropped.join(", ")} (the token needs push access, and an assignee needs access to the repository)`
        : created,
      ...(res.data.html_url !== undefined
        ? { resultUrl: res.data.html_url }
        : {}),
    };
  }

  const number = b.number;
  if (number === undefined)
    throw new Error("Proposal is missing its issue number.");
  const issuePath = `${repoPath}/issues/${number}`;

  if (b.operation === "comment") {
    const res = await githubRequest<{ html_url?: string }>(
      config,
      "POST",
      `${issuePath}/comments`,
      { body: { body: b.commentBody ?? "" } },
    );
    return {
      resultSummary: `Commented on ${b.repo}#${number}`,
      resultUrl: res.data.html_url ?? webUrl(number),
    };
  }

  // edit / label: each change is its own request, so a failure names the ones
  // that already landed rather than reading as "nothing happened". GitHub
  // answers 2xx while silently ignoring changes the token may not make, so
  // every step checks the issue it gets back.
  const ignored = (what: string) =>
    new Error(
      `GitHub answered but did not ${what} on ${b.repo}#${number}; the token needs push access, and an assignee needs access to the repository.`,
    );
  const fields = {
    ...(b.title !== undefined ? { title: b.title } : {}),
    ...(b.issueBody !== undefined ? { body: b.issueBody } : {}),
    ...(b.state !== undefined ? { state: b.state } : {}),
    ...(b.state === "closed"
      ? { state_reason: b.stateReason ?? "completed" }
      : {}),
  };
  const steps: Array<{ label: string; run: () => Promise<void> }> = [];
  if (Object.keys(fields).length)
    steps.push({
      label: fieldChangeLabels(b).join(", "),
      run: async () => {
        const res = await githubRequest<IssueData>(config, "PATCH", issuePath, {
          body: fields,
        });
        if (b.state !== undefined && res.data.state !== b.state)
          throw ignored(b.state === "closed" ? "close it" : "reopen it");
      },
    });
  if (b.addAssignees?.length)
    steps.push({
      label: `assign ${b.addAssignees.join(", ")}`,
      run: async () => {
        const res = await githubRequest<IssueData>(
          config,
          "POST",
          `${issuePath}/assignees`,
          { body: { assignees: b.addAssignees } },
        );
        const unmet = missing(b.addAssignees, loginsOf(res.data));
        if (unmet.length) throw ignored(`assign ${unmet.join(", ")}`);
      },
    });
  if (b.removeAssignees?.length)
    steps.push({
      label: `unassign ${b.removeAssignees.join(", ")}`,
      run: async () => {
        const res = await githubRequest<IssueData>(
          config,
          "DELETE",
          `${issuePath}/assignees`,
          { body: { assignees: b.removeAssignees } },
        );
        const present = loginsOf(res.data);
        const unmet = (b.removeAssignees ?? []).filter((login) =>
          present.has(login.toLowerCase()),
        );
        if (unmet.length) throw ignored(`unassign ${unmet.join(", ")}`);
      },
    });
  if (b.addLabels?.length)
    steps.push({
      label: `add label ${b.addLabels.join(", ")}`,
      run: async () => {
        const res = await githubRequest<IssueData["labels"]>(
          config,
          "POST",
          `${issuePath}/labels`,
          { body: { labels: b.addLabels } },
        );
        const unmet = missing(b.addLabels, namesOf(res.data));
        if (unmet.length) throw ignored(`add label ${unmet.join(", ")}`);
      },
    });
  for (const name of b.removeLabels ?? [])
    steps.push({
      label: `remove label ${name}`,
      run: async () => {
        try {
          await githubRequest(
            config,
            "DELETE",
            `${issuePath}/labels/${encodeURIComponent(name)}`,
          );
        } catch (error) {
          if (!/HTTP 404/.test(String(error))) throw error;
          // 404 also means a deleted issue or lost access. Only a READABLE
          // issue without the label is the requested end state.
          const issue = await githubRequest<IssueData>(
            config,
            "GET",
            issuePath,
          ).catch(() => {
            throw error;
          });
          if (namesOf(issue.data.labels).has(name.toLowerCase())) throw error;
        }
      },
    });
  const applied: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
      applied.push(step.label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        applied.length
          ? `${message} — already applied: ${applied.join("; ")}`
          : message,
      );
    }
  }
  return {
    resultSummary: `${b.repo}#${number} — ${applied.join("; ")}`,
    resultUrl: webUrl(number),
  };
}

export const githubIssueWriteTools = [githubMutateIssueTool];
