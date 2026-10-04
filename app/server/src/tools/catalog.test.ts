import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { AgentType } from "@assistant/shared";
import type { AgentTool } from "../mcp/tool.ts";
import {
  agentToolsFor,
  assistantIntegrationTools,
  eagerToolNamesFor,
  modeGatedActiveToolNames,
  toolGroupsFor,
} from "./catalog.ts";

const PERSONAS: AgentType[] = [
  "assistant",
  "personal-assistant",
  "workshop",
  "developer",
];

/**
 * What the eager tool block COSTS: name + description + JSON schema, in
 * characters. Characters, not an estimated token count, for the reason
 * `promptInventory.ts` records — there is no offline tokenizer, so chars/4 was
 * a second guess layered on the number we actually control.
 */
function eagerBlockChars(tools: AgentTool[]): number {
  return tools.reduce(
    (n, tool) =>
      n +
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length,
    0,
  );
}

describe("tool catalog", () => {
  test("every catalog tool has an explicit side-effect classification", () => {
    for (const persona of [
      ...PERSONAS,
      "workflow-coordinator",
    ] as AgentType[]) {
      for (const tool of agentToolsFor(persona))
        assert.ok(
          ["none", "local", "external"].includes(tool.sideEffects ?? ""),
          `${persona}: ${tool.name} needs a sideEffects decision`,
        );
    }
    const workshop = new Map(
      agentToolsFor("workshop").map((tool) => [tool.name, tool.sideEffects]),
    );
    assert.equal(workshop.get("task_read"), "none");
    assert.equal(workshop.get("task_manage"), "local");
    assert.equal(workshop.get("jira_mutate_issue"), "external");
    assert.equal(workshop.get("browser_click"), "external");
  });

  test("Build exposure is unchanged while Plan permits its deliberate exceptions", () => {
    for (const persona of [
      ...PERSONAS,
      "workflow-coordinator",
    ] as AgentType[]) {
      const tools = agentToolsFor(persona);
      const all = new Set(tools.map((tool) => tool.name));
      assert.equal(
        modeGatedActiveToolNames("build", tools, all),
        all,
        `${persona}: Build is an identity projection`,
      );
      const plan = modeGatedActiveToolNames("plan", tools, all);
      for (const tool of tools)
        assert.equal(
          plan.has(tool.name),
          tool.sideEffects === "none" ||
            tool.name === "task_manage" ||
            tool.name === "session_spawn" ||
            tool.name === "background_tasks",
          `${persona}: Plan classification for ${tool.name}`,
        );
    }
  });

  test("every persona tool belongs to exactly one group", () => {
    for (const persona of PERSONAS) {
      const seen = new Map<string, string>();
      for (const group of toolGroupsFor(persona)) {
        for (const tool of group.tools) {
          const existing = seen.get(tool.name);
          assert.ok(
            !existing,
            `${persona}: tool ${tool.name} is in both ${existing} and ${group.id}`,
          );
          seen.set(tool.name, group.id);
        }
      }
    }
  });

  test("group ids are unique and metadata is well-formed", () => {
    for (const persona of PERSONAS) {
      const ids = new Set<string>();
      for (const group of toolGroupsFor(persona)) {
        assert.ok(
          /^[a-z0-9-]+$/.test(group.id),
          `${persona}: bad group id ${group.id}`,
        );
        assert.ok(
          !ids.has(group.id),
          `${persona}: duplicate group id ${group.id}`,
        );
        ids.add(group.id);
        assert.ok(group.label.trim().length > 0, `${group.id} needs a label`);
        assert.ok(
          group.description.trim().length > 0,
          `${group.id} needs a description`,
        );
        assert.ok(
          group.tools.length > 0,
          `${persona}: group ${group.id} has no tools`,
        );
        if (group.gate)
          assert.equal(
            group.family,
            "integration",
            `${group.id}: gated groups are integration-family`,
          );
      }
    }
  });

  test("managed worktree lifecycle and delivery are deferred shared tools for coding personas", () => {
    for (const persona of ["workshop", "developer"] as const) {
      const lifecycle = toolGroupsFor(persona).find(
        ({ id }) => id === "worktrees",
      );
      assert.ok(lifecycle, `${persona} is missing the worktrees group`);
      assert.equal(lifecycle.loading, "deferred");
      assert.equal(lifecycle.family, "shared");
      assert.equal(lifecycle.gate, undefined);
      assert.deepEqual(
        lifecycle.tools.map((tool) => tool.name),
        [
          "worktree_create",
          "worktree_status",
          "worktree_set_base",
          "worktree_remove",
        ],
      );

      const delivery = toolGroupsFor(persona).find(
        ({ id }) => id === "managed-delivery",
      );
      assert.ok(delivery, `${persona} is missing managed delivery`);
      assert.equal(delivery.loading, "deferred");
      assert.equal(delivery.family, "shared");
      assert.deepEqual(
        delivery.tools.map((tool) => [tool.name, tool.sideEffects]),
        [
          ["worktree_commit", "local"],
          ["worktree_push", "external"],
          ["worktree_create_pull_request", "external"],
          ["worktree_ready_pull_request", "external"],
          ["worktree_finish_pull_request", "external"],
        ],
      );
      const tags = toolGroupsFor(persona).find(({ id }) => id === "git-tags");
      assert.ok(tags);
      assert.equal(tags.loading, "deferred");
      assert.deepEqual(
        tags.tools.map((tool) => [tool.name, tool.sideEffects]),
        [["git_publish_tag", "external"]],
      );
    }
  });

  test("eager sets match the decided small core", () => {
    const assistantEager = eagerToolNamesFor("assistant");
    for (const expected of [
      "current_time",
      "ask_questions",
      "memory_search",
      "memory_manage",
      "task_read",
      "list_attachments",
      "read_attachment",
    ]) {
      assert.ok(
        assistantEager.has(expected),
        `assistant eager set is missing ${expected}`,
      );
    }
    // Integration families must stay deferred.
    for (const deferred of [
      "jira_get_issue",
      "google_calendar_list_events",
      "slack_search",
      "github_get_issue",
      "tempo_list_worklogs",
      "web_search",
      "kb_write_entry",
      "session_control",
      "session_send_prompt",
      "convert_pdf",
      // Task-286: the KB read tools are discovered, not eager. The eager KB
      // prompt pointer is what keeps the Knowledge Base reachable.
      "kb_search",
      "kb_get_entry",
    ]) {
      assert.ok(
        !assistantEager.has(deferred),
        `${deferred} must be deferred for the assistant persona`,
      );
    }
    // Memory stays eager on purpose (Task-286): the `<memory>` snapshot is
    // already in the prompt, so acting on it must not need a discovery hop.
    for (const persona of PERSONAS) {
      const eager = eagerToolNamesFor(persona);
      for (const name of ["memory_search", "memory_manage"])
        assert.ok(eager.has(name), `${persona} eager set is missing ${name}`);
    }
    const workshopEager = eagerToolNamesFor("workshop");
    // `ls` is eager on purpose (Task-319): deferred, a listing tool costs a
    // discovery round trip and loses to the shell `ls` it replaces.
    for (const expected of ["review_comments_list", "ls"]) {
      assert.ok(
        workshopEager.has(expected),
        `workshop eager set is missing ${expected}`,
      );
    }
    assert.ok(
      !workshopEager.has("browser_navigate"),
      "browser tool group tools stay deferred",
    );
  });

  /**
   * A RATCHET at what the Task-285 trim actually achieved, not a headroom
   * allowance: the old 9,500/8,000-token guard (~38k/32k chars) could not fail.
   * Growing any eager tool now fails here and has to be argued.
   *
   * Task-285's acceptance number was amended from 9,000 to 10,900 developer
   * chars, because 9,000 was set against a baseline measured BEFORE Tasks
   * 282/284/298 moved persona-prompt rules into the tool descriptions: ~5,600
   * of these characters are JSON Schema structure and ~2,000 are those moved-in
   * descriptions, so the difference was only reachable by re-tiering (which
   * would reverse Task-286) or by cutting capability, not by wording.
   *
   * The committed per-layer budget file and its CI check are Task-288's — this
   * stays a plain in-code ceiling, deliberately not promoted into one.
   *
   * The coding ceilings carry one argued raise: Task-319's eager `ls` (561
   * chars). It is not new capability priced into the eager block — on pi it
   * replaces the `ls` BUILTIN whose definition cost 399 chars in the harness
   * block (`piPromptMeasure.ts`), and deferring it would cost a discovery round
   * trip per listing, which is what the tool exists to avoid.
   *
   * Measured after that change, so the next reader can tell slack from tool:
   * assistant/personal-assistant 10,160, workshop 12,288, developer 11,759.
   * Each ceiling sits a few dozen chars above its measurement on purpose.
   *
   * The second argued raise is `task_manage.githubIssues` (58 chars, no
   * description: its refusal names the ref format). Linking a GitHub issue is
   * a Task field an agent sets in the same write as the rest, so it cannot
   * live in a deferred tool, and every schema line it would displace records a
   * silent wrong write it prevents. Measured after it: assistant/personal-
   * assistant 10,227, workshop 12,355, developer 11,826.
   */
  const EAGER_BLOCK_CHAR_CEILING: Record<AgentType, number> = {
    assistant: 10_260,
    "personal-assistant": 10_260,
    workshop: 12_390,
    developer: 11_860,
    "workflow-coordinator": 2_000,
  };

  test("the eager tool block stays within its character ceiling", () => {
    for (const persona of PERSONAS) {
      const eagerNames = eagerToolNamesFor(persona);
      const eagerTools = agentToolsFor(persona).filter((tool) =>
        eagerNames.has(tool.name),
      );
      const chars = eagerBlockChars(eagerTools);
      const ceiling = EAGER_BLOCK_CHAR_CEILING[persona];
      assert.ok(
        chars <= ceiling,
        `${persona}: eager tool block ${chars} chars exceeds ${ceiling} — trim a description or defer a group, do not raise this`,
      );
    }
  });

  test("browser tool groups are ordinary catalog groups (no separate approval flow)", () => {
    const groups = toolGroupsFor("workshop");
    const browser = groups.find((group) => group.id === "browser");
    assert.ok(browser, "browser pack is a catalog group");
    assert.equal(browser!.loading, "deferred");
    assert.equal(browser!.gate, undefined, "browser is always usable, no gate");
    const rawMcp = groups.find((group) => group.id === "browser-raw-mcp");
    assert.ok(rawMcp, "raw-mcp pack is a catalog group");
    assert.equal(
      rawMcp!.gate,
      "browserRawMcp",
      "raw-mcp is gated exactly like any other integration",
    );
    const postReload = groups.find((group) => group.id === "post-reload");
    assert.ok(
      postReload && postReload.loading === "eager",
      "workshop_defer_after_reload stays eager",
    );
    for (const group of toolGroupsFor("assistant")) {
      assert.notEqual(
        group.id,
        "browser",
        "assistant persona has no browser tool groups",
      );
      assert.notEqual(
        group.id,
        "browser-raw-mcp",
        "assistant persona has no browser tool groups",
      );
    }
  });

  test("container image pulls are a deferred, GitHub-gated coding-only group", () => {
    for (const persona of ["workshop", "developer"] as AgentType[]) {
      const group = toolGroupsFor(persona).find(
        (candidate) => candidate.id === "container-images",
      );
      assert.ok(group, `${persona} should expose the container-images group`);
      assert.equal(group!.loading, "deferred");
      // Credentials come from the GitHub integration, so the group shares that gate.
      assert.equal(group!.gate, "github");
      assert.deepEqual(
        group!.tools.map((tool) => tool.name),
        ["container_image_pull"],
      );
    }
    for (const persona of ["assistant", "personal-assistant"] as AgentType[]) {
      const names = new Set(agentToolsFor(persona).map((tool) => tool.name));
      assert.ok(
        !names.has("container_image_pull"),
        `${persona} must not expose container_image_pull`,
      );
    }
  });

  test("workflow tools are scoped and deliberately tiered by persona", () => {
    for (const persona of ["workshop", "developer"] as AgentType[]) {
      const group = toolGroupsFor(persona).find(
        (candidate) => candidate.id === "workflow",
      );
      assert.ok(group, `${persona} should expose the workflow group`);
      assert.equal(group!.loading, "deferred");
      assert.equal(group!.family, "shared");
      assert.equal(group!.gate, undefined);
      assert.deepEqual(
        group!.tools.map((tool) => tool.name),
        ["session_submit_result"],
      );
    }
    const coordinator = toolGroupsFor("workflow-coordinator").find(
      (candidate) => candidate.id === "workflow",
    );
    assert.ok(coordinator);
    assert.equal(coordinator!.loading, "eager");
    assert.deepEqual(
      coordinator!.tools.map((tool) => tool.name),
      ["workflow_status", "session_submit_result"],
    );
    const coordinatorActions = toolGroupsFor("workflow-coordinator").find(
      (candidate) => candidate.id === "workflow-actions",
    );
    assert.equal(coordinatorActions?.loading, "deferred");
    assert.deepEqual(
      coordinatorActions?.tools.map((tool) => tool.name),
      ["workflow_gate_action"],
    );
    const coordinatorTasks = toolGroupsFor("workflow-coordinator").find(
      (candidate) => candidate.id === "workflow-follow-up-tasks",
    );
    assert.equal(coordinatorTasks?.loading, "deferred");
    assert.deepEqual(
      coordinatorTasks?.tools.map((tool) => tool.name),
      ["task_manage"],
    );
    for (const persona of [
      "assistant",
      "personal-assistant",
      "workshop",
      "developer",
    ] as AgentType[]) {
      const names = new Set(agentToolsFor(persona).map((tool) => tool.name));
      assert.ok(
        !names.has("workflow_status"),
        `${persona} must not expose coordinator run status`,
      );
      assert.ok(
        !names.has("workflow_gate_action"),
        `${persona} must not expose coordinator gate actions`,
      );
      if (persona === "assistant" || persona === "personal-assistant")
        assert.ok(
          !names.has("session_submit_result"),
          `${persona} must not expose workflow result submission`,
        );
    }
  });

  test("first-class kb_* tools are exposed", () => {
    const names = assistantIntegrationTools().map((tool) => tool.name);
    for (const tool of [
      "kb_tree",
      "kb_search",
      "kb_get_entry",
      "kb_write_entry",
      "kb_edit_entry",
    ]) {
      assert.ok(
        names.includes(tool),
        `expected ${tool} in the assistant tool list`,
      );
    }
  });

  test("skill authoring is one deferred group for the four agreed personas", () => {
    const expected = [
      "skill_list",
      "skill_get",
      "skill_read_file",
      "skill_create",
      "skill_edit",
      "skill_manage_files",
      "skill_rename",
      "skill_delete",
      "skill_history",
      "skill_diff",
    ];
    for (const persona of PERSONAS) {
      const group = toolGroupsFor(persona).find(({ id }) => id === "skills");
      assert.ok(group, `${persona} should expose the skills group`);
      assert.equal(group.loading, "deferred");
      assert.equal(group.family, "shared");
      assert.equal(group.gate, undefined);
      assert.deepEqual(
        group.tools.map((tool) => tool.name),
        expected,
      );
      // Plan mode keeps the reads and drops every committing mutation.
      const tools = agentToolsFor(persona);
      const plan = modeGatedActiveToolNames(
        "plan",
        tools,
        new Set(tools.map((tool) => tool.name)),
      );
      for (const name of [
        "skill_list",
        "skill_get",
        "skill_read_file",
        "skill_history",
        "skill_diff",
      ])
        assert.ok(plan.has(name), `${persona}: Plan should keep ${name}`);
      for (const name of [
        "skill_create",
        "skill_edit",
        "skill_manage_files",
        "skill_rename",
        "skill_delete",
      ])
        assert.ok(!plan.has(name), `${persona}: Plan must drop ${name}`);
    }
    const coordinator = new Set(
      agentToolsFor("workflow-coordinator").map((tool) => tool.name),
    );
    for (const name of expected)
      assert.ok(
        !coordinator.has(name),
        `workflow-coordinator must not expose ${name}`,
      );
  });

  test("settings tools are a deferred group for the Personal Assistant only", () => {
    const group = toolGroupsFor("personal-assistant").find(
      ({ id }) => id === "settings",
    );
    assert.ok(group, "personal-assistant exposes the settings group");
    assert.equal(group.loading, "deferred");
    assert.equal(group.gate, undefined);
    assert.deepEqual(
      group.tools.map((tool) => tool.name),
      ["settings_read", "settings_update"],
    );
    for (const persona of [
      "assistant",
      "workshop",
      "developer",
      "workflow-coordinator",
    ] as const)
      assert.ok(
        !agentToolsFor(persona).some((tool) =>
          tool.name.startsWith("settings_"),
        ),
        `${persona} must not expose settings tools`,
      );
    // Plan mode keeps the read and drops the write.
    const tools = agentToolsFor("personal-assistant");
    const plan = modeGatedActiveToolNames(
      "plan",
      tools,
      new Set(tools.map((tool) => tool.name)),
    );
    assert.ok(plan.has("settings_read"));
    assert.ok(!plan.has("settings_update"));
  });

  test("developer excludes the app-dev-box-only workshop tools", () => {
    const developer = new Set(
      agentToolsFor("developer").map((tool) => tool.name),
    );
    const workshop = new Set(
      agentToolsFor("workshop").map((tool) => tool.name),
    );
    for (const excluded of [
      "workshop_defer_after_reload",
      "workshop_draft_handoff",
    ]) {
      assert.ok(workshop.has(excluded), `workshop should expose ${excluded}`);
      assert.ok(
        !developer.has(excluded),
        `developer must not expose ${excluded}`,
      );
    }
  });

  test("assistant personas share the assistant toolset; coding personas extend it", () => {
    const assistant = agentToolsFor("assistant")
      .map((tool) => tool.name)
      .sort();
    const permanent = agentToolsFor("personal-assistant")
      .map((tool) => tool.name)
      .sort();
    // The Personal Assistant alone also gets the settings tools.
    assert.deepEqual(
      permanent,
      [...assistant, "settings_read", "settings_update"].sort(),
    );
    const workshop = new Set(
      agentToolsFor("workshop").map((tool) => tool.name),
    );
    for (const name of assistant)
      assert.ok(
        workshop.has(name),
        `workshop is missing assistant tool ${name}`,
      );
  });
});
