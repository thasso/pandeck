import { expect, it } from "vitest";
import { previewKindForPath, worktreeZoomMode } from "./previewZoom.ts";

/**
 * Which zoom a worktree document answers to. The bug this pins: "Preview" was
 * read as "a picture", so a rendered Markdown preview — text, reflowing through
 * the typography roles like every other text body — was handed visual mode, and
 * its controls moved a scale nothing on screen read.
 */

it("names the renderer a path previews as", () => {
  expect(previewKindForPath("docs/notes.md")).toBe("markdown");
  expect(previewKindForPath("docs/notes.markdown")).toBe("markdown");
  expect(previewKindForPath("art/logo.svg")).toBe("svg");
  expect(previewKindForPath("page.HTML")).toBe("html");
  expect(previewKindForPath("shot.png")).toBe("raster");
  expect(previewKindForPath("src/main.ts")).toBeUndefined();
});

it("gives Markdown Preview text mode and every other preview visual mode", () => {
  expect(worktreeZoomMode("file", "preview", "markdown")).toBe("text");
  expect(worktreeZoomMode("file", "preview", "svg")).toBe("visual");
  expect(worktreeZoomMode("file", "preview", "html")).toBe("visual");
  expect(worktreeZoomMode("file", "preview", "raster")).toBe("visual");
  // A preview with no renderer cannot be showing reflowable text.
  expect(worktreeZoomMode("file", "preview", undefined)).toBe("visual");
});

it("keeps source, changes and the diff view on text mode", () => {
  // Raster is the exception below: its File pivot renders the image itself.
  for (const kind of ["markdown", "svg", "html", undefined] as const) {
    expect(worktreeZoomMode("file", "file", kind)).toBe("text");
    expect(worktreeZoomMode("file", "vs-base", kind)).toBe("text");
    expect(worktreeZoomMode("diff", "file", kind)).toBe("text");
    // Even a "preview" pivot cannot make the Changes view a picture.
    expect(worktreeZoomMode("diff", "preview", kind)).toBe("text");
  }
});

it("treats an image's File pivot as the picture it is", () => {
  // A raster file gets no Preview pivot — `FilePreview` renders on File — so
  // reading "file" as "source text" would leave its controls doing nothing.
  expect(worktreeZoomMode("file", "file", "raster")).toBe("visual");
  expect(worktreeZoomMode("file", "preview", "raster")).toBe("visual");
  // Its diff against the base is a pierre surface like any other.
  expect(worktreeZoomMode("file", "vs-base", "raster")).toBe("text");
  expect(worktreeZoomMode("diff", "file", "raster")).toBe("text");
});

it("reads the History list as text, even for an image", () => {
  expect(worktreeZoomMode("file", "history", "raster")).toBe("text");
  expect(worktreeZoomMode("file", "history", "markdown")).toBe("text");
  expect(worktreeZoomMode("file", "history", undefined)).toBe("text");
});
