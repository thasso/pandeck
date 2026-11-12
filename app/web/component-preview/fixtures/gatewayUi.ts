import type {
  GatewayUiAccount,
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
