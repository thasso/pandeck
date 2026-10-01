import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, Harness, ServerMessage } from "@assistant/shared";
import { afterAll, test } from "vitest";

const cwd = mkdtempSync(join(tmpdir(), "workflow-coordinator-availability-"));
const originalNodeEnv = process.env.NODE_ENV;
process.env.ASSISTANT_CWD = cwd;
process.env.NODE_ENV = "production";

const { isAgentAvailable, isAgentSessionAvailable } =
  await import("./agents.ts");
const { Connection } = await import("./connection.ts");
const { sessionStore } = await import("./db/sessionStore.ts");

afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  rmSync(cwd, { recursive: true, force: true });
});

function makeConnection() {
  const sent: ServerMessage[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
  return { connection: new Connection(socket), sent };
}

function sessionGuard(connection: InstanceType<typeof Connection>) {
  return (
    connection as unknown as {
      guardSessionRef(ref: { harness: Harness; kind: AgentKind }): boolean;
    }
  ).guardSessionRef.bind(connection);
}

test("the workflow coordinator is internal-only but its pi sessions load", () => {
  assert.equal(isAgentAvailable("workflow-coordinator"), false);
  assert.equal(isAgentSessionAvailable("workflow-coordinator"), true);

  const { connection, sent } = makeConnection();
  try {
    assert.equal(
      sessionGuard(connection)({ harness: "pi", kind: "workflow-coordinator" }),
      true,
    );
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
    );
  } finally {
    connection.dispose();
  }
});

test("existing-session guards still refuse environment-gated personas", () => {
  assert.equal(isAgentSessionAvailable("workshop"), false);

  const { connection, sent } = makeConnection();
  try {
    assert.equal(
      sessionGuard(connection)({ harness: "pi", kind: "workshop" }),
      false,
    );
    assert.ok(
      sent.some(
        (message) =>
          message.type === "error" &&
          message.message === 'The "workshop" agent is not available.',
      ),
    );
  } finally {
    connection.dispose();
  }
});

test("forking cannot create another server-owned persona session", async () => {
  const id = "workflow-coordinator-fork-parent";
  sessionStore.upsert({ id, harness: "pi", agentType: "workflow-coordinator" });
  const { connection, sent } = makeConnection();

  try {
    await (
      connection as unknown as {
        onForkSession(
          sessionId: string,
          entryId: string,
          position: "before" | "at",
        ): Promise<void>;
      }
    ).onForkSession(id, "entry-1", "at");
    assert.ok(
      sent.some(
        (message) =>
          message.type === "error" &&
          message.message ===
            'The "workflow-coordinator" agent is not available.',
      ),
    );
  } finally {
    connection.dispose();
    sessionStore.remove(id);
  }
});
