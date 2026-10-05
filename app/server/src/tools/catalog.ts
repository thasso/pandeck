/**
 * The harness-neutral tool catalog: every persona's toolset is composed of
 * {@link ToolGroup}s. A group carries the durable metadata the lazy-loading
 * machinery needs —
 *
 *  - `loading`: "eager" groups are in the model's initial context; "deferred"
 *    groups are discovered on demand (pi `find_tools`, Claude native tool
 *    search) so a session's first request stays small;
 *  - `gate`: the integration setting that must be enabled before the group's
 *    tools are active (Settings-driven, reconciled live via
 *    `integrationToolChanges.ts`);
 *  - `family`: "integration" groups form the assistant integration-tool
 *    universe reused by one-shot helper allowlists; "shared" groups are the
 *    cross-persona app tools.
 *
 * This module is the single source of truth for persona toolsets: the persona
 * registry (`agentTypes.ts`) and both harness wirings consume it. Keep tools
 * registered in EXACTLY ONE group per persona (guarded by catalog.test.ts).
 */
import {
  uniqueAgentTools,
  type AgentTool,
  type ToolSideEffects,
} from "../mcp/tool.ts";
import {
  type AgentType,
  isPersonalAssistantAgentType,
  type SessionMode,
} from "@assistant/shared";
import {
  currentIntegrationToolGates,
  isPlanModeToolAllowed,
  type IntegrationToolGates,
} from "./toolPolicy.ts";
import type { AuditToolInventory } from "../sessionAudit.ts";
// Type-only: the conditions are computed from `toolPolicy.ts`'s gates, one
// layer below this module, so this stays a shape reference and no more.
import type {
  PromptConditionKey,
  PromptConditions,
} from "../promptConditions.ts";
import {
  queuePostReloadContinuationTool,
  toolsForToolGroup,
} from "../mcp/toolGroups/registry.ts";
import { containerImageTools } from "./container/containerImageTools.ts";
import { backgroundTasksTools } from "./backgroundTasksTools.ts";
import { askQuestionsTool } from "./core/questionTool.ts";
import { assistantContactsTools } from "./core/contactsTools.ts";
import { lsTool } from "./core/lsTool.ts";
import { showFilesTool } from "./core/showFilesTool.ts";
import { assistantProjectRegistryTools } from "./core/projectRegistryTools.ts";
import { projectCreateTool } from "./core/projectCreateTool.ts";
import { assistantTimeTools } from "./core/timeTools.ts";
import { settingsTools } from "./settings/settingsTools.ts";
import {
  githubActivityTools,
  githubCiTools,
  githubCodeTools,
  githubCollaborationTools,
  githubRepositoryTools,
} from "./github/githubTools.ts";
import { githubPrWriteTools } from "./github/githubPrWriteTools.ts";
import { githubIssueWriteTools } from "./github/githubIssueWriteTools.ts";
import { githubRepoWriteTools } from "./github/githubRepoWriteTools.ts";
import { forgejoCiTools } from "./forgejo/forgejoCiTools.ts";
import { forgejoPrWriteTools } from "./forgejo/forgejoPrWriteTools.ts";
import { forgejoReleaseWriteTools } from "./forgejo/forgejoReleaseTools.ts";
import {
  forgejoCollaborationTools,
  forgejoContentTools,
  forgejoRepositoryTools,
} from "./forgejo/forgejoTools.ts";
import { assistantGoogleCalendarTools } from "./google/googleCalendarTools.ts";
import { assistantGoogleDriveTools } from "./google/googleDriveTools.ts";
import { assistantGoogleGmailArchiveTools } from "./google/googleGmailArchiveTools.ts";
import { assistantGoogleGmailTools } from "./google/googleGmailTools.ts";
import { assistantGoogleMeetTools } from "./google/googleMeetTools.ts";
import { assistantMeetingMinutesDiscoveryTools } from "./google/googleMeetingMinutesDiscoveryTools.ts";
import { assistantMeetingMinutesScannerTools } from "./google/meetingMinutesScannerTools.ts";
import { assistantConfluenceTools } from "./confluence/confluenceTools.ts";
import { assistantJiraTools } from "./jira/jiraTools.ts";
import { assistantAttachmentTools } from "./knowledge/attachmentTools.ts";
import { assistantDocumentTools } from "./knowledge/documentTools.ts";
import { assistantSpreadsheetTools } from "./knowledge/spreadsheetTools.ts";
import { assistantKnowledgeBaseTools } from "./knowledge/knowledgeBaseTools.ts";
import { memoryTools } from "./knowledge/memoryTools.ts";
import { skillLibraryTools } from "./skills/skillTools.ts";
import { sessionAuditTools } from "./sessions/sessionAuditTool.ts";
import { sessionControlTools } from "./sessions/sessionControlTool.ts";
import { sessionLogTools } from "./sessions/sessionLogTools.ts";
import { sessionLookupTools } from "./sessions/sessionLookupTools.ts";
import { sessionSendPromptTools } from "./sessions/sessionSendPromptTool.ts";
import { sessionSpawnTools } from "./sessions/sessionSpawnTool.ts";
import { assistantSlackHuddleTools } from "./slack/slackHuddleTools.ts";
import { assistantSlackTools } from "./slack/slackTools.ts";
import {
  taskToolsForKind,
  workflowCoordinatorTaskCreateTools,
} from "./tasks/taskTools.ts";
import { assistantTempoTools } from "./tempo/tempoTools.ts";
import { assistantTempoExportTools } from "./tempo/tempoExportTools.ts";
import { context7Tools } from "./web/context7Tools.ts";
import { webTools } from "./web/webTools.ts";
import { sessionSubmitResultTools } from "./workflow/sessionSubmitResultTool.ts";
import { workflowGateActionTools } from "./workflow/workflowGateActionTool.ts";
import { workflowStatusTools } from "./workflow/workflowStatusTool.ts";
import { assistantWorkshopHandoffTools } from "./workshop/workshopHandoffTool.ts";
import {
  worktreeReviewAuthorTools,
  worktreeReviewFixTools,
} from "./workshop/worktreeReviewTools.ts";
import { worktreeDeliveryTools } from "./workshop/worktreeDeliveryTools.ts";
import { gitPublishTagTool } from "./workshop/gitTagTools.ts";
import { worktreeTools } from "./workshop/worktreeTools.ts";

/** "eager" = in the initial model context; "deferred" = discovered on demand. */
type ToolLoading = "eager" | "deferred";

/** One catalog unit: a coherent set of tools with shared loading/gating. */
export interface ToolGroup {
  id: string;
  label: string;
  /** What the group does — matched by deferred-tool search alongside tool metadata. */
  description: string;
  /** Discriminating discovery vocabulary combined with each tool's own hint. */
  searchHint?: string;
  loading: ToolLoading;
  /**
   * Session-start condition that keeps an `eager` group eager. Without it the
   * group is deferred for that session — the tools stay in the universe and
   * remain discoverable, they just do not cost every first request.
   */
  eagerWhen?: PromptConditionKey;
  /** "integration" groups form the assistant integration universe (one-shot allowlists). */
  family: "shared" | "integration";
  /** Integration gate that must be enabled for the group's tools to be active. */
  gate?: keyof IntegrationToolGates;
  tools: Array<AgentTool & { sideEffects: ToolSideEffects }>;
}

type UnclassifiedToolGroup = Omit<ToolGroup, "tools"> & { tools: AgentTool[] };

/**
 * The explicit side-effect decision for the complete catalog. This is kept
 * beside composition rather than inferred from names or execute call sites: a
 * new registration fails while building the catalog until it is classified.
 */
const TOOL_SIDE_EFFECTS: Record<string, ToolSideEffects> = {
  current_time: "none",
  ask_questions: "none",
  memory_search: "none",
  memory_manage: "local",
  settings_read: "none",
  settings_update: "local",
  settings_request_input: "local",
  accounts_read: "none",
  models_read: "none",
  accounts_update: "local",
  accounts_sign_in: "local",
  task_read: "none",
  task_manage: "local",
  list_attachments: "none",
  read_attachment: "none",
  kb_search: "none",
  kb_get_entry: "none",
  kb_show_entry: "none",
  kb_tree: "none",
  kb_write_entry: "local",
  kb_edit_entry: "local",
  kb_add_asset: "local",
  kb_list_assets: "none",
  kb_read_asset: "none",
  kb_read_extract: "none",
  kb_move_entry: "local",
  kb_history: "none",
  kb_diff: "none",
  skill_list: "none",
  skill_get: "none",
  skill_read_file: "none",
  skill_history: "none",
  skill_diff: "none",
  skill_create: "local",
  skill_edit: "local",
  skill_manage_files: "local",
  skill_rename: "local",
  skill_delete: "local",
  convert_pdf: "local",
  convert_xlsx: "local",
  workshop_draft_handoff: "local",
  project_registry_read: "none",
  project_registry_write: "local",
  project_create: "external",
  contacts_lookup: "none",
  contacts_manage: "local",
  session_read: "none",
  session_search: "none",
  session_lookup: "none",
  session_audit: "none",
  session_control: "local",
  session_send_prompt: "local",
  session_spawn: "local",
  web_search: "none",
  web_fetch: "none",
  context7_resolve_library: "none",
  context7_get_docs: "none",
  jira_get_issue: "none",
  jira_search_issues: "none",
  jira_lookup: "none",
  jira_mutate_issue: "external",
  confluence_search: "none",
  confluence_get_page: "none",
  confluence_lookup: "none",
  confluence_download_attachment: "local",
  confluence_mutate_page: "external",
  tempo_list_worklogs: "none",
  tempo_mutate_worklogs: "external",
  tempo_export_worklogs: "local",
  tempo_export_report: "local",
  google_calendar_list_events: "none",
  google_drive_search_files: "none",
  google_drive_get_file: "none",
  google_drive_download: "local",
  google_gmail_read: "none",
  google_gmail_archive: "external",
  google_meet_list_records: "none",
  meeting_minutes_discovery: "none",
  meeting_minutes_scan_source: "local",
  slack_search: "none",
  slack_conversation_read: "none",
  slack_thread_read: "none",
  slack_unread: "none",
  slack_file_read: "none",
  slack_huddle_history: "none",
  github_list_repositories: "none",
  github_search_repositories: "none",
  github_search_code: "none",
  github_get_content: "none",
  github_list_notifications: "none",
  github_search_issues: "none",
  github_get_issue: "none",
  github_get_pull_request: "none",
  github_org_activity: "none",
  github_watch_pull_request_checks: "none",
  github_get_ref_checks: "none",
  github_list_actions_runs: "none",
  github_get_actions_run: "none",
  github_get_actions_job_log: "none",
  forgejo_list_repositories: "none",
  forgejo_search_repositories: "none",
  forgejo_list_notifications: "none",
  forgejo_search_issues: "none",
  forgejo_get_issue: "none",
  forgejo_get_pull_request: "none",
  forgejo_get_content: "none",
  forgejo_watch_pull_request_checks: "none",
  forgejo_get_ref_checks: "none",
  forgejo_list_actions_runs: "none",
  forgejo_get_actions_run: "none",
  ls: "none",
  show_files: "none",
  review_comments_list: "none",
  review_comment_reply: "local",
  review_comment_resolve: "local",
  review_comment_create: "local",
  review_set_open: "local",
  review_set_close: "local",
  worktree_create: "local",
  worktree_status: "none",
  worktree_set_base: "local",
  worktree_remove: "local",
  worktree_commit: "local",
  worktree_push: "external",
  git_publish_tag: "external",
  worktree_create_pull_request: "external",
  worktree_ready_pull_request: "external",
  worktree_finish_pull_request: "external",
  workshop_defer_after_reload: "local",
  workflow_status: "none",
  workflow_gate_action: "external",
  session_submit_result: "local",
  browser_navigate: "external",
  browser_snapshot: "none",
  browser_click: "external",
  browser_fill: "external",
  browser_press: "external",
  browser_resize_viewport: "external",
  browser_screenshot: "local",
  browser_console: "none",
  browser_network: "none",
  browser_close: "external",
  browser_mcp_call: "external",
  github_create_pull_request: "external",
  github_edit_pull_request: "external",
  github_ready_pull_request: "external",
  github_review_pull_request: "external",
  github_comment_pull_request: "external",
  github_assign_pull_request: "external",
  github_mutate_issue: "external",
  github_rerun_actions_run: "external",
  github_delete_branch: "external",
  forgejo_create_pull_request: "external",
  forgejo_edit_pull_request: "external",
  forgejo_ready_pull_request: "external",
  forgejo_review_pull_request: "external",
  forgejo_comment_pull_request: "external",
  forgejo_create_release: "external",
  container_image_pull: "local",
  background_tasks: "local",
};

function classifyToolGroups(groups: UnclassifiedToolGroup[]): ToolGroup[] {
  return groups.map((group) => ({
    ...group,
    tools: group.tools.map((tool) => {
      const sideEffects = TOOL_SIDE_EFFECTS[tool.name];
      if (!sideEffects)
        throw new Error(
          `Catalog tool ${tool.name} needs an explicit sideEffects classification.`,
        );
      return { ...tool, sideEffects };
    }),
  }));
}

const KNOWLEDGE_CORE_TOOL_NAMES = new Set(["kb_search", "kb_get_entry"]);

function knowledgeCoreTools(): AgentTool[] {
  return assistantKnowledgeBaseTools.filter((tool) =>
    KNOWLEDGE_CORE_TOOL_NAMES.has(tool.name),
  );
}

function knowledgeManagementTools(): AgentTool[] {
  return assistantKnowledgeBaseTools.filter(
    (tool) => !KNOWLEDGE_CORE_TOOL_NAMES.has(tool.name),
  );
}

/** Groups shared by every persona (assistant and coding alike). */
function commonToolGroups(agentType: AgentType): UnclassifiedToolGroup[] {
  return [
    // ------------------------------- eager --------------------------------
    {
      id: "time",
      label: "Time",
      description: "Current date and time with timezone information.",
      loading: "eager",
      family: "integration",
      tools: assistantTimeTools,
    },
    {
      id: "questions",
      label: "Questions",
      description:
        "Ask the user interactive structured questions in the web UI.",
      loading: "eager",
      family: "shared",
      tools: [askQuestionsTool],
    },
    {
      id: "memory",
      label: "Memory",
      description:
        "Long-term memory: search and manage durable preferences, facts, constraints, and working state.",
      loading: "eager",
      eagerWhen: "memoryEnabled",
      gate: "memory",
      family: "shared",
      tools: memoryTools,
    },
    {
      id: "tasks",
      label: "Tasks",
      description:
        "Durable Tasks: read, search, create, update, and comment on the user's task list.",
      loading: "eager",
      family: "shared",
      tools: taskToolsForKind(agentType),
    },
    {
      id: "attachments",
      label: "Attachments",
      description: "List and read files attached to this session.",
      // Eager only for a session whose FIRST PROMPT carried user files
      // (Task 287): most sessions never carry one, and a session that gains a
      // file later reaches these two tools through an ordinary tool search
      // rather than moving the prompt prefix mid-conversation. The hidden
      // Task/Project context attachments deliberately do not count — they are
      // inlined in the prompt, so `list_attachments` can report an attachment
      // a session has no eager tool for, which is the accepted trade.
      loading: "eager",
      eagerWhen: "attachments",
      family: "integration",
      tools: assistantAttachmentTools,
    },
    // ------------------------------ deferred ------------------------------
    {
      id: "knowledge-core",
      label: "Knowledge Base search",
      description:
        "Knowledge Base retrieval for durable notes, briefs, decisions, plans, and project references already recorded by the user.",
      searchHint:
        "knowledge base kb durable recorded knowledge notes briefs decisions reference already know",
      // Deferred (Task-286): most sessions never consult the KB, so its two
      // read tools are not worth the ~1.36k chars they cost every first
      // request. The eager KB prompt pointer keeps the Knowledge Base
      // DISCOVERABLE, and both harnesses reach these tools in one search
      // round trip.
      loading: "deferred",
      family: "integration",
      tools: knowledgeCoreTools(),
    },
    {
      id: "knowledge",
      label: "Knowledge Base management",
      description:
        "Knowledge Base authoring and organization: entries, targeted edits, assets, history, diffs, and anchored comment threads.",
      searchHint:
        "knowledge base kb entry asset history diff comment durable documentation",
      loading: "deferred",
      family: "integration",
      tools: knowledgeManagementTools(),
    },
    {
      id: "skills",
      label: "Skills library",
      description:
        "The user's central skills library: list and read skills and the reference files beside them, author and validate SKILL.md and supporting files, rename or delete a skill, and inspect the library's Git history and diffs. Every mutation is one commit in the user's own skills repository.",
      searchHint:
        "skill skills library author create edit validate history diff rename delete supporting files references SKILL.md",
      // Deferred: most sessions never author a skill, and the four personas
      // that may do it reach the group in one search round trip.
      loading: "deferred",
      family: "shared",
      tools: skillLibraryTools,
    },
    {
      id: "show-files",
      label: "Show files",
      description:
        "Show a file that already exists on this host in the chat — image, Markdown, HTML document or download — by linking where it lives, without copying it.",
      searchHint:
        "show file image picture screenshot markdown html document preview inline chat card link download attach",
      // Deferred: the prompt already states the URL form, so an agent that only
      // needs a link writes one. This is for the checked snippet.
      loading: "deferred",
      family: "shared",
      tools: [showFilesTool],
    },
    {
      id: "documents",
      label: "Documents",
      description:
        "Convert PDF documents to Markdown and XLSX workbooks to CSV tables (session attachments, host files or KB assets).",
      loading: "deferred",
      family: "integration",
      tools: [...assistantDocumentTools, ...assistantSpreadsheetTools],
    },
    {
      id: "workshop-handoff",
      label: "Workshop handoff",
      description:
        "Draft and hand off app-improvement proposals to a Workshop coding session.",
      loading: "deferred",
      family: "integration",
      tools: assistantWorkshopHandoffTools,
    },
    {
      id: "project-registry",
      label: "Project registry",
      description:
        "Local Project registry records: canonical project context, filesystem/repository mappings, and linked Git or Jira identities; approval-gated creation of a new Project with its GitHub or Forgejo repository.",
      searchHint:
        "project registry repo repository mapping local path folder jira project context create new project github forgejo",
      loading: "deferred",
      family: "shared",
      tools: [...assistantProjectRegistryTools, projectCreateTool],
    },
    {
      id: "contacts",
      label: "Contacts",
      description:
        "Contacts directory identities: colleagues, work ids, roles, and responsibility-area routing.",
      searchHint:
        "contacts directory person colleague identity email slack jira responsibility",
      loading: "deferred",
      family: "shared",
      tools: assistantContactsTools,
    },
    {
      id: "background-tasks",
      label: "Background tasks",
      description:
        "Recover and inspect this session's governed background work, or Stop one task or all owned work by PA task id. Completion is delivered automatically; list and status are recovery and inspection, not polling.",
      searchHint:
        "background task process monitor shell status stop stop-all recovery inspection",
      loading: "deferred",
      family: "shared",
      tools: backgroundTasksTools(),
    },
    {
      id: "sessions",
      label: "Sessions",
      description:
        "Other agent-session operations: identify a session, inspect or search its transcript, audit its token context, deliver a peer prompt, inspect the approved runtime roster, directly start exact-profile peers, or propose new sessions for the user to approve.",
      searchHint:
        "another agent session transcript log inspect lookup audit send peer prompt spawn create delegate",
      loading: "deferred",
      family: "shared",
      tools: [
        ...sessionLogTools(),
        ...sessionLookupTools(),
        ...sessionAuditTools(catalogAuditInventory),
        ...sessionSendPromptTools(),
        ...sessionSpawnTools(),
      ],
    },
    {
      id: "session-controls",
      label: "Session controls",
      description:
        "Stop a still-owned spawned child or retract queued peer deliveries.",
      searchHint:
        "stop abort spawned child cancel retract remove queued delivery clear queue",
      loading: "deferred",
      family: "shared",
      tools: sessionControlTools(),
    },
    {
      id: "web",
      label: "Web",
      description:
        "Public web research: Brave search and fetching pages as Markdown.",
      loading: "deferred",
      family: "shared",
      tools: webTools,
    },
    {
      id: "context7",
      label: "Context7 docs",
      description:
        "Context7 library-id resolution and current framework/API documentation snippets.",
      searchHint:
        "context7 library framework package api docs documentation current version",
      loading: "deferred",
      family: "shared",
      tools: context7Tools,
    },
    // --------------------------- deferred, gated --------------------------
    {
      id: "jira",
      label: "Jira",
      description:
        "Jira issues: read, search (JQL), field/project/user lookup, and approval-gated mutations.",
      loading: "deferred",
      family: "integration",
      gate: "jira",
      tools: assistantJiraTools,
    },
    {
      id: "confluence",
      label: "Confluence",
      description:
        "Confluence pages: CQL search, read a page as Markdown, space/tree/label discovery, attachment downloads, and approval-gated page and attachment writes.",
      loading: "deferred",
      family: "integration",
      gate: "confluence",
      tools: assistantConfluenceTools,
    },
    {
      id: "tempo",
      label: "Tempo",
      description:
        "Tempo worklogs: list time entries, export and report on whole date ranges, and propose approval-gated worklog changes.",
      loading: "deferred",
      family: "integration",
      gate: "tempo",
      tools: [...assistantTempoTools, ...assistantTempoExportTools],
    },
    {
      id: "google-calendar",
      label: "Google Calendar",
      description:
        "Google Calendar events: agendas, attendees, and Meet conference details.",
      loading: "deferred",
      family: "integration",
      gate: "google",
      tools: assistantGoogleCalendarTools,
    },
    {
      id: "google-drive",
      label: "Google Drive",
      description:
        "Google Drive: search, read/export document text, and download files or zipped folders.",
      loading: "deferred",
      family: "integration",
      gate: "google",
      tools: assistantGoogleDriveTools,
    },
    {
      id: "google-gmail",
      label: "Gmail",
      description:
        "Gmail: search email threads, read messages, and prepare approval-gated archives.",
      loading: "deferred",
      family: "integration",
      gate: "google",
      tools: [
        ...assistantGoogleGmailTools,
        ...assistantGoogleGmailArchiveTools,
      ],
    },
    {
      id: "google-meet",
      label: "Google Meet",
      description:
        "Google Meet conference records, participants, and attendance evidence.",
      loading: "deferred",
      family: "integration",
      gate: "google",
      tools: assistantGoogleMeetTools,
    },
    {
      id: "google-minutes",
      label: "Meeting minutes",
      description:
        "Discover and scan meeting-minutes sources across Calendar, Drive, and Gmail for action items.",
      loading: "deferred",
      family: "integration",
      gate: "google",
      tools: [
        ...assistantMeetingMinutesDiscoveryTools,
        ...assistantMeetingMinutesScannerTools,
      ],
    },
    {
      id: "slack",
      label: "Slack",
      description:
        "Slack: search messages, read conversations/threads/files, and aggregate unreads.",
      loading: "deferred",
      family: "integration",
      gate: "slack",
      tools: assistantSlackTools,
    },
    {
      id: "slack-huddles",
      label: "Slack Huddles",
      description:
        "Personal Slack Huddle attendance history (experimental browser-session capability).",
      loading: "deferred",
      family: "integration",
      gate: "slackHuddles",
      tools: assistantSlackHuddleTools,
    },
    {
      id: "github-repositories",
      label: "GitHub repositories",
      description:
        "GitHub: enumerate accessible repositories (incl. private org/collaborator repos) and search repository metadata/README.",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubRepositoryTools,
    },
    {
      id: "github-code",
      label: "GitHub code",
      description:
        "GitHub: search code across accessible repositories and read files/directories at a ref.",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubCodeTools,
    },
    {
      id: "github-collaboration",
      label: "GitHub collaboration",
      description:
        "GitHub: notifications, issue/PR search, and detailed issue and pull-request reads (commits, files, reviews, inline threads).",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubCollaborationTools,
    },
    {
      id: "github-activity",
      label: "GitHub activity",
      description:
        "GitHub: per-repo org/day activity digest (pushes/PRs/issues/releases).",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubActivityTools,
    },
    {
      id: "github-ci",
      label: "GitHub CI",
      description:
        "GitHub: watch a pull request until checks finish, inspect ref checks and Actions runs/jobs/steps, and read bounded job logs.",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubCiTools,
    },
    {
      id: "github-issue-writes",
      label: "GitHub issue writes",
      description:
        "GitHub: approval-gated issue creation, edits, comments, and label changes on issues and pull requests.",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubIssueWriteTools,
    },
    {
      id: "forgejo-repositories",
      label: "Forgejo repositories",
      description:
        "Forgejo: enumerate repositories on the configured instance and search them by keyword/topic.",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoRepositoryTools,
    },
    {
      id: "forgejo-collaboration",
      label: "Forgejo collaboration",
      description:
        "Forgejo: notifications, structured issue/PR search, and detailed issue and pull-request reads (commits, files, diff, reviews, inline comments).",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoCollaborationTools,
    },
    {
      id: "forgejo-content",
      label: "Forgejo content",
      description:
        "Forgejo: read files and list directories in a repository at a ref (the instance has no code search).",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoContentTools,
    },
    {
      id: "forgejo-ci",
      label: "Forgejo CI",
      description:
        "Forgejo: watch a pull request until checks finish, inspect ref checks, and read Actions workflow runs with their jobs and web log links.",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoCiTools,
    },
  ];
}

/**
 * The Settings page as tools ([Task-729](pa://task/729)), for the Personal
 * Assistant only: it is the user's own assistant, the one that should be able
 * to configure the app for them.
 */
function settingsToolGroup(): UnclassifiedToolGroup {
  return {
    id: "settings",
    label: "Settings",
    description:
      "Read and change the app's settings: models, integrations and their connection tests, assistant behaviour, automation, developer workflow; ask the user for a secret or an account connection through a card; manage and sign in the Claude and OpenAI accounts models run on.",
    searchHint:
      "settings configuration configure preferences enable disable integration model account token api key connect credential profile login sign in",
    loading: "deferred",
    family: "shared",
    tools: settingsTools,
  };
}

/** Extra groups for the coding personas (workshop/developer). */
function codingToolGroups(): UnclassifiedToolGroup[] {
  return [
    {
      id: "listing",
      label: "Directory listing",
      description:
        "Bounded, alias-free directory listing (replaces pi's `ls` builtin).",
      // Eager: a deferred listing tool would cost a discovery round trip and be
      // strictly worse than the shell `ls` it exists to replace (Task-319).
      loading: "eager",
      family: "shared",
      tools: [lsTool],
    },
    {
      id: "worktree-review",
      label: "Worktree review",
      description:
        "Review comment threads on the current worktree: list, reply, and resolve.",
      loading: "eager",
      family: "shared",
      tools: worktreeReviewFixTools,
    },
    {
      id: "worktrees",
      label: "Managed worktrees",
      description:
        "Create, inspect, retarget and remove registered git worktrees across projects.",
      loading: "deferred",
      family: "shared",
      tools: worktreeTools,
    },
    {
      id: "managed-delivery",
      label: "Managed worktree delivery",
      description:
        "Checked commit, push and pull-request delivery for managed worktrees; publish a checked git tag from an ordinary or managed checkout.",
      loading: "deferred",
      family: "shared",
      tools: worktreeDeliveryTools,
    },
    {
      id: "git-tags",
      label: "Git tags",
      description:
        "Approval-gated lightweight tag creation and publication from an ordinary or managed checkout; release publication uses the separate Forgejo release tool.",
      searchHint: "git tag create publish push version tag release approval",
      loading: "deferred",
      family: "shared",
      tools: [gitPublishTagTool],
    },
    {
      id: "worktree-review-authoring",
      label: "Worktree review authoring",
      description:
        "Open and close review sets and create anchored findings on the current worktree.",
      loading: "deferred",
      family: "shared",
      tools: worktreeReviewAuthorTools,
    },
    {
      id: "post-reload",
      label: "Post-reload continuation",
      description:
        "Queue an automatic follow-up prompt to run after the dev server reloads.",
      // Eager: the agent must always be able to queue a continuation (before a
      // reload cuts the turn short) without a discovery round-trip first.
      loading: "eager",
      family: "shared",
      tools: [queuePostReloadContinuationTool],
    },
    {
      id: "workflow",
      label: "Workflow results",
      description:
        "Submit the structured terminal result for the Workflow Run step assigned to this session.",
      loading: "deferred",
      family: "shared",
      tools: sessionSubmitResultTools(),
    },
    {
      id: "browser",
      label: "Browser testing",
      description:
        "Curated Playwright MCP browser tools for local web UI testing (screenshots/traces are stored as session artifacts).",
      loading: "deferred",
      family: "shared",
      tools: toolsForToolGroup("browser"),
    },
    {
      id: "browser-raw-mcp",
      label: "Raw browser MCP",
      description:
        "Advanced escape hatch for Playwright MCP capabilities missing from the standard browser tools.",
      loading: "deferred",
      family: "integration",
      gate: "browserRawMcp",
      tools: toolsForToolGroup("browser-raw-mcp"),
    },
    {
      id: "github-pr-writes",
      label: "GitHub PR writes",
      description:
        "GitHub: approval-gated pull-request creation, draft-to-ready transitions, description edits, reviews, comments, and reviewer/assignee changes (coding personas only).",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubPrWriteTools,
    },
    {
      id: "github-repo-writes",
      label: "GitHub CI and branch writes",
      description:
        "GitHub: re-run finished Actions runs (immediate) and approval-gated remote branch deletion (coding personas only).",
      loading: "deferred",
      family: "integration",
      gate: "github",
      tools: githubRepoWriteTools,
    },
    {
      id: "forgejo-pr-writes",
      label: "Forgejo PR writes",
      description:
        "Forgejo: approval-gated pull-request creation, WIP-to-ready transitions, description edits, reviews, and comments on the configured self-hosted instance (coding personas only).",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoPrWriteTools,
    },
    {
      id: "forgejo-releases",
      label: "Forgejo releases",
      description:
        "Forgejo: approval-gated release publication (annotated tag plus notes) on the configured self-hosted instance; a repository may deploy from the release event (coding personas only).",
      loading: "deferred",
      family: "integration",
      gate: "forgejo",
      tools: forgejoReleaseWriteTools,
    },
    {
      id: "container-images",
      label: "Container images",
      description:
        "Pull container images (including private ghcr.io builder images) onto the host so worktree builds can use them; credentials stay server-side.",
      loading: "deferred",
      family: "integration",
      // Credentials come from the GitHub integration, so it shares that gate.
      gate: "github",
      tools: containerImageTools,
    },
  ];
}

/** Workshop-only tools that are meaningless for a generic prod coding agent. */
const DEVELOPER_EXCLUDED_TOOLS = new Set([
  "workshop_defer_after_reload",
  "workshop_draft_handoff",
]);

/**
 * The persona's tool groups — the single source of truth both harnesses and
 * the persona registry compose from. Group `tools` arrays are already
 * persona-filtered (developer exclusions applied).
 */
export function toolGroupsFor(agentType: AgentType): ToolGroup[] {
  if (agentType === "workflow-coordinator")
    return classifyToolGroups([
      {
        id: "workflow",
        label: "Workflow run",
        description:
          "Read this coordinator session's run status and submit structured assignment results.",
        loading: "eager",
        family: "shared",
        tools: [...workflowStatusTools(), ...sessionSubmitResultTools()],
      },
      {
        id: "workflow-actions",
        label: "Workflow user decisions",
        description:
          "User-instructed aliases of this run's currently offered card controls.",
        loading: "deferred",
        family: "shared",
        tools: workflowGateActionTools(),
      },
      {
        id: "workflow-follow-up-tasks",
        label: "Workflow follow-up Tasks",
        description:
          "Create user-requested follow-up Tasks with Workflow Run provenance.",
        loading: "deferred",
        family: "shared",
        tools: workflowCoordinatorTaskCreateTools(),
      },
    ]);
  const groups = [
    ...commonToolGroups(agentType),
    ...(agentType === "workshop" || agentType === "developer"
      ? codingToolGroups()
      : []),
    ...(isPersonalAssistantAgentType(agentType) ? [settingsToolGroup()] : []),
  ];
  const personaGroups =
    agentType !== "developer"
      ? groups
      : groups
          .map((group) => ({
            ...group,
            tools: group.tools.filter(
              (tool) => !DEVELOPER_EXCLUDED_TOOLS.has(tool.name),
            ),
          }))
          .filter((group) => group.tools.length > 0);
  return classifyToolGroups(personaGroups);
}

/**
 * This catalog as `sessionAudit.ts` reads it. The audit is reached from the
 * `session_audit` tool, which this module registers, so the dependency runs one
 * way only: the catalog hands its inventory down, and nothing under `tools/`
 * reads the catalog back.
 */
export const catalogAuditInventory: AuditToolInventory = {
  toolsFor: (agentType) =>
    toolGroupsFor(agentType).flatMap((group) =>
      group.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        group: group.id,
        loading: group.loading,
      })),
    ),
  eagerToolNames: (agentType, conditions) =>
    eagerToolNamesFor(agentType, conditions),
};

/** Claude ToolSearch metadata: combine a tool-specific hint with its family vocabulary. */
export function catalogSearchHintFor(
  agentType: AgentType,
  toolName: string,
): string | undefined {
  for (const group of toolGroupsFor(agentType)) {
    const tool = group.tools.find((candidate) => candidate.name === toolName);
    if (!tool) continue;
    const hint = [tool.searchHint, group.searchHint].filter(Boolean).join(" ");
    return hint || undefined;
  }
  return undefined;
}

/** The persona's full flat tool universe (deduped, registration order). */
export function agentToolsFor(agentType: AgentType): AgentTool[] {
  return uniqueAgentTools(
    toolGroupsFor(agentType).flatMap((group) => group.tools),
  );
}

/**
 * Names of the persona's eager tools (initial model context).
 *
 * `conditions` are the session's FROZEN session-start conditions
 * (`promptConditions.ts`): a group with `eagerWhen` is eager only for a session
 * whose condition holds, and deferred (still discoverable) for the rest. Omit
 * them and every eager group is eager, which is what a measurement or a caller
 * without a session wants.
 */
export function eagerToolNamesFor(
  agentType: AgentType,
  conditions?: PromptConditions,
): Set<string> {
  return new Set(
    toolGroupsFor(agentType)
      .filter(
        (group) =>
          group.loading === "eager" &&
          (!group.eagerWhen || (conditions?.[group.eagerWhen] ?? true)),
      )
      .flatMap((group) => group.tools.map((tool) => tool.name)),
  );
}

/**
 * Apply the Build/Plan tool policy to an otherwise-active catalog set.
 * Build is intentionally an identity projection; Plan retains read-only tools,
 * the Task manager, and `session_spawn` for its read-only runtime-profile
 * operation. The tool itself refuses its session-creating operations in Plan.
 */
export function modeGatedActiveToolNames(
  mode: SessionMode,
  tools: AgentTool[],
  otherwiseActive: ReadonlySet<string>,
): ReadonlySet<string> {
  if (mode === "build") return otherwiseActive;
  return new Set(
    tools
      .filter(
        (tool) => isPlanModeToolAllowed(tool) && otherwiseActive.has(tool.name),
      )
      .map((tool) => tool.name),
  );
}

/** Integration-family tools passing the given gates (one-shot allowlists, tests). */
export function integrationToolsForGates(
  gates: IntegrationToolGates,
): AgentTool[] {
  return toolGroupsFor("assistant")
    .filter(
      (group) =>
        group.family === "integration" && (!group.gate || gates[group.gate]),
    )
    .flatMap((group) => group.tools);
}

/** Integration-family tools passing the CURRENT gates. */
export function assistantIntegrationTools(): AgentTool[] {
  return integrationToolsForGates(currentIntegrationToolGates());
}

/** Full integration universe regardless of gates (live-session registration). */
export function assistantIntegrationToolUniverse(): AgentTool[] {
  return toolGroupsFor("assistant")
    .filter((group) => group.family === "integration")
    .flatMap((group) => group.tools);
}

/**
 * Apply current integration gates to an otherwise-active tool-name set. Takes
 * the persona explicitly (rather than assuming "assistant") so a gate on a
 * coding-only group (e.g. `browserRawMcp`) is actually enforced for workshop/
 * developer sessions, not silently bypassed.
 */
export function integrationGatedActiveToolNames(
  agentType: AgentType,
  tools: AgentTool[],
  otherwiseActive: ReadonlySet<string>,
): ReadonlySet<string> {
  const gates = currentIntegrationToolGates();
  const gatedOff = new Set(
    toolGroupsFor(agentType)
      .filter((group) => group.gate && !gates[group.gate])
      .flatMap((group) => group.tools.map((tool) => tool.name)),
  );
  return new Set(
    tools
      .filter(
        (tool) => otherwiseActive.has(tool.name) && !gatedOff.has(tool.name),
      )
      .map((tool) => tool.name),
  );
}
