import { describe, expect, it } from "vitest";
import { servedFileKind, servedFileName } from "./servedFiles.ts";

describe("served file URLs", () => {
  it("names a file by its last segment, decoded", () => {
    expect(
      servedFileName("/api/files/tmp/example/My%20Report.md?token=x"),
    ).toBe("My Report.md");
  });

  it("classifies by extension, with an explicit MIME type winning", () => {
    expect(servedFileKind("/api/files/x/a.png")).toBe("image");
    expect(servedFileKind("/api/files/x/a.MD")).toBe("markdown");
    expect(servedFileKind("/api/files/x/a.html")).toBe("html");
    expect(servedFileKind("/api/files/x/a.log")).toBe("text");
    expect(servedFileKind("/api/files/x/a.sqlite")).toBe("other");
    expect(servedFileKind("/api/files/x/dockerfile")).toBe("other");
    // Readable text the server serves as text/plain, so the card must offer
    // the viewer rather than a download (parity lives in the shared table).
    expect(servedFileKind("/api/files/x/train.py")).toBe("text");
    expect(servedFileKind("/api/files/x/style.css")).toBe("text");
    expect(servedFileKind("/api/files/x/a.bin", "image/webp")).toBe("image");
  });
});
