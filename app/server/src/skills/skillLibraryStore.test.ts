import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { git, gitOptional } from "../gitExec.ts";
import { SkillLibraryStore } from "./skillLibraryStore.ts";

let tempRoot: string;
let libraryRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "skills-store-test-"));
  libraryRoot = join(tempRoot, "skills");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

async function assertFreshReaderOwnedRepo(root: string): Promise<void> {
  assert.equal(
    (await git(["symbolic-ref", "--short", "HEAD"], root)).stdout.trim(),
    "main",
  );
  assert.notEqual(
    (await gitOptional(["rev-parse", "--verify", "HEAD"], root)).code,
    0,
    "bootstrap must not create a commit",
  );
  assert.notEqual(
    (await gitOptional(["config", "--local", "--get", "user.name"], root)).code,
    0,
    "bootstrap must not configure an author",
  );
  assert.ok(!existsSync(join(root, ".gitignore")));
}

describe("SkillLibraryStore bounded reads", () => {
  test("streams a diff larger than the shared Git buffer with exact metadata", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await git(
      [
        "-c",
        "user.name=Owner",
        "-c",
        "user.email=owner@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Base",
      ],
      libraryRoot,
    );
    const content = `${"0123456789abcdef".repeat(850_000)}\n`;
    await writeFile(join(libraryRoot, "large.txt"), content);
    await git(["add", "large.txt"], libraryRoot);
    await git(
      [
        "-c",
        "user.name=Owner",
        "-c",
        "user.email=owner@example.test",
        "commit",
        "-m",
        "Large diff",
      ],
      libraryRoot,
    );

    const diff = await store.diff({
      from: "HEAD~1",
      to: "HEAD",
      maxChars: 100,
    });

    assert.equal(diff.patch.length, 100);
    assert.equal(diff.truncated, true);
    assert.ok(diff.totalChars > 12 * 1024 * 1024);
  }, 30_000);

  test("does not execute repository-configured diff programs", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "notes.md"), "old\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "old"], libraryRoot);
    await writeFile(join(libraryRoot, "notes.md"), "new\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "new"], libraryRoot);

    const marker = join(tempRoot, "external-diff-ran");
    const external = join(tempRoot, "external-diff");
    await writeFile(external, `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    await git(["config", "diff.external", external], libraryRoot);
    await git(["config", "color.ui", "always"], libraryRoot);

    const diff = await store.diff({
      from: "HEAD~1",
      to: "HEAD",
      maxChars: 1_000,
    });

    assert.match(diff.patch, /-old/);
    assert.equal(diff.patch.includes(String.fromCharCode(27)), false);
    assert.ok(!existsSync(marker));
  });
});

describe("SkillLibraryStore initialization", () => {
  test("creates a missing library directory as an empty main-branch repository", async () => {
    assert.ok(!existsSync(libraryRoot));

    await new SkillLibraryStore(libraryRoot).ensureInitialized();

    assert.ok(existsSync(join(libraryRoot, ".git")));
    assert.equal((await git(["status", "--short"], libraryRoot)).stdout, "");
    await assertFreshReaderOwnedRepo(libraryRoot);
  });

  test("initializes a fresh directory without staging or changing its files", async () => {
    await mkdir(libraryRoot);
    const skillPath = join(libraryRoot, "SKILL.md");
    await writeFile(skillPath, "user-owned\n", "utf8");

    await new SkillLibraryStore(libraryRoot).ensureInitialized();

    assert.equal(await readFile(skillPath, "utf8"), "user-owned\n");
    assert.equal(
      (await git(["status", "--short"], libraryRoot)).stdout,
      "?? SKILL.md\n",
    );
    await assertFreshReaderOwnedRepo(libraryRoot);
  });

  test("leaves an existing user repository unchanged", async () => {
    await mkdir(libraryRoot);
    await git(["init", "-b", "trunk"], libraryRoot);
    await writeFile(join(libraryRoot, "SKILL.md"), "existing\n", "utf8");
    await git(["add", "SKILL.md"], libraryRoot);
    await git(
      [
        "-c",
        "user.name=Library Owner",
        "-c",
        "user.email=owner@example.test",
        "commit",
        "-m",
        "Seed library",
      ],
      libraryRoot,
    );
    await git(["config", "user.name", "Owner Override"], libraryRoot);
    const headBefore = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout;

    await new SkillLibraryStore(libraryRoot).ensureInitialized();

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout,
      headBefore,
    );
    assert.equal(
      (await git(["symbolic-ref", "--short", "HEAD"], libraryRoot)).stdout,
      "trunk\n",
    );
    assert.equal(
      (await git(["config", "--local", "--get", "user.name"], libraryRoot))
        .stdout,
      "Owner Override\n",
    );
    assert.equal((await git(["status", "--short"], libraryRoot)).stdout, "");
    assert.ok(!existsSync(join(libraryRoot, ".gitignore")));
  });

  test("serializes concurrent stores and remains idempotent on reopen", async () => {
    const stores = Array.from(
      { length: 8 },
      () => new SkillLibraryStore(libraryRoot),
    );

    await Promise.all(stores.map((store) => store.ensureInitialized()));
    await Promise.all(stores.map((store) => store.ensureInitialized()));
    await new SkillLibraryStore(libraryRoot).ensureInitialized();

    assert.equal((await git(["status", "--short"], libraryRoot)).stdout, "");
    await assertFreshReaderOwnedRepo(libraryRoot);
  });

  test("retries initialization after git temporarily fails", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    vi.stubEnv("PATH", "");

    await assert.rejects(store.ensureInitialized(), /git init/);
    vi.unstubAllEnvs();
    await store.ensureInitialized();

    assert.ok(existsSync(join(libraryRoot, ".git")));
    await assertFreshReaderOwnedRepo(libraryRoot);
  });
});

describe("SkillLibraryStore history and provenance", () => {
  async function userCommit(
    root: string,
    message: string,
    file = "notes.md",
  ): Promise<void> {
    await writeFile(join(root, file), `${file}\n`, "utf8");
    await git(["add", "-A"], root);
    const messageFile = join(tempRoot, "commit-message.txt");
    await writeFile(messageFile, message, "utf8");
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-F",
        messageFile,
      ],
      root,
    );
  }

  test("an unborn repository has an empty history, and a read failure never poses as one", async () => {
    const store = new SkillLibraryStore(libraryRoot);

    assert.deepEqual(await store.history(), { entries: [], truncated: false });

    await userCommit(libraryRoot, "First commit\n");
    const { entries: history } = await store.history();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.subject, "First commit");
  });

  test("the commit-count bound reports whether older commits remain", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await userCommit(libraryRoot, "First commit\n", "first.md");
    await userCommit(libraryRoot, "Second commit\n", "second.md");
    await userCommit(libraryRoot, "Third commit\n", "third.md");

    const bounded = await store.history({ limit: 2 });
    assert.deepEqual(
      bounded.entries.map((entry) => entry.subject),
      ["Third commit", "Second commit"],
    );
    assert.equal(bounded.truncated, true);

    const complete = await store.history({ limit: 3 });
    assert.equal(complete.entries.length, 3);
    assert.equal(complete.truncated, false);
  });

  test("a hand-authored enormous commit message is bounded, not dropped", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    // Both halves are what `%B` used to stream in full: a subject far past any
    // sane length, and a body large enough to overflow the buffered executor.
    await userCommit(
      libraryRoot,
      `${"S".repeat(50_000)}\n\n${"B".repeat(14 * 1024 * 1024)}\n\nSkill-Task: 633\n`,
    );

    const { entries: history } = await store.history();

    assert.equal(history.length, 1);
    assert.ok(
      history[0]!.subject.length <= 400,
      `subject was ${history[0]!.subject.length} characters`,
    );
    assert.match(history[0]!.subject, /^S+\.\.$/);
    assert.equal(history[0]?.trailers["Skill-Task"], "633");
  });

  test("control bytes in hand-authored messages cannot forge history records", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await userCommit(
      libraryRoot,
      `First\x1eforged\x1fsubject\n\nSkill-Task: real\x1evalue\x1fstill-real\n`,
      "first.md",
    );
    await userCommit(libraryRoot, "Second\n", "second.md");

    const history = await store.history();

    assert.equal(history.entries.length, 2);
    assert.deepEqual(
      history.entries.map((entry) => entry.subject),
      ["Second", "First\x1eforged\x1fsubject"],
    );
    assert.equal(
      history.entries[1]?.trailers["Skill-Task"],
      "real\x1evalue\x1fstill-real",
    );
  });

  test("repository status truly bounds a zero-width HEAD subject", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    // Git's `%<(N,trunc)` counts display columns, so combining marks bypass a
    // nominal width bound. The status read must bound retained characters.
    await userCommit(libraryRoot, `A${"\u0301".repeat(10_000)}\n`, "huge.md");

    const status = await store.status();

    assert.ok((status.head?.subject.length ?? 0) <= 400);
    assert.match(status.head?.subject ?? "", /^A\u0301+…$/u);
    assert.equal(status.head?.commit.length, 40);
  });

  test("machine-global log output encoding cannot corrupt history or status", async () => {
    const globalConfig = join(tempRoot, "global.gitconfig");
    await writeFile(
      globalConfig,
      "[i18n]\n\tlogOutputEncoding = ISO-8859-1\n",
      "utf8",
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await userCommit(
      libraryRoot,
      "Änderung\n\nSkill-Task: Tâsk\n",
      "unicode.md",
    );

    const history = await store.history();
    const status = await store.status();

    assert.equal(history.entries[0]?.subject, "Änderung");
    assert.equal(history.entries[0]?.trailers["Skill-Task"], "Tâsk");
    assert.equal(status.head?.subject, "Änderung");
  });

  test("provenance reaches the commit as single bounded trailer lines", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();

    await store.commitMutation(
      {
        actor: {
          id: "pi:workshop:sess-1",
          // A session title is outside data: a newline in it must not be able
          // to forge or split the trailer block it is written into.
          name: "Title\nSkill-Task: 999\nSkill-Names: forged",
        },
        reason: "Add a skill",
        sessionId: "sess-1",
        taskId: "633",
        skillNames: ["release-notes"],
      },
      async (ctx) => {
        const bytes = new TextEncoder().encode("notes\n");
        await writeFile(join(libraryRoot, "notes.md"), bytes);
        // Claimed as this mutation's own work, with the bytes that prove it:
        // registering the path alone stages nothing, and the index entry has to
        // turn out to be exactly these bytes.
        ctx.created("notes.md", { bytes });
      },
    );

    const [entry] = (await store.history()).entries;
    assert.equal(entry?.subject, "Add a skill");
    assert.deepEqual(Object.keys(entry?.trailers ?? {}).sort(), [
      "Skill-Actor",
      "Skill-Names",
      "Skill-Paths",
      "Skill-Session",
      "Skill-Task",
    ]);
    assert.equal(entry?.trailers["Skill-Task"], "633");
    assert.equal(entry?.trailers["Skill-Names"], "release-notes");
    assert.match(
      entry?.trailers["Skill-Actor"] ?? "",
      /^pi:workshop:sess-1 \(Title Skill-Task: 999 Skill-Names: forged\)$/,
    );
  });

  test("an oversized reason and task id are bounded in the commit subject and trailer", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();

    await store.commitMutation(
      {
        actor: { id: "pi:workshop:sess-1", name: "Workshop" },
        reason: "R".repeat(5_000),
        sessionId: "sess-1",
        taskId: "T".repeat(5_000),
      },
      async (ctx) => {
        const bytes = new TextEncoder().encode("notes\n");
        await writeFile(join(libraryRoot, "notes.md"), bytes);
        // Claimed as this mutation's own work, with the bytes that prove it:
        // registering the path alone stages nothing, and the index entry has to
        // turn out to be exactly these bytes.
        ctx.created("notes.md", { bytes });
      },
    );

    const [entry] = (await store.history()).entries;
    assert.ok((entry?.subject.length ?? 0) <= 200);
    assert.ok((entry?.trailers["Skill-Task"]?.length ?? 0) <= 64);
    assert.equal(
      (await git(["log", "-1", "--format=%B"], libraryRoot)).stdout.split(
        "\n",
      )[0]?.length,
      200,
    );
  });
});

describe("SkillLibraryStore history refuses to invent an empty past", () => {
  test("a Git that cannot run is an error, not a library without history", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "notes.md"), "notes\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-qm",
        "First commit",
      ],
      libraryRoot,
    );
    assert.equal((await store.history()).entries.length, 1);

    // The repository has a commit; only the environment is broken. Reporting
    // that as "no history" would be the same lie an empty library would be.
    vi.stubEnv("PATH", "");
    await assert.rejects(() => store.history());
    vi.unstubAllEnvs();

    assert.equal((await store.history()).entries.length, 1);
  });

  test("a repository Git cannot read is an error, not an empty history", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "notes.md"), "notes\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-qm",
        "First commit",
      ],
      libraryRoot,
    );

    // A corrupt HEAD makes `rev-parse` exit 128, not 1: git RAN and failed,
    // which is a repository problem. Only exit 1 — HEAD names a branch with no
    // commit — is a library that genuinely has no past.
    const headFile = join(libraryRoot, ".git", "HEAD");
    const head = await readFile(headFile, "utf8");
    await writeFile(headFile, "garbage\n", "utf8");
    await assert.rejects(() => store.history(), /could not be read|rev-parse/);
    await writeFile(headFile, head, "utf8");

    assert.equal((await store.history()).entries.length, 1);
  });

  test("a commit whose trailers exceed the stream cap is still reported", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    const messageFile = join(tempRoot, "huge-trailers.txt");
    await writeFile(
      messageFile,
      `Huge trailers\n\nSkill-Task: 633\nSkill-Paths: ${"p".repeat(300_000)}\n`,
      "utf8",
    );
    await writeFile(join(libraryRoot, "notes.md"), "notes\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-F",
        messageFile,
      ],
      libraryRoot,
    );

    const history = await store.history();

    // The identity fields come first in the record, so a stream cut inside the
    // trailer block still describes a real commit; dropping it turned the only
    // commit in the repository into "no history at all".
    assert.equal(history.entries.length, 1);
    assert.equal(history.truncated, true);
    assert.equal(history.entries[0]?.subject, "Huge trailers");
    assert.equal(
      history.entries[0]?.commit,
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
    );
    assert.equal(history.entries[0]?.trailers["Skill-Task"], "633");
    assert.ok(
      (history.entries[0]?.trailers["Skill-Paths"]?.length ?? 0) <= 400,
    );
  });
});

const meta = {
  actor: { id: "pi:workshop:sess-1", name: "Workshop" },
  reason: "Change the library",
  sessionId: "sess-1",
};

describe("SkillLibraryStore: hashing an open descriptor", () => {
  /**
   * A hash over a descriptor is a sequence of reads, and a writer who already
   * holds the inode open is not stopped by anything the reader can do to its
   * NAME. If such a read answers with the id of the prefix it happened to see,
   * a caller acting on that answer deletes bytes it never proved were its own.
   */
  test("an append during the read makes the answer unusable, not a match", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    const path = join(libraryRoot, "tone.md");
    await writeFile(path, "ours\n", "utf8");
    // Committed, because a mutation refuses to run over an unclean tree.
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const truth = (
      await git(["hash-object", "--", path], libraryRoot)
    ).stdout.trim();

    let undisturbed = "";
    let raced = "";
    await store.commitMutation({ ...meta, reason: "Hash" }, async (ctx) => {
      const quiet = await open(path, "r");
      try {
        // The honest reading first, so the check cannot be "always refuse".
        undisturbed = await ctx.blobId(quiet);
      } finally {
        await quiet.close();
      }

      // Then the same read with a writer appending through a descriptor it
      // opened beforehand, landing on the first `read` — where a real writer
      // would.
      const appending = await open(path, "a");
      const racing = await open(path, "r");
      try {
        const read = racing.read.bind(racing);
        let first = true;
        Object.assign(racing, {
          read: async (...args: Parameters<typeof read>) => {
            if (first) {
              first = false;
              await appending.write("user appended\n");
            }
            return read(...args);
          },
        });
        raced = await ctx.blobId(racing);
      } finally {
        await racing.close();
        await appending.close();
      }

      // One real change, so the mutation has something to commit.
      const bytes = new TextEncoder().encode("placeholder\n");
      await writeFile(join(libraryRoot, "placeholder.md"), bytes);
      ctx.created("placeholder.md", { bytes });
    });

    assert.equal(
      undisturbed,
      truth,
      "an undisturbed read answers Git's own id",
    );
    assert.notEqual(raced, truth, "a prefix must not answer as a match");
    assert.equal(raced, "", "and it must be an id nothing can equal");
  });
});

describe("SkillLibraryStore: what reaches the commit", () => {
  test("canonicalizes malformed Unicode before building commit identity", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();

    await store.commitMutation(
      {
        ...meta,
        actor: { ...meta.actor, name: "Work\ud800shop" },
        reason: "Change\ud800",
      },
      async (ctx) => {
        const bytes = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "ours.txt"), bytes);
        ctx.created("ours.txt", { bytes });
      },
    );

    const history = await store.history();
    assert.equal(history.entries[0]?.subject, "Change�");
    assert.equal(history.entries[0]?.author, "Work�shop");
  });

  test("commit cleanup configuration cannot rewrite generated provenance", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await git(["config", "commit.cleanup", "strip"], libraryRoot);

    await store.commitMutation(
      { ...meta, reason: "# Keep this" },
      async (ctx) => {
        const bytes = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "ours.txt"), bytes);
        ctx.created("ours.txt", { bytes });
      },
    );

    const message = (
      await git(
        ["-c", "i18n.logOutputEncoding=utf-8", "log", "-1", "--format=%B"],
        libraryRoot,
      )
    ).stdout;
    assert.match(message, /^# Keep this\n\nSkill-Actor:/);
  });

  /**
   * The handoff to Git is the one step that is not anchored to an inode: `add`
   * and `checkout` take pathnames, and the repository lock does not serialize
   * the person editing the same working tree. So a mutation hands Git the paths
   * it MADE, not the names it touched, and the index is read back before the
   * commit is allowed to happen.
   */
  test("a file written beside the mutation's own is not staged with it", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();

    await store.commitMutation(
      { ...meta, reason: "Add a skill" },
      async (ctx) => {
        await mkdir(join(libraryRoot, "release-notes"));
        ctx.touch("release-notes");
        const ours = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "release-notes", "SKILL.md"), ours);
        ctx.created("release-notes/SKILL.md", { bytes: ours });
        // The window this closes: a hand author writes into the same folder
        // after the mutation's work and before it is staged.
        await writeFile(
          join(libraryRoot, "release-notes", "user.txt"),
          "user data\n",
          "utf8",
        );
      },
    );

    assert.equal(
      (
        await git(["show", "--name-only", "--format=", "HEAD"], libraryRoot)
      ).stdout.trim(),
      "release-notes/SKILL.md",
    );
    assert.equal(
      await readFile(join(libraryRoot, "release-notes", "user.txt"), "utf8"),
      "user data\n",
    );
  });

  test("a replacement of the mutation's OWN path refuses the commit", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    const head = await gitOptional(["rev-parse", "HEAD"], libraryRoot);

    // The path is the one the mutation claimed, so names and statuses all look
    // right; only the CONTENT is somebody else's. Committing it would publish a
    // hand author's bytes as this tool's work.
    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Add a skill" }, async (ctx) => {
        await mkdir(join(libraryRoot, "release-notes"));
        const ours = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "release-notes", "SKILL.md"), ours);
        ctx.created("release-notes/SKILL.md", { bytes: ours });
        await writeFile(
          join(libraryRoot, "release-notes", "SKILL.md"),
          "theirs\n",
          "utf8",
        );
      }),
      /did not make/,
    );

    assert.equal(
      (await gitOptional(["rev-parse", "HEAD"], libraryRoot)).stdout,
      head.stdout,
      "nothing may be committed once the index holds somebody else's bytes",
    );
    assert.equal(
      await readFile(join(libraryRoot, "release-notes", "SKILL.md"), "utf8"),
      "theirs\n",
      "and their bytes are still theirs afterwards",
    );
  });

  test("moved content REWRITTEN IN PLACE at its new path refuses the commit", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await mkdir(join(libraryRoot, "release-notes"));
    await writeFile(
      join(libraryRoot, "release-notes", "tone.md"),
      "ours\n",
      "utf8",
    );
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const head = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim();

    // The case an inode could never answer. The content is MOVED, not written
    // here, so there are no bytes of this mutation's own to compare; the file
    // is then truncated and rewritten THROUGH THE SAME INODE, which is what a
    // shell redirect does. Its dev/ino never change, so an identity check sees
    // its own placement while Git has staged somebody else's bytes.
    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Move" }, async (ctx) => {
        await mkdir(join(libraryRoot, "changelog-notes"));
        const placed = join(libraryRoot, "changelog-notes", "tone.md");
        await link(join(libraryRoot, "release-notes", "tone.md"), placed);
        const pin = await open(placed, "r");
        ctx.hold(pin);
        const before = await pin.stat();
        ctx.created("changelog-notes/tone.md", {
          movedFrom: "release-notes/tone.md",
        });

        const theirs = await open(placed, "r+");
        await theirs.truncate(0);
        await theirs.write("theirs\n");
        await theirs.close();
        const after = await pin.stat();
        assert.equal(
          after.ino,
          before.ino,
          "the reproduction requires the inode to be unchanged",
        );
      }),
      /did not make/,
    );

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
      head,
      "nothing may be committed once the index holds somebody else's bytes",
    );
  });

  test("a concurrent mode change on the mutation's own path refuses the commit", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    const head = await gitOptional(["rev-parse", "HEAD"], libraryRoot);

    // The bytes are this mutation's; the executable bit is not. An index entry
    // is mode AND object, so committing it would record somebody else's change
    // as part of this one.
    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Add a skill" }, async (ctx) => {
        await mkdir(join(libraryRoot, "release-notes"));
        const path = join(libraryRoot, "release-notes", "SKILL.md");
        const ours = new TextEncoder().encode("ours\n");
        await writeFile(path, ours);
        ctx.created("release-notes/SKILL.md", { bytes: ours });
        await chmod(path, 0o755);
      }),
      /did not make/,
    );

    assert.equal(
      (await gitOptional(["rev-parse", "HEAD"], libraryRoot)).stdout,
      head.stdout,
    );
  });

  test("an edit of a file the library already keeps executable still commits", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await mkdir(join(libraryRoot, "release-notes"));
    const path = join(libraryRoot, "release-notes", "run.sh");
    await writeFile(path, "#!/bin/sh\necho old\n", "utf8");
    await chmod(path, 0o755);
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);

    // The mirror: the mode the repository already has is the mode that must
    // still be there, so writing to a hand-authored executable is not a change
    // this mutation did not make.
    await store.commitMutation({ ...meta, reason: "Edit" }, async (ctx) => {
      const bytes = new TextEncoder().encode("#!/bin/sh\necho new\n");
      await writeFile(path, bytes);
      ctx.wrote("release-notes/run.sh", bytes);
    });

    assert.equal(
      (
        await git(
          ["ls-tree", "HEAD", "--", "release-notes/run.sh"],
          libraryRoot,
        )
      ).stdout.startsWith("100755"),
      true,
    );
  });

  test("moved content that arrives intact is committed", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await mkdir(join(libraryRoot, "release-notes"));
    await writeFile(
      join(libraryRoot, "release-notes", "tone.md"),
      "ours\n",
      "utf8",
    );
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);

    // The other direction, so the proof cannot be "refuse everything": an
    // undisturbed move commits, with the committed content at its new path.
    await store.commitMutation({ ...meta, reason: "Move" }, async (ctx) => {
      await mkdir(join(libraryRoot, "changelog-notes"));
      await link(
        join(libraryRoot, "release-notes", "tone.md"),
        join(libraryRoot, "changelog-notes", "tone.md"),
      );
      ctx.created("changelog-notes/tone.md", {
        movedFrom: "release-notes/tone.md",
      });
    });

    assert.equal(
      (await git(["show", "HEAD:changelog-notes/tone.md"], libraryRoot)).stdout,
      "ours\n",
    );
  });

  test("changed paths retain every legal filename byte", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    const path = 'line\nbreak\t"quoted" trailing ';
    const bytes = new TextEncoder().encode("ours\n");

    const outcome = await store.commitMutation(
      { ...meta, reason: "Add unusual path" },
      async (ctx) => {
        await writeFile(join(libraryRoot, path), bytes);
        ctx.created(path, { bytes });
      },
    );

    assert.deepEqual(outcome.commit.changedPaths, [path]);
    assert.equal(await readFile(join(libraryRoot, path), "utf8"), "ours\n");
    const encodedPaths = (
      await git(
        ["log", "-1", "--format=%(trailers:key=Skill-Paths,valueonly)"],
        libraryRoot,
      )
    ).stdout.trim();
    assert.deepEqual(JSON.parse(encodedPaths), [path]);
  });

  for (const setting of ["commitEncoding", "logOutputEncoding"] as const) {
    test(`machine-global i18n.${setting} does not corrupt non-ASCII commit identity`, async () => {
      const globalConfig = join(tempRoot, "global.gitconfig");
      await writeFile(
        globalConfig,
        `[i18n]\n\t${setting} = ISO-8859-1\n`,
        "utf8",
      );
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      const store = new SkillLibraryStore(libraryRoot);
      await store.ensureInitialized();

      const outcome = await store.commitMutation(
        {
          ...meta,
          actor: { ...meta.actor, name: "Wörkshop" },
          reason: "Änderung",
        },
        async (ctx) => {
          const bytes = new TextEncoder().encode("ours\n");
          await writeFile(join(libraryRoot, "ours.txt"), bytes);
          ctx.created("ours.txt", { bytes });
        },
      );

      assert.equal(
        (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
        outcome.commit.commit,
      );
      assert.equal(
        (
          await git(
            [
              "-c",
              "i18n.logOutputEncoding=utf-8",
              "log",
              "-1",
              "--format=%an%x00%B",
            ],
            libraryRoot,
          )
        ).stdout.startsWith("Wörkshop\0Änderung\n"),
        true,
      );
    });
  }

  test("a post-commit hook that adds a commit undoes the whole mutation", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "seed.md"), "seed\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const head = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim();
    const hooks = join(libraryRoot, ".git", "hooks");
    const guard = join(libraryRoot, ".git", "post-commit-guard");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "post-commit"),
      `#!/bin/sh\nif test ! -e '${guard}'; then touch '${guard}'; git commit --allow-empty -qm 'hook commit'; fi\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Add" }, async (ctx) => {
        const bytes = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "ours.txt"), bytes);
        ctx.created("ours.txt", { bytes });
        ctx.onRollback(async () => {
          await rm(join(libraryRoot, "ours.txt"), { force: true });
        });
      }),
      /exactly one new commit|post-commit/,
    );

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
      head,
    );
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], libraryRoot)).stdout.trim(),
      "1",
    );
    assert.ok(!existsSync(join(libraryRoot, "ours.txt")));
  });

  test("a post-commit hook that amends away provenance undoes the mutation", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "seed.md"), "seed\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const head = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim();
    const hooks = join(libraryRoot, ".git", "hooks");
    const guard = join(libraryRoot, ".git", "post-amend-guard");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "post-commit"),
      `#!/bin/sh\nif test ! -e '${guard}'; then touch '${guard}'; git commit --amend --no-verify -qm 'hook amended'; fi\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Add" }, async (ctx) => {
        const bytes = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "ours.txt"), bytes);
        ctx.created("ours.txt", { bytes });
        ctx.onRollback(async () => {
          await rm(join(libraryRoot, "ours.txt"), { force: true });
        });
      }),
      /generated message|amended HEAD/,
    );

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
      head,
    );
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], libraryRoot)).stdout.trim(),
      "1",
    );
    assert.ok(!existsSync(join(libraryRoot, "ours.txt")));
  });

  test("a pre-commit hook that stages its own file undoes the commit", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "seed.md"), "seed\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const head = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim();

    // The index proof runs BEFORE `git commit`, and a hook runs between them
    // with the index in its hands. A hook that stages a file of its own puts
    // content in the commit that no claim covers, while the result names only
    // what the mutation did.
    const hooks = join(libraryRoot, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf 'user data\\n' > '${libraryRoot}/user.txt'\ngit add -- '${libraryRoot}/user.txt'\nexit 0\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Add" }, async (ctx) => {
        const bytes = new TextEncoder().encode("ours\n");
        await writeFile(join(libraryRoot, "ours.txt"), bytes);
        ctx.created("ours.txt", { bytes });
      }),
      /did not make/,
    );

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
      head,
      "the commit the hook widened must be undone, not kept",
    );
    // And nothing anybody wrote is destroyed by the undo: the hook's file is
    // still on disk, and reported rather than committed.
    assert.equal(
      await readFile(join(libraryRoot, "user.txt"), "utf8"),
      "user data\n",
    );
  });

  test("a change the mutation did not make refuses the commit", async () => {
    const store = new SkillLibraryStore(libraryRoot);
    await store.ensureInitialized();
    await writeFile(join(libraryRoot, "kept.md"), "committed\n", "utf8");
    await git(["add", "-A"], libraryRoot);
    await git(["commit", "-m", "seed"], libraryRoot);
    const head = (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim();

    // A removal's pathspec is a whole folder, so a tracked file recreated under
    // it lands in the index as somebody else's content. Reading the index back
    // is what catches that; nothing is committed.
    await assert.rejects(
      store.commitMutation({ ...meta, reason: "Remove" }, async (ctx) => {
        await writeFile(join(libraryRoot, "kept.md"), "theirs\n", "utf8");
        ctx.touch(".");
        ctx.removed(".");
      }),
      /did not make/,
    );

    assert.equal(
      (await git(["rev-parse", "HEAD"], libraryRoot)).stdout.trim(),
      head,
      "nothing may be committed once the index holds somebody else's work",
    );
  });
});
