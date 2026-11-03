/**
 * A test's gateway link (`gatewayLink.ts`): the in-process gateway on a free
 * port with a temp state directory and no upstream, so a test reads the
 * leases its engines were granted. Import it only after the test has set its
 * `DATA_DIR`, as the link reads credential profiles from there.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayLink, type GatewayLink } from "../gatewayLink.ts";

/** A gateway lease record, named through the link: only it imports `gateway/`. */
type LeaseRecord = ReturnType<
  NonNullable<GatewayLink["gateway"]>["leases"]["records"]
>[number];

export interface TestGatewayLink {
  link: GatewayLink;
  stateDir: string;
  /** Every log line of the link and its gateway. */
  lines: string[];
  /** The gateway's engine leases, oldest first. */
  engineLeases(): Extract<LeaseRecord, { kind: "engine" }>[];
  close(): Promise<void>;
}

export async function startGatewayLinkForTests(): Promise<TestGatewayLink> {
  const stateDir = join(mkdtempSync(join(tmpdir(), "gateway-link-")), "state");
  const lines: string[] = [];
  const link = startGatewayLink({
    stateDir,
    port: 0,
    log: (line) => lines.push(line),
  });
  assert.equal(await link.ready, true, lines.join("\n"));
  return {
    link,
    stateDir,
    lines,
    engineLeases: () =>
      link
        .gateway!.leases.records()
        .filter(
          (record): record is Extract<LeaseRecord, { kind: "engine" }> =>
            record.kind === "engine",
        )
        .sort((a, b) => a.grantedAt - b.grantedAt),
    async close() {
      await link.close();
      rmSync(join(stateDir, ".."), { recursive: true, force: true });
    },
  };
}
