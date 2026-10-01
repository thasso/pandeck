import { describe, expect, it } from "vitest";
import {
  servedFileDeliveryOf,
  servedFileInlineContentTypeOf,
  servedFileKindOf,
  servedFileMediaElementOf,
  servedFileRendersInApp,
} from "./servedFiles.ts";

/**
 * This table is the one place the server's delivery and the web's rendering
 * agree, so the cases worth pinning are the ones where a disagreement was
 * user-visible: source and config files ARE readable text, and active content
 * is never delivered as a document.
 */
describe("served file classification", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(servedFileKindOf("/x/a.PNG")).toBe("image");
    expect(servedFileKindOf("/x/a.md")).toBe("markdown");
    expect(servedFileKindOf("/x/a.HTML")).toBe("html");
    expect(servedFileKindOf("/x/a.log")).toBe("text");
    expect(servedFileKindOf("/x/a.pdf")).toBe("media");
    expect(servedFileKindOf("/x/a.sqlite")).toBe("other");
  });

  it("treats source and config files as readable text", () => {
    for (const name of [
      "app.css",
      "main.ts",
      "component.tsx",
      "script.py",
      "lib.rs",
      "main.go",
      "run.sh",
      "flake.nix",
      "Config.toml",
      "data.csv",
    ])
      expect(servedFileKindOf(name)).toBe("text");
  });

  it("has no extension to read where there is none", () => {
    expect(servedFileKindOf("/x/Dockerfile")).toBe("other");
    expect(servedFileKindOf("/x/.gitignore")).toBe("other");
    expect(servedFileKindOf("")).toBe("other");
  });

  it("owns inline MIME behavior for every shared kind", () => {
    expect(servedFileInlineContentTypeOf("plot.bmp")).toBe("image/bmp");
    expect(servedFileInlineContentTypeOf("report.md")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(servedFileInlineContentTypeOf("main.py")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(servedFileInlineContentTypeOf("report.pdf")).toBe("application/pdf");
    expect(servedFileInlineContentTypeOf("recording.ogg")).toBe("audio/ogg");
    expect(servedFileInlineContentTypeOf("track.aac")).toBe("audio/aac");
    expect(servedFileInlineContentTypeOf("track.flac")).toBe("audio/flac");
    expect(servedFileInlineContentTypeOf("clip.mov")).toBe("video/quicktime");
    expect(servedFileInlineContentTypeOf("clip.m4v")).toBe("video/x-m4v");
    expect(servedFileInlineContentTypeOf("clip.ogv")).toBe("video/ogg");
    expect(servedFileInlineContentTypeOf("page.html")).toBe(
      "application/octet-stream",
    );
  });

  it("owns the browser player choice for every claimed media format", () => {
    for (const name of ["x.ogg", "x.mp3", "x.wav", "x.m4a", "x.aac", "x.flac"])
      expect(servedFileMediaElementOf(name)).toBe("audio");
    for (const name of ["x.mp4", "x.webm", "x.mov", "x.m4v", "x.ogv"])
      expect(servedFileMediaElementOf(name)).toBe("video");
    expect(servedFileMediaElementOf("x.pdf")).toBeNull();
  });

  it("never delivers active content as a document", () => {
    expect(servedFileDeliveryOf("html")).toBe("download");
    expect(servedFileDeliveryOf("other")).toBe("download");
    expect(servedFileDeliveryOf("markdown")).toBe("text");
    expect(servedFileDeliveryOf("text")).toBe("text");
    expect(servedFileDeliveryOf("image")).toBe("image");
    expect(servedFileDeliveryOf("media")).toBe("media");
  });

  it("knows which kinds the app renders itself", () => {
    expect(servedFileRendersInApp("markdown")).toBe(true);
    expect(servedFileRendersInApp("other")).toBe(false);
  });
});
