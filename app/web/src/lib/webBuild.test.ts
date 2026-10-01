import { describe, expect, it } from "vitest";
import { recordWebBuild } from "./webBuild.ts";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("assistant.webBuildId", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get("assistant.webBuildId"),
  };
}

describe("web build deployment detection", () => {
  it("records the first build without asking for a reload", () => {
    const target = storage();
    expect(recordWebBuild(target, "build-a")).toBe(false);
    expect(target.value()).toBe("build-a");
  });

  it("requests exactly one reload when the served build changes", () => {
    const target = storage("build-a");
    expect(recordWebBuild(target, "build-b")).toBe(true);
    expect(target.value()).toBe("build-b");
    expect(recordWebBuild(target, "build-b")).toBe(false);
  });
});
