// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountModelOption,
  CodeDeliveryWorkflowConfig,
  WorkflowRunLimits,
} from "@assistant/shared";
import type { Prefs } from "../hooks/usePrefs.ts";
import {
  WorkflowRunStartSheet,
  type StoredRoleRuntimes,
  type WorkflowBaseWorktree,
} from "./WorkflowRunStartSheet.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

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

const models: AccountModelOption[] = [
  model(),
  model({ id: "claude-haiku-4-5", name: "Claude Haiku" }),
  model({
    provider: "openai-codex",
    id: "gpt-5.6",
    name: "GPT-5.6",
    supportedThinkingLevels: ["low", "medium", "high"],
    credentialProfileId: "acc-2",
    accountName: "Work",
  }),
];

interface StartInput {
  taskId: string;
  config: CodeDeliveryWorkflowConfig;
  baseBranch?: string;
  limits?: WorkflowRunLimits;
  requestId: string;
}

const mainWorktree: WorkflowBaseWorktree = {
  id: "main:project-one",
  projectId: "project-one",
  isMain: true,
  branch: "main",
  status: "active",
};

function renderSheet(options?: {
  storedRuntimes?: Prefs["workflowRoleRuntimes"];
  worktrees?: WorkflowBaseWorktree[];
  tasks?: Array<{ id: string; parentId?: string }>;
}): {
  started: StartInput[];
  remembered: { runtimes: StoredRoleRuntimes; limits: WorkflowRunLimits }[];
} {
  const harness: {
    started: StartInput[];
    remembered: { runtimes: StoredRoleRuntimes; limits: WorkflowRunLimits }[];
  } = { started: [], remembered: [] };
  act(() =>
    root?.render(
      <WorkflowRunStartSheet
        task={{
          id: "42",
          title: "Add the widget",
          projectId: "project-one",
        }}
        tasks={options?.tasks ?? [{ id: "42" }]}
        models={models}
        worktrees={options?.worktrees ?? [mainWorktree]}
        storedRuntimes={options?.storedRuntimes}
        storedLimits={undefined}
        startStates={{}}
        onStart={(input) => harness.started.push(input)}
        onRemember={(entry) => harness.remembered.push(entry)}
        onContinueInBackground={() => undefined}
        onClearStart={() => undefined}
        onClose={() => undefined}
      />,
    ),
  );
  return harness;
}

function button(match: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.includes(match) ||
      element.getAttribute("title")?.includes(match) ||
      element.getAttribute("aria-label")?.includes(match),
  );
  expect(found, `no button matching ${match}`).toBeTruthy();
  return found as HTMLButtonElement;
}

describe("workflow role-set start interaction", () => {
  it("starts with required sets and empty fallback sets", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "req-1" });
    const harness = renderSheet();
    act(() => button("Start run").click());

    expect(harness.started[0]?.config.roles).toEqual({
      implementer: [
        expect.objectContaining({
          modelId: "claude-sonnet-5",
          family: "claude",
        }),
      ],
      reviewer: [
        expect.objectContaining({
          modelId: "claude-sonnet-5",
          family: "claude",
        }),
      ],
      fixer: [],
      verdict: [],
    });
    expect(harness.started[0]?.requestId).toBe("req-1");
    expect(harness.started[0]?.baseBranch).toBeUndefined();
    expect(harness.started[0]?.limits).toBeUndefined();
  });

  it("sends a selected active-worktree branch as this run's base", () => {
    const harness = renderSheet({
      worktrees: [
        mainWorktree,
        {
          id: "wt-epic",
          projectId: "project-one",
          branch: "epic/widget",
          status: "active",
        },
        {
          id: "wt-removed",
          projectId: "project-one",
          branch: "old-epic",
          status: "removed",
        },
      ],
    });
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Base branch"]',
    );
    expect(select).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set;
      setter?.call(select, "epic/widget");
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => button("Start run").click());

    expect(harness.started[0]?.baseBranch).toBe("epic/widget");
    expect([...select!.options].map((option) => option.value)).toEqual([
      "main",
      "epic/widget",
    ]);
  });

  it("starts from the nearest ancestor worktree branch by default", () => {
    const harness = renderSheet({
      tasks: [
        { id: "42", parentId: "31" },
        { id: "31", parentId: "20" },
        { id: "20" },
      ],
      worktrees: [
        mainWorktree,
        {
          id: "wt-epic",
          projectId: "project-one",
          branch: "epic/20",
          status: "active",
          taskIds: ["20"],
        },
      ],
    });
    expect(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Base branch"]',
      )?.value,
    ).toBe("epic/20");

    act(() => button("Start run").click());
    expect(harness.started[0]?.baseBranch).toBe("epic/20");
  });

  it("adds and removes optional role candidates independently", () => {
    const harness = renderSheet();
    act(() => button("Add fixer configuration").click());
    act(() => button("Add verdict configuration").click());
    expect(button("Fixer configuration A")).toBeTruthy();
    expect(button("Verdict configuration A")).toBeTruthy();

    act(() => button("Remove Fixer configuration A").click());
    expect(
      [...document.body.querySelectorAll("button")].some((element) =>
        element.textContent?.includes("Fixer configuration A"),
      ),
    ).toBe(false);

    act(() => button("Start run").click());
    expect(harness.started[0]?.config.roles.fixer).toEqual([]);
    expect(harness.started[0]?.config.roles.verdict).toHaveLength(1);
  });

  it("sends explicit ceilings only when the user enables them", () => {
    const harness = renderSheet();
    act(() => button("Add fixer configuration").click());
    act(() => button("Add verdict configuration").click());
    const custom = [...document.body.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Set ceilings myself"),
    )!;
    act(() => custom.click());
    act(() => button("Start run").click());

    expect(harness.started[0]?.limits).toEqual({
      maxIterations: 3,
      maxReviewPasses: 2,
    });
    expect(harness.started[0]?.config.roles.fixer).toHaveLength(1);
    expect(harness.started[0]?.config.roles.verdict).toHaveLength(1);
  });

  it("captures free family and operator notes", () => {
    const harness = renderSheet();
    act(() => button("Reviewer configuration A").click());
    const family = document.querySelector<HTMLInputElement>(
      "#workflow-family-reviewer-0",
    );
    const notes = document.querySelector<HTMLInputElement>(
      "#workflow-notes-reviewer-0",
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(family, "cross-family");
      family?.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(notes, "Strong discovery recall");
      notes?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Start run").click());
    expect(harness.started[0]?.config.roles.reviewer[0]).toMatchObject({
      family: "cross-family",
      notes: "Strong discovery recall",
    });
  });

  it("restores each role set and remembers the started shape", () => {
    const harness = renderSheet({
      storedRuntimes: {
        coordinator: {
          modelKey: "claude-sdk:claude-haiku-4-5",
          credentialProfileId: "acc-1",
          thinkingLevel: "low",
        },
        roles: {
          implementer: [
            {
              modelKey: "claude-sdk:claude-sonnet-5",
              credentialProfileId: "acc-1",
              thinkingLevel: "high",
              family: "claude",
            },
          ],
          reviewer: [
            {
              modelKey: "openai-codex:gpt-5.6",
              credentialProfileId: "acc-2",
              thinkingLevel: "medium",
              family: "gpt",
            },
          ],
          fixer: [],
          verdict: [],
        },
      },
    });
    expect(button("Reviewer configuration A").textContent).toContain("GPT-5.6");
    act(() => button("Start run").click());
    expect(harness.remembered[0]?.runtimes.roles.reviewer[0]).toMatchObject({
      modelKey: "openai-codex:gpt-5.6",
      family: "gpt",
    });
  });
});
