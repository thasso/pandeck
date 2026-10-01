import assert from "node:assert/strict";
import { test } from "vitest";
import { parsePrAgentJson } from "./prAgent.ts";

test("parses fenced PR JSON and sanitizes title/body/warnings", () => {
  const parsed = parsePrAgentJson(`\`\`\`json
{
  "title": "Title: Add the pull request workflow.",
  "body": ["## Summary\\nAdds the workflow.", "", 42, "\`\`\`"],
  "warnings": ["Patch was truncated.", null]
}
\`\`\``);
  assert.deepEqual(parsed, {
    title: "Add the pull request workflow",
    body: ["## Summary\nAdds the workflow."],
    warnings: ["Patch was truncated."],
  });
});

test("rejects malformed responses and missing titles", () => {
  assert.throws(() => parsePrAgentJson("not json"), /invalid JSON/);
  assert.throws(
    () => parsePrAgentJson('{"title":"","body":[],"warnings":[]}'),
    /usable title/,
  );
  assert.throws(
    () => parsePrAgentJson('{"title":"```json","body":[],"warnings":[]}'),
    /wrapper instead of a title/,
  );
});

test("bounds long titles without leaving a partial word", () => {
  const parsed = parsePrAgentJson(
    JSON.stringify({
      title: `${"word ".repeat(30)}tail`,
      body: [],
      warnings: [],
    }),
  );
  assert.ok(parsed.title.length <= 120);
  assert.equal(parsed.title.endsWith("wor"), false);
});
