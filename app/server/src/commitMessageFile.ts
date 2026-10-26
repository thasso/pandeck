/**
 * The commit-message file for `git commit -F`: written here, on the server,
 * and read by the checkout's git, which runs on its Worker. That works while
 * the server and the Worker share an account and a host; phase 3 must settle
 * where the file is written (Task-1154, `docs/workers.md`).
 *
 * Imports only Node built-ins and nothing of the checkout family: the git
 * that reads the file is injected.
 */
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes `message` to a fresh temp file, commits with it through `runGit`,
 * and removes the file. A failure to create or write the file propagates
 * before any git call, with no cleanup. `"verbatim"` keeps the text exactly
 * (`--cleanup=verbatim`); `"git-default"` leaves git's cleanup on.
 */
export async function commitWithMessageFile(
  message: string,
  cleanup: "verbatim" | "git-default",
  runGit: (args: string[]) => Promise<unknown>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-commit-"));
  const file = join(dir, "COMMIT_MESSAGE");
  writeFileSync(file, `${message.trim()}\n`, "utf8");
  try {
    await runGit([
      "commit",
      ...(cleanup === "verbatim" ? ["--cleanup=verbatim"] : []),
      "-F",
      file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
