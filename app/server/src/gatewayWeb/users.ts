/**
 * What the gateway UI needs of the edge's users (Task-1402), defined here as
 * `gatewayTools/` defines what `EdgeTools` expects: the edge's entry adapts
 * `ClientRegistry` to it, so this directory imports nothing from `gateway/`.
 * Either method may throw when the registry is unavailable.
 */
export interface GatewayWebUsers {
  /** The user an admitted sign-in reaches; see `ClientRegistry.signIn`. */
  signIn(identity: { issuer: string; subject: string; email: string }): {
    userId: string;
    outcome: "existing" | "created" | "bound";
  };
  user(id: string): { id: string; label: string; email?: string } | undefined;
}
