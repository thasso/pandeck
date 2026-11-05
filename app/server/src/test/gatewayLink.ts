/**
 * A test's gateway link (`gatewayLink.ts`): the in-process gateway on a free
 * port with a temp state directory and no upstream unless the test names its
 * fakes, so a test reads the leases its engines were granted. Import it only after the test has set its
 * `DATA_DIR`, as the link reads credential profiles from there.
 *
 * A test that names its own `stateDir`, to start another link on it, owns
 * that directory: closing leaves it in place.
 *
 * Its gateway renews Claude tokens only at the test's fake token endpoint, or
 * at a closed loopback port that refuses at once: never at the real one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startGatewayLink,
  type GatewayLink,
  type GatewayLinkOptions,
} from "../gatewayLink.ts";

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

/** Loopback's discard port, where nothing listens: a renewal fails there. */
const NO_TOKEN_ENDPOINT = { connect: { host: "127.0.0.1", port: 9 } };

export async function startGatewayLinkForTests(
  options: Partial<
    Pick<
      GatewayLinkOptions,
      "stateDir" | "start" | "upstreams" | "compat" | "claudeTokenEndpoint"
    >
  > = {},
): Promise<TestGatewayLink> {
  /** The temp directory this helper made and removes, if it made one. */
  const own =
    options.stateDir === undefined
      ? mkdtempSync(join(tmpdir(), "gateway-link-"))
      : undefined;
  const stateDir = options.stateDir ?? join(own!, "state");
  const lines: string[] = [];
  const link = startGatewayLink({
    stateDir,
    port: 0,
    log: (line) => lines.push(line),
    ...(options.start ? { start: options.start } : {}),
    ...(options.upstreams ? { upstreams: options.upstreams } : {}),
    ...(options.compat ? { compat: options.compat } : {}),
    claudeTokenEndpoint: options.claudeTokenEndpoint ?? NO_TOKEN_ENDPOINT,
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
      if (own) rmSync(own, { recursive: true, force: true });
    },
  };
}
