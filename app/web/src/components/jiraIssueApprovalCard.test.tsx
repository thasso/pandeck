// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  JiraIssueApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * A Jira create is approved on what the card shows, so the card has to show
 * the ticket the way Jira will: rendered Markdown, every field the agent set,
 * and a way to read ALL of it — the clipped preview must never be the only
 * place the description exists.
 */

const description = [
  "## Goal",
  "",
  "Ship the **preview** dialog.",
  "",
  "- [ ] render markdown",
  "- [ ] open the full ticket",
  "",
  ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the spec.`),
].join("\n");

const body: JiraIssueApprovalBody = {
  kind: "jiraIssue",
  jiraHost: "acme.atlassian.net",
  items: [
    {
      clientId: "new-task",
      issueKey: "",
      operation: "create",
      createProjectKey: "PA",
      createIssueType: "Task",
      createSummary: "Preview Jira tickets before creating them",
      createDescription: description,
      createParentIssue: "PA-100",
      fieldChanges: [
        { fieldId: "labels", label: "Labels", to: "set ui, jira" },
        { fieldId: "priority", label: "Priority", to: "High" },
      ],
      linkChanges: [
        {
          op: "add",
          type: "Blocks",
          direction: "outward",
          relationship: "blocks",
          targetIssueKey: "PA-99",
        },
      ],
    },
  ],
};

const card = (patch: Partial<ApprovalCardData> = {}): ApprovalCardData => ({
  renderKind: "approval",
  id: "appr_jira",
  sessionId: "assistant-session",
  kind: "jiraIssue",
  status: "pending",
  title: "Create Jira issue",
  createdAt: Date.now(),
  body,
  ...patch,
});

test("renders the create as a ticket: rendered Markdown, fields, links", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={card()} />);
  expect(html).toContain("Preview Jira tickets before creating them");
  expect(html).toContain("<strong>preview</strong>");
  expect(html).toContain("<h2");
  expect(html).not.toContain("## Goal");
  expect(html).toContain("PA-100");
  expect(html).toContain("Labels");
  expect(html).toContain("set ui, jira");
  expect(html).toContain("Priority");
  expect(html).toContain("High");
  expect(html).toContain("blocks");
  expect(html).toContain("PA-99");
  expect(html).toContain("Read full ticket");
});

test("renders a comment body as Markdown too", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        body: {
          kind: "jiraIssue",
          items: [
            {
              clientId: "c1",
              issueKey: "PA-7",
              operation: "comment",
              issueUrl: "https://acme.atlassian.net/browse/PA-7",
              commentBody: "Fixed in `main`, see *notes*.",
              fieldChanges: [],
            },
          ],
        },
      })}
    />,
  );
  expect(html).toContain("<code>main</code>");
  expect(html).toContain("<em>notes</em>");
  expect(html).toContain("Read full comment");
});

let host: HTMLDivElement;
let root: Root;
const resolved: string[] = [];

function render(data: ApprovalCardData) {
  act(() => {
    root.render(
      <ApprovalCard
        approval={data}
        onResolve={(_id, decision) => resolved.push(decision)}
      />,
    );
  });
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
const dialog = () => document.body.querySelector('[role="dialog"]');

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  resolved.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("Read full ticket opens the whole proposal and approves from there", () => {
  render(card());
  expect(dialog()).toBeNull();

  act(() => button("Read full ticket")!.click());
  const open = dialog();
  expect(open).not.toBeNull();
  expect(open!.getAttribute("aria-label")).toBe("New Task in PA");
  // The full description, not the clipped preview: the last paragraph is there.
  expect(open!.textContent).toContain("Paragraph 40 of the spec.");
  expect(open!.querySelector(".prose h2")?.textContent).toBe("Goal");
  expect(open!.textContent).toContain("Labels");
  expect(open!.textContent).toContain("PA-99");

  const approve = [...open!.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Approve",
  );
  act(() => approve!.click());
  expect(resolved).toEqual(["approved"]);
  expect(dialog()).toBeNull();
});

test("Escape closes the dialog without deciding; a settled card only offers Close", () => {
  render(card());
  act(() => button("Read full ticket")!.click());
  act(() => {
    dialog()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(dialog()).toBeNull();
  expect(resolved).toEqual([]);

  render(
    card({
      status: "executed",
      body: {
        ...body,
        items: [
          {
            ...body.items[0]!,
            resultIssueKey: "PA-123",
            resultIssueUrl: "https://acme.atlassian.net/browse/PA-123",
          },
        ],
      },
    }),
  );
  expect(host.textContent).toContain("created PA-123");
  act(() => button("Read full ticket")!.click());
  const settled = dialog()!;
  const labels = [...settled.querySelectorAll("button")].map((element) =>
    element.textContent?.trim(),
  );
  expect(labels).not.toContain("Approve");
  expect(labels).toContain("Close");
});

test("an executed comment or edit says what it did, not 'created'", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        status: "executed",
        body: {
          kind: "jiraIssue",
          items: [
            {
              clientId: "c1",
              issueKey: "PA-7",
              operation: "comment",
              commentBody: "Done.",
              resultIssueUrl: "https://acme.atlassian.net/browse/PA-7",
              fieldChanges: [],
            },
            {
              clientId: "e1",
              issueKey: "PA-8",
              operation: "edit",
              resultIssueUrl: "https://acme.atlassian.net/browse/PA-8",
              // A field that was unset: both sides still render.
              fieldChanges: [
                {
                  fieldId: "priority",
                  label: "Priority",
                  from: null,
                  to: "High",
                },
              ],
            },
          ],
        },
      })}
    />,
  );
  expect(html).toContain("commented");
  expect(html).toContain("updated");
  expect(html).not.toContain("created");
  expect(html).toContain("—");
  expect(html).toContain("→");
  expect(html).toContain("High");
});

const rankItem: JiraIssueApprovalBody["items"][number] = {
  clientId: "r1",
  issueKey: "PA-12",
  operation: "rank",
  fieldChanges: [],
  rankIssueKeys: ["PA-12", "PA-10"],
  rankPosition: "top",
  rankTargetIssueKey: "PA-9",
  rankScope: { kind: "board", boardId: 42, epics: true },
  rankSteps: [
    { issueKey: "PA-12", placement: "before", relativeToIssueKey: "PA-9" },
    { issueKey: "PA-10", placement: "after", relativeToIssueKey: "PA-12" },
  ],
};

test("a pending rank shows the move and its steps, with no outcome yet", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={card({ body: { kind: "jiraIssue", items: [rankItem] } })}
    />,
  );
  expect(html).toContain("PA-12, PA-10");
  expect(html).toContain("top");
  expect(html).toContain("board 42 epic list");
  expect(html).toContain("before");
  expect(html).toContain("after");
  expect(html).not.toContain("not attempted");
  expect(html).not.toContain("applied");
});

test("a partially applied rank names the step that failed and the ones left alone", () => {
  const steps = rankItem.rankSteps!;
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        status: "failed",
        body: {
          kind: "jiraIssue",
          items: [
            {
              ...rankItem,
              rankSteps: [
                { ...steps[0]!, resultOk: true },
                {
                  ...steps[1]!,
                  resultOk: false,
                  error: "SCHEDULE_ISSUES denied",
                },
              ],
              rankResultOrder: ["PA-12", "PA-9", "PA-10"],
              error: "Applied: PA-12. Not attempted: none.",
            },
          ],
        },
      })}
    />,
  );
  expect(html).toContain("applied");
  expect(html).toContain("SCHEDULE_ISSUES denied");
  expect(html).toContain("Order now");
  expect(html).toContain("PA-12 → PA-9 → PA-10");
});

function withoutParent(item: JiraIssueApprovalBody["items"][number]) {
  const { createParentIssue: _parent, ...rest } = item;
  return rest;
}

test("a create field written as null still shows on the card", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        body: {
          ...body,
          items: [
            {
              ...withoutParent(body.items[0]!),
              fieldChanges: [
                { fieldId: "Epic Link", label: "Epic", to: null },
                { fieldId: "customfield_1", label: "Team", to: "" },
              ],
            },
          ],
        },
      })}
    />,
  );
  expect(html).toContain("Epic");
  expect(html).toContain("Team");
  expect((html.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("the dialog takes focus and returns it to the opener on close", async () => {
  render(card());
  const opener = button("Read full ticket")!;
  opener.focus();
  act(() => opener.click());
  // Base UI moves focus after the popup mounts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const open = dialog() as HTMLElement;
  // Base UI's dialog owns the focus trap; what this card owns is that focus
  // moves into the proposal and comes back to the button that opened it.
  expect(open.contains(document.activeElement)).toBe(true);

  act(() => {
    open.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
});
