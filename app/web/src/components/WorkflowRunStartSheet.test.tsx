import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountModelOption } from "@assistant/shared";
import {
  canAddConfiguration,
  canRemoveConfiguration,
  configurationHint,
  configurationLabel,
  defaultRoleSelection,
  initialRoleStates,
  preferredWorkflowBaseBranch,
  rememberedRuntimes,
  workflowBaseBranchOptions,
  WorkflowRunStartLayer,
  type WorkflowRunStartLayerProps,
} from "./WorkflowRunStartSheet.tsx";

function model(
  overrides: Partial<AccountModelOption> = {},
): AccountModelOption {
  return {
    provider: "claude-sdk",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
    credentialProfileId: "acc-1",
    accountName: "Main",
    ...overrides,
  };
}

const models = [
  model(),
  model({ id: "claude-haiku-4-5", name: "Claude Haiku" }),
];

const state = (index = 0) => ({
  model: models[index],
  thinkingLevel: "medium" as const,
  family: "claude",
  notes: "",
});

describe("workflow role-set helpers", () => {
  it("defaults required sets and leaves fallback sets empty", () => {
    const roles = initialRoleStates(models, undefined);
    expect(roles.sets.implementer).toHaveLength(1);
    expect(roles.sets.reviewer).toHaveLength(1);
    expect(roles.sets.fixer).toEqual([]);
    expect(roles.sets.verdict).toEqual([]);
    expect(roles.coordinator.model).toBe(models[1]);
  });

  it("restores family and notes with each candidate", () => {
    const selected = defaultRoleSelection(models, {
      modelKey: "claude-sdk:claude-sonnet-5",
      credentialProfileId: "acc-1",
      thinkingLevel: "high",
      family: "custom-family",
      notes: "Strong at migrations",
    });
    expect(selected).toMatchObject({
      model: models[0],
      thinkingLevel: "high",
      family: "custom-family",
      notes: "Strong at migrations",
    });
  });

  it("uses the provider as the family for a future provider", () => {
    const future = model({
      provider: "future-provider" as AccountModelOption["provider"],
      id: "future-model",
    });
    expect(defaultRoleSelection([future], undefined).family).toBe(
      "future-provider",
    );
  });

  it("does not carry a disappeared model's family onto its fallback", () => {
    const selected = defaultRoleSelection(models, {
      modelKey: "openai-codex:disappeared",
      credentialProfileId: "gone-account",
      thinkingLevel: "high",
      family: "gpt-custom",
      notes: "Remembered evidence",
    });
    expect(selected.model).toBe(models[0]);
    expect(selected.family).toBe("claude");
  });

  it("uses independent required and optional bounds", () => {
    expect(canRemoveConfiguration("implementer", 1)).toBe(false);
    expect(canRemoveConfiguration("fixer", 1)).toBe(true);
    expect(canAddConfiguration("verdict", 6)).toBe(false);
    expect(configurationLabel("reviewer", 0)).toBe("Reviewer configuration A");
    expect(configurationHint("fixer")).toContain("falls back");
    expect(configurationHint("verdict")).toContain("skips");
  });

  it("offers main first and distinct active Project worktree branches", () => {
    expect(
      workflowBaseBranchOptions("project-one", [
        {
          id: "main:project-one",
          projectId: "project-one",
          isMain: true,
          branch: "main",
          status: "active",
        },
        {
          id: "wt-epic",
          projectId: "project-one",
          branch: "epic",
          status: "active",
        },
        {
          id: "wt-removed",
          projectId: "project-one",
          branch: "removed",
          status: "removed",
        },
      ]),
    ).toEqual([
      { branch: "main", isMain: true },
      { branch: "epic", isMain: false },
    ]);
  });

  it("prefers the nearest ancestor with an active worktree", () => {
    const tasks = [
      { id: "615", parentId: "531" },
      { id: "531", parentId: "529" },
      { id: "529" },
    ];
    const worktrees = [
      {
        id: "main:project-one",
        projectId: "project-one",
        isMain: true,
        branch: "main",
        status: "active" as const,
      },
      {
        id: "wt-529",
        projectId: "project-one",
        branch: "t529-skills-library",
        status: "active" as const,
        taskIds: ["529"],
      },
    ];
    expect(
      preferredWorkflowBaseBranch("615", "project-one", tasks, worktrees),
    ).toBe("t529-skills-library");
    expect(
      preferredWorkflowBaseBranch("615", "project-one", tasks, [
        { ...worktrees[1]!, status: "removed" },
      ]),
    ).toBeUndefined();
  });

  it("remembers each role set independently", () => {
    expect(
      rememberedRuntimes({
        coordinator: state(1),
        sets: {
          implementer: [state()],
          reviewer: [state()],
          fixer: [],
          verdict: [{ ...state(), notes: "Calibrated" }],
        },
      }).roles.verdict[0],
    ).toMatchObject({ family: "claude", notes: "Calibrated" });
  });
});

function renderLayer(
  overrides: Partial<WorkflowRunStartLayerProps> = {},
): string {
  const none = () => undefined;
  return renderToStaticMarkup(
    <WorkflowRunStartLayer
      task={{ id: "42", title: "Add the widget" }}
      models={models}
      roles={{
        coordinator: { ...state(1), thinkingLevel: "low" },
        sets: {
          implementer: [state()],
          reviewer: [state()],
          fixer: [],
          verdict: [],
        },
      }}
      limits={{ maxIterations: 3, maxReviewPasses: 2 }}
      overrides={{ implementer: "", reviewer: "" }}
      pending={false}
      onChangeRole={none}
      onAddConfiguration={none}
      onRemoveConfiguration={none}
      onChangeLimits={none}
      onChangeOverride={none}
      onResetDefaults={none}
      onStart={none}
      onClose={none}
      onContinueInBackground={none}
      {...overrides}
    />,
  );
}

describe("WorkflowRunStartLayer", () => {
  it("renders all four role-set controls and fallback semantics", () => {
    const html = renderLayer();
    expect(html).toContain("Implementer configuration A");
    expect(html).toContain("Reviewer configuration A");
    expect(html).toContain("Add fixer configuration");
    expect(html).toContain("Add verdict configuration");
    expect(html).toContain("Empty fixer");
    expect(html).toContain("empty verdict");
    expect(html).toContain("CI machine verification");
  });

  it("names the selected base in the authorization summary", () => {
    const html = renderLayer({
      baseBranches: [
        { branch: "main", isMain: true },
        { branch: "epic", isMain: false },
      ],
      baseBranch: "epic",
    });
    expect(html).toContain("forked from");
    expect(html).toContain("epic");
  });

  it("renders configured fixer and verdict candidates", () => {
    const html = renderLayer({
      roles: {
        coordinator: { ...state(1), thinkingLevel: "low" },
        sets: {
          implementer: [state()],
          reviewer: [state()],
          fixer: [state()],
          verdict: [state()],
        },
      },
    });
    expect(html).toContain("Fixer configuration A");
    expect(html).toContain("Verdict configuration A");
  });
});
