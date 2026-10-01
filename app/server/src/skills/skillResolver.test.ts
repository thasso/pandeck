import { describe, expect, it } from "vitest";
import { resolveSkillNames } from "./skillResolver.ts";

const available = [{ name: "zeta" }, { name: "alpha" }, { name: "alpha" }];

describe("resolveSkillNames", () => {
  it("defaults absent and off names to disabled and excludes stale settings", () => {
    expect(
      resolveSkillNames(available, [
        { alpha: "on", zeta: "off", missing: "on" },
      ]),
    ).toEqual(["alpha"]);
  });

  it("returns sorted unique names and lets later scope layers override", () => {
    expect(
      resolveSkillNames(available, [
        { alpha: "off", zeta: "on" },
        { alpha: "on", zeta: "off" },
      ]),
    ).toEqual(["alpha"]);
  });
});
