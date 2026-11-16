/**
 * The vault's OAuth clients for users' integrations (Task-1411): read once at
 * start from `vault --integrations-config <file>`, a JSON object keyed by
 * provider, each `{clientId, clientSecret}`. Only `atlassian` is known; other
 * provider keys are ignored, so a file can name a later provider before this
 * vault knows it. The file must be a regular file nobody but its owner may
 * read (mode without group or other bits).
 *
 * The client secret lives only in the vault's memory: it is sent only to the
 * provider's fixed token endpoint (`vaultAtlassian.ts`), never logged, never
 * answered to the edge. A refusal is a fixed text holding no value from the
 * file.
 */
import { readFileSync, statSync } from "node:fs";

/** One provider's confidential OAuth client. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The OAuth clients a vault holds, by provider. */
export interface IntegrationClients {
  atlassian?: OAuthClient | undefined;
}

/** Why a config file was refused; the text holds nothing from the file. */
export class IntegrationClientsRefusal extends Error {}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 1024;
/** Printable ASCII without space: what an OAuth client id or secret is. */
const VALUE_RE = /^[\x21-\x7e]+$/;

function isValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_VALUE_CHARS &&
    VALUE_RE.test(value)
  );
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads and checks `file`; throws `IntegrationClientsRefusal` when unusable. */
export function loadIntegrationClients(file: string): IntegrationClients {
  let mode: number;
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile())
      throw new IntegrationClientsRefusal(
        "the integrations config is not a regular file",
      );
    mode = stat.mode;
    size = stat.size;
  } catch (err) {
    if (err instanceof IntegrationClientsRefusal) throw err;
    throw new IntegrationClientsRefusal(
      "the integrations config cannot be read",
    );
  }
  if ((mode & 0o077) !== 0)
    throw new IntegrationClientsRefusal(
      "the integrations config is readable by group or others; chmod 600 it",
    );
  if (size > MAX_FILE_BYTES)
    throw new IntegrationClientsRefusal("the integrations config is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new IntegrationClientsRefusal(
      "the integrations config is not valid JSON",
    );
  }
  const root = objectOf(parsed);
  if (!root)
    throw new IntegrationClientsRefusal(
      "the integrations config is not a JSON object",
    );
  const clients: IntegrationClients = {};
  if (root.atlassian !== undefined) {
    const entry = objectOf(root.atlassian);
    if (!entry || !isValue(entry.clientId) || !isValue(entry.clientSecret))
      throw new IntegrationClientsRefusal(
        "the integrations config's atlassian entry needs a non-empty clientId and clientSecret",
      );
    clients.atlassian = {
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
    };
  }
  return clients;
}
