import { describe, expect, it } from "vitest";
import {
  extractPaObjectLinkUris,
  fallbackPaObjectResolution,
  formatPaObjectLink,
  parsePaObjectLink,
  paWorktreeTitle,
} from "@assistant/shared/objectLinks";
import { createTask } from "./tasks.ts";
import { resolvePaObjectLinks } from "./objectLinkResolver.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";

describe("pa:// object links", () => {
  it("parses known object links", () => {
    expect(parsePaObjectLink("pa://task/257")).toMatchObject({
      uri: "pa://task/257",
      objectType: "task",
      knownType: true,
      id: "257",
    });
  });

  it("preserves query params and fragments", () => {
    expect(
      parsePaObjectLink("pa://knowledge/kb-entry?view=history#heading-1"),
    ).toMatchObject({
      objectType: "knowledge",
      id: "kb-entry",
      query: "view=history",
      fragment: "heading-1",
    });
  });

  it("round-trips escaped ids", () => {
    const uri = formatPaObjectLink({
      objectType: "project",
      id: "Project With Space",
      fragment: "A heading",
    });
    expect(uri).toBe("pa://project/Project%20With%20Space#A%20heading");
    expect(parsePaObjectLink(uri)).toMatchObject({
      id: "Project With Space",
      fragment: "A heading",
    });
  });

  it("parses unknown object types without treating them as known", () => {
    const parsed = parsePaObjectLink("pa://future-type/abc");
    expect(parsed).toMatchObject({
      objectType: "future-type",
      knownType: false,
      id: "abc",
    });
    expect(parsed && fallbackPaObjectResolution(parsed)).toMatchObject({
      existence: "missing",
      href: "#unresolved-pa-link:future-type%2Fabc",
    });
  });

  it("rejects invalid URI shapes", () => {
    expect(parsePaObjectLink("https://task/257")).toBeNull();
    expect(parsePaObjectLink("pa://task")).toBeNull();
    expect(parsePaObjectLink("pa://task/one/two")).toBeNull();
    expect(parsePaObjectLink("pa://1bad/id")).toBeNull();
    expect(parsePaObjectLink("pa://task/%E0%A4%A")).toBeNull();
    expect(parsePaObjectLink("pa://user@task/257")).toBeNull();
    expect(parsePaObjectLink("pa://task:123/257")).toBeNull();
  });

  it("addresses a Knowledge Base file by its path", () => {
    const uri = formatPaObjectLink({
      objectType: "knowledge",
      id: "projects/demo plan/notes.md",
    });
    expect(uri).toBe("pa://knowledge/projects/demo%20plan/notes.md");
    expect(parsePaObjectLink(`${uri}#L4`)).toMatchObject({
      objectType: "knowledge",
      id: "projects/demo plan/notes.md",
      fragment: "L4",
    });
    expect(parsePaObjectLink("pa://knowledge/a/../b.md")).toBeNull();
    expect(parsePaObjectLink("pa://knowledge/a//b.md")).toBeNull();
    expect(() =>
      formatPaObjectLink({ objectType: "knowledge", id: "../secret" }),
    ).toThrow();
    expect(
      extractPaObjectLinkUris("Read pa://knowledge/projects/plan.md, then."),
    ).toEqual(["pa://knowledge/projects/plan.md"]);
  });

  it("formats worktree link titles from one shared helper", () => {
    expect(
      paWorktreeTitle({ id: "main:proj", branch: "main" }, "Project Name"),
    ).toBe("Main checkout · Project Name");
    expect(
      paWorktreeTitle({ id: "wt-1", branch: "feature-branch" }, "Project Name"),
    ).toBe("feature-branch");
  });

  it("extracts pa links from markdown and bare prose", () => {
    expect(
      extractPaObjectLinkUris(
        "See [](pa://task/257), <pa://project/time-tracking-automation>, and pa://knowledge/kb#Heading.",
      ),
    ).toEqual([
      "pa://task/257",
      "pa://project/time-tracking-automation",
      "pa://knowledge/kb#Heading",
    ]);
  });

  it("resolves task links through the compact server resolver", async () => {
    const task = createTask({
      title: "Resolver coverage task",
      description: "",
      status: "todo",
      source: { createdBy: "agent" },
    });
    const links = await resolvePaObjectLinks([
      `pa://task/${task.id}`,
      "pa://task/999999",
      "pa://knowledge/example#Intro",
    ]);
    expect(
      links.find((link) => link.uri === `pa://task/${task.id}`),
    ).toMatchObject({
      href: `/tasks/${task.id}`,
      title: "Resolver coverage task",
      typeLabel: "Task",
      existence: "exists",
    });
    expect(links.find((link) => link.uri === "pa://task/999999")).toMatchObject(
      { existence: "missing", title: "Task 999999" },
    );
    // A knowledge id that is not indexed resolves as missing (not a placeholder).
    expect(
      links.find((link) => link.uri === "pa://knowledge/example#Intro"),
    ).toMatchObject({
      href: "/knowledge/files?path=example#Intro",
      existence: "missing",
    });
  });

  it("resolves knowledge links to indexed entry titles", async () => {
    const store = new KnowledgeBaseStore();
    const content = [
      "---",
      "kb:",
      "  schema: 1",
      "  id: kb-resolver-demo",
      "  type: note",
      '  title: "Resolver Demo Entry"',
      "  status: active",
      '  createdAt: "2026-06-01T10:00:00.000Z"',
      '  updatedAt: "2026-06-01T10:00:00.000Z"',
      "---",
      "Body.",
      "",
    ].join("\n");
    await store.commitChanges(
      [{ op: "write", path: "resolver-demo/index.md", content }],
      {
        actor: { kind: "agent", id: "test", name: "Test" },
        reason: "seed resolver entry",
      },
    );
    const [resolved] = await resolvePaObjectLinks([
      "pa://knowledge/kb-resolver-demo",
    ]);
    expect(resolved).toMatchObject({
      href: "/knowledge/files?path=resolver-demo%2Findex.md",
      title: "Resolver Demo Entry",
      typeLabel: "Knowledge",
      existence: "exists",
    });
  });
});
