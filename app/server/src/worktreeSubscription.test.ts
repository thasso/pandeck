import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { projectStore } from "./db/projectStore.ts";
import {
  clearWorktreeStatusMemoryForTests,
  worktreeStatusComputeCountsForTests,
} from "./worktrees/worktreeStatus.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as ServerMessage),
  };
}

describe("worktree topic subscription", () => {
  it("sends an authoritative list when the topic becomes active", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent) as never);

    await connection.handle({ type: "subscribe", topics: ["worktrees"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.some((message) => message.type === "worktreeList")).toBe(true);
  });

  it("mounting a list plus its watches computes each status once", async () => {
    const repoPath = join(process.env.ASSISTANT_CWD!, "surface-repo");
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: repoPath },
    );
    projectStore.put({
      id: "surface-proj",
      name: "Surface Project",
      key: "SP",
      description: "",
      status: "active",
      localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    clearWorktreeStatusMemoryForTests();
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent) as never);
    await connection.handle({ type: "subscribe", topics: ["worktrees"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      sent.filter((message) => message.type === "worktreeStatus"),
    ).toHaveLength(0);
    expect(worktreeStatusComputeCountsForTests().full).toBe(0);

    const id = mainWorktreeId("surface-proj");
    await connection.handle({ type: "watchWorktree", worktreeId: id });
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (sent.some((message) => message.type === "worktreeStatus")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      sent.filter((message) => message.type === "worktreeStatus"),
    ).toHaveLength(1);
    expect(worktreeStatusComputeCountsForTests().full).toBe(1);

    await connection.handle({ type: "unwatchWorktree", worktreeId: id });
  });
});
