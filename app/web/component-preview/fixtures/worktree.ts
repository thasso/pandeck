/**
 * Wire-level fixtures for the worktree, pull request, review and document
 * stories: the records the server sends, plus `installWorktreeApi`, which
 * answers the worktree page's REST reads from them so the production page
 * renders without a server.
 */
import type {
  ProjectRecord,
  PullRequestInventoryItem,
  WorktreeChangeFile,
  WorktreeChangesResponse,
  WorktreeComment,
  WorktreeCommitLogEntry,
  WorktreeFileDiffResponse,
  WorktreeFileLogEntry,
  WorktreeGitStatus,
  WorktreeRecord,
  WorktreeTreeEntry,
} from "@assistant/shared";
import type { Prefs } from "../../src/hooks/usePrefs.ts";

/** A fixed clock, so relative times read the same on every render. */
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

export const worktreeProject: ProjectRecord = {
  id: "pandeck",
  key: "PD",
  name: "Pandeck",
  color: "#5b62e6",
  localPaths: [{ path: "/work/pandeck", kind: "repo" }],
};

export const featureWorktree: WorktreeRecord = {
  id: "pd-retry-backoff",
  projectId: "pandeck",
  mainRepoRoot: "/work/pandeck",
  path: "/work/worktrees/pd-retry-backoff",
  branch: "retry-backoff",
  baseBranch: "main",
  baseCommit: "8f3e2a1c9b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f",
  status: "active",
  sessionIds: ["s-impl", "s-review"],
  taskIds: ["812"],
  createdAt: NOW - 26 * HOUR,
  updatedAt: NOW - 4 * MIN,
};

/** Every git axis of a worktree; `overrides` picks the state. */
export function worktreeStatus(
  overrides: Partial<WorktreeGitStatus> = {},
): WorktreeGitStatus {
  return {
    worktreeId: featureWorktree.id,
    branch: featureWorktree.branch,
    head: "4c1d9e2",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 3,
    behind: 0,
    upstream: { ahead: 0, behind: 0, name: "origin/retry-backoff" },
    merged: false,
    updatedAt: NOW - MIN,
    ...overrides,
  };
}

export const cleanStatus = worktreeStatus();
export const dirtyStatus = worktreeStatus({
  dirty: true,
  filesChanged: 2,
  untracked: 1,
  additions: 24,
  deletions: 3,
  upstream: { ahead: 1, behind: 0, name: "origin/retry-backoff" },
  behind: 2,
});

/** The diff-display prefs the page reads; the rest are the app defaults. */
export const storyPrefs = {
  theme: "light",
  textScale: 100,
  worktreeChangesRailWidth: 280,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  diffStyle: "unified",
  diffWordLevel: true,
  diffIgnoreWhitespace: true,
  diffWrap: false,
  diffExpandContext: false,
} as Prefs;

interface FixtureFile {
  oldContent: string;
  newContent: string;
  diff: string;
  change: WorktreeChangeFile;
}

const FILES: Record<string, FixtureFile> = {
  "src/lib/retry.ts": {
    oldContent:
      "export interface RetryOptions {\n  attempts: number;\n  delayMs: number;\n}\n\nexport async function retry<T>(\n  run: () => Promise<T>,\n  { attempts, delayMs }: RetryOptions,\n): Promise<T> {\n  let lastError: unknown;\n  for (let attempt = 0; attempt < attempts; attempt += 1) {\n    try {\n      return await run();\n    } catch (error) {\n      lastError = error;\n      await new Promise((resolve) => setTimeout(resolve, delayMs));\n    }\n  }\n  throw lastError;\n}\n",
    newContent:
      "export interface RetryOptions {\n  attempts: number;\n  delayMs: number;\n  /** Multiply the delay by this after every failed attempt. */\n  backoff?: number;\n}\n\nexport async function retry<T>(\n  run: () => Promise<T>,\n  { attempts, delayMs, backoff = 2 }: RetryOptions,\n): Promise<T> {\n  let lastError: unknown;\n  let delay = delayMs;\n  for (let attempt = 0; attempt < attempts; attempt += 1) {\n    try {\n      return await run();\n    } catch (error) {\n      lastError = error;\n      await new Promise((resolve) => setTimeout(resolve, delay));\n      delay *= backoff;\n    }\n  }\n  throw lastError;\n}\n",
    diff: "diff --git a/src/lib/retry.ts b/src/lib/retry.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/lib/retry.ts\n+++ b/src/lib/retry.ts\n@@ -1,19 +1,23 @@\n export interface RetryOptions {\n   attempts: number;\n   delayMs: number;\n+  /** Multiply the delay by this after every failed attempt. */\n+  backoff?: number;\n }\n \n export async function retry<T>(\n   run: () => Promise<T>,\n-  { attempts, delayMs }: RetryOptions,\n+  { attempts, delayMs, backoff = 2 }: RetryOptions,\n ): Promise<T> {\n   let lastError: unknown;\n+  let delay = delayMs;\n   for (let attempt = 0; attempt < attempts; attempt += 1) {\n     try {\n       return await run();\n     } catch (error) {\n       lastError = error;\n-      await new Promise((resolve) => setTimeout(resolve, delayMs));\n+      await new Promise((resolve) => setTimeout(resolve, delay));\n+      delay *= backoff;\n     }\n   }\n   throw lastError;\n",
    change: {
      path: "src/lib/retry.ts",
      status: "modified",
      additions: 6,
      deletions: 2,
      binary: false,
    },
  },
  "docs/retries.md": {
    oldContent:
      "# Retries\n\nRequests to the provider retry three times with a fixed delay.\n",
    newContent:
      "# Retries\n\nRequests to the provider retry three times. The delay doubles after every\nfailed attempt, starting at 250 ms, so a flaky provider is not hammered.\n\n| Attempt | Delay  |\n| ------- | ------ |\n| 1       | 250 ms |\n| 2       | 500 ms |\n| 3       | 1 s    |\n",
    diff: "diff --git a/docs/retries.md b/docs/retries.md\nindex 1a2b3c4..5d6e7f8 100644\n--- a/docs/retries.md\n+++ b/docs/retries.md\n@@ -1,3 +1,10 @@\n # Retries\n \n-Requests to the provider retry three times with a fixed delay.\n+Requests to the provider retry three times. The delay doubles after every\n+failed attempt, starting at 250 ms, so a flaky provider is not hammered.\n+\n+| Attempt | Delay  |\n+| ------- | ------ |\n+| 1       | 250 ms |\n+| 2       | 500 ms |\n+| 3       | 1 s    |\n",
    change: {
      path: "docs/retries.md",
      status: "modified",
      additions: 8,
      deletions: 1,
      binary: false,
    },
  },
  "src/lib/retry.test.ts": {
    oldContent: "",
    newContent:
      'import { expect, it, vi } from "vitest";\nimport { retry } from "./retry.ts";\n\nit("backs off between attempts", async () => {\n  vi.useFakeTimers();\n  const run = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(1);\n  const result = retry(run, { attempts: 2, delayMs: 10 });\n  await vi.runAllTimersAsync();\n  await expect(result).resolves.toBe(1);\n});\n',
    diff: 'diff --git a/src/lib/retry.test.ts b/src/lib/retry.test.ts\nnew file mode 100644\nindex 0000000..5d6e7f8\n--- /dev/null\n+++ b/src/lib/retry.test.ts\n@@ -0,0 +1,10 @@\n+import { expect, it, vi } from "vitest";\n+import { retry } from "./retry.ts";\n+\n+it("backs off between attempts", async () => {\n+  vi.useFakeTimers();\n+  const run = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(1);\n+  const result = retry(run, { attempts: 2, delayMs: 10 });\n+  await vi.runAllTimersAsync();\n+  await expect(result).resolves.toBe(1);\n+});\n',
    change: {
      path: "src/lib/retry.test.ts",
      status: "untracked",
      additions: 10,
      deletions: 0,
      binary: false,
    },
  },
};

const changedFiles: WorktreeChangeFile[] = Object.values(FILES).map(
  (file) => file.change,
);

function changesResponse(
  files: WorktreeChangeFile[] = changedFiles,
): WorktreeChangesResponse {
  return {
    worktreeId: featureWorktree.id,
    branch: featureWorktree.branch,
    head: "4c1d9e2",
    scope: { kind: "workingTree" },
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    updatedAt: NOW - MIN,
  };
}

function fileDiff(path: string): WorktreeFileDiffResponse | undefined {
  const file = FILES[path];
  if (!file) return undefined;
  return {
    worktreeId: featureWorktree.id,
    path,
    status: file.change.status,
    language: path.endsWith(".md") ? "markdown" : "typescript",
    binary: false,
    truncated: false,
    diff: file.diff,
    oldContent: file.oldContent,
    newContent: file.newContent,
    updatedAt: NOW - MIN,
  };
}

function fileContent(path: string): string | undefined {
  return FILES[path]?.newContent;
}

const treeEntries: Record<string, WorktreeTreeEntry[]> = {
  "": [
    { name: "docs", path: "docs", kind: "dir" },
    { name: "src", path: "src", kind: "dir" },
    { name: "README.md", path: "README.md", kind: "file", size: 1840 },
    { name: "package.json", path: "package.json", kind: "file", size: 912 },
  ],
  docs: [
    { name: "retries.md", path: "docs/retries.md", kind: "file", size: 310 },
  ],
  src: [{ name: "lib", path: "src/lib", kind: "dir" }],
  "src/lib": [
    { name: "retry.ts", path: "src/lib/retry.ts", kind: "file", size: 640 },
    {
      name: "retry.test.ts",
      path: "src/lib/retry.test.ts",
      kind: "file",
      size: 380,
    },
  ],
};

const commitLog: WorktreeCommitLogEntry[] = [
  {
    oid: "4c1d9e2a7b3f5e6d8c9a0b1c2d3e4f5a6b7c8d9e",
    shortOid: "4c1d9e2",
    subject: "Double the retry delay after every failed attempt",
    author: "Ari Kim",
    authoredAt: NOW - 40 * MIN,
  },
  {
    oid: "9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
    shortOid: "9b8a7c6",
    subject: "Document the provider retry policy",
    author: "Ari Kim",
    authoredAt: NOW - 3 * HOUR,
  },
  {
    oid: "1f2e3d4c5b6a7980a1b2c3d4e5f60718293a4b5c",
    shortOid: "1f2e3d4",
    subject: "Extract retry() from the provider client",
    author: "Pandeck agent",
    authoredAt: NOW - 20 * HOUR,
  },
  {
    oid: featureWorktree.baseCommit,
    shortOid: "8f3e2a1",
    subject: "Release 0.42.0",
    author: "Sam Ortiz",
    authoredAt: NOW - 30 * HOUR,
    onBase: true,
  },
];

const fileLog: WorktreeFileLogEntry[] = commitLog
  .filter((entry) => !entry.onBase)
  .map((entry, index, all) => ({
    ...entry,
    path: "src/lib/retry.ts",
    parentOid: all[index + 1]?.oid ?? featureWorktree.baseCommit,
  }));

/** A review in progress: open, moved, agent-answered and resolved threads. */
export const reviewComments: WorktreeComment[] = [
  {
    id: "c-backoff",
    worktreeId: featureWorktree.id,
    author: { kind: "user" },
    body: "Cap the delay — with `backoff = 2` ten attempts wait over four minutes.",
    current: { path: "src/lib/retry.ts", line: 14 },
    anchorState: "anchored",
    createdAt: NOW - 30 * MIN,
    updatedAt: NOW - 30 * MIN,
  },
  {
    id: "c-backoff-reply",
    worktreeId: featureWorktree.id,
    parentId: "c-backoff",
    author: {
      kind: "agent",
      sessionId: "s-impl-0123456789",
      model: "claude-opus-5-5",
    },
    body: "Agreed. I'll add `maxDelayMs` with a 30 s default.",
    current: { path: "src/lib/retry.ts", line: 14 },
    createdAt: NOW - 20 * MIN,
    updatedAt: NOW - 20 * MIN,
  },
  {
    id: "c-table",
    worktreeId: featureWorktree.id,
    author: { kind: "user" },
    body: "The table should say what happens after the third attempt.",
    severity: "minor",
    current: { path: "docs/retries.md", line: 6 },
    anchorState: "moved",
    createdAt: NOW - 25 * MIN,
    updatedAt: NOW - 25 * MIN,
  },
  {
    id: "c-gone",
    worktreeId: featureWorktree.id,
    author: { kind: "user" },
    body: "This constant was the old fixed delay; is it still used?",
    anchor: {
      path: "src/lib/retry.ts",
      side: "new",
      line: 3,
      commit: featureWorktree.baseCommit,
      dirty: false,
      selectors: {
        quote: { exact: "const RETRY_DELAY_MS = 250;", prefix: "", suffix: "" },
      },
    },
    anchorState: "orphaned",
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
  },
  {
    id: "c-name",
    worktreeId: featureWorktree.id,
    author: { kind: "user" },
    body: "Rename `run` to `attemptOnce`?",
    current: { path: "src/lib/retry.ts", line: 8 },
    resolvedAt: NOW - 10 * MIN,
    attachedSessionId: "s-impl",
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 10 * MIN,
  },
];

/** A pull request as the inventory carries it; `overrides` picks the state. */
export function pullRequest(
  overrides: {
    [K in keyof PullRequestInventoryItem]?:
      PullRequestInventoryItem[K] | undefined;
  } = {},
): PullRequestInventoryItem {
  // `undefined` drops a default, as the wire omits the field.
  const item = {
    projectId: "pandeck",
    provider: "github",
    repositoryKey: "pandeck/pandeck",
    repoWebUrl: "https://github.com/pandeck/pandeck",
    number: 418,
    url: "https://github.com/pandeck/pandeck/pull/418",
    title: "Back off between provider retries",
    headBranch: "retry-backoff",
    baseBranch: "main",
    author: "ari-kim",
    mine: true,
    reviewRequested: false,
    updatedAt: NOW - 12 * MIN,
    state: "open",
    ci: {
      state: "success",
      total: 9,
      url: "https://github.com/pandeck/pandeck/actions",
    },
    review: { changesRequested: false, unresolvedThreads: 1 },
    mergeable: true,
    headSha: "4c1d9e2a7b3f5e6d8c9a0b1c2d3e4f5a6b7c8d9e",
    capabilities: {
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      defaultMergeMethod: "squash",
      canDeleteBranchOnMerge: true,
    },
    worktreeId: featureWorktree.id,
    sessionIds: ["s-impl", "s-review"],
    taskIds: ["812"],
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined),
  ) as unknown as PullRequestInventoryItem;
}

export const pullRequestInventory: PullRequestInventoryItem[] = [
  pullRequest(),
  pullRequest({
    number: 421,
    title: "Show the merge method the repository allows",
    headBranch: "merge-methods",
    mine: false,
    reviewRequested: true,
    author: "sam-ortiz",
    ci: { state: "pending", total: 9 },
    review: { changesRequested: false },
    worktreeId: undefined,
    sessionIds: [],
    taskIds: [],
  }),
  pullRequest({
    number: 409,
    title: "Draft: stream tool output into the transcript while it runs",
    headBranch: "stream-tool-output",
    draft: true,
    ci: { state: "failure", total: 9 },
    review: { changesRequested: true },
    worktreeId: undefined,
  }),
  pullRequest({
    number: 397,
    title: "Settle sessions when their worktree is retired",
    headBranch: "settle-on-retire",
    state: "merged",
    ci: { state: "success", total: 8 },
  }),
];

/* ------------------------------ the fake server ----------------------------- */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Answer `/api/worktrees/<id>/…` reads from the fixtures above and leave every
 * other request to the real `fetch`. Returns the restore function.
 */
export function installWorktreeApi({
  status = dirtyStatus,
  files = changedFiles,
}: {
  status?: WorktreeGitStatus;
  files?: WorktreeChangeFile[];
} = {}): () => void {
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.href,
    );
    const match = /^\/api\/worktrees\/[^/]+\/([a-z-]+)$/.exec(url.pathname);
    if (!match) return realFetch(input, init);
    const path = url.searchParams.get("path") ?? "";
    switch (match[1]) {
      case "status":
        return json(status);
      case "changes":
        return json(changesResponse(files));
      case "file-diff": {
        const diff = fileDiff(path);
        return diff
          ? json(diff)
          : json({ error: "Path not changed in this scope." }, 400);
      }
      case "file": {
        const content = fileContent(path) ?? `# ${path}\n`;
        return json({
          worktreeId: featureWorktree.id,
          path,
          language: path.endsWith(".md") ? "markdown" : "typescript",
          mimeType: "text/plain",
          binary: false,
          truncated: false,
          content,
          updatedAt: NOW - MIN,
        });
      }
      case "tree":
        return json(treeEntries[path] ?? []);
      case "log":
        return json({ worktreeId: featureWorktree.id, entries: commitLog });
      case "file-log":
        return json({
          worktreeId: featureWorktree.id,
          path,
          entries: fileLog,
          truncated: false,
        });
      default:
        return json({ error: "Not in the story fixtures." }, 404);
    }
  };
  return () => {
    window.fetch = realFetch;
  };
}
