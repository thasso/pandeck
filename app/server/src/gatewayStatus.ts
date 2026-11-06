/**
 * The credential gateway's connection state as app status (`gatewayStatus`,
 * Task-1383 D3): the installed link's `unreachable` and `incompatible` reach
 * every browser, replayed on connect and broadcast on change. Connected,
 * connecting and no link at all are `ok`.
 */
import type { GatewayStatusState, ServerMessage } from "@assistant/shared";
import {
  installedGatewayLink,
  type GatewayConnectionState,
  type GatewayLink,
} from "./gatewayLink.ts";

let broadcast: ((message: ServerMessage) => void) | undefined;
let announced: GatewayStatusState = "ok";
const followed = new WeakSet<GatewayLink>();

function statusOf(
  state: GatewayConnectionState | undefined,
): GatewayStatusState {
  return state === "unreachable" || state === "incompatible" ? state : "ok";
}

/** Who hears of every change; `hub.ts` sets it. */
export function setGatewayStatusBroadcaster(
  value: (message: ServerMessage) => void,
): void {
  broadcast = value;
}

/** Follows the installed link's connection state from now on (`index.ts`). */
export function followGatewayStatus(): void {
  const link = installedGatewayLink();
  if (!link || followed.has(link)) return;
  followed.add(link);
  const announce = (state: GatewayConnectionState): void => {
    const next = statusOf(state);
    if (next === announced) return;
    announced = next;
    broadcast?.({ type: "gatewayStatus", state: next });
  };
  link.onConnectionState(announce);
  announce(link.connectionState());
}

export function sendGatewayStatusTo(connection: {
  send: (message: ServerMessage) => void;
}): void {
  connection.send({
    type: "gatewayStatus",
    state: statusOf(installedGatewayLink()?.connectionState()),
  });
}
