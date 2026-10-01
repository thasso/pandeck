/** A TCP port which may be forwarded by the desktop shell. */
export const PORT_FORWARD_MIN_PORT = 1024;
export const PORT_FORWARD_MAX_PORT = 65_535;

/** Whether `port` is an integer inside the forwardable range. */
export function isPortForwardPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= PORT_FORWARD_MIN_PORT &&
    port <= PORT_FORWARD_MAX_PORT
  );
}

export interface PortForwardGrantRequest {
  port: number;
}

/**
 * Expiring credential for the dedicated binary forwarding socket.
 *
 * `token` is secret and must be sent in the WebSocket Authorization header,
 * never in a URL. `id` is non-secret and is used only to revoke the grant.
 */
export interface PortForwardGrant {
  id: string;
  token: string;
  port: number;
  expiresAt: string;
  expiresAtMs: number;
}

export interface PortForwardGrantRevokeRequest {
  id: string;
}

/** Public state reported by the native shell. */
export interface PortForwardTunnelStatus {
  port: number;
  localUrl: string;
  serverOrigin: string;
  activeConnections: number;
  expiresAt: string;
}
