/**
 * Fresh-import guards for the client-mode writes (Task-1463 P6b, P6B-F1):
 * each module loads ALONE in a fresh registry, so an import cycle that would
 * leave a binding in its temporal dead zone fails here, and the executor
 * modules still register their approval kinds when nothing else loaded them
 * first.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

/** Imports `load()` in a fresh registry and returns the kinds it registered. */
async function freshImport<M>(
  load: () => Promise<M>,
): Promise<{ module: M; registered: string[] }> {
  vi.resetModules();
  const registered: string[] = [];
  vi.doMock("../../pendingApprovals.ts", async (original) => {
    const actual = await original<typeof import("../../pendingApprovals.ts")>();
    return {
      ...actual,
      registerApprovalExecutor: ((kind, executor) => {
        registered.push(kind);
        return actual.registerApprovalExecutor(kind, executor);
      }) as typeof actual.registerApprovalExecutor,
    };
  });
  const module = await load();
  return { module, registered };
}

afterEach(() => {
  vi.doUnmock("../../pendingApprovals.ts");
  vi.resetModules();
});

test("catalog.ts loads alone and registers both write kinds", async () => {
  const { module, registered } = await freshImport(
    () => import("../catalog.ts"),
  );
  assert.equal(typeof module.toolGroupsFor, "function");
  assert.ok(registered.includes("jiraIssue"));
  assert.ok(registered.includes("confluencePage"));
});

test("jiraTools.ts loads alone and registers jiraIssue", async () => {
  const { module, registered } = await freshImport(
    () => import("../jira/jiraTools.ts"),
  );
  assert.equal(module.jiraMutateIssueTool.name, "jira_mutate_issue");
  assert.ok(registered.includes("jiraIssue"));
});

test("confluenceTools.ts loads alone and registers confluencePage", async () => {
  const { module, registered } = await freshImport(
    () => import("../confluence/confluenceTools.ts"),
  );
  assert.equal(module.confluenceMutatePageTool.name, "confluence_mutate_page");
  assert.ok(registered.includes("confluencePage"));
});

test("remoteWrites.ts loads alone and builds both write tools from the leaves", async () => {
  const { module, registered } = await freshImport(
    () => import("./remoteWrites.ts"),
  );
  const jira = module.remoteWriteTool({
    name: "jira_mutate_issue",
    effect: "write",
    actionKey: "jira:write",
    product: "jira",
    kind: "jiraIssue",
    twoPhase: true,
  });
  const confluence = module.remoteWriteTool({
    name: "confluence_mutate_page",
    effect: "write",
    actionKey: "confluence:write",
    product: "confluence",
    kind: "confluencePage",
    twoPhase: true,
  });
  assert.equal(jira.label, "Jira: Prepare Issue Changes");
  assert.equal(confluence.label, "Confluence: Prepare Page Changes");
  // It reaches no local tool module, so it registers no local executor.
  assert.deepEqual(
    registered.filter(
      (kind) => kind === "jiraIssue" || kind === "confluencePage",
    ),
    [],
  );
});
