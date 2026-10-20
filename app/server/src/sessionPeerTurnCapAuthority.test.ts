import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

const root = fileURLToPath(new URL("./", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];
  });
}
type Node = { type: string; name?: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value;

test("existing-session cap writers have only user-command and human-approved executor consumers", () => {
  const consumers = new Set<string>();
  let approvedWrites = 0;
  for (const path of sources(root)) {
    const source = readFileSync(path, "utf8");
    if (!/setSessionPeerTurnCap|setPeerTurnCap/.test(source)) continue;
    const name = relative(root, path);
    function visit(node: Node, parents: Node[]) {
      // References include imports, aliases, re-exports and member access.
      // An agent tool cannot hide a new consumer behind a different tool name.
      if (
        node.type === "Identifier" &&
        ["setSessionPeerTurnCap", "setPeerTurnCap"].includes(node.name ?? "")
      ) {
        consumers.add(name);
        if (
          name === "tools/approvals/approvalGrantsRequestTool.ts" &&
          parents.at(-1)?.type === "CallExpression"
        ) {
          approvedWrites++;
          const method = parents.findLastIndex(
            (parent) =>
              parent.type === "Property" &&
              isNode(parent.key) &&
              parent.key.name === "execute",
          );
          assert.ok(
            method >= 0,
            "the tool may write only inside its human-approved executor",
          );
          const registration = parents[method - 2]!;
          assert.equal(registration.type, "CallExpression");
          assert.ok(
            isNode(registration.callee) &&
              registration.callee.name === "registerApprovalExecutor",
          );
          assert.equal(
            (registration.arguments as Node[])[0]?.value,
            "approvalGrantsRequest",
          );
        }
      }
      for (const value of Object.values(node))
        for (const child of Array.isArray(value) ? value : [value])
          if (isNode(child)) visit(child, [...parents, node]);
    }
    visit(parseSync(path, source).program as unknown as Node, []);
  }
  assert.equal(approvedWrites, 1);
  assert.deepEqual([...consumers].sort(), [
    "connection.ts",
    "db/sessionStore.ts",
    "peerSpawnRuntimes.ts",
    "tools/approvals/approvalGrantsRequestTool.ts",
    "validateClientMessage.ts",
  ]);
});
