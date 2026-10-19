import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AgentDefinitionApprovalBody,
  ApprovalCard as ApprovalCardData,
  CommitDisplay,
  ManagedCommitOverrideApprovalBody,
  SessionSpawnApprovalBody,
  SettingsInputApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { CommitCard } from "./CommitCard.tsx";

/**
 * Agents write Markdown in every field they author, so approval and delivery
 * cards render it: a backtick or `**` left literal reads as broken. What must
 * read verbatim — the commit message, a blocker's file — stays plain.
 */

const commit: CommitDisplay = {
  status: "blocked",
  dryRun: true,
  forced: false,
  commitMessage: "Keep `**raw**` in the message",
  blockers: [
    {
      kind: "unclear",
      file: "src/__init__.py",
      reason: "Mixes `holdersOf` with **unrelated** cleanup.",
    },
  ],
  warnings: ["`api.snap` has **no** test touching it."],
  files: [{ path: "src/__init__.py", status: "modified", additions: 1 }],
  totals: { files: 1, additions: 1, deletions: 0 },
};

function approval(body: ApprovalCardData["body"]): ApprovalCardData {
  return {
    renderKind: "approval",
    id: "appr_md",
    sessionId: "session-1",
    kind: body.kind,
    status: "pending",
    title: "Review the proposal",
    createdAt: 0,
    body,
  };
}

const render = (body: ApprovalCardData["body"]) =>
  renderToStaticMarkup(
    <ApprovalCard approval={approval(body)} onResolve={() => {}} />,
  );

describe("approval card Markdown", () => {
  it("renders the review's blockers and warnings on a commit override", () => {
    const body: ManagedCommitOverrideApprovalBody = {
      kind: "managedCommitOverride",
      worktreeId: "wt-1",
      branch: "feature",
      reason: "The `snapshot` is regenerated.",
      stagedOnly: true,
      commit,
    };
    const html = render(body);

    expect(html).toContain("<code>holdersOf</code>");
    expect(html).toContain("<strong>unrelated</strong>");
    expect(html).toContain("<code>api.snap</code> has <strong>no</strong>");
    // The file a blocker names and the commit message stay verbatim.
    expect(html).toContain("src/__init__.py: ");
    expect(html).toContain("Keep `**raw**` in the message");
  });

  it("renders a proposed session's title inline", () => {
    const body: SessionSpawnApprovalBody = {
      kind: "sessionSpawn",
      items: [
        {
          rowId: "row_a",
          title: "Review `auth` **now**",
          agentType: "assistant",
          prompt: "Review it.",
          responseRequested: true,
          provider: "claude-sdk",
          modelId: "sonnet",
          credentialProfileId: "claude-default",
          thinkingLevel: "medium",
        },
      ],
    };
    const html = render(body);

    expect(html).toContain(
      '<span class="prose prose-inline">Review <code>auth</code> <strong>now</strong></span>',
    );
  });

  it("renders the reason a settings input is requested", () => {
    const body: SettingsInputApprovalBody = {
      kind: "settingsInput",
      path: "github.token",
      label: "Personal access token",
      section: "github",
      mode: "secret",
      wasConfigured: false,
      reason: "To read **private** pull requests in `acme/api`.",
    };
    const html = render(body);

    expect(html).toContain("<strong>private</strong>");
    expect(html).toContain("<code>acme/api</code>");
    expect(html).not.toMatch(/<p[^>]*><div/);
  });

  it("renders an agent definition's purpose inline", () => {
    const body: AgentDefinitionApprovalBody = {
      kind: "agentDefinition",
      action: "create",
      name: "reviewer",
      description: "Reviews `diff` ranges **independently**.",
      persona: "developer",
      model: { after: ["opus"] },
      resolvedModels: [{ model: "claude-sdk/opus", effort: "high" }],
      effort: { after: "high" },
      peerTurns: { before: 4, after: 10 },
      source: "---\nname: reviewer\n---\n**literal source**",
      reason: "Add the reviewer agent",
    };
    const html = render(body);

    expect(html).toContain(
      "Reviews <code>diff</code> ranges <strong>independently</strong>.",
    );
    expect(html).toContain("**literal source**");
    expect(html).toContain("Peer turns at once");
    expect(html).toContain("10");
  });
});

describe("commit card Markdown", () => {
  it("renders blocker reasons and warnings, and keeps the message verbatim", () => {
    const html = renderToStaticMarkup(<CommitCard commit={commit} />);

    expect(html).toContain("<code>holdersOf</code>");
    expect(html).toContain("<strong>unrelated</strong>");
    expect(html).toContain("<code>api.snap</code> has <strong>no</strong>");
    expect(html).toContain("src/__init__.py: ");
    expect(html).toContain("Keep `**raw**` in the message");
  });
});

/**
 * The server's own findings quote a raw path with `markdownCodeSpan`
 * (`app/server/src/markdownCodeSpan.ts`, whose test pins these spans). A path
 * holding backticks or `__` must still read verbatim once it renders.
 */
describe("server-quoted paths in commit findings", () => {
  const warning = (span: string) =>
    `Untracked binary/non-text file will be included if committed: ${span}`;

  it.each([
    ["__init__.py", "`__init__.py`"],
    ["a`__init__`b.bin", "``a`__init__`b.bin``"],
    ["`__init__.bin`", "`` `__init__.bin` ``"],
  ])("reads %j verbatim inside one code span", (path, span) => {
    const html = renderToStaticMarkup(
      <CommitCard
        commit={{ ...commit, blockers: [], warnings: [warning(span)] }}
      />,
    );

    expect(html).toContain(`committed: <code>${path}</code>`);
    expect(html).not.toMatch(/<(strong|em)>/);
  });
});
