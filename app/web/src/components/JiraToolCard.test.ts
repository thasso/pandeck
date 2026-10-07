// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { JiraToolCard, shouldRenderJiraTool } from "./JiraToolCard.tsx";

type Block = Parameters<typeof shouldRenderJiraTool>[0];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderCard(cardBlock: Block): HTMLDivElement {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(createElement(JiraToolCard, { block: cardBlock })));
  return container;
}

function block(
  overrides: Partial<{
    name: string;
    done: boolean;
    isError: boolean;
    args: unknown;
    output: string;
  }>,
): Block {
  return {
    kind: "tool",
    name: "jira_lookup",
    done: true,
    isError: false,
    args: { render: true },
    output: JSON.stringify({ kind: "projects", projects: [] }),
    ...overrides,
  } as unknown as Block;
}

describe("shouldRenderJiraTool", () => {
  it("renders jira_lookup projects/users tables when render=true", () => {
    expect(
      shouldRenderJiraTool(
        block({ output: JSON.stringify({ kind: "projects", projects: [] }) }),
      ),
    ).toBe(true);
    expect(
      shouldRenderJiraTool(
        block({ output: JSON.stringify({ kind: "users", users: [] }) }),
      ),
    ).toBe(true);
  });

  it("does not render the jira_lookup fields kind (no table card)", () => {
    expect(
      shouldRenderJiraTool(
        block({ output: JSON.stringify({ kind: "fields", fields: [] }) }),
      ),
    ).toBe(false);
  });

  it("requires render=true", () => {
    expect(shouldRenderJiraTool(block({ args: { render: false } }))).toBe(
      false,
    );
    expect(shouldRenderJiraTool(block({ args: {} }))).toBe(false);
  });

  it("renders jira_search_issues when render=true", () => {
    expect(
      shouldRenderJiraTool(
        block({
          name: "jira_search_issues",
          output: JSON.stringify({ jql: "x", issues: [] }),
        }),
      ),
    ).toBe(true);
  });

  it("ignores unrelated, unfinished, errored, or unparsable blocks", () => {
    expect(shouldRenderJiraTool(block({ name: "jira_get_issue" }))).toBe(false);
    expect(shouldRenderJiraTool(block({ done: false }))).toBe(false);
    expect(shouldRenderJiraTool(block({ isError: true }))).toBe(false);
    expect(shouldRenderJiraTool(block({ output: "not json" }))).toBe(false);
  });
});

describe("JiraToolCard rendering", () => {
  it("keeps issue row state when an issue has no server identifier", () => {
    const issueBlock = () =>
      block({
        name: "jira_search_issues",
        output: JSON.stringify({
          renderColumns: [{ id: "summary", name: "Summary" }],
          issues: [{ summary: "Identifier missing" }],
        }),
      });
    const host = renderCard(issueBlock());
    const expand = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand issue"]',
    );
    if (!expand) throw new Error("issue expand button did not render");

    act(() => expand.click());
    expect(host.textContent).toContain("Issue details");

    renderCard(issueBlock());
    expect(host.querySelector('button[aria-label="Collapse issue"]')).toBe(
      expand,
    );
    expect(host.textContent).toContain("Issue details");
  });

  it("keeps project, issue-type, and user nodes without identifiers", () => {
    const projectsBlock = () =>
      block({
        output: JSON.stringify({
          kind: "projects",
          projects: [
            {
              name: "Nameless project",
              issueTypes: [{ iconUrl: "/type.svg" }],
            },
          ],
        }),
      });
    const host = renderCard(projectsBlock());
    const expand = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand project"]',
    );
    if (!expand) throw new Error("project expand button did not render");
    act(() => expand.click());
    const issueType = host
      .querySelector('img[src="/type.svg"]')
      ?.closest("span");
    if (!issueType) throw new Error("issue type did not render");

    renderCard(projectsBlock());
    expect(host.querySelector('button[aria-label="Collapse project"]')).toBe(
      expand,
    );
    expect(host.querySelector('img[src="/type.svg"]')?.closest("span")).toBe(
      issueType,
    );

    const usersBlock = () =>
      block({
        output: JSON.stringify({ kind: "users", users: [{}] }),
      });
    renderCard(usersBlock());
    const userRow = host.querySelector("tbody tr");
    expect(userRow).not.toBeNull();
    renderCard(usersBlock());
    expect(host.querySelector("tbody tr")).toBe(userRow);
  });

  it("routes jira_lookup by payload.kind and returns null for fields/unknown", () => {
    expect(
      JiraToolCard({
        block: block({
          output: JSON.stringify({ kind: "projects", projects: [] }),
        }),
      }),
    ).not.toBeNull();
    expect(
      JiraToolCard({
        block: block({ output: JSON.stringify({ kind: "users", users: [] }) }),
      }),
    ).not.toBeNull();
    expect(
      JiraToolCard({
        block: block({
          output: JSON.stringify({ kind: "fields", fields: [] }),
        }),
      }),
    ).toBeNull();
    expect(
      JiraToolCard({
        block: block({
          name: "jira_search_issues",
          output: JSON.stringify({ issues: [] }),
        }),
      }),
    ).not.toBeNull();
    expect(
      JiraToolCard({ block: block({ name: "jira_get_issue" }) }),
    ).toBeNull();
  });
});
