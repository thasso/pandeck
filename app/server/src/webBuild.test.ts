import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webBuildId } from "./webBuild.ts";

describe("webBuildId", () => {
  it("is stable for one shell and changes with its content-addressed entry chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-web-build-"));
    const index = join(dir, "index.html");
    writeFileSync(index, '<script src="/assets/index-a.js"></script>');
    const first = webBuildId(index);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(webBuildId(index)).toBe(first);

    writeFileSync(index, '<script src="/assets/index-b.js"></script>');
    expect(webBuildId(index)).not.toBe(first);
  });

  it("degrades when no production web build exists", () => {
    expect(webBuildId("/definitely/missing/index.html")).toBeUndefined();
  });
});
