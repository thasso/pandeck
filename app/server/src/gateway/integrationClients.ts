/**
 * The vault's OAuth clients for users' integrations (Task-1411, Task-1452,
 * Task-1444): read once at start from `vault --integrations-config <file>`, a
 * JSON object keyed by provider. `atlassian` and `slack` are each `{clientId,
 * clientSecret}`; `github` is the GitHub App, `{appId, clientId,
 * clientSecret, privateKeyFile}`, `appId` a positive integer. Other provider
 * keys are ignored, so a file can name a later provider before this vault
 * knows it. The file must be a regular file nobody but its owner may read
 * (mode without group or other bits).
 *
 * The App's private key is a separate PEM file, `privateKeyFile` (absolute,
 * or relative to the config file's directory), held to the same rules and at
 * most 16 KiB: an RSA private key `node:crypto` parses, read once here. It
 * stays a `KeyObject` in memory behind `sign`, which signs RS256 and is the
 * only use of it; nothing hands the key or its text on.
 *
 * The client secret lives only in the vault's memory: it is sent only to the
 * provider's fixed token endpoint (`vaultAtlassian.ts`, `vaultSlack.ts`,
 * `vaultGithub.ts`), never logged, never answered to the edge. A refusal is a
 * fixed text holding no value from either file.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** One provider's confidential OAuth client. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * The GitHub App: its OAuth client for users' tokens, and `sign`, the App
 * key's RS256 signature over `data` (the seam a hardware key may fill later).
 */
export interface GithubAppClient extends OAuthClient {
  appId: number;
  sign(data: string): Buffer;
}

/** The OAuth clients a vault holds, by provider. */
export interface IntegrationClients {
  atlassian?: OAuthClient | undefined;
  slack?: OAuthClient | undefined;
  github?: GithubAppClient | undefined;
}

const PROVIDERS = ["atlassian", "slack"] as const;

/** Why a config file was refused; the text holds nothing from the file. */
export class IntegrationClientsRefusal extends Error {}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const APP_ID_RE = /^[1-9][0-9]{0,14}$/;
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

/**
 * `file`'s text when it is a regular file only its owner may read, at most
 * `maxBytes`; else a refusal naming `what`, nothing from the file.
 */
function readPrivateFile(file: string, what: string, maxBytes: number): string {
  let mode: number;
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile())
      throw new IntegrationClientsRefusal(`${what} is not a regular file`);
    mode = stat.mode;
    size = stat.size;
  } catch (err) {
    if (err instanceof IntegrationClientsRefusal) throw err;
    throw new IntegrationClientsRefusal(`${what} cannot be read`);
  }
  if ((mode & 0o077) !== 0)
    throw new IntegrationClientsRefusal(
      `${what} is readable by group or others; chmod 600 it`,
    );
  if (size > maxBytes)
    throw new IntegrationClientsRefusal(`${what} is too large`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new IntegrationClientsRefusal(`${what} cannot be read`);
  }
}

function appIdOf(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && APP_ID_RE.test(text)
    ? Number(text)
    : undefined;
}

/** The GitHub App entry with its key read and checked; refused otherwise. */
function githubAppOf(entry: unknown, configFile: string): GithubAppClient {
  const fields = objectOf(entry);
  const appId = appIdOf(fields?.appId);
  if (
    !fields ||
    appId === undefined ||
    !isValue(fields.clientId) ||
    !isValue(fields.clientSecret) ||
    !isValue(fields.privateKeyFile)
  )
    throw new IntegrationClientsRefusal(
      "the integrations config's github entry needs a positive integer appId and a non-empty clientId, clientSecret and privateKeyFile",
    );
  const what = "the GitHub App private key file";
  const pem = readPrivateFile(
    resolve(dirname(configFile), fields.privateKeyFile),
    what,
    MAX_KEY_FILE_BYTES,
  );
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new IntegrationClientsRefusal(`${what} holds no PEM private key`);
  }
  if (key.asymmetricKeyType !== "rsa")
    throw new IntegrationClientsRefusal(`${what} holds no RSA private key`);
  return {
    appId,
    clientId: fields.clientId,
    clientSecret: fields.clientSecret,
    sign: (data) => sign("sha256", Buffer.from(data, "utf8"), key),
  };
}

/** Reads and checks `file`; throws `IntegrationClientsRefusal` when unusable. */
export function loadIntegrationClients(file: string): IntegrationClients {
  const text = readPrivateFile(file, "the integrations config", MAX_FILE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  for (const provider of PROVIDERS) {
    if (root[provider] === undefined) continue;
    const entry = objectOf(root[provider]);
    if (!entry || !isValue(entry.clientId) || !isValue(entry.clientSecret))
      throw new IntegrationClientsRefusal(
        `the integrations config's ${provider} entry needs a non-empty clientId and clientSecret`,
      );
    clients[provider] = {
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
    };
  }
  if (root.github !== undefined)
    clients.github = githubAppOf(root.github, file);
  return clients;
}
