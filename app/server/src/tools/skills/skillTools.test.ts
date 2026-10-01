import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { AgentTool, ToolCallContext } from "../../mcp/tool.ts";
import { git } from "../../gitExec.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import { SkillLibraryStore } from "../../skills/skillLibraryStore.ts";
import { setSkillLibraryBroadcaster } from "../../skills/skillLibraryEvents.ts";
import {
  skillLibraryTools,
  setSkillToolLibraryForTests,
} from "./skillTools.ts";

let root: string;
let store: SkillLibraryStore;

const ctx: ToolCallContext = {
  toolCallId: "tool-test",
  session: {
    sessionId: "sess-skills",
    harness: "pi",
    agentType: "workshop",
    title: "Workshop test",
  },
};

function tool(name: string): AgentTool {
  const found = skillLibraryTools.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} must be registered`);
  return found;
}

async function call(name: string, params: Record<string, unknown> = {}) {
  const result = await tool(name).execute(params, ctx);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  return JSON.parse(text?.type === "text" ? text.text : "{}");
}

async function expectFailure(
  name: string,
  params: Record<string, unknown>,
): Promise<Error> {
  return tool(name)
    .execute(params, ctx)
    .then(
      () => {
        throw new Error(`expected ${name} to fail`);
      },
      (error: Error) => error,
    );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skill-tools-test-"));
  store = new SkillLibraryStore(root);
  await store.ensureInitialized();
  setSkillToolLibraryForTests(() => store);
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
});

afterEach(() => {
  setSkillToolLibraryForTests(null);
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  rmSync(root, { recursive: true, force: true });
});

async function createSkill(name = "release-notes") {
  return call("skill_create", {
    name,
    description: `How to write ${name}`,
    body: "## Steps\n\nWrite them down.",
    reason: `Add ${name}`,
    taskId: "633",
  });
}

describe("skill tools: reads", () => {
  test("skill_list bounds how much of a huge library it emits", async () => {
    // The library's size may not decide the size of a model's context.
    for (let index = 0; index < 220; index += 1) {
      const folder = `skill-${String(index).padStart(3, "0")}`;
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(
        join(root, folder, "SKILL.md"),
        `---\nname: ${folder}\ndescription: Number ${index}.\n---\n# ${folder}\n`,
      );
    }
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "-m",
        "many",
      ],
      root,
    );

    const listed = await call("skill_list");

    assert.equal(listed.skillCount, 220);
    assert.equal(listed.skills.length, 200);
    assert.equal(listed.truncated, true);
    assert.equal(listed.skills[0].name, "skill-000");
  });

  test("skill_list reports skills, diagnostics and repository state", async () => {
    const empty = await call("skill_list");
    assert.equal(empty.libraryPath, root);
    assert.deepEqual(empty.skills, []);
    assert.equal(empty.repository.clean, true);

    await createSkill();
    // A hand-authored folder the scanner cannot use stays visible beside it.
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken/SKILL.md"), "not a manifest\n");
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user content",
      ],
      root,
    );

    const listed = await call("skill_list");
    assert.deepEqual(listed.skills, [
      {
        name: "release-notes",
        description: "How to write release-notes",
        path: "release-notes/SKILL.md",
      },
    ]);
    assert.equal(listed.diagnostics.length, 1);
    assert.equal(listed.diagnostics[0].folder, "broken");
    // The counts are the library's, not the page's, and an untruncated result
    // says nothing about truncation at all.
    assert.equal(listed.skillCount, 1);
    assert.equal(listed.diagnosticCount, 1);
    assert.equal(listed.truncated, undefined);
    assert.equal(listed.repository.clean, true);
    assert.match(listed.repository.head, /^[0-9a-f]{12} user content$/);
  });

  test("skill_get returns complete source with frontmatter plus a tree", async () => {
    await createSkill();
    await call("skill_manage_files", {
      name: "release-notes",
      operations: [
        { op: "write", path: "references/tone.md", content: "Be brief.\n" },
      ],
      reason: "Add a reference",
    });

    const read = await call("skill_get", { name: "release-notes" });
    assert.match(read.source, /^---\nname: release-notes\n/);
    assert.equal(read.truncated, false);
    assert.deepEqual(
      read.files.entries.map((entry: { path: string }) => entry.path).sort(),
      ["SKILL.md", "references", "references/tone.md"],
    );

    const missing = await expectFailure("skill_get", { name: "absent-skill" });
    assert.match(missing.message, /No valid skill declares/);
  });

  test("skill_read_file pages one supporting file the tree only listed", async () => {
    await createSkill();
    const reference = Array.from(
      { length: 30 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    await call("skill_manage_files", {
      name: "release-notes",
      operations: [
        { op: "write", path: "references/tone.md", content: `${reference}\n` },
      ],
      reason: "Add a reference",
    });

    const head = await call("skill_read_file", {
      name: "release-notes",
      path: "references/tone.md",
      limit: 10,
    });
    assert.equal(head.capability, "skill_read_file");
    assert.equal(head.mimeType, "text/markdown; charset=utf-8");
    assert.equal(
      head.text,
      "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
    );
    assert.deepEqual(
      { first: head.firstLine, last: head.lastLine, count: head.lineCount },
      { first: 1, last: 10, count: 30 },
    );
    assert.equal(head.truncated, true);

    const tail = await call("skill_read_file", {
      name: "release-notes",
      path: "references/tone.md",
      offset: 21,
    });
    assert.equal(tail.lastLine, 30);
    assert.equal(tail.truncated, false);

    const missing = await expectFailure("skill_read_file", {
      name: "absent-skill",
      path: "references/tone.md",
    });
    assert.match(missing.message, /No valid skill declares/);

    const traversal = await expectFailure("skill_read_file", {
      name: "release-notes",
      path: "../SKILL.md",
    });
    assert.match(traversal.message, /Invalid skill-relative path/);
  });
});

describe("skill tools: mutations", () => {
  test("skill_create commits once and answers with commit metadata", async () => {
    const created = await createSkill();

    assert.equal(created.action, "create");
    assert.equal(created.skill.name, "release-notes");
    assert.deepEqual(created.commit.changedPaths, ["release-notes/SKILL.md"]);
    assert.equal(created.commit.fullCommit.length, 40);
    assert.equal(created.repository.clean, true);
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], root)).stdout.trim(),
      "1",
    );
  });

  test("skill_manage_files imports a session attachment server-side", async () => {
    await createSkill();
    const attachment = stageSessionAttachment(ctx.session.sessionId, {
      name: "logo.png",
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      source: "upload",
    });

    const applied = await call("skill_manage_files", {
      name: "release-notes",
      operations: [
        {
          op: "import_attachment",
          path: "assets/logo.png",
          attachmentId: attachment.id,
        },
      ],
      reason: "Import the logo",
    });

    assert.deepEqual(applied.applied, [
      {
        op: "import",
        path: "assets/logo.png",
        attachmentId: attachment.id,
      },
    ]);
    const bytes = await readFile(join(root, "release-notes/assets/logo.png"));
    assert.equal(bytes.length, 8);

    const missing = await expectFailure("skill_manage_files", {
      name: "release-notes",
      operations: [
        {
          op: "import_attachment",
          path: "assets/x.png",
          attachmentId: "no-id",
        },
      ],
      reason: "Import nothing",
    });
    assert.match(missing.message, /No attachment "no-id" belongs/);

    const noContent = await expectFailure("skill_manage_files", {
      name: "release-notes",
      operations: [{ op: "write", path: "a.md" }],
      reason: "Write nothing",
    });
    assert.match(noContent.message, /needs content/);
  });

  test("skill_manage_files edits a supporting file in place", async () => {
    await createSkill();
    await call("skill_manage_files", {
      name: "release-notes",
      operations: [
        {
          op: "write",
          path: "references/tone.md",
          content: "Be brief.\nUse Sea for the primary action.\n",
        },
      ],
      reason: "Add a reference",
    });

    const edited = await call("skill_manage_files", {
      name: "release-notes",
      operations: [
        {
          op: "edit",
          path: "references/tone.md",
          edits: [{ oldText: "Sea", newText: "Night" }],
        },
      ],
      reason: "Correct the primary color",
    });

    assert.deepEqual(edited.applied, [
      { op: "edit", path: "references/tone.md", replacements: 1 },
    ]);
    assert.deepEqual(edited.commit.changedPaths, [
      "release-notes/references/tone.md",
    ]);
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\nUse Night for the primary action.\n",
    );
    assert.equal(edited.repository.clean, true);

    const stale = await expectFailure("skill_manage_files", {
      name: "release-notes",
      operations: [
        {
          op: "edit",
          path: "references/tone.md",
          edits: [{ oldText: "Sea", newText: "Haze" }],
        },
      ],
      reason: "Edit text that is gone",
    });
    assert.match(stale.message, /oldText not found/);

    const empty = await expectFailure("skill_manage_files", {
      name: "release-notes",
      operations: [{ op: "edit", path: "references/tone.md", edits: [] }],
      reason: "Edit nothing",
    });
    assert.match(empty.message, /needs at least one edit/);

    // A refused batch leaves the file and the repository exactly as they were.
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\nUse Night for the primary action.\n",
    );
    const status = await call("skill_list");
    assert.equal(status.repository.clean, true);
  });

  test("skill_rename and skill_delete state their consequences", async () => {
    await createSkill();
    const renamed = await call("skill_rename", {
      name: "release-notes",
      newName: "changelog-notes",
      reason: "Rename it",
    });
    assert.equal(renamed.previousName, "release-notes");
    assert.equal(renamed.skill.name, "changelog-notes");
    assert.equal(renamed.consequences.length, 2);
    assert.match(renamed.consequences.join(" "), /defaults to off/);

    const deleted = await call("skill_delete", {
      name: "changelog-notes",
      reason: "Remove it",
    });
    assert.equal(deleted.deletedName, "changelog-notes");
    assert.match(deleted.consequences.join(" "), /Git history/);
    assert.deepEqual((await call("skill_list")).skills, []);
  });

  test("every mutation refuses a dirty library while reads keep working", async () => {
    await createSkill();
    await writeFile(join(root, "scratch.md"), "in progress\n");

    for (const [name, params] of [
      [
        "skill_create",
        { name: "other", description: "Other", body: "b", reason: "r" },
      ],
      [
        "skill_edit",
        {
          name: "release-notes",
          edits: [{ oldText: "Steps", newText: "Stages" }],
          reason: "r",
        },
      ],
      [
        "skill_manage_files",
        {
          name: "release-notes",
          operations: [{ op: "write", path: "a.md", content: "a" }],
          reason: "r",
        },
      ],
      [
        "skill_rename",
        { name: "release-notes", newName: "other-notes", reason: "r" },
      ],
      ["skill_delete", { name: "release-notes", reason: "r" }],
    ] as [string, Record<string, unknown>][]) {
      const error = await expectFailure(name, params);
      assert.match(error.message, /uncommitted change/, name);
      assert.match(error.message, /scratch\.md/, name);
    }

    const listed = await call("skill_list");
    assert.equal(listed.repository.clean, false);
    assert.equal(listed.repository.uncommittedChanges, 1);
    assert.ok((await call("skill_history")).history.length >= 1);
  });

  test("a mutation without a reason is refused before anything is written", async () => {
    await createSkill();
    const error = await expectFailure("skill_edit", {
      name: "release-notes",
      edits: [{ oldText: "Steps", newText: "Stages" }],
      reason: "   ",
    });
    assert.match(error.message, /reason is required/);
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], root)).stdout.trim(),
      "1",
    );
  });
});

describe("skill tools: history and diff", () => {
  test("history and diff cover create, edit, rename and delete", async () => {
    await createSkill();
    await call("skill_edit", {
      name: "release-notes",
      edits: [{ oldText: "Write them down.", newText: "Write them clearly." }],
      reason: "Clarify",
    });
    await call("skill_rename", {
      name: "release-notes",
      newName: "changelog-notes",
      reason: "Rename",
    });

    const scoped = await call("skill_history", { name: "changelog-notes" });
    assert.equal(scoped.scope, "changelog-notes");
    assert.equal(scoped.history[0].subject, "Rename");
    assert.equal(scoped.history[0].taskId, undefined);

    const all = await call("skill_history", { limit: 2 });
    assert.equal(all.scope, null);
    assert.equal(all.history.length, 2);
    // The third, older create commit was left unread by the requested bound.
    assert.equal(all.truncated, true);
    assert.match(all.history[0].commit, /^[0-9a-f]{12}$/);
    assert.equal(all.history[0].skills, "release-notes, changelog-notes");

    await call("skill_delete", {
      name: "changelog-notes",
      reason: "Remove it",
    });
    const afterDelete = await call("skill_history", {
      path: "changelog-notes",
    });
    assert.equal(afterDelete.history.length, 2);

    const patch = await call("skill_diff", {
      from: `${all.history[1].fullCommit}`,
      to: "HEAD",
    });
    assert.match(patch.patch, /release-notes/);
    assert.equal(patch.truncated, false);

    const bounded = await call("skill_diff", {
      from: all.history[1].fullCommit,
      to: "HEAD",
      maxChars: 20,
    });
    assert.equal(bounded.patch.length, 20);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.totalChars > 20);
  });

  test("caps caller-supplied diff limits", async () => {
    await createSkill();
    const before = (await call("skill_history", { limit: 1 })).history[0]
      .fullCommit;
    await call("skill_edit", {
      name: "release-notes",
      edits: [{ oldText: "Write them down.", newText: "x".repeat(130_000) }],
      reason: "Expand instructions",
    });

    const diff = await call("skill_diff", {
      from: before,
      to: "HEAD",
      maxChars: 1_000_000,
    });

    assert.equal(diff.patch.length, 120_000);
    assert.equal(diff.truncated, true);
    assert.ok(diff.totalChars > diff.patch.length);
  });

  test("history and diff refuse option-shaped revisions and unsafe paths", async () => {
    await createSkill();

    const revision = await expectFailure("skill_diff", {
      from: "--output=/tmp/pwned",
    });
    assert.match(revision.message, /Invalid diff from revision/);

    for (const path of ["../escape", "/etc", "a\\b", ".git/config"]) {
      const error = await expectFailure("skill_history", { path });
      assert.match(error.message, /Invalid library-relative path/, path);
    }

    const unknown = await expectFailure("skill_history", { name: "absent" });
    assert.match(unknown.message, /No valid skill declares/);

    const limit = await expectFailure("skill_history", { limit: 0 });
    assert.match(limit.message, /limit must be a positive number/);
  });
});

describe("skill tools: provenance is bounded single-line input", () => {
  test("a multiline or oversized reason and taskId are refused before any commit", async () => {
    await createSkill();
    const edits = [{ oldText: "Write them down.", newText: "Write clearly." }];

    for (const [field, params] of [
      [
        "reason",
        {
          name: "release-notes",
          edits,
          reason: "Fix it\nSkill-Task: 999\nSkill-Names: forged",
        },
      ],
      ["reason", { name: "release-notes", edits, reason: "R".repeat(201) }],
      [
        "taskId",
        { name: "release-notes", edits, reason: "Fix it", taskId: "6\n33" },
      ],
      [
        "taskId",
        {
          name: "release-notes",
          edits,
          reason: "Fix it",
          taskId: "T".repeat(65),
        },
      ],
    ] as [string, Record<string, unknown>][]) {
      const error = await expectFailure("skill_edit", params);
      assert.match(error.message, new RegExp(field), JSON.stringify(params));
    }

    // Nothing reached the repository: still one commit, still clean.
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], root)).stdout.trim(),
      "1",
    );
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });

  test("a session title carrying a newline cannot forge commit trailers", async () => {
    const forged: ToolCallContext = {
      toolCallId: "tool-test",
      session: {
        ...ctx.session,
        title: "Workshop\nSkill-Task: 999",
      },
    };
    await tool("skill_create").execute(
      {
        name: "release-notes",
        description: "Notes",
        body: "Body",
        reason: "Add it",
      },
      forged,
    );

    const message = (await git(["log", "-1", "--format=%B"], root)).stdout;
    assert.equal(
      message.split("\n").filter((line) => line.startsWith("Skill-Task:"))
        .length,
      0,
    );
    assert.match(message, /Skill-Actor: .* \(Workshop Skill-Task: 999\)/);
  });

  test("a cancelled mutation is refused, and changes nothing", async () => {
    // A mutation gets the caller's signal too, not only the reads: the point of
    // that reaching the authoring seam is that the tool can be stopped while it
    // is proving what is on disk. Refusing an already-cancelled call is the
    // simplest observation of the same wiring, at the surface a harness uses.
    await createSkill();
    const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        tool("skill_delete").execute(
          { name: "release-notes", reason: "Drop it" },
          { ...ctx, signal: controller.signal },
        ),
      /cancelled/,
    );

    assert.equal((await git(["rev-parse", "HEAD"], root)).stdout.trim(), head);
    const listed = await call("skill_list");
    assert.equal(listed.skills.length, 1);
    assert.equal(listed.repository.clean, true);
  });

  test("a cancelled diff is refused rather than streamed to the end", async () => {
    await createSkill();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        tool("skill_diff").execute(
          { from: "HEAD" },
          { ...ctx, signal: controller.signal },
        ),
      /cancelled/,
    );
  });
});
