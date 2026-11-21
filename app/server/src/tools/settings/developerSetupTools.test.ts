import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import {
  GITHUB_CLASSIC_PAT_SCOPES,
  GITHUB_CLASSIC_PAT_URL,
} from "@assistant/shared/settingsRegistry";
import { GitCommandError, type GitResult } from "../../gitExec.ts";
import { developerSetupTools } from "./developerSetupTools.ts";

type GitAnswer = GitResult | Error;
const answers = new Map<string, GitAnswer>();
const calls: Array<{ args: string[]; cwd: string }> = [];

vi.mock("../../gitExec.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gitExec.ts")>()),
  checkoutGitOn: () => ({
    gitReadOnlyOptionalExit: async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      const answer = answers.get(args.join(" "));
      if (!answer) throw new Error(`unexpected git ${args.join(" ")}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }),
}));

const ctx = {
  toolCallId: "call-1",
  session: { sessionId: "s-pa", cwd: "/home/u" },
} as never;
const tool = (name: string) =>
  developerSetupTools.find((t) => t.name === name)!;
const gitSetupRead = () => tool("git_setup_read").execute({}, ctx);

const ok = (stdout: string): GitResult => ({ stdout, stderr: "", code: 0 });
const unset: GitResult = { stdout: "", stderr: "", code: 1 };
const VERSION = "--version";
const NAME = "config --global --get user.name";
const EMAIL = "config --global --get user.email";

beforeEach(() => {
  answers.clear();
  calls.length = 0;
});

describe("git_setup_read", () => {
  test("reports the version and a complete global identity", async () => {
    answers.set(VERSION, ok("git version 2.54.0\n"));
    answers.set(NAME, ok("Ada Lovelace\n"));
    answers.set(EMAIL, ok("ada@example.com\n"));
    const result = await gitSetupRead();
    assert.deepEqual(result.details, {
      git: "installed",
      version: "git version 2.54.0",
      globalIdentity: {
        configured: true,
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    });
    // Runs in the session's directory, and only ever reads.
    assert.ok(calls.every((call) => call.cwd === "/home/u"));
    assert.ok(
      calls.every(
        (call) =>
          call.args[0] === "--version" ||
          (call.args[0] === "config" && call.args.includes("--get")),
      ),
    );
  });

  test("names what is missing from the identity", async () => {
    answers.set(VERSION, ok("git version 2.54.0\n"));
    answers.set(NAME, ok("Ada Lovelace\n"));
    answers.set(EMAIL, unset);
    const result = await gitSetupRead();
    assert.deepEqual(
      (result.details as { globalIdentity: unknown }).globalIdentity,
      { configured: false, name: "Ada Lovelace" },
    );

    answers.set(NAME, unset);
    const neither = await gitSetupRead();
    assert.deepEqual(
      (neither.details as { globalIdentity: unknown }).globalIdentity,
      { configured: false },
    );
  });

  test("says Git is not installed when there is no git to run", async () => {
    answers.set(
      VERSION,
      new GitCommandError(
        "git --version failed: spawn git ENOENT",
        { stdout: "", stderr: "", code: -1 },
        "execution",
      ),
    );
    const result = await gitSetupRead();
    assert.equal((result.details as { git: string }).git, "not_installed");
    assert.equal(calls.length, 1, "no identity read without git");
  });

  test("a check that could not run fails instead of guessing", async () => {
    answers.set(
      VERSION,
      new GitCommandError(
        "git --version failed: Worker connection ended",
        { stdout: "", stderr: "", code: -1 },
        "execution",
      ),
    );
    await assert.rejects(gitSetupRead(), /Could not check Git.*Do not assume/);

    answers.set(VERSION, { stdout: "", stderr: "boom", code: 128 });
    await assert.rejects(gitSetupRead(), /Could not check Git/);
  });

  test("an unreadable identity fails, naming the installed version", async () => {
    answers.set(VERSION, ok("git version 2.54.0\n"));
    answers.set(NAME, { stdout: "", stderr: "bad config", code: 3 });
    answers.set(EMAIL, unset);
    await assert.rejects(
      gitSetupRead(),
      /Git is installed \(git version 2\.54\.0\), but its global identity could not be read/,
    );
  });
});

describe("github_pat_setup_link", () => {
  const link = (username: unknown) =>
    tool("github_pat_setup_link").execute({ username } as never, ctx);

  test("returns the shared classic token link and scopes", async () => {
    const result = await link("  Octo-Cat  ");
    assert.deepEqual(result.details, {
      url: GITHUB_CLASSIC_PAT_URL,
      username: "Octo-Cat",
      scopes: GITHUB_CLASSIC_PAT_SCOPES,
      note: (result.details as { note: string }).note,
    });
    const url = new URL(GITHUB_CLASSIC_PAT_URL);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/settings/tokens/new");
    assert.equal(
      url.searchParams.get("scopes"),
      "repo,workflow,read:packages,notifications",
    );
    // A classic token belongs to the signed-in account: nothing selects one.
    assert.equal(url.search.includes("Octo"), false);
  });

  test("refuses anything that is not a GitHub username", async () => {
    for (const bad of [
      "",
      "-octo",
      "octo-",
      "oc--to",
      "octo cat",
      "octo&scopes=admin:org",
      "a".repeat(40),
      42,
    ])
      await assert.rejects(link(bad), /not a GitHub username/, String(bad));
    await link("a".repeat(39));
    await link("o");
  });
});
