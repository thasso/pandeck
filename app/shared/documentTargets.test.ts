import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_ANCHOR_LINES,
  boundedDocumentLineRange,
  documentTargetHref,
  documentTargetPaUri,
  formatDocumentLineAnchor,
  parseDocumentLineAnchor,
  parseDocumentTarget,
  resolveDocumentReference,
  type DocumentTarget,
} from "./documentTargets.ts";

describe("document targets", () => {
  it("parses every internal source and refuses external URLs", () => {
    expect(parseDocumentTarget("/api/files/tmp/example/a%20b.md")).toEqual({
      kind: "hostFile",
      path: "/tmp/example/a b.md",
    });
    expect(
      parseDocumentTarget("/api/session-artifacts/s%201/out/report.txt"),
    ).toEqual({
      kind: "sessionArtifact",
      sessionId: "s 1",
      path: "out/report.txt",
    });
    expect(parseDocumentTarget("/knowledge/~file/team/data.json")).toEqual({
      kind: "knowledgeFile",
      path: "team/data.json",
    });
    expect(
      parseDocumentTarget("/api/knowledge/asset?id=kb-1&path=images%2Fa.png"),
    ).toEqual({
      kind: "knowledgeAsset",
      entryId: "kb-1",
      path: "images/a.png",
    });
    expect(parseDocumentTarget("https://example.com/report.md")).toBeNull();
    expect(
      parseDocumentTarget("https://assistant.example/api/files/etc/passwd"),
    ).toBeNull();
    expect(
      parseDocumentTarget("//assistant.example/api/files/etc/passwd"),
    ).toBeNull();
    expect(parseDocumentTarget("/api/files//etc/passwd")).toBeNull();
    expect(
      parseDocumentTarget("/api/knowledge/file-preview?path=secret.md"),
    ).toBeNull();
    expect(
      parseDocumentTarget(
        "/api/knowledge/asset-backup?id=kb-1&path=secret.html",
      ),
    ).toBeNull();
  });

  it("defaults worktree documents to file view and requires an explicit diff", () => {
    expect(
      parseDocumentTarget("pa://worktree/wt-1?path=src%2Fa.ts#L42-L57"),
    ).toEqual({
      kind: "worktreeFile",
      worktreeId: "wt-1",
      path: "src/a.ts",
      view: "file",
      anchor: { start: 42, end: 57 },
    });
    expect(
      parseDocumentTarget("pa://worktree/wt-1?path=src%2Fa.ts&view=diff#L42"),
    ).toMatchObject({ view: "diff", anchor: { start: 42 } });
    expect(
      parseDocumentTarget("/worktrees/wt-1/files?path=src%2Fa.ts"),
    ).toMatchObject({ view: "file" });
    expect(
      parseDocumentTarget("/worktrees/wt-1/changes?path=src%2Fa.ts"),
    ).toMatchObject({ view: "diff" });
  });

  it("formats canonical app and agent-facing worktree links", () => {
    const file: DocumentTarget = {
      kind: "worktreeFile",
      worktreeId: "wt 1",
      path: "src/a file.ts",
      view: "file",
      anchor: { start: 7 },
    };
    expect(documentTargetHref(file)).toBe(
      "/worktrees/wt%201/files?path=src%2Fa+file.ts#L7",
    );
    expect(documentTargetPaUri(file)).toBe(
      "pa://worktree/wt%201?path=src%2Fa+file.ts#L7",
    );
    expect(documentTargetPaUri({ ...file, view: "diff" })).toContain(
      "&view=diff#L7",
    );
    const asset: DocumentTarget = {
      kind: "knowledgeAsset",
      entryId: "kb 1",
      path: "images/a plot.png",
      anchor: { start: 2 },
    };
    expect(parseDocumentTarget(documentTargetHref(asset))).toEqual(asset);
    expect(parseDocumentTarget(documentTargetPaUri(asset)!)).toEqual(asset);
  });

  it("uses inclusive one-based line anchors", () => {
    expect(parseDocumentLineAnchor("#L1")).toEqual({ start: 1 });
    expect(parseDocumentLineAnchor("L42-L57")).toEqual({
      start: 42,
      end: 57,
    });
    expect(parseDocumentLineAnchor("L0")).toBeUndefined();
    expect(parseDocumentLineAnchor("L9-L2")).toBeUndefined();
    expect(formatDocumentLineAnchor({ start: 2, end: 4 })).toBe("#L2-L4");
  });

  it("drops a line number no address can express, at either end", () => {
    const unsafe = String(Number.MAX_SAFE_INTEGER + 2); // 9007199254740993
    const huge = "1".repeat(40);
    expect(parseDocumentLineAnchor(`L${Number.MAX_SAFE_INTEGER}`)).toEqual({
      start: Number.MAX_SAFE_INTEGER,
    });
    expect(parseDocumentLineAnchor(`L${unsafe}`)).toBeUndefined();
    // The end is the half that used to survive parsing and throw later.
    expect(parseDocumentLineAnchor(`L1-L${unsafe}`)).toBeUndefined();
    expect(parseDocumentLineAnchor(`L1-L${huge}`)).toBeUndefined();
    expect(parseDocumentLineAnchor(`L${huge}-L${huge}`)).toBeUndefined();
  });

  it("never throws while formatting, whatever it is handed", () => {
    // Anything parse accepts formats back to the same address…
    for (const fragment of ["L1", "L42-L57", `L${Number.MAX_SAFE_INTEGER}`]) {
      const anchor = parseDocumentLineAnchor(fragment);
      expect(anchor).toBeDefined();
      expect(formatDocumentLineAnchor(anchor)).toBe(`#${fragment}`);
    }
    // …and a range built in code that no address can express simply loses the
    // anchor, rather than taking the render down with it.
    expect(formatDocumentLineAnchor({ start: 1, end: 1e21 })).toBe("");
    expect(formatDocumentLineAnchor({ start: 0 })).toBe("");
    expect(formatDocumentLineAnchor({ start: 9, end: 2 })).toBe("");
    expect(formatDocumentLineAnchor({ start: 1.5 })).toBe("");
    expect(
      documentTargetHref({
        kind: "hostFile",
        path: "/a.md",
        anchor: { start: 1, end: 1e21 },
      }),
    ).toBe("/files/a.md");
  });

  it("bounds the range a renderer may draw, without changing the address", () => {
    expect(boundedDocumentLineRange({ start: 12 })).toEqual({
      start: 12,
      end: 12,
      truncated: false,
    });
    expect(boundedDocumentLineRange({ start: 12, end: 20 })).toEqual({
      start: 12,
      end: 20,
      truncated: false,
    });
    const exact = boundedDocumentLineRange({
      start: 1,
      end: MAX_DOCUMENT_ANCHOR_LINES,
    });
    expect(exact).toEqual({
      start: 1,
      end: MAX_DOCUMENT_ANCHOR_LINES,
      truncated: false,
    });
    // A legitimate address, an illegitimate amount of rendering: it is cut back
    // to the cap FROM the first addressed line, and says so.
    expect(boundedDocumentLineRange({ start: 1, end: 500_000 })).toEqual({
      start: 1,
      end: MAX_DOCUMENT_ANCHOR_LINES,
      truncated: true,
    });
    expect(boundedDocumentLineRange({ start: 9_000, end: 9_000_000 })).toEqual({
      start: 9_000,
      end: 9_000 + MAX_DOCUMENT_ANCHOR_LINES - 1,
      truncated: true,
    });
    // The parsed anchor itself is untouched: the URL keeps its meaning.
    const anchor = parseDocumentLineAnchor("L1-L500000");
    expect(anchor).toEqual({ start: 1, end: 500_000 });
    expect(formatDocumentLineAnchor(anchor)).toBe("#L1-L500000");
  });

  it("keeps relative navigation in the source and resets worktree links to file view", () => {
    expect(
      resolveDocumentReference(
        { kind: "sessionArtifact", sessionId: "s1", path: "out/a.md" },
        "../images/p.png",
      ),
    ).toEqual({
      kind: "sessionArtifact",
      sessionId: "s1",
      path: "images/p.png",
    });
    expect(
      resolveDocumentReference(
        {
          kind: "worktreeFile",
          worktreeId: "w1",
          path: "src/a.md",
          view: "diff",
          anchor: { start: 3 },
        },
        "./b.ts#L8-L9",
      ),
    ).toEqual({
      kind: "worktreeFile",
      worktreeId: "w1",
      path: "src/b.ts",
      view: "file",
      anchor: { start: 8, end: 9 },
    });
  });

  it("resolves URL encoding once, replaces source anchors, and supports same-document anchors", () => {
    const source: DocumentTarget = {
      kind: "hostFile",
      path: "/tmp/a%20b/read me.md",
      anchor: { start: 4 },
    };
    expect(resolveDocumentReference(source, "next%20file.md#L9")).toEqual({
      kind: "hostFile",
      path: "/tmp/a%20b/next file.md",
      anchor: { start: 9 },
    });
    expect(resolveDocumentReference(source, "literal%2520name.txt")).toEqual({
      kind: "hostFile",
      path: "/tmp/a%20b/literal%20name.txt",
    });
    expect(resolveDocumentReference(source, "#L12-L14")).toEqual({
      kind: "hostFile",
      path: "/tmp/a%20b/read me.md",
      anchor: { start: 12, end: 14 },
    });
    expect(resolveDocumentReference(source, "plain.txt")).not.toHaveProperty(
      "anchor",
    );
  });
});
