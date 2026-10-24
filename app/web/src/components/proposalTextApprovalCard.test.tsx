// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  GithubPullRequestApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * A description edit is approved on what the card shows, so the card renders
 * the Markdown as the pull request will, opens all of it, and — when it knows
 * the description being replaced — shows the change against it.
 */

vi.mock("./diff/DiffSurface.tsx", () => ({
  DiffSurface: ({
    oldFile,
    newFile,
  }: {
    oldFile: { contents: string };
    newFile: { contents: string };
  }) => (
    <div data-testid="diff">
      <pre data-side="old">{oldFile.contents}</pre>
      <pre data-side="new">{newFile.contents}</pre>
    </div>
  ),
}));

const previous = "Jira: STAR-1485\n\nExtract 2.1.5.";
const next =
  "Jira: [STAR-1485](https://castlabs.atlassian.net/browse/STAR-1485)\n\nExtract **2.1.6**.\n\n## What changes\n\n- four opt-in modes";

const editBody: GithubPullRequestApprovalBody = {
  kind: "githubPullRequest",
  operation: "edit",
  repo: "castlabs/stardust",
  pullNumber: 362,
  prBody: next,
  previousPrBody: previous,
};

const card = (
  body: ApprovalCardData["body"],
  patch: Partial<ApprovalCardData> = {},
): ApprovalCardData => ({
  renderKind: "approval",
  id: "appr_pr",
  sessionId: "dev-session",
  kind: body.kind,
  status: "pending",
  title: "Edit pull request description",
  summary: "castlabs/stardust#362",
  createdAt: Date.now(),
  body,
  ...patch,
});

test.each([true, false])(
  "a review-thread proposal shows its target and resolved=%s action",
  (resolved) => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={card({
          kind: "githubPullRequest",
          operation: "resolveThread",
          repo: "acme/app",
          pullNumber: 42,
          threadId: "PRRT_one",
          resolved,
        })}
      />,
    );
    expect(html).toContain(resolved ? "Resolve" : "Reopen");
    expect(html).toContain("review thread");
    expect(html).toContain("acme/app#42");
    expect(html).toContain("PRRT_one");
  },
);

test.each([
  ["githubPullRequest", true],
  ["forgejoPullRequest", false],
] as const)(
  "a %s close shows the bound head, the branch decision and the comment",
  (kind, deleteBranch) => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={card({
          kind,
          operation: "close",
          repo: "acme/app",
          pullNumber: 42,
          head: "feature",
          base: "main",
          headSha: "abcdef1234567",
          commentBody: "Superseded by **#43**.",
          ...(deleteBranch ? { deleteBranch } : {}),
        })}
      />,
    );
    expect(html).toContain("Close without merging");
    expect(html).toContain("acme/app#42");
    expect(html).toContain("abcdef1");
    expect(html).toContain(deleteBranch ? "delete after closing" : "keep");
    expect(html).toContain("<strong>#43</strong>");
  },
);

test("an edit renders the new description as Markdown and offers the change", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={card(editBody)} />);
  expect(html).toContain("<strong>2.1.6</strong>");
  expect(html).toContain("<h2");
  expect(html).not.toContain("## What changes");
  expect(html).toContain(
    'href="https://castlabs.atlassian.net/browse/STAR-1485"',
  );
  expect(html).toContain("Read full description");
  expect(html).toContain("Show changes");
});

test("without the replaced description, or with an identical one, there is no change to show", () => {
  const { previousPrBody: _unknown, ...unknown } = editBody;
  const unread = renderToStaticMarkup(
    <ApprovalCard approval={card(unknown)} />,
  );
  expect(unread).toContain("Read full description");
  expect(unread).not.toContain("Show changes");

  const same = renderToStaticMarkup(
    <ApprovalCard approval={card({ ...editBody, previousPrBody: next })} />,
  );
  expect(same).not.toContain("Show changes");
  expect(same).toContain("Same as the current text.");
});

test("clearing a description says so and still shows what goes", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard approval={card({ ...editBody, prBody: "" })} />,
  );
  expect(html).toContain("Clears the description.");
  expect(html).not.toContain("Read full description");
  expect(html).toContain("Show changes");
});

test("issue, comment and release text render as Markdown too", () => {
  const issue = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        kind: "githubIssue",
        operation: "edit",
        repo: "acme/app",
        number: 8,
        title: "New title",
        previousTitle: "Old title",
        issueBody: "Steps:\n\n1. *open* it",
        previousIssueBody: "Steps: open it",
      })}
    />,
  );
  expect(issue).toContain("<em>open</em>");
  expect(issue).toContain("Old title");
  expect(issue).toContain("New title");
  expect(issue).toContain("Show changes");

  const comment = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        kind: "githubPullRequest",
        operation: "comment",
        repo: "acme/app",
        pullNumber: 4,
        commentBody: "Looks good, see `main`.",
      })}
    />,
  );
  expect(comment).toContain("<code>main</code>");
  expect(comment).toContain("Read full comment");

  const release = renderToStaticMarkup(
    <ApprovalCard
      approval={card({
        kind: "forgejoRelease",
        repo: "acme/app",
        tag: "v1.2.0",
        targetSha: "0123456789abcdef",
        notes: "## Fixes\n\n- the **seek** bar",
      })}
    />,
  );
  expect(release).toContain("<strong>seek</strong>");
  expect(release).toContain("Read full notes");
});

let host: HTMLDivElement;
let root: Root;
const resolved: string[] = [];

const button = (label: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
const dialog = () => document.body.querySelector('[role="dialog"]');

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  resolved.length = 0;
  act(() => {
    root.render(
      <ApprovalCard
        approval={card(editBody)}
        onResolve={(_id, decision) => resolved.push(decision)}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("Show changes opens the dialog on the diff; Preview has the whole text; Approve decides", async () => {
  await act(async () => button("Show changes")!.click());
  const open = dialog()!;
  expect(open.getAttribute("aria-label")).toBe(
    "New description for castlabs/stardust#362",
  );
  const diff = open.querySelector('[data-testid="diff"]');
  expect(diff).not.toBeNull();
  // Both sides newline-terminated, so a last-line edit reads as that edit.
  expect(diff!.querySelector('[data-side="old"]')!.textContent).toBe(
    `${previous}\n`,
  );
  expect(diff!.querySelector('[data-side="new"]')!.textContent).toBe(
    `${next}\n`,
  );

  await act(async () => button("Preview", open)!.click());
  expect(open.querySelector(".prose h2")?.textContent).toBe("What changes");

  act(() => button("Approve", open)!.click());
  expect(resolved).toEqual(["approved"]);
  expect(dialog()).toBeNull();
});

test("Read full description opens on the preview", () => {
  act(() => button("Read full description")!.click());
  const open = dialog()!;
  expect(open.querySelector(".prose h2")?.textContent).toBe("What changes");
  expect(open.querySelector('[data-testid="diff"]')).toBeNull();
});

function rerender(data: ApprovalCardData) {
  act(() => {
    root.render(
      <ApprovalCard
        approval={data}
        onResolve={(_id, decision) => resolved.push(decision)}
      />,
    );
  });
}

const inlineComments = Array.from({ length: 10 }, (_, i) => ({
  path: "src/seek.ts",
  line: i + 1,
  body: `Comment **${i + 1}**`,
  ...(i === 9 ? { suggestion: "seek(0);" } : {}),
}));

test("Read full review opens the summary and EVERY inline comment the approval submits", () => {
  rerender(
    card({
      kind: "githubPullRequest",
      operation: "review",
      repo: "acme/app",
      pullNumber: 9,
      reviewEvent: "REQUEST_CHANGES",
      reviewSummary: "Needs a **reset**.",
      inlineComments,
    }),
  );
  // The card lists the first eight and says how many more there are.
  expect(host.textContent).toContain("10 inline comments");
  expect(host.textContent).toContain("and 2 more");
  expect(host.textContent).not.toContain("seek(0);");

  act(() => button("Read full review")!.click());
  const open = dialog()!;
  expect(open.getAttribute("aria-label")).toBe("Review of acme/app#9");
  expect(open.querySelector("strong")?.textContent).toBe("reset");
  expect(open.textContent).toContain("src/seek.ts:10");
  expect(open.textContent).toContain("seek(0);");

  act(() => button("Reject", open)!.click());
  expect(resolved).toEqual(["rejected"]);
});

test("a review with only inline comments still opens in full", () => {
  rerender(
    card({
      kind: "githubPullRequest",
      operation: "review",
      repo: "acme/app",
      pullNumber: 9,
      reviewEvent: "COMMENT",
      inlineComments: inlineComments.slice(0, 1),
    }),
  );
  act(() => button("Read full review")!.click());
  expect(dialog()!.textContent).toContain("1 inline comment");
  expect(dialog()!.textContent).not.toContain("Summary");
});

test("a Confluence body opens in the reading dialog with the card's decision", () => {
  rerender(
    card({
      kind: "confluencePage",
      items: [
        {
          clientId: "p1",
          operation: "edit",
          pageId: "42",
          title: "Player runbook",
          body: "## Rollback\n\nRun **deploy --previous**.",
          placement: "replace",
          lossyNodes: ["extension"],
        },
        {
          clientId: "p2",
          operation: "edit",
          pageId: "43",
          title: "Changelog",
          body: "- 2.1.6",
          placement: "append",
        },
      ],
    }),
  );
  expect(button("Read full text")).toBeDefined();
  act(() => button("Read full page")!.click());
  const open = dialog()!;
  expect(open.getAttribute("aria-label")).toBe("Player runbook");
  expect(open.querySelector(".prose h2")?.textContent).toBe("Rollback");
  // Approving from the dialog must not hide what the replace destroys.
  expect(open.querySelector('[role="note"]')?.textContent).toContain(
    "drops content Markdown cannot carry back: extension",
  );
  expect(open.textContent).toContain("Replace body of");
  act(() => button("Approve", open)!.click());
  expect(resolved).toEqual(["approved"]);
});
