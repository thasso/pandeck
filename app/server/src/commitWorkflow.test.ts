import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  acceptCommitDryRun,
  runCommitWorkflow,
  setCommitMessageGeneratorForTests,
} from "./commitWorkflow.ts";
import type { CommitAgentResult } from "./commitAgent.ts";
import type { AgentSession } from "./piSdk/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";

// Passthrough git seam with one hook: run something after the workflow's
// unlocked inspection and right before it takes the repository lock.
const lockHooks = vi.hoisted(() => ({
  beforeLock: undefined as (() => void) | undefined,
  beforeInspect: undefined as (() => void) | undefined,
}));
vi.mock("./gitExec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitExec.ts")>();
  return {
    ...actual,
    checkoutGitOn: (side: Parameters<typeof actual.checkoutGitOn>[0]) => {
      const family = actual.checkoutGitOn(side);
      return {
        ...family,
        resolveRepoRoot: async (cwd: string) => {
          lockHooks.beforeInspect?.();
          return family.resolveRepoRoot(cwd);
        },
      };
    },
    withRepoLock: async <T>(key: string, fn: () => Promise<T>) => {
      lockHooks.beforeLock?.();
      return actual.withRepoLock(key, fn);
    },
  };
});

const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pa-commit-workflow-"));
  repos.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test User");
  git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "base");
  git(cwd, "switch", "-c", "feature");
  return cwd;
}

const generated: CommitAgentResult = {
  status: "commit",
  subject: "Update checked content",
  body: ["Keep the generated message workflow."],
  blockers: [],
  warnings: [],
};

/** A minimal slash-command session: an empty transcript plus a custom-entry store. */
function fakeSession(): AgentSession {
  const entries = new Map<string, unknown>();
  let next = 0;
  return {
    sessionManager: {
      getBranch: () => [],
      appendCustomEntry: (customType: string, data: unknown) => {
        const id = `entry-${(next += 1)}`;
        entries.set(id, { type: "custom", customType, data });
        return id;
      },
      getEntry: (id: string) => entries.get(id),
    },
  } as unknown as AgentSession;
}

afterEach(() => {
  lockHooks.beforeLock = undefined;
  lockHooks.beforeInspect = undefined;
  vi.restoreAllMocks();
  setCommitMessageGeneratorForTests(null);
  for (const cwd of repos.splice(0))
    rmSync(cwd, { recursive: true, force: true });
});

test("commit helper captures transcript source requirement before git awaits", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const source = vi
    .spyOn(sessionStore, "getIncludingDeleted")
    .mockReturnValue({ requiresEnterprise: true } as never);
  lockHooks.beforeInspect = () =>
    source.mockReturnValue({ requiresEnterprise: false } as never);
  setCommitMessageGeneratorForTests(async (prompt, helperSource) => {
    assert.match(prompt, /Enterprise transcript context/);
    assert.deepEqual(helperSource, {
      sourceSessionId: "enterprise-commit",
      requiresEnterprise: true,
    });
    return generated;
  });
  const session = fakeSession();
  session.sessionManager.getBranch = () =>
    [
      {
        id: "user-1",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Enterprise transcript context" }],
        },
      },
    ] as never;
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "slash",
    cwd,
    dryRun: true,
    session,
    sessionId: "enterprise-commit",
    requiresEnterprise: false,
  });
  assert.equal(result.status, "dry-run");
});

test("checked workflow commits with a generated message and reports no changes as data", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const progress: string[] = [];
  setCommitMessageGeneratorForTests(async (prompt) => {
    assert.match(prompt, /Mode: real commit/);
    return generated;
  });
  const committed = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    force: false,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(committed.status, "committed");
  assert.equal(committed.forced, false);
  assert.equal(
    committed.commitMessage,
    generated.subject + "\n\n" + generated.body[0],
  );
  assert.equal(
    committed.commitHash,
    git(cwd, "rev-parse", "HEAD").slice(0, 12),
  );
  assert.match(git(cwd, "log", "-1", "--format=%B"), /Update checked content/);
  assert.deepEqual(progress, [
    "Inspecting git changes…",
    "Generating commit message…",
    "Staging all changes…",
    "Creating git commit…",
  ]);

  setCommitMessageGeneratorForTests(async () => {
    throw new Error("clean trees do not invoke the agent");
  });
  const clean = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
  });
  assert.equal(clean.status, "blocked");
  assert.match(clean.blockers[0]?.reason ?? "", /No changes to commit/);
});

test("a caller message is committed as given while the commit agent still reviews", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const message =
    "STAR-1502: Add the caller-written subject\n\n# Not a comment\nBody line.";
  let reviewed = 0;
  setCommitMessageGeneratorForTests(async () => {
    reviewed += 1;
    return {
      ...generated,
      status: "block",
      blockers: [{ kind: "unsafe", reason: "Unrelated change" }],
    };
  });
  const progress: string[] = [];
  const blocked = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    callerMessage: message,
    onProgress: (step) => progress.push(step),
  });
  assert.equal(reviewed, 1);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.commitMessage, message);
  assert.deepEqual(blocked.blockers, [
    { kind: "unsafe", reason: "Unrelated change" },
  ]);
  assert.equal(git(cwd, "log", "-1", "--format=%s"), "base");
  assert.deepEqual(progress.slice(0, 2), [
    "Inspecting git changes…",
    "Reviewing changes…",
  ]);

  setCommitMessageGeneratorForTests(async () => {
    reviewed += 1;
    return generated;
  });
  const committed = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    callerMessage: message,
  });
  assert.equal(reviewed, 2);
  assert.equal(committed.status, "committed");
  assert.equal(git(cwd, "log", "-1", "--format=%B"), message);
});

test("caller and approved messages survive git cleanup verbatim", async () => {
  const cwd = repo();
  // The strictest cleanup a user may configure: it drops `#` lines.
  git(cwd, "config", "commit.cleanup", "strip");
  const message =
    "STAR-1502: Keep exact text\n\n# Notes for Percy\n\n\n- trailing space  \nend";
  const lastMessage = () =>
    execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd,
      encoding: "utf8",
    });
  setCommitMessageGeneratorForTests(async () => generated);
  writeFileSync(join(cwd, "file.txt"), "caller\n");
  const committed = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    callerMessage: message,
  });
  assert.equal(committed.status, "committed");
  assert.equal(lastMessage(), `${message}\n\n`);

  writeFileSync(join(cwd, "file.txt"), "approved\n");
  const proposal = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    dryRun: true,
    callerMessage: message,
  });
  const approved = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    approvedChange: {
      fingerprint: proposal.changeFingerprint!,
      message: proposal.commitMessage!,
    },
  });
  assert.equal(approved.status, "committed");
  assert.equal(lastMessage(), `${message}\n\n`);
});

test("a commit a commit-msg hook refuses leaves no message file behind", async () => {
  const cwd = repo();
  const tmp = mkdtempSync(join(tmpdir(), "pa-commit-message-tmp-"));
  repos.push(tmp);
  const seen = join(tmp, "..", `${basename(tmp)}.seen`);
  repos.push(seen);
  // The hook records what the message file's TMPDIR held while git ran.
  writeFileSync(
    join(cwd, ".git", "hooks", "commit-msg"),
    `#!/bin/sh\nls "${tmp}" > "${seen}"\nexit 1\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(cwd, "file.txt"), "refused\n");
  setCommitMessageGeneratorForTests(async () => generated);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const result = await runCommitWorkflow({
      side: DEFAULT_WORKER_SIDE,
      source: "tool",
      cwd,
    });
    assert.equal(result.status, "failed");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.match(readFileSync(seen, "utf8"), /^assistant-commit-.{6}\n$/);
  assert.deepEqual(readdirSync(tmp), []);
  assert.equal(git(cwd, "log", "--oneline").split("\n").length, 1);
});

test("tool callers contribute session prompts, touched paths, context and a checkpoint entry", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const appended: Array<{ type: string; data: unknown }> = [];
  const sessionManager = {
    getBranch: () => [
      {
        type: "message",
        id: "prompt-1",
        message: { role: "user", content: "Implement the checked commit" },
      },
      {
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: { path: "file.txt" },
            },
          ],
        },
      },
    ],
    appendCustomEntry: (type: string, data: unknown) => {
      appended.push({ type, data });
      return "checkpoint-1";
    },
  };
  setCommitMessageGeneratorForTests(async (prompt) => {
    assert.match(prompt, /Complete Task 585/);
    assert.match(prompt, /Implement the checked commit/);
    assert.match(prompt, /- file\.txt/);
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    sessionManager,
    sessionKind: "developer",
    sessionId: "session-1",
    additionalContext: "Complete Task 585",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.customEntryId, "checkpoint-1");
  assert.deepEqual(result.includedUserEntryIds, ["prompt-1"]);
  assert.deepEqual(result.sessionTouchedPaths, ["file.txt"]);
  assert.equal(appended.at(-1)?.type, "workshop.commit");
});

test("credentials in session prompts and caller context are redacted, not blocked", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const accessKey = "ASIA" + "ABCDEFGHIJKLMNOP";
  const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const sessionToken = "IQoJb3JpZ2luX2VjEXAMPLETOKENVALUE";
  const sessionManager = {
    getBranch: () => [
      {
        type: "message",
        id: "prompt-1",
        message: {
          role: "user",
          content: [
            `export AWS_ACCESS_KEY_ID=${accessKey}`,
            `export AWS_SECRET_ACCESS_KEY=${secretKey}`,
            `{ "SessionToken": "${sessionToken}" }`,
          ].join("\n"),
        },
      },
    ],
    appendCustomEntry: () => "checkpoint-1",
  };
  let prompt = "";
  setCommitMessageGeneratorForTests(async (text) => {
    prompt = text;
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    sessionManager,
    additionalContext: `aws_session_token = ${sessionToken}`,
  });
  assert.equal(result.status, "committed");
  for (const value of [accessKey, secretKey, sessionToken])
    assert.ok(!prompt.includes(value), `prompt leaks ${value}`);
  assert.match(prompt, /AWS_SECRET_ACCESS_KEY=\[redacted\]/);
  assert.match(prompt, /"SessionToken": "\[redacted\]"/);
  assert.match(prompt, /aws_session_token = \[redacted\]/);
});

test("a temporary AWS access key in the diff still blocks", async () => {
  const cwd = repo();
  writeFileSync(
    join(cwd, "file.txt"),
    `key = ${"ASIA" + "ABCDEFGHIJKLMNOP"}\n`,
  );
  setCommitMessageGeneratorForTests(async () => generated);
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.kind === "secret"));
});

test("same-sized content drift after generation blocks before staging", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "first\n");
  setCommitMessageGeneratorForTests(async () => {
    // Same status, stat and byte length as the inspected change: only hashing
    // the complete patch catches this external-editor drift.
    writeFileSync(join(cwd, "file.txt"), "other\n");
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
  });
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.at(-1)?.reason ?? "", /change set moved/);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(git(cwd, "log", "--oneline").split("\n").length, 1);
});

test("fingerprints untracked files beyond the commit-agent summary cap", async () => {
  const cwd = repo();
  for (let index = 0; index < 81; index += 1)
    writeFileSync(
      join(cwd, `untracked-${String(index).padStart(3, "0")}.txt`),
      "first\n",
    );
  setCommitMessageGeneratorForTests(async () => {
    writeFileSync(join(cwd, "untracked-080.txt"), "other\n");
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
  });
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.at(-1)?.reason ?? "", /change set moved/);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
});

test("commits dangling untracked symlinks without following their referents", async () => {
  const cwd = repo();
  symlinkSync("missing-target", join(cwd, "dangling.txt"));
  setCommitMessageGeneratorForTests(async () => generated);
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "slash",
    cwd,
  });
  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "show", "HEAD:dangling.txt"), "missing-target");
  assert.equal(
    git(cwd, "ls-tree", "HEAD", "dangling.txt").split(" ")[0],
    "120000",
  );
});

test("registered branch drift is revalidated inside the repository lock", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  setCommitMessageGeneratorForTests(async () => {
    git(cwd, "switch", "-c", "moved");
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
  });
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.at(-1)?.reason ?? "", /branch changed.*moved/);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
});

test("agent calls cannot force secret blockers while slash force remains available", async () => {
  setCommitMessageGeneratorForTests(async () => generated);
  const toolRepo = repo();
  writeFileSync(join(toolRepo, ".env"), "SAFE_TEST_VALUE=yes\n");
  const blocked = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd: toolRepo,
    force: false,
    expectedBranch: "feature",
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.some((item) => item.kind === "secret"));

  const humanRepo = repo();
  writeFileSync(join(humanRepo, ".env"), "SAFE_TEST_VALUE=yes\n");
  const forced = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "slash",
    cwd: humanRepo,
    force: true,
  });
  assert.equal(forced.status, "committed");
  assert.equal(forced.forced, true);
});

test("a Workflow Run's forced commit still refuses a secret the check finds", async () => {
  setCommitMessageGeneratorForTests(async () => generated);
  const cwd = repo();
  writeFileSync(join(cwd, ".env"), "SAFE_TEST_VALUE=yes\n");
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    expectedBranch: "feature",
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.kind === "secret"));
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
});

test("a Workflow Run's forced commit overrides the check's other problems", async () => {
  setCommitMessageGeneratorForTests(async () => ({
    ...generated,
    status: "block",
    blockers: [
      { kind: "unsafe", reason: "a recipient drain may wait forever" },
    ],
  }));
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    expectedBranch: "feature",
  });
  assert.equal(result.status, "committed");
});

test("approved overrides bind changes and message while retaining a fresh secret veto", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  setCommitMessageGeneratorForTests(async () => ({
    ...generated,
    status: "block",
    blockers: [{ kind: "unsafe", reason: "Potential issue" }],
  }));
  const proposal = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    dryRun: true,
  });
  assert.equal(proposal.status, "blocked");
  const approvedChange = {
    fingerprint: proposal.changeFingerprint!,
    message: proposal.commitMessage!,
  };
  const head = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "file.txt"), "another\n");
  const stale = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    approvedChange,
  });
  assert.equal(stale.status, "blocked");
  assert.match(stale.blockers[0]!.reason, /no longer match the approved/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  setCommitMessageGeneratorForTests(async () => ({
    ...generated,
    status: "block",
    blockers: [{ kind: "secret", reason: "Fresh secret finding" }],
  }));
  const secret = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    approvedChange,
  });
  assert.equal(secret.status, "blocked");
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
  setCommitMessageGeneratorForTests(async () => ({
    ...generated,
    subject: "A different regenerated message",
    status: "block",
    blockers: [{ kind: "unsafe", reason: "Potential issue" }],
  }));
  const committed = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    approvedChange,
  });
  assert.equal(committed.status, "committed");
  assert.equal(git(cwd, "log", "-1", "--format=%B"), approvedChange.message);
});

test("approved overrides reject changes during fresh review and Git operations under the lock", async () => {
  for (const mutate of [
    (cwd: string) => writeFileSync(join(cwd, "file.txt"), "moved\n"),
    (cwd: string) =>
      writeFileSync(
        join(cwd, ".git", "MERGE_HEAD"),
        git(cwd, "rev-parse", "HEAD") + "\n",
      ),
  ]) {
    const cwd = repo();
    writeFileSync(join(cwd, "file.txt"), "changed\n");
    setCommitMessageGeneratorForTests(async () => ({
      ...generated,
      status: "block",
      blockers: [{ kind: "unsafe", reason: "Potential issue" }],
    }));
    const proposal = await runCommitWorkflow({
      side: DEFAULT_WORKER_SIDE,
      source: "tool",
      cwd,
      dryRun: true,
    });
    lockHooks.beforeLock = () => mutate(cwd);
    const result = await runCommitWorkflow({
      side: DEFAULT_WORKER_SIDE,
      source: "tool",
      cwd,
      force: true,
      forceRefusesSecrets: true,
      approvedChange: {
        fingerprint: proposal.changeFingerprint!,
        message: proposal.commitMessage!,
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
    assert.equal(git(cwd, "log", "--oneline").split("\n").length, 1);
    lockHooks.beforeLock = undefined;
  }
});

test("staged-only approved override leaves other edits out of the commit", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "staged\n");
  git(cwd, "add", "file.txt");
  setCommitMessageGeneratorForTests(async () => ({
    ...generated,
    status: "block",
    blockers: [{ kind: "unsafe", reason: "Potential issue" }],
  }));
  const proposal = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    dryRun: true,
    stagedOnly: true,
  });
  writeFileSync(join(cwd, "file.txt"), "unstaged\n");
  writeFileSync(join(cwd, ".env"), "SAFE_TEST_VALUE=yes\n");
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    stagedOnly: true,
    force: true,
    forceRefusesSecrets: true,
    approvedChange: {
      fingerprint: proposal.changeFingerprint!,
      message: proposal.commitMessage!,
    },
  });
  assert.equal(result.status, "committed");
  assert.equal(git(cwd, "show", "HEAD:file.txt"), "staged");
  assert.match(git(cwd, "diff"), /unstaged/);
  assert.ok(git(cwd, "status", "--porcelain").includes(".env"));
});

test("staged-only scope commits the index as-is and leaves the rest of the tree alone", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "mine.txt"), "mine\n");
  git(cwd, "add", "mine.txt");
  writeFileSync(join(cwd, "file.txt"), "someone else's edit\n");
  writeFileSync(join(cwd, ".env"), "SAFE_TEST_VALUE=yes\n");
  const progress: string[] = [];
  let prompt = "";
  setCommitMessageGeneratorForTests(async (text) => {
    prompt = text;
    // Working-tree drift outside the index must not block a staged commit.
    writeFileSync(join(cwd, "file.txt"), "moved again\n");
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    stagedOnly: true,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.status, "committed");
  assert.equal(result.stagedOnly, true);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["mine.txt"],
  );
  assert.equal(result.totals.files, 1);
  assert.deepEqual(progress, [
    "Inspecting git changes…",
    "Generating commit message…",
    "Creating git commit…",
  ]);
  assert.match(prompt, /Scope: staged index only\. 2 unstaged or untracked/);
  assert.match(prompt, /- \.env\n|- file\.txt\n/);
  assert.match(prompt, /index entries only/);
  assert.doesNotMatch(prompt, /someone else's edit/);
  assert.doesNotMatch(prompt, /SAFE_TEST_VALUE/);
  assert.equal(
    git(cwd, "show", "--stat", "--format=", "HEAD").includes("mine.txt"),
    true,
  );
  assert.equal(git(cwd, "diff", "--name-only", "HEAD"), "file.txt");
  assert.equal(git(cwd, "ls-files", "--others", "--exclude-standard"), ".env");
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "");
});

test("staged-only scope blocks on an empty index and still fingerprints index drift", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "unstaged\n");
  setCommitMessageGeneratorForTests(async () => {
    throw new Error("an empty index does not invoke the agent");
  });
  const empty = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    stagedOnly: true,
  });
  assert.equal(empty.status, "blocked");
  assert.equal(empty.stagedOnly, true);
  assert.equal(empty.blockers[0]?.reason, "No staged changes to commit.");
  assert.equal(empty.files.length, 0);

  git(cwd, "add", "file.txt");
  writeFileSync(join(cwd, "file.txt"), "unstaged on top\n");
  setCommitMessageGeneratorForTests(async () => {
    // Reverting the tree-only edit turns `MM` into `M `: not index drift.
    writeFileSync(join(cwd, "file.txt"), "unstaged\n");
    return generated;
  });
  const settled = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    stagedOnly: true,
  });
  assert.equal(settled.status, "committed");
  assert.equal(git(cwd, "show", "--format=", "HEAD:file.txt"), "unstaged");

  writeFileSync(join(cwd, "file.txt"), "second\n");
  git(cwd, "add", "file.txt");
  setCommitMessageGeneratorForTests(async () => {
    writeFileSync(join(cwd, "file.txt"), "restaged\n");
    git(cwd, "add", "file.txt");
    return generated;
  });
  const drifted = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    stagedOnly: true,
  });
  assert.equal(drifted.status, "blocked");
  assert.match(drifted.blockers.at(-1)?.reason ?? "", /change set moved/);
  assert.equal(git(cwd, "log", "--oneline").split("\n").length, 2);
});

test("staged renames and quoted paths project one file each with exact paths", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "old name.txt"), "a\n");
  writeFileSync(join(cwd, "tab\tname.txt"), "b\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "quoted paths");
  git(cwd, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(cwd, "tab\tname.txt"), "b\nc\n");
  git(cwd, "add", "-A");
  writeFileSync(join(cwd, "file.txt"), "left in the tree\n");
  let prompt = "";
  setCommitMessageGeneratorForTests(async (text) => {
    prompt = text;
    return generated;
  });
  const result = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "tool",
    cwd,
    expectedBranch: "feature",
    stagedOnly: true,
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(result.files, [
    {
      path: "new name.txt",
      status: "renamed",
      sessionTouched: false,
      additions: 0,
      deletions: 0,
    },
    {
      path: "tab\tname.txt",
      status: "modified",
      sessionTouched: false,
      additions: 1,
      deletions: 0,
    },
  ]);
  assert.deepEqual(result.totals, { files: 2, additions: 1, deletions: 0 });
  assert.match(prompt, /^R {2}old name\.txt -> new name\.txt$/m);
  assert.match(prompt, /^M {2}tab\tname\.txt$/m);
  assert.equal(git(cwd, "diff", "--name-only", "HEAD"), "file.txt");
});

test("accepting a staged-only dry run rechecks the index under the lock", async () => {
  const cwd = repo();
  const session = fakeSession();
  writeFileSync(join(cwd, "file.txt"), "first\n");
  git(cwd, "add", "file.txt");
  setCommitMessageGeneratorForTests(async (prompt) => {
    assert.match(prompt, /Mode: dry-run preview/);
    return generated;
  });
  const dry = await runCommitWorkflow({
    side: DEFAULT_WORKER_SIDE,
    source: "slash",
    cwd,
    dryRun: true,
    stagedOnly: true,
    session,
  });
  assert.equal(dry.status, "dry-run");
  assert.equal(dry.stagedOnly, true);
  assert.ok(dry.customEntryId);

  lockHooks.beforeLock = () => {
    writeFileSync(join(cwd, "file.txt"), "second\n");
    git(cwd, "add", "file.txt");
  };
  const moved = await acceptCommitDryRun({
    side: DEFAULT_WORKER_SIDE,
    session,
    entryId: dry.customEntryId!,
    cwd,
  });
  assert.equal(moved.status, "failed");
  assert.match(moved.error ?? "", /moved while the commit was being prepared/);
  assert.equal(git(cwd, "log", "--oneline").split("\n").length, 1);
  assert.equal(git(cwd, "diff", "--cached", "--name-only"), "file.txt");

  lockHooks.beforeLock = undefined;
  writeFileSync(join(cwd, "file.txt"), "first\n");
  git(cwd, "add", "file.txt");
  writeFileSync(join(cwd, "file.txt"), "tree only\n");
  const accepted = await acceptCommitDryRun({
    side: DEFAULT_WORKER_SIDE,
    session,
    entryId: dry.customEntryId!,
    cwd,
  });
  assert.equal(accepted.status, "committed");
  assert.equal(accepted.stagedOnly, true);
  assert.equal(git(cwd, "show", "--format=", "HEAD:file.txt"), "first");
  assert.equal(git(cwd, "diff", "--name-only", "HEAD"), "file.txt");
});
