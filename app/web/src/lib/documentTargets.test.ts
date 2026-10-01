// @vitest-environment jsdom
import { expect, it } from "vitest";
import { resolveInternalDocumentTarget } from "./documentTargets.ts";
import { serverHttpOrigin } from "./serverOrigin.ts";

it("accepts configured-server document URLs but leaves foreign URLs external", () => {
  expect(
    resolveInternalDocumentTarget(
      `${serverHttpOrigin()}/api/files/tmp/example/report.md#L2`,
    ),
  ).toEqual({
    kind: "hostFile",
    path: "/tmp/example/report.md",
    anchor: { start: 2 },
  });
  expect(
    resolveInternalDocumentTarget(
      "https://other.example/api/files/tmp/example/report.md",
    ),
  ).toBeNull();
});
