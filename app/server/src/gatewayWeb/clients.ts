/**
 * What the gateway UI needs of the user's enrolled clients and their MCP
 * tokens (Task-1405), defined here as `accounts.ts` defines accounts: the
 * edge's composition adapts its user-scoped operations to it.
 *
 * The user always comes from the session; another user's client is as unknown
 * as a missing one. An enrollment code or MCP token appears only in the answer
 * that creates it. A machine's enrollment request (Task-1410) is looked up and
 * decided by its user code, which travels only in a POST body; approving binds
 * the session's user. A refusal is a `ClientsRefusal` with a fixed code;
 * anything else thrown means the registry is unavailable.
 */
import type {
  GatewayUiClient,
  GatewayUiEnrollmentCode,
  GatewayUiEnrollmentDecideRequest,
  GatewayUiEnrollmentRequest,
  GatewayUiMcpToken,
} from "@assistant/shared/gatewayUi";
import { isId, isRecord } from "./accounts.ts";

export type ClientsRefusalCode =
  "unknown_client" | "limit_reached" | "unknown_request";

export class ClientsRefusal extends Error {
  constructor(readonly code: ClientsRefusalCode) {
    super(code);
  }
}

export interface GatewayWebClients {
  /** The user's clients that are not revoked. */
  list(userId: string): GatewayUiClient[];
  createCode(userId: string, label: string): GatewayUiEnrollmentCode;
  /** Ends the client's connections, logins and leases now. */
  revoke(userId: string, clientId: string): void;
  /** Replaces any earlier token. */
  mintMcpToken(userId: string, clientId: string): GatewayUiMcpToken;
  revokeMcpToken(userId: string, clientId: string): void;
  /** The undecided request with this user code (`unknown_request`). */
  enrollment(userId: string, userCode: string): GatewayUiEnrollmentRequest;
  /**
   * Approves it for the user (`limit_reached` past the page's limits) or
   * denies it; the first decision wins (`unknown_request` after).
   */
  decideEnrollment(userId: string, userCode: string, approve: boolean): void;
}

const MAX_LABEL_CHARS = 200;

/** `{label}`, trimmed, 1-200 characters. */
export function decodeCodeRequest(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.label !== "string") return undefined;
  const label = value.label.trim();
  return label !== "" && label.length <= MAX_LABEL_CHARS ? label : undefined;
}

/** `{clientId}`; any other field (a `userId`) is ignored. */
export function decodeClientRequest(value: unknown): string | undefined {
  return isRecord(value) && isId(value.clientId) ? value.clientId : undefined;
}

/** Longer than any user code with its dash and spaces; the registry checks it. */
const MAX_USER_CODE_CHARS = 16;

const isUserCode = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= MAX_USER_CODE_CHARS;

/** `{userCode}`; any other field (a `userId`) is ignored. */
export function decodeEnrollmentLookup(value: unknown): string | undefined {
  return isRecord(value) && isUserCode(value.userCode)
    ? value.userCode
    : undefined;
}

/** `{userCode, approve}`; any other field (a `userId`) is ignored. */
export function decodeEnrollmentDecision(
  value: unknown,
): GatewayUiEnrollmentDecideRequest | undefined {
  return isRecord(value) &&
    isUserCode(value.userCode) &&
    typeof value.approve === "boolean"
    ? { userCode: value.userCode, approve: value.approve }
    : undefined;
}
