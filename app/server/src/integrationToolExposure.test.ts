import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  assistantIntegrationToolUniverse,
  integrationGatedActiveToolNames,
  integrationToolsForGates,
  toolGroupsFor,
} from "./tools/catalog.ts";
import type { IntegrationToolGates } from "./tools/toolPolicy.ts";
import { notifyIntegrationToolsChanged } from "./integrationToolChanges.ts";
import { updateGithubSettings } from "./githubSettings.ts";
import { createPiToolActivation } from "./piSdk/toolActivation.ts";
import { updateSlackSettings } from "./slackSettings.ts";

const namesFor = (gates: IntegrationToolGates) =>
  new Set(integrationToolsForGates(gates).map((tool) => tool.name));

/**
 * The same gate filter for a CODING persona: `integrationToolsForGates` reads
 * the assistant's groups, so a coding-only family (e.g. PR writes) is invisible
 * to it by construction.
 */
const codingNamesFor = (gates: IntegrationToolGates) =>
  new Set(
    toolGroupsFor("developer")
      .filter(
        (group) =>
          group.family === "integration" && (!group.gate || gates[group.gate]),
      )
      .flatMap((group) => group.tools.map((tool) => tool.name)),
  );

const ALL_OFF = {
  jira: false,
  confluence: false,
  tempo: false,
  google: false,
  slack: false,
  github: false,
  forgejo: false,
  browserRawMcp: false,
  knowledgeBase: false,
} as const;

describe("integration tool exposure", () => {
  test("disabled integrations do not expose their tools", () => {
    const names = namesFor(ALL_OFF);
    assert.ok(!names.has("jira_get_issue"));
    assert.ok(!names.has("jira_lookup"));
    assert.ok(!names.has("tempo_list_worklogs"));
    assert.ok(!names.has("google_calendar_list_events"));
    assert.ok(!names.has("slack_search"));
    assert.ok(!names.has("github_list_notifications"));
    assert.ok(names.has("current_time"));
    assert.ok(!names.has("kb_search"));
  });

  test("the Knowledge Base setting switches every kb_* tool", () => {
    const kb = (gates: typeof ALL_OFF | { knowledgeBase: true }) =>
      [...namesFor({ ...ALL_OFF, ...gates })]
        .filter((name) => name.startsWith("kb_"))
        .sort();
    assert.deepEqual(kb(ALL_OFF), []);
    assert.deepEqual(kb({ knowledgeBase: true }), [
      "kb_edit",
      "kb_history",
      "kb_list",
      "kb_move",
      "kb_read",
      "kb_search",
      "kb_show",
      "kb_write",
    ]);
  });

  test("registers the optional universe while keeping disabled tools inactive", () => {
    const universe = assistantIntegrationToolUniverse();
    const allNames = new Set(universe.map((tool) => tool.name));
    const active = integrationGatedActiveToolNames(
      "assistant",
      universe,
      allNames,
    );
    assert.ok(
      allNames.has("slack_search"),
      "Slack can be enabled without restarting a live session",
    );
    assert.ok(!active.has("slack_search"));
    assert.ok(active.has("current_time"));
  });

  test("pushes Slack gate changes into live pi tool activation", async () => {
    updateSlackSettings({ enabled: false });
    const tools = assistantIntegrationToolUniverse();
    const applied: Array<ReadonlySet<string>> = [];
    const activation = createPiToolActivation({
      sessionId: "integration-live-gate",
      agentType: "assistant",
      agentTools: tools,
      // Deferral off: this test isolates the integration-gate reconciliation.
      eagerToolNames: new Set(),
      deferToolLoading: false,
      applyActiveToolNames: (names) => applied.push(new Set(names)),
    });
    try {
      activation.initialize([]);
      assert.ok(
        activation.toolNames.has("slack_search"),
        "universe registered up front",
      );
      assert.equal(
        applied[applied.length - 1]!.has("slack_search"),
        false,
        "gated-off tools start inactive",
      );
      updateSlackSettings({ enabled: true });
      notifyIntegrationToolsChanged();
      assert.ok(
        applied[applied.length - 1]!.has("slack_search"),
        "gate enable reconciles the active set",
      );
    } finally {
      updateSlackSettings({ enabled: false });
      notifyIntegrationToolsChanged();
      activation.dispose();
    }
  });

  test("gate changes stay deferred-aware: enabling an integration does not auto-load its tools", () => {
    updateGithubSettings({ enabled: false });
    const tools = assistantIntegrationToolUniverse();
    const applied: Array<ReadonlySet<string>> = [];
    const activation = createPiToolActivation({
      sessionId: "integration-live-github-gate",
      agentType: "assistant",
      agentTools: tools,
      eagerToolNames: new Set(["current_time"]),
      deferToolLoading: true,
      applyActiveToolNames: (names) => applied.push(new Set(names)),
    });
    try {
      activation.initialize([]);
      assert.equal(
        applied[applied.length - 1]!.has("github_list_notifications"),
        false,
      );
      updateGithubSettings({ enabled: true });
      notifyIntegrationToolsChanged();
      // Usable now, but still deferred: the tool joins the active set only via
      // find_tools (or a transcript-loaded seed), never by a gate flip alone.
      const latest = applied[applied.length - 1]!;
      assert.equal(latest.has("github_list_notifications"), false);
      assert.ok(latest.has("current_time"));
      assert.ok(latest.has("find_tools"));
    } finally {
      updateGithubSettings({ enabled: false });
      notifyIntegrationToolsChanged();
      activation.dispose();
    }
  });

  test("each enabled integration exposes only its related family", () => {
    const slack = namesFor({ ...ALL_OFF, slack: true });
    assert.deepEqual(
      [...slack].filter((name) => name.startsWith("slack_")).sort(),
      [
        "slack_conversation_read",
        "slack_file_read",
        "slack_search",
        "slack_thread_read",
        "slack_unread",
      ],
    );
    assert.ok(!slack.has("google_calendar_list_events"));

    const google = namesFor({ ...ALL_OFF, google: true });
    assert.ok(google.has("google_calendar_list_events"));
    assert.ok(!google.has("slack_search"));

    const github = namesFor({ ...ALL_OFF, github: true });
    assert.deepEqual(
      [...github].filter((name) => name.startsWith("github_")).sort(),
      [
        "github_get_actions_job_log",
        "github_get_actions_run",
        "github_get_content",
        "github_get_issue",
        "github_get_pull_request",
        "github_get_ref_checks",
        "github_list_actions_runs",
        "github_list_notifications",
        "github_list_repositories",
        "github_mutate_issue",
        "github_org_activity",
        "github_search_code",
        "github_search_issues",
        "github_search_repositories",
        "github_watch_pull_request_checks",
      ],
    );
    // Issue writes are shared with the assistant; re-runs, branch deletes and
    // PR writes stay with the coding personas.
    assert.ok(!github.has("github_rerun_actions_run"));
    assert.ok(!github.has("github_delete_branch"));
    assert.ok(!github.has("slack_search"));

    // Forgejo's read family is shared with the assistant; its PR writes are
    // coding-persona only, so the assistant never sees those.
    const forgejoGates = { ...ALL_OFF, forgejo: true };
    const forgejoRead = [
      "forgejo_get_actions_run",
      "forgejo_get_content",
      "forgejo_get_issue",
      "forgejo_get_pull_request",
      "forgejo_get_ref_checks",
      "forgejo_list_actions_runs",
      "forgejo_list_notifications",
      "forgejo_list_repositories",
      "forgejo_search_issues",
      "forgejo_search_repositories",
      "forgejo_watch_pull_request_checks",
    ];
    assert.deepEqual(
      [...namesFor(forgejoGates)]
        .filter((name) => name.startsWith("forgejo_"))
        .sort(),
      forgejoRead,
    );
    // Forgejo has no code-search API, so the GitHub twin has no counterpart.
    assert.ok(!namesFor(forgejoGates).has("forgejo_search_code"));
    // Nor an Actions log endpoint: logs live only on web routes an API token
    // cannot authenticate against, so there is no job-log twin either.
    assert.ok(!namesFor(forgejoGates).has("forgejo_get_actions_job_log"));
    assert.deepEqual(
      [...codingNamesFor(forgejoGates)]
        .filter((name) => name.startsWith("forgejo_"))
        .sort(),
      [
        "forgejo_comment_pull_request",
        "forgejo_create_pull_request",
        "forgejo_create_release",
        "forgejo_edit_pull_request",
        "forgejo_ready_pull_request",
        "forgejo_review_pull_request",
        ...forgejoRead,
      ].sort(),
    );
    assert.ok(!codingNamesFor(forgejoGates).has("github_create_pull_request"));
    assert.deepEqual(
      [...codingNamesFor(ALL_OFF)].filter((name) =>
        name.startsWith("forgejo_"),
      ),
      [],
    );
  });

  test("jira and tempo are independent gates", () => {
    // Jira on, Tempo off: only the Jira family, no Tempo tools.
    const jira = namesFor({ ...ALL_OFF, jira: true });
    assert.deepEqual(
      [...jira].filter((name) => name.startsWith("jira_")).sort(),
      [
        "jira_get_issue",
        "jira_lookup",
        "jira_mutate_issue",
        "jira_search_issues",
      ],
    );
    assert.ok(!jira.has("tempo_list_worklogs"));
    assert.ok(!jira.has("tempo_mutate_worklogs"));

    // Tempo on, Jira off: only the Tempo family, no Jira tools. (Tempo tools still run;
    // they degrade to raw issue ids at call time when Jira creds are unavailable.)
    const tempo = namesFor({ ...ALL_OFF, tempo: true });
    assert.deepEqual(
      [...tempo].filter((name) => name.startsWith("tempo_")).sort(),
      [
        "tempo_export_report",
        "tempo_export_worklogs",
        "tempo_list_worklogs",
        "tempo_mutate_worklogs",
      ],
    );
    assert.ok(!tempo.has("jira_get_issue"));
    assert.ok(!tempo.has("jira_lookup"));

    // Both on: both families exposed.
    const both = namesFor({ ...ALL_OFF, jira: true, tempo: true });
    assert.ok(both.has("jira_lookup"));
    assert.ok(both.has("tempo_list_worklogs"));
  });

  test("confluence is its own gate, independent of jira", () => {
    // Jira supplies Confluence's credentials, but the two switch separately:
    // enabling Jira must not expose Confluence tools, or vice versa.
    const jira = namesFor({ ...ALL_OFF, jira: true });
    assert.deepEqual(
      [...jira].filter((name) => name.startsWith("confluence_")),
      [],
    );
    const confluence = namesFor({ ...ALL_OFF, confluence: true });
    assert.deepEqual(
      [...confluence].filter((name) => name.startsWith("confluence_")).sort(),
      [
        "confluence_download_attachment",
        "confluence_get_page",
        "confluence_lookup",
        "confluence_mutate_page",
        "confluence_search",
      ],
    );
    assert.ok(!confluence.has("jira_get_issue"));
  });
});
