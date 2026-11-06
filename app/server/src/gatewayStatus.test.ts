import assert from "node:assert/strict";
import type { ServerMessage } from "@assistant/shared";
import { afterEach, test } from "vitest";
import {
  installGatewayLink,
  type GatewayConnectionState,
  type GatewayLink,
} from "./gatewayLink.ts";
import {
  followGatewayStatus,
  sendGatewayStatusTo,
  setGatewayStatusBroadcaster,
} from "./gatewayStatus.ts";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

/** A link with only a connection state, which the test moves. */
function fakeLink(): {
  link: GatewayLink;
  move(state: GatewayConnectionState): void;
} {
  let state: GatewayConnectionState = "connecting";
  const listeners = new Set<(state: GatewayConnectionState) => void>();
  const link = {
    connectionState: () => state,
    onConnectionState(listener: (state: GatewayConnectionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayLink;
  return {
    link,
    move(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function sent(): ServerMessage[] {
  const messages: ServerMessage[] = [];
  sendGatewayStatusTo({ send: (message) => messages.push(message) });
  return messages;
}

test("without a link the gateway is ok", () => {
  assert.deepEqual(sent(), [{ type: "gatewayStatus", state: "ok" }]);
});

test("the link's unreachable and incompatible are broadcast once per change and replayed on connect", () => {
  const broadcasts: ServerMessage[] = [];
  setGatewayStatusBroadcaster((message) => broadcasts.push(message));
  const fake = fakeLink();
  uninstall = installGatewayLink(fake.link);
  followGatewayStatus();
  followGatewayStatus();
  assert.deepEqual(broadcasts, [], "connecting is ok, as before");
  fake.move("unreachable");
  fake.move("unreachable");
  assert.deepEqual(sent(), [{ type: "gatewayStatus", state: "unreachable" }]);
  fake.move("connecting");
  fake.move("connected");
  fake.move("incompatible");
  assert.deepEqual(broadcasts, [
    { type: "gatewayStatus", state: "unreachable" },
    { type: "gatewayStatus", state: "ok" },
    { type: "gatewayStatus", state: "incompatible" },
  ]);
  assert.deepEqual(sent(), [{ type: "gatewayStatus", state: "incompatible" }]);
});
