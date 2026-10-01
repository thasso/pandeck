import { describe, expect, it } from "vitest";
import { entryLocalAssetHref } from "./knowledgeEntry.ts";

describe("entryLocalAssetHref", () => {
  it("recognizes entry-local asset paths", () => {
    expect(entryLocalAssetHref("assets/diagram.png")).toBe(
      "assets/diagram.png",
    );
    expect(entryLocalAssetHref("./assets/sub/photo.jpg")).toBe(
      "assets/sub/photo.jpg",
    );
    expect(entryLocalAssetHref("assets/report.pdf?x=1#frag")).toBe(
      "assets/report.pdf",
    );
  });

  it("ignores absolute, scheme, root, and fragment URLs", () => {
    expect(entryLocalAssetHref("https://example.com/a.png")).toBeNull();
    expect(entryLocalAssetHref("pa://knowledge/kb-1")).toBeNull();
    expect(entryLocalAssetHref("mailto:x@y.z")).toBeNull();
    expect(entryLocalAssetHref("/assets/a.png")).toBeNull();
    expect(entryLocalAssetHref("//cdn/a.png")).toBeNull();
    expect(entryLocalAssetHref("#section")).toBeNull();
    expect(entryLocalAssetHref("other/a.png")).toBeNull();
    expect(entryLocalAssetHref("assets/")).toBeNull();
  });
});
