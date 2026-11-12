import type {
  GatewayUiAccount,
  GatewayUiAtlassian,
  GatewayUiClient,
  GatewayUiEnrollmentCode,
  GatewayUiMcpToken,
  GatewayUiMe,
} from "@assistant/shared/gatewayUi";

/** `GET /api/me` for a signed-in user of the gateway's page. */
export const gatewayUiMe: GatewayUiMe = {
  userId: "u_Q2hhbmdlTWVQbGVh",
  email: "person@example.org",
  label: "person@example.org",
};

/** `GET /api/accounts`: one logged-in account and one needing a login. */
export const gatewayUiAccounts: GatewayUiAccount[] = [
  {
    id: "claude-1a2b3c4d5e6f",
    provider: "claude",
    name: "Work",
    needsLogin: false,
  },
  {
    id: "codex-6f5e4d3c2b1a",
    provider: "openai-codex",
    name: "OpenAI",
    needsLogin: true,
  },
];

/** `GET /api/integrations/atlassian` with nothing stored. */
export const gatewayUiAtlassianNotSet: GatewayUiAtlassian = {
  connected: false,
};

/** A stored credential: site and email, never the token. */
export const gatewayUiAtlassianConnected: GatewayUiAtlassian = {
  connected: true,
  site: "example-team.atlassian.net",
  email: "person@example.org",
  displayName: "Person Example",
};

/** The vault is locked: the stored credential cannot be read now. */
export const gatewayUiAtlassianLocked: GatewayUiAtlassian = {
  connected: false,
  problem: "vault_locked",
};

/** `GET /api/clients`: two machines, one with an MCP token. */
export const gatewayUiClients: GatewayUiClient[] = [
  {
    id: "cl_4f2a9c1e7b3d",
    label: "Work laptop",
    createdAt: Date.UTC(2026, 9, 14, 9, 30),
    mcpToken: true,
  },
  {
    id: "cl_8e1d6b0a5c2f",
    label: "Home desktop",
    createdAt: Date.UTC(2026, 10, 2, 18, 5),
    mcpToken: false,
  },
];

/** `POST /api/clients/code`: an obviously fake one-time code. */
export const gatewayUiEnrollmentCode: GatewayUiEnrollmentCode = {
  code: "FAKE-enrollment-code-0000",
  validForSeconds: 900,
};

/** `POST /api/clients/mcp-token`: an obviously fake MCP token. */
export const gatewayUiMcpToken: GatewayUiMcpToken = {
  token: "pgmcp_FAKE-token-for-the-preview-only",
};
